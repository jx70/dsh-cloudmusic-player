/**
 * lib/lyrics.mjs —— 歌词：搜索 → 取 LRC → 解析 → 缓存
 * ============================================================================
 * 数据来源是网易云自己的 web API（不需要登录、不传 cookie）：
 *   GET {base}/search/get?s=<title artist>&type=1&limit=5
 *         → result.songs[] = { id, name, artists[].name, duration }
 *   GET {base}/song/lyric?id=<id>&lv=-1&kv=-1&tv=-1
 *         → lrc.lyric（原文） / klyric.lyric（卡拉OK） / tlyric.lyric（翻译）
 * 正文优先原文；原文为空时退卡拉OK；两者都空才退翻译。
 * 原文是外语歌时，把 tlyric 按时间戳叠成每一行的 `tr`（第二行小字）——
 * 中文歌的 tlyric 通常是空的（实测），所以「只给外语部分加翻译」是接口自带的性质。
 *
 * 这是**非公开接口**，可能限流或改字段。所以：
 *   1. 一切失败都返回 { ok:false, reason } —— 绝不让播放控制跟着挂；
 *   2. 结果落磁盘缓存，同一首歌第二次起零请求；
 *   3. base 可配（lyricsApiBase），镜像/反代/自建都能接。
 *
 * 参数是「歌名 + 歌手 + 时长」，不是 songId：SMTC 不给 id，
 * 所以用时长做二次校验（同名翻唱/现场版靠 duration 区分）。
 * ============================================================================
 */
import { LyricsCache } from './cache.mjs'

/** 单次请求超时 */
const HTTP_TIMEOUT_MS = 8000
/** 缓存 30 天（见 cache.mjs DEFAULT_TTL_MS）*/
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/**
 * 清洗搜索词：SMTC 给的标题常带「(Live)」「【】」「feat. xxx」「- Remastered」等噪声，
 * 原样丢给搜索接口会把结果带偏到现场版/翻唱。
 */
export function normalizeTitle(title) {
  if (!title) return ''
  return String(title)
    .replace(/[（(【\[][^）)】\]]{0,40}[）)】\]]/g, ' ')
    .replace(/\s*[-–—]\s*(remaster(ed)?|live|acoustic|instrumental|demo|edit|version)\b.*$/i, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring)\s+[^,，/]+/gi, ' ')
    .replace(/[\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 歌手字段可能是「A/B」「A & B」「A, B」，取第一个 */
export function primaryArtist(artist) {
  if (!artist) return ''
  return String(artist)
    .split(/[/&,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)[0] || ''
}

/**
 * LRC 解析。
 * 支持一行多时间戳 `[00:12.34][01:05.67]词`、`[mm:ss:xx]` 老格式、以及 `[ti:]` 元信息。
 * 空文本行**保留时间点**（`text:''`）当作间奏标记 —— 前端用它做「本行是空气」的
 * 平滑过渡，而不是让上一句歌词一直挂着。
 *
 * @param {string} lrc
 * @returns {{ t: number, text: string }[]} 按时间升序，t 单位毫秒
 */
export function parseLrc(lrc) {
  if (!lrc) return []
  const out = []
  const tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const rawLine of String(lrc).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    tagRe.lastIndex = 0
    const stamps = []
    let m
    while ((m = tagRe.exec(line)) !== null) {
      const min = Number(m[1])
      const sec = Number(m[2])
      let frac = 0
      if (m[3] !== undefined) {
        const s = m[3]
        // 两位是厘秒，三位是毫秒
        frac = s.length === 3 ? Number(s) : Number(s) * 10
      }
      stamps.push(min * 60000 + sec * 1000 + frac)
    }
    if (stamps.length === 0) continue
    const text = line.replace(tagRe, '').replace(/\s+/g, ' ').trim()
    for (const t of stamps) out.push({ t, text })
  }
  out.sort((a, b) => a.t - b.t)
  // 去掉时间完全重复的（少见，但偶有双行同戳）
  const dedup = []
  for (const row of out) {
    const prev = dedup[dedup.length - 1]
    if (prev && prev.t === row.t) {
      if (!prev.text && row.text) dedup[dedup.length - 1] = row
      continue
    }
    dedup.push(row)
  }
  return dedup
}

/**
 * 译文配对的容差（毫秒）。
 *
 * 实测（2026-11 本机）：`lrc` 与 `tlyric` 的时间戳几乎总是**完全相同**的字符串
 * （`[00:27.890]` 对 `[00:27.890]`）。God knows 39/39、たぶん 62/62 全精确命中；
 * Ref:rain 57 条里 56 条精确，只有 1 条偏了十几毫秒。所以这里给一个很小的窗口就够，
 * 窗口开大会把相邻的两句错配 —— 歌词错位比没译文更糟。
 */
const NEAR_MS = 60

/**
 * 把译文合进原文行。
 *
 * 网易云的 `tlyric` 是**与原文同格式的 LRC**，只包含被翻译的那些行；
 * 中文歌通常整段为空（实测「越来越不懂」「起风了」「孤勇者」都是 0 字节）——
 * 也就是说「只给外语部分加翻译」这件事由接口本身保证，我们不需要判断语种。
 *
 * 规则：
 *  · 时间戳精确相等 → 配对；
 *  · 否则找 |Δt| ≤ NEAR_MS 的最近一条；
 *  · 再不行就不附加（宁缺不错）。
 * 跳过：译文为空、译文与原文（去空白后）相同、原文本身是空文本行（间奏标记）。
 *
 * 返回**新数组**，未配上的行不带 `tr` 键（而不是 `tr: undefined`）——
 * 这样 JSON.stringify 之后 `tr` 会彻底消失，前端判断 `typeof line.tr === 'string'` 才干净。
 *
 * @param {{t:number,text:string}[]} lines 原文行
 * @param {{t:number,text:string}[]} transLines 译文行
 * @returns {{t:number,text:string,tr?:string}[]}
 */
export function mergeTranslation(lines, transLines) {
  if (!Array.isArray(lines) || lines.length === 0) return lines || []
  if (!Array.isArray(transLines) || transLines.length === 0) return lines

  const exact = new Map()
  const stamps = []
  for (const row of transLines) {
    const text = String(row.text || '').trim()
    if (!text) continue
    if (!exact.has(row.t)) exact.set(row.t, text)
    stamps.push(row.t)
  }
  if (stamps.length === 0) return lines
  stamps.sort((a, b) => a - b)

  /** 二分找最近的译文时间戳 */
  const nearest = (t) => {
    let lo = 0
    let hi = stamps.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const v = stamps[mid]
      if (v === t) return v
      if (v < t) lo = mid + 1
      else hi = mid - 1
    }
    const after = stamps[lo]
    const before = stamps[lo - 1]
    if (after === undefined) return before
    if (before === undefined) return after
    return t - before <= after - t ? before : after
  }

  const out = []
  for (const line of lines) {
    const text = String(line.text || '')
    if (!text.trim()) {
      out.push({ t: line.t, text: line.text })
      continue
    }
    let tr = exact.get(line.t)
    if (tr === undefined) {
      const near = nearest(line.t)
      if (near !== undefined && Math.abs(near - line.t) <= NEAR_MS) tr = exact.get(near)
    }
    if (tr === undefined || tr === '' || tr === text.trim()) {
      out.push({ t: line.t, text: line.text })
    } else {
      out.push({ t: line.t, text: line.text, tr })
    }
  }
  return out
}

/** 带超时的 fetch，返回解析后的 JSON */
async function getJson(url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*', referer: 'https://music.163.com/' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (!text || text.trim() === '') throw new Error('empty body')
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 带一次重试的取数：网络抖动/瞬时 5xx 时重试一次即可覆盖绝大多数情况。
 */
async function getJsonRetry(url, timeoutMs) {
  try {
    return await getJson(url, timeoutMs)
  } catch (first) {
    await new Promise((r) => setTimeout(r, 400))
    try {
      return await getJson(url, timeoutMs)
    } catch {
      throw first
    }
  }
}

/**
 * 标题相似度。
 * 先把两边都「去装饰」再比 —— 搜索结果的标题常带 `(钢琴版)`、`[原唱: xx]`、`- Cover`，
 * 这些括号里的东西恰恰是**判断它是不是原版**的依据，比较标题时应该先剥掉，
 * 由 scoreCandidate() 单独扣分。
 */
function titleScore(a, b) {
  const pick = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[（(【\[][^）)】\]]{0,40}[）)】\]]/g, ' ')
      .replace(/[\s'"“”·・:：,，.。!！?？\-–—_/\\]/g, '')
      .trim()
  const x = pick(a)
  const y = pick(b)
  if (!x || !y) return 0
  if (x === y) return 100
  if (x.includes(y) || y.includes(x)) return 60
  return 0
}

/** 结果标题里出现这些词，说明它不是原版（是我们不想要的那个版本）*/
const VERSION_NOISE =
  /(cover|翻唱|原唱|伴奏|纯音乐|instrumental|karaoke|remix|dj|加速|降速|慢速|升调|降调|翻自|片段|试听|铃声|治愈版|钢琴版|吉他版|童声|女声版|男声版|鼠鼠版|恶搞|八音盒|纯享)/i

/** SMTC 有时把歌手字段给成这些占位符，别拿它们去卡搜索结果 */
const ARTIST_PLACEHOLDER = /^(未知.*|unknown.*|various.*|va|v\.a\.|n\/a|none|-+|null)$/i

/** 连我们自己的标题里都带这些词，就说明用户要的就是这个版本，不该扣分 */
function noiseWords(s) {
  const m = String(s || '').match(VERSION_NOISE)
  return m ? m[0].toLowerCase() : ''
}

/**
 * 给一个搜索结果打分；返回 null 表示**直接淘汰**。
 *
 * 权重设计来自实测（2026-11 本机）：搜「稻香 周杰伦」时前 20 条**全是翻唱/改编/伴奏**，
 * 原版根本不在结果里。如果只比标题，会选中一条 198 秒的伴奏版，然后把它的歌词
 * 贴着 223 秒的原版时间轴滚 —— 比「暂无歌词」更糟。所以这里用两条**硬规则**：
 *
 *   1. 歌手明确对不上 → 淘汰。同名不同人 = 翻唱，歌词字面一样但时间轴是它自己的。
 *      SMTC 不给歌手（占位符/空）时跳过这条，只靠时长。
 *   2. 时长差超过 8 秒 → 淘汰。翻唱/剪辑版最可靠的指纹。
 *
 * 软因子：标题相似度、歌手命中加分、版本噪声词扣分、时长接近加分。
 */
function scoreCandidate(cand, want) {
  const title = titleScore(want.title, cand.name)
  if (!title) return null

  let score = title

  const wantArtist = String(want.artist || '').trim()
  const candArtists = String(cand.artists || '').trim()
  const artistKnown = wantArtist && !ARTIST_PLACEHOLDER.test(wantArtist)

  if (artistKnown && candArtists) {
    const hay = candArtists.toLowerCase()
    const needle = wantArtist.toLowerCase()
    if (hay.includes(needle) || needle.includes(hay)) {
      score += 50
    } else {
      // 硬规则 1
      return null
    }
  } else if (artistKnown && !candArtists) {
    score -= 15
  }

  // 硬规则 2 + 软加分
  if (want.durationMs && cand.durationMs) {
    const delta = Math.abs(cand.durationMs - want.durationMs)
    if (delta <= 1200) score += 70
    else if (delta <= 3000) score += 45
    else if (delta <= 8000) score -= 35
    else return null
  }

  // 版本噪声词
  const wantNoise = noiseWords(want.title)
  const hitNoise = String(cand.name || '').match(VERSION_NOISE)
  if (hitNoise && hitNoise[0].toLowerCase() !== wantNoise) score -= 55

  return { ...cand, score, titleScore: title }
}

/** 低于这个分就不认 —— 宁可「暂无歌词」，也不给错词 */
const MIN_SCORE = 95

export class LyricsService {
  /**
   * @param {{ getConfig: () => { lyricsEnabled: boolean, lyricsApiBase: string, requestTimeoutMs?: number } }} options
   * @param {string} cacheDir
   */
  constructor(options, cacheDir) {
    this.getConfig = options.getConfig
    this.cache = new LyricsCache(cacheDir)
  }

  base() {
    const cfg = this.getConfig() || {}
    const base = String(cfg.lyricsApiBase || 'https://music.163.com/api').replace(/\/+$/, '')
    return base
  }

  enabled() {
    const cfg = this.getConfig() || {}
    return cfg.lyricsEnabled !== false
  }

  /** 译文开关。关掉只影响「外语歌的第二行」，原文照常取 */
  translationEnabled() {
    const cfg = this.getConfig() || {}
    return cfg.lyricsTranslation !== false
  }

  /**
   * 按歌名/歌手/时长取歌词。
   * @param {{ title?: string, artist?: string, durationMs?: number, songId?: number|string }} q
   * @returns {Promise<{ ok: boolean, songId?: number, source?: string, translated?: boolean, lines?: {t:number,text:string,tr?:string}[], reason?: string }>}
   */
  async resolve(q) {
    if (!this.enabled()) return { ok: false, reason: 'lyrics-disabled' }

    const givenId = q.songId ? Number(q.songId) : 0
    const title = normalizeTitle(q.title)
    const artist = primaryArtist(q.artist)
    const durationMs = Number(q.durationMs) > 0 ? Number(q.durationMs) : 0

    if (!title && !givenId) return { ok: false, reason: 'no-query' }

    // 1) 已知 songId：直接查缓存 + 取词
    if (givenId) {
      const hit = this.cache.get(givenId, CACHE_TTL_MS)
      if (hit) {
        return {
          ok: true,
          songId: givenId,
          source: hit.source,
          lines: hit.lines,
          translated: hit.translated === true,
          cached: true,
        }
      }
      const fetched = await this.fetchLyric(givenId)
      if (fetched.ok) {
        this.cache.set(givenId, {
          lines: fetched.lines,
          source: fetched.source,
          translated: fetched.translated === true,
        })
        return fetched
      }
      return fetched
    }

    // 2) 按歌名搜：搜索接口比歌词接口便宜，但也不能每次都打
    let songs
    try {
      const word = artist ? `${title} ${artist}` : title
      const url = `${this.base()}/search/get?s=${encodeURIComponent(word)}&type=1&limit=20`
      const json = await getJsonRetry(url, HTTP_TIMEOUT_MS)
      songs = (json && json.result && json.result.songs) || []
    } catch (err) {
      return { ok: false, reason: 'search-failed', detail: String(err && err.message ? err.message : err) }
    }
    if (!Array.isArray(songs) || songs.length === 0) return { ok: false, reason: 'not-found' }

    // 打分：标题 + 歌手 + 时长 + 版本噪声词（详见 scoreCandidate 的注释）
    const want = { title, artist, durationMs }
    const scored = songs
      .map((s) => {
        const cand = {
          id: Number(s.id),
          name: s.name || s.title || '',
          artists: (s.artists || s.ar || [])
            .map((a) => a && a.name)
            .filter(Boolean)
            .join('/'),
          durationMs: Number(s.duration || s.dt || 0),
        }
        if (!cand.id) return null
        return scoreCandidate(cand, want)
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) return { ok: false, reason: 'not-found' }

    const best = scored[0]
    if (best.score < MIN_SCORE) {
      // 宁可空着也不给错词：这个环境下「稻香」搜出来全是翻唱
      return {
        ok: false,
        reason: 'low-confidence',
        detail: `最佳候选 ${best.name || '(无名)'} / ${best.artists || '?'} 评分 ${best.score}`,
        candidates: scored.slice(0, 3).map((c) => ({ id: c.id, name: c.name, artists: c.artists, score: c.score })),
      }
    }

    // 3) 依次试前几条（有些歌 id 下的 lrc 是空的，但同名的另一个版本有）
    for (const cand of scored.filter((c) => c.score >= MIN_SCORE).slice(0, 3)) {
      const hit = this.cache.get(cand.id, CACHE_TTL_MS)
      if (hit) {
        return {
          ok: true,
          songId: cand.id,
          source: hit.source,
          lines: hit.lines,
          translated: hit.translated === true,
          cached: true,
          matched: { name: cand.name, artists: cand.artists, score: cand.score, durationMs: cand.durationMs },
        }
      }
      const fetched = await this.fetchLyric(cand.id)
      if (fetched.ok) {
        this.cache.set(cand.id, {
          lines: fetched.lines,
          source: fetched.source,
          translated: fetched.translated === true,
        })
        return { ...fetched, matched: { name: cand.name, artists: cand.artists, score: cand.score, durationMs: cand.durationMs } }
      }
    }
    return { ok: false, reason: 'no-lyric-body' }
  }

  /**
   * 取一首歌的歌词正文。纯歌词（无时间戳）的也接受，按 4 秒一行平均铺开 ——
   * 总比整块不显示好。
   */
  async fetchLyric(songId) {
    let json
    try {
      const url = `${this.base()}/song/lyric?id=${songId}&lv=-1&kv=-1&tv=-1`
      json = await getJsonRetry(url, HTTP_TIMEOUT_MS)
    } catch (err) {
      return { ok: false, songId, translated: false, reason: 'lyric-failed', detail: String(err && err.message ? err.message : err) }
    }
    if (!json) return { ok: false, songId, translated: false, reason: 'lyric-empty' }

    const lrcBody = json.lrc && json.lrc.lyric
    const klyBody = json.klyric && json.klyric.lyric
    const trBody = json.tlyric && json.tlyric.lyric

    // 正文候选：原文 → 卡拉OK；**译文不参与正文选优**（它是第二行，不是歌词本体）。
    // 译文只有在原文和卡拉OK都空的时候才退而当正文 —— 老逻辑那样做是对的，保留。
    const candidates = [
      ['lrc', lrcBody],
      ['klyric', klyBody],
      ['tlyric', trBody],
    ]
    for (const [source, body] of candidates) {
      if (!body || !String(body).trim()) continue
      const lines = parseLrc(body)
      if (lines.length === 0) continue
      // 只有「正文是从原文/卡拉OK来的」才需要往上面叠译文；
      // 正文本身取自 tlyric 时再合并一次就是自己叠自己。
      const merged =
        source !== 'tlyric' && this.translationEnabled() && trBody && String(trBody).trim()
          ? mergeTranslation(lines, parseLrc(trBody))
          : lines
      const translated = merged.some((l) => typeof l.tr === 'string' && l.tr)
      return { ok: true, songId, source, lines: merged, translated }
    }

    // 完全没有时间戳：原文当成纯文本，按行平均铺
    const plain = [lrcBody, trBody]
      .map((s) => (s ? String(s).trim() : ''))
      .find(Boolean)
    if (plain) {
      const rows = plain
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (rows.length > 0) {
        const lines = rows.map((text, i) => ({ t: i * 4000, text }))
        return { ok: true, songId, source: 'plain', lines, translated: false }
      }
    }
    return { ok: false, songId, translated: false, reason: 'no-lyric-body' }
  }
}
