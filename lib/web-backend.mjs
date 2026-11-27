/**
 * web-backend.mjs — 网易云「网页版」播放通道（CDP 全包方案，前端零改动）
 *
 * 背景：cloudmusic-player 原本只控制本机客户端（windows-powershell 后端 +
 * helper.ps1 + SMTC）。客户端没装/没开时，用户仍希望用悬浮框完成同样的动作。
 * 这个后端不碰前端 client.js，只守住 Host 侧 6 条路由契约 + 状态形状：
 *   - 通过 CDP 驱动 ego-lite 的持久浏览器（default space）里的 music.163.com 页面；
 *   - 登录态复用：优先用客户端解出的 cookie 注入浏览器（Storage.setCookies），
 *     浏览器已登录则直接用，未登录返回一个可读的 ok:false；
 *   - 出声：网页版本身点播放只会提示"去客户端播放"，所以真实音频走明文
 *     POST https://music.163.com/api/song/enhance/player/url/v1 + 登录 cookie
 *     拿到 URL，再注入页面 <audio> 播放（带 Referer 防盗链）。
 *
 * 设计约束（来自 k65 验收）：
 *   - 上层 action 接口形状不变（state/action/volume/lyrics 的返回跟原生后端一致）；
 *   - 网页版未登录/未打开/浏览器没起，一律 {ok:false,error,message} 不抛异常；
 *   - play_daily 复用 DailyService 的 cookie/取数，打通 songId→song/url→audio。
 *
 * 不依赖任何 npm 包：Node 内置 fetch / WebSocket（Node ≥ 22）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadCookieHeader } from './cookies.mjs'
import { LikeService } from './like.mjs'
import { SmtcBrowser } from './smtc-browser.mjs'
import { WinrtAudio } from './winrt-audio.mjs'

const MUSIC_ORIGIN = 'https://music.163.com'
const MUSIC_HOME = `${MUSIC_ORIGIN}/`
const SONG_URL_API = `${MUSIC_ORIGIN}/api/song/enhance/player/url/v1`
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const PAGE_TARGET_HINT = 'music.163.com'
const AUDIO_ID = '__dsh_cmp_audio'
const CONNECT_TIMEOUT_MS = 4000
const EVAL_TIMEOUT_MS = 6000
// 播放顺序：上层/前端用短值 order/cycle/single/random（index.js set_mode 参数），
// 状态 now.mode 必须回内部枚举 playOrder/playCycle/playOneCycle/playRandom，
// 前端 client.js 的 MODE_ORDER 才认、图标才会跟着切。
const MODE_SHORT_TO_ENUM = { order: 'playOrder', cycle: 'playCycle', single: 'playOneCycle', random: 'playRandom' }
const MODE_ENUM_DEFAULT = 'playCycle'

/** 浏览器 CDP 配置：从 ego-lite 的 browser.json 读（Windows 在 %LOCALAPPDATA%\ego-lite-linux）。 */
function egoConfigPath() {
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'ego-lite-linux', 'browser.json')
  return join(homedir(), '.ego-lite-linux', 'browser.json')
}

function readEgoConfig(overridePath) {
  try {
    const p = overridePath || egoConfigPath()
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    if (!cfg.wsUrl) throw new Error('browser.json 缺少 wsUrl')
    return cfg
  } catch (err) {
    return { error: `读 ego 浏览器配置失败：${String(err?.message || err)}` }
  }
}

/**
 * 极简 CDP 客户端：一个 browser-level WebSocket，attach 到页面 target 后用
 * sessionId 发 Runtime.evaluate / Page.reload；不依赖 ws / playwright。
 */
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.closed = false
  }

  async connect(timeoutMs = CONNECT_TIMEOUT_MS) {
    if (this.ws && this.ws.readyState === 1) return
    if (typeof WebSocket === 'undefined') throw new Error('Node 版本过低，缺少内置 WebSocket（需 ≥ 22）')
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP 超时')), timeoutMs)
      ws.onopen = () => { clearTimeout(timer); resolve() }
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`CDP 连接错误：${e?.message || 'unknown'}`)) }
    })
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
    ws.onclose = () => {
      this.ws = null
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('CDP 连接已关闭'))
      }
      this.pending.clear()
    }
  }

  cmd(method, params = {}, sessionId, timeoutMs = EVAL_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('CDP 未连接')
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 调用超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /** 连接是否仍存活。浏览器重启后 ws 会关闭，旧连接必须丢弃重建。 */
  isAlive() { return !this.closed && !!this.ws && this.ws.readyState === 1 }

  close() {
    this.closed = true
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
  }
}

/** 把 loadCookieHeader 的 header 解析成 CDP Storage.setCookies 需要的数组。 */
function cookieHeaderToCdp(cookieHeader, domain = '.music.163.com') {
  const cookies = []
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (!name) continue
    cookies.push({ name, value, domain, path: '/', secure: false, httpOnly: false, sameSite: 'None' })
  }
  return cookies
}

/** 页面内取值：返回 { status, pos, end, title, artist, songId, liked, playing }。
 *  用户手动在网页放歌时是「打开客户端播放」模式——没有 <audio>、时间栏 00:00，
 *  但 window.player.getPlaying().track 带着完整元数据（歌名/id/歌手/时长/playing），
 *  这是识别当前歌曲最可靠的数据源。DOM 标题常是「网易云音乐」，只做兜底。 */
const READ_STATE_EXPR = `(() => {
  const a = document.getElementById(${JSON.stringify(AUDIO_ID)})
  const gp = (window.player && typeof window.player.getPlaying === 'function')
    ? window.player.getPlaying() : null
  const rawTrack = gp ? gp.track : null
  // getPlaying().track 有两种形态：完整对象 {id,name,artists...} 或裸数字 songId。
  const track = rawTrack && typeof rawTrack === 'object' ? rawTrack : null
  const trackId = track ? (track.id || '') : (typeof rawTrack === 'number' ? rawTrack : '')
  const titleEl = document.querySelector('.m-playbar .title, .m-playbar .name, .m-playbar .j-title')
  const artistEl = document.querySelector('.m-playbar .artist, .m-playbar .s-fc4, .m-playbar .j-artist')
  const statusEl = document.querySelector('.m-playbar .ply, .m-playbar .play')
  const isPlaying = !!(a && !a.paused && !a.ended) ||
    !!(gp && gp.playing === true) ||
    !!(statusEl && (statusEl.classList.contains('ply') === false))
  // 进度：<audio> 为准；用户手动放歌无 audio 时退到 getPlaying().track.position（秒），再退 0。
  const posMs = a ? Math.round((a.currentTime || 0) * 1000)
    : (track && Number(track.position) > 0 ? Math.round(Number(track.position) * 1000) : 0)
  const endMs = a ? Math.round((a.duration || 0) * 1000)
    : (track && Number(track.duration) > 0 ? Math.round(Number(track.duration)) : 0)
  const artists = track && Array.isArray(track.artists)
    ? track.artists.map((x) => (x && x.name) || '').filter(Boolean).join(' / ') : ''
  return {
    status: isPlaying ? 'Playing' : 'Paused',
    pos: posMs,
    end: endMs,
    title: (track && track.name) || (titleEl && titleEl.textContent || '').trim(),
    artist: artists || (artistEl && artistEl.textContent || '').trim(),
    songId: String(trackId || ''),
    liked: null,
    hasAudio: !!a,
    audioReady: a ? a.readyState : 0,
    // audio 自己在放哪首：注入时写在 dataset 上。页面手动点的那首和插件接管的那首
    // 常常不是同一首，state() 必须按这个 id 取元数据，否则歌名/时长会张冠李戴。
    audioSongId: a ? String(a.dataset && a.dataset.songId || '') : '',
    pageTitle: document.title || '',
  }
})()`

export class WebBackend {
  /**
   * @param {{ getConfig?: () => any, log?: (msg:string)=>void,
   *          daily?: import('./daily.mjs').DailyService }} deps
   */
  constructor(deps = {}) {
    this.getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({})
    this.log = typeof deps.log === 'function' ? deps.log : () => {}
    this.daily = deps.daily || null
    // 日推出声引擎：WinRT MediaPlayer 常驻后台进程（无窗口、不弹页、不依赖 CDP/ego）。
    // 只有 Windows 才建真实实例；测试可注入 mock。ego 关着、个人 Edge 无 CDP 时，
    // 日推靠它精确播指定曲目；个人 Edge 手动放歌仍走 SMTC（互不干扰）。
    this.winrtAudio = deps.winrtAudio || (process.platform === 'win32'
      ? new WinrtAudio({ getConfig: this.getConfig, log: this.log })
      : null)
    this.winrtPlaying = false  // 日推引擎是否占用当前播放
    this.winrtSong = null      // 引擎当前曲目 { id, name, artist }
    // 可注入 CDP 工厂（测试用）：默认用真实 CdpClient。
    this._cdpFactory = typeof deps.cdpFactory === 'function' ? deps.cdpFactory : ((wsUrl) => new CdpClient(wsUrl))
    // SMTC 回退：ego-lite 的网页是「去客户端播放」占位，用户真正在放的歌在个人 Edge
    // （无 CDP 端口），只能靠系统媒体会话读到。可注入测试。
    this.smtc = deps.smtc || new SmtcBrowser({ getConfig: this.getConfig, log: this.log })
    // 本次 state 实际采用的数据源：'cdp'（插件自己的 audio / 网页队列）或 'smtc'（个人浏览器媒体会话）
    this.dataSource = 'cdp'
    this.smtcState = null
    this.id = 'web-cdp'
    this.platform = 'web'
    this.reason = ''
    this.capabilities = { playback: true, sessionVolume: true, systemVolume: false, lyrics: true, web: true }
    // 播放队列：daily 取数后的 id 列表；当前曲目索引；正在播放的音频 URL 缓存
    this.queue = []
    this.queueIndex = -1
    // 播放顺序（内部枚举）。set_mode 会改它，next/prev/自动切歌按它决定走向，
    // state().now.mode 回它给前端切图标。persist 到配置以便重启后保持。
    this.mode = MODE_ENUM_DEFAULT
    this.audioUrlCache = new Map() // songId -> { url, at }
    this.songMetaCache = new Map() // songId -> { name, artist, durationMs, at }；数字 track 时按 id 补元数据
    this.cdp = null
    this.sessionId = null
    this.injectedCookies = false
    this.lastError = ''
    this.volumeLevel = 0.8
    this.muted = false
    // 用户在网页里手动点的那首（getPlaying().track 给的裸 songId）。
    // 网页播放器已被网易云阉割成「去客户端播放」，页面里没有 <audio>，
    // 所以要把这首接管过来：用 Host 侧 cookie 取 URL，在同一个页面注入 <audio>。
    this.manualSongId = ''
    // 喜欢（红心）：网页版没有客户端 CEF cookie，用一个改用浏览器/手填 cookie 的
    // LikeService 实例；cookie 来源统一走 _cookieForApi()（手填 > 客户端解出 > 浏览器）。
    // 可注入测试。上层 client.js 只读 now.liked，无需知道走的是哪个实例。
    this.likeWeb = deps.likeWeb || new LikeService({
      getConfig: this.getConfig,
      log: this.log,
      cookieLoader: async () => {
        // 网页版通道优先用浏览器已登录会话（个人 Edge / ego 都可能是登录源）；
        // 拿不到再退到手填 cookie / 客户端解出的 cookie。
        try {
          const bc = await this._browserCookies()
          if (bc.hasLogin && bc.header) return { ok: true, cookie: bc.header }
        } catch { /* fallthrough */ }
        const cookie = await this._cookieForApi()
        return cookie ? { ok: true, cookie } : { ok: false, error: 'cookie-missing' }
      },
    })
    // state() 里 liked 查询的节流（参照 player.mjs:485-517）：切歌即查，否则 likeSyncMs 一次
    this.likedForSong = ''
    this.likedCheckedAt = 0
    this.likedFailAt = 0
    // title+artist -> songId 搜索缓存（SMTC 场景没有 songId，按歌名搜），60 分钟
    this.songSearchCache = new Map()
    // 系统音量：Windows 端点级、与播放通道无关。复用 native PlayerService 的
    // helper（不依赖客户端进程）。注入后自动把 capabilities.systemVolume 打开，
    // 让 web 通道也能读/写系统音量、跟随系统。
    let _svc = deps.systemVolumeService || null
    Object.defineProperty(this, 'systemVolumeService', {
      configurable: true,
      get() { return _svc },
      set(v) {
        _svc = v
        this.capabilities.systemVolume = !!(v && process.platform === 'win32')
      },
    })
    this.capabilities.systemVolume = !!(_svc && process.platform === 'win32')
  }

  /** 系统音量能力是否可用（注入了 native helper 且在 Windows）。 */
  _hasSystemVolume() {
    return !!(this.systemVolumeService && process.platform === 'win32')
  }

  /** 读系统音量读数，失败返回 null（不影响 state 其它字段）。 */
  async _readSystemVolume() {
    if (!this._hasSystemVolume()) return null
    try {
      // 不强制 fresh：native state 自带 400ms 缓存，系统音量低频变化，够用且省一次 helper 往返。
      const st = await this.systemVolumeService.state({})
      return st?.systemVolume || st?.volume || null
    } catch { return null }
  }

  _cfg() {
    const c = this.getConfig() || {}
    return {
      webBrowserJson: String(c.webBrowserJson || ''),
      webLoginCookie: String(c.webLoginCookie || ''),
      webAutoInjectCookie: c.webAutoInjectCookie !== false,
      webSongUrlApi: String(c.webSongUrlApi || SONG_URL_API),
      webSongUrlLevel: String(c.webSongUrlLevel || 'standard'),
      requestTimeoutMs: Number(c.requestTimeoutMs) > 0 ? Number(c.requestTimeoutMs) : 6000,
    }
  }

  /**
   * 数字形态的 getPlaying().track（只有一个 songId）时，按 id 从页面内同源
   * /api/song/detail 补歌名/歌手/时长。60 分钟缓存。失败返回 null，调用方用占位。
   */
  async _songMeta(songId) {
    const id = String(songId || '')
    if (!id || id === 'undefined') return null
    const hit = this.songMetaCache.get(id)
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.meta
    try {
      const raw = await this._eval(`(async () => {
        try {
          const r = await fetch('/api/song/detail?ids=[${id}]', { credentials: 'include' })
          const j = await r.json()
          const s = (j.songs && j.songs[0]) || null
          if (!s) return null
          return JSON.stringify({
            name: s.name || '',
            artist: (s.artists || []).map((a) => a.name).filter(Boolean).join(' / '),
            durationMs: Number(s.duration) || 0,
          })
        } catch (e) { return null }
      })()`)
      const meta = raw ? JSON.parse(raw) : null
      if (meta && meta.name) {
        this.songMetaCache.set(id, { meta, at: Date.now() })
        return meta
      }
    } catch { /* 取不到就返回 null */ }
    return null
  }

  /** 是否支持播放（后端抽象要求） */
  supported() { return true }

  /** 建立 CDP 连接、复用已打开的 music.163.com 页面、注入登录 cookie。幂等。
   *  绝不新建浏览器窗口/标签：用户没打开网页版时返回可读错误。 */
  async ensure() {
    // 连接还在就复用；浏览器重启后旧 ws 会关闭，必须丢弃重建。
    if (this.cdp && this.cdp.isAlive?.() && this.sessionId) {
      this.lastError = ''
      return { ok: true }
    }
    // 浏览器重启瞬间会重写 browser.json，这里重试几次，避免偶发 ENOENT 挂成陈旧错误。
    const cfg = this._cfg()
    let ec
    for (let i = 0; i < 4; i++) {
      ec = readEgoConfig(cfg.webBrowserJson)
      if (!ec.error) break
      await new Promise((r) => setTimeout(r, 200))
    }
    if (ec.error) return this._fail('web-browser-unavailable', ec.error)
    try {
      const cdp = this._cdpFactory(ec.wsUrl)
      await cdp.connect()
      // 只复用用户已经打开的网易云页面。找不到就报错，绝不 Target.createTarget——
      // 那会弹出一个新浏览器窗口，正是"点重试弹新窗口"的根因。
      const targets = await cdp.cmd('Target.getTargets')
      let page = (targets.targetInfos || []).find(
        (t) => t.type === 'page' && String(t.url || '').includes(PAGE_TARGET_HINT),
      )
      if (!page) {
        cdp.close()
        return this._fail('web-page-not-found', '没有找到已打开的 music.163.com 页面')
      }
      const attached = await cdp.cmd('Target.attachToTarget', { targetId: page.targetId, flatten: true })
      const sessionId = attached.sessionId
      this.cdp = cdp
      this.sessionId = sessionId
      // 等页面加载出来
      await this._eval('document.readyState', sessionId).catch(() => {})

      // 用户可能已在网页里登录、甚至正在放歌。此时绝不能注入 cookie / reload——
      // 那样会打断播放、把当前歌曲清掉。已登录或已读到正在播的歌，直接复用现状。
      let alreadyPlaying = false
      try {
        const s = await this._eval(READ_STATE_EXPR, sessionId)
        alreadyPlaying = !!(s && (
          (s.songId && s.songId !== 'undefined') ||
          (s.title && s.title !== '网易云音乐')
        ))
      } catch { /* 读不到就按没在播处理 */ }
      const browserLoggedIn = (await this._browserCookies()).hasLogin
      // 连上了、页面也在，旧错误就该清掉，免得 health 一直挂着 ENOENT。
      this.lastError = ''
      if (alreadyPlaying || browserLoggedIn) return { ok: true }

      // 浏览器没登录：注入手填 / 客户端解出的 cookie，reload 一次让登录态生效
      let cookie = cfg.webLoginCookie
      if (!cookie && cfg.webAutoInjectCookie) {
        try {
          const got = await loadCookieHeader({})
          if (got?.ok && got.cookie) cookie = got.cookie
        } catch (err) {
          this.log(`web: loadCookieHeader failed: ${String(err?.message || err)}`)
        }
      }
      if (cookie) {
        await cdp.cmd('Storage.setCookies', { cookies: cookieHeaderToCdp(cookie) })
        this.injectedCookies = true
        await cdp.cmd('Page.reload', { ignoreCache: false }, sessionId).catch(() => {})
        await this._waitReady(sessionId)
      }
      return { ok: true }
    } catch (err) {
      return this._fail('web-cdp-error', String(err?.message || err))
    }
  }

  async _waitReady(sessionId) {
    for (let i = 0; i < 10; i++) {
      try {
        const s = await this._eval('document.readyState', sessionId)
        if (s === 'complete' || s === 'interactive') return
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  async _eval(expression, sessionId = this.sessionId) {
    const r = await this.cdp.cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, sessionId)
    if (r.exceptionDetails) {
      const e = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval error'
      throw new Error(e)
    }
    return r.result?.value
  }

  _fail(error, detail) {
    this.lastError = detail || error
    return { ok: false, error, message: this._message(error), detail: detail || '' }
  }

  _message(error) {
    const map = {
      'web-browser-unavailable': '网页版通道不可用：没有找到 ego 浏览器，请先打开浏览器并登录网易云网页版',
      'web-page-not-found': '网易云网页版页面未打开，请先在浏览器里打开 music.163.com（插件不会替你新开窗口）',
      'web-cdp-error': '网页版通道出错：无法连接或操作浏览器',
      'web-not-logged-in': '网易云网页版尚未登录，请先在浏览器里登录（或确保本机客户端已登录以复用 cookie）',
      'web-no-audio-url': '这首歌暂时拿不到播放地址（可能无版权或需 VIP），换一首试试',
      'web-no-song': '当前没有可播放的歌曲',
      'web-action-failed': '网页版播放动作执行失败',
    }
    return map[error] || '网页版通道出错'
  }

  /**
   * 读浏览器完整 cookie（含 httpOnly 的 MUSIC_U）——必须在 browser-level CDP
   * 连接上发 Storage.getCookies，document.cookie 读不到 httpOnly。
   * @returns {Promise<{header:string, hasLogin:boolean}>}
   */
  async _browserCookies() {
    try {
      const res = await this.cdp.cmd('Storage.getCookies', {})
      const list = (res?.cookies || []).filter((c) => String(c.domain || '').includes('music.163.com'))
      const header = list.map((c) => `${c.name}=${c.value}`).join('; ')
      const hasLogin = list.some((c) => c.name === 'MUSIC_U' && c.value && c.value.length > 6)
      return { header, hasLogin }
    } catch {
      return { header: '', hasLogin: false }
    }
  }

  /** 登录态探测：浏览器 cookie 有 MUSIC_U，或页面有昵称，即视为已登录。 */
  async _isLoggedIn() {
    const bc = await this._browserCookies()
    if (bc.hasLogin) return true
    try {
      const r = await this._eval(`(() => {
        const nickEl = document.querySelector('.m-tophead .name, .m-tophead .u-name, .head .name, .m-tophead a')
        const nick = nickEl ? (nickEl.textContent || '').trim() : ''
        const loginBtn = document.querySelector('.m-tophead .u-login, .m-tophead .login, a[href*="/login"]')
        return { nick: !!nick, hasLoginBtn: !!loginBtn }
      })()`)
      if (r && r.nick && !r.hasLoginBtn) return true
      // 页面还没渲染出用户态但 httpOnly cookie 在，也算登录
      return bc.hasLogin
    } catch {
      return bc.hasLogin
    }
  }

  /** 供 API 调用取 cookie：手填 > 客户端解出 > 浏览器完整 cookie。 */
  async _cookieForApi() {
    const cfg = this._cfg()
    if (cfg.webLoginCookie) return cfg.webLoginCookie
    try {
      const got = await loadCookieHeader({})
      if (got?.ok && got.cookie) return got.cookie
    } catch { /* fallthrough */ }
    const bc = await this._browserCookies()
    return bc.header
  }

  /** 明文拿歌曲播放 URL（实测 /api/song/enhance/player/url/v1 + cookie 即可，无需 weapi 加密）。 */
  async _songUrl(songId) {
    if (!songId) return this._fail('web-no-song', '')
    const cfg = this._cfg()
    const cached = this.audioUrlCache.get(String(songId))
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return { ok: true, url: cached.url }
    const cookie = await this._cookieForApi()
    const body = new URLSearchParams({
      ids: JSON.stringify([Number(songId)]),
      level: cfg.webSongUrlLevel,
      encodeType: 'aac',
    })
    let parsed
    try {
      const res = await fetch(cfg.webSongUrlApi, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: MUSIC_ORIGIN + '/',
          'User-Agent': UA,
          Cookie: cookie,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      })
      const text = await res.text()
      parsed = JSON.parse(text)
    } catch (err) {
      return this._fail('web-no-audio-url', String(err?.message || err))
    }
    const info = Array.isArray(parsed?.data) ? parsed.data[0] : null
    const url = info && info.url ? String(info.url) : ''
    if (!url) return this._fail('web-no-audio-url', `code=${parsed?.code} ${info?.message || ''}`)
    this.audioUrlCache.set(String(songId), { url, at: Date.now() })
    return { ok: true, url }
  }

  /** 在页面里注入/复用 <audio>，加载指定 URL 并播放。 */
  async _playUrl(url, { positionMs = 0, songId = '' } = {}) {
    const expr = `(() => {
      let a = document.getElementById(${JSON.stringify(AUDIO_ID)})
      if (!a) {
        a = document.createElement('audio')
        a.id = ${JSON.stringify(AUDIO_ID)}
        a.style.display = 'none'
        document.body.appendChild(a)
      }
      if (${JSON.stringify(String(songId))}) a.dataset.songId = ${JSON.stringify(String(songId))}
      a.src = ${JSON.stringify(url)}
      a.volume = ${Number(this.volumeLevel)}
      a.muted = ${this.muted ? 'true' : 'false'}
      a.load()
      const p = a.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
      if (${Number(positionMs)} > 0) {
        const seek = () => { try { a.currentTime = ${Number(positionMs)} / 1000 } catch (e) {} }
        if (a.readyState >= 1) seek(); else a.addEventListener('loadedmetadata', seek, { once: true })
      }
      return { paused: a.paused, readyState: a.readyState }
    })()`
    return await this._eval(expr)
  }

  async _controlAudio(method, arg) {
    const call = {
      play: `(() => { const a=document.getElementById(${JSON.stringify(AUDIO_ID)}); if(!a) return false; const p=a.play(); if(p&&p.catch)p.catch(()=>{}); return true })()`,
      pause: `(() => { const a=document.getElementById(${JSON.stringify(AUDIO_ID)}); if(!a) return false; a.pause(); return true })()`,
      next: null,
      prev: null,
      seek: `(() => { const a=document.getElementById(${JSON.stringify(AUDIO_ID)}); if(a){a.currentTime=${Number(arg)}/1000} return !!a })()`,
    }[method]
    if (call) return await this._eval(call)
    return false
  }

  /** 播放「网页里手动点的那首」。
   *  网易云网页版已把播放器改成「去客户端播放」占位，页面里根本没有 <audio>，
   *  window.player.addTo() 也只是空转。所以手动点播的歌要由插件接管：
   *  用它给的 songId 走 Host 侧 cookie 取真实音频 URL，在同一个页面注入 <audio> 播放。
   *  这样 play/pause/seek 对「手动点的歌」也生效，进度也才开始走。 */
  async _playManual() {
    const s = await this._eval(READ_STATE_EXPR).catch(() => null)
    const songId = String(s?.songId || this.manualSongId || '')
    if (!songId || songId === 'undefined') return this._fail('web-no-song', '')
    this.manualSongId = songId
    // 已经在放这首：别重新 load，那会把进度打回 0。
    // 但「在放」得是同一首——页面手动切歌后 audio 还停在上一首，必须换。
    const cur = await this._eval(`(() => {
      const a = document.getElementById(${JSON.stringify(AUDIO_ID)})
      if (!a) return 'none'
      const same = String(a.dataset && a.dataset.songId || '') === ${JSON.stringify(songId)}
      if (!same) return 'other'
      if (!a.paused && !a.ended) return 'playing'
      return a.readyState >= 1 ? 'paused' : 'empty'
    })()`).catch(() => 'none')
    if (cur === 'playing') return { ok: true, songId, reused: true }
    if (cur === 'paused') {
      const r = await this._controlAudio('play')
      if (r !== false) return { ok: true, songId, resumed: true }
    }
    const got = await this._songUrl(songId)
    if (!got.ok) return got
    const r = await this._playUrl(got.url, { songId })
    return { ok: true, songId, url: got.url, audio: r }
  }

  /** 暂停任意一路：优先插件自己的 <audio>；没有 audio（从没让插件播过）就退到
   *  页面播放器 window.player.pause()，让「手动点的歌」也能被暂停。 */
  async _pauseAny() {
    const r = await this._controlAudio('pause').catch(() => false)
    if (r !== false) return { ok: true, via: 'audio' }
    try {
      await this._eval(`(() => { try { window.player && window.player.pause && window.player.pause() } catch (e) {} return true })()`)
      return { ok: true, via: 'page-player' }
    } catch (err) {
      return this._fail('web-action-failed', String(err?.message || err))
    }
  }

  /** 播放队列里的第 idx 首（取 URL → 注入 audio → 播放）。 */
  async _playQueueIndex(idx) {
    if (idx < 0 || idx >= this.queue.length) return this._fail('web-no-song', '')
    const song = this.queue[idx]
    const id = song?.id || song?.songId
    const got = await this._songUrl(id)
    if (!got.ok) return got
    this.queueIndex = idx
    const r = await this._playUrl(got.url, { songId: id })
    // 用播放器 DOM 标题兜底：让悬浮框即使拿不到 api 元数据也有东西显示
    try { await this._eval(`window.player && window.player.addTo && window.player.addTo([${Number(id)}])`) } catch { /* ignore */ }
    return { ok: true, url: got.url, audio: r, song }
  }

  /**
   * 按当前播放顺序算「下一首/上一首」的目标索引。
   * - order 顺序：到头就停在边界（返回 null 表示没有下一首）；
   * - cycle 列表循环：越界回环；
   * - single 单曲循环：原地不动；
   * - random 随机：换一首不同的（列表只有 1 首则原地）。
   * delta = +1 下一首 / -1 上一首。
   */
  _advanceIndex(delta = 1) {
    const n = this.queue.length
    if (!n) return null
    const cur = this.queueIndex >= 0 ? this.queueIndex : 0
    switch (this.mode) {
      case 'playOneCycle':
        return cur
      case 'playRandom': {
        if (n <= 1) return 0
        let next = cur
        while (next === cur) next = Math.floor(Math.random() * n)
        return next
      }
      case 'playOrder': {
        const to = cur + delta
        return to >= 0 && to < n ? to : null
      }
      case 'playCycle':
      default:
        return (cur + delta + n) % n
    }
  }

  // ---------------------------------------------------------------- 后端接口

  /** SMTC 是否启用（配置默认开）。 */
  _smtcEnabled() {
    try { return this.getConfig().smtcEnabled !== false } catch { return true }
  }

  /** 喜欢状态查询的节流窗口（ms），与原生 likeSyncMs 同源。 */
  _likeSyncMs() {
    try {
      const v = Number(this.getConfig().likeSyncMs)
      if (v > 0) return v
    } catch { /* fallthrough */ }
    return 8000
  }

  /**
   * 带节流的 liked 查询：切歌必查，否则 likeSyncMs 一次；失败 15s 退避。
   * 返回 true/false（已喜欢/未喜欢）或 null（查不到，前端按空心处理）。
   */
  async _likedFor(songId) {
    const id = String(songId || '')
    if (!id || id === '0' || id === 'undefined' || id === 'NaN') return null
    try {
      const nowMs = Date.now()
      const changed = this.likedForSong !== id
      const due = nowMs - this.likedCheckedAt >= this._likeSyncMs()
      const retryOk = !this.likedFailAt || nowMs - this.likedFailAt >= 15000
      if (changed || (due && retryOk)) {
        const res = await this.likeWeb.isLiked(id, { force: true })
        this.likedForSong = id
        this.likedCheckedAt = nowMs
        if (res && res.ok) {
          this.likedFailAt = 0
          return !!res.liked
        }
        this.likedFailAt = nowMs
        return null
      }
      const cached = this.likeWeb.cache?.get(id)
      return cached ? !!cached.liked : null
    } catch {
      return null
    }
  }

  /** 把 liked 字段挂到 state 的 now 上（前端红心只读这个字段）。 */
  async _attachLiked(now, songId) {
    if (!now) return now
    now.liked = await this._likedFor(songId)
    return now
  }

  /**
   * SMTC 场景没有 songId 时，按 title+artist 在页面内同源搜一首最像的。
   * 60 分钟缓存；搜不到返回 ''（上层 liked 显示 null、like 动作返回 like-no-song）。
   */
  async _songIdBySearch(title, artist) {
    const t = String(title || '').trim()
    if (!t) return ''
    const key = `${t}|${String(artist || '').trim()}`
    const hit = this.songSearchCache.get(key)
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.id
    const q = String(artist || '').trim() ? `${t} ${String(artist).trim()}` : t
    const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    const want = norm(t)
    const pick = (songs) => {
      if (!Array.isArray(songs) || !songs.length) return ''
      const match = songs.find((s) => norm(s.name) === want) || songs[0]
      return match && match.id ? String(match.id) : ''
    }
    const save = (id) => { this.songSearchCache.set(key, { id, at: Date.now() }); return id }
    // 1) CDP 页面内同源 fetch（ego 浏览器开着、music 页在时最稳，带页面登录态）
    try {
      const raw = await this._eval(`(async () => {
        try {
          const r = await fetch('/api/search/get?s=' + encodeURIComponent(${JSON.stringify(q)}) + '&type=1&limit=8', { credentials: 'include' })
          const j = await r.json()
          return JSON.stringify((j.result && j.result.songs) || [])
        } catch (e) { return '[]' }
      })()`)
      const id = pick(raw ? JSON.parse(raw) : [])
      if (id) return save(id)
    } catch { /* 浏览器/CDP 没开 → 走 Node 侧兜底 */ }
    // 2) Node 侧明文 fetch：ego 浏览器关了、CDP 断了也能搜。SMTC 场景红心与
    //    「喜欢」都依赖这个 songId，不能因为 agent 浏览器没开就失效。
    try {
      const cfg = this._cfg()
      const cookie = await this._cookieForApi()
      const url = `${MUSIC_ORIGIN}/api/search/get?s=${encodeURIComponent(q)}&type=1&limit=8`
      const res = await fetch(url, {
        headers: { Referer: MUSIC_ORIGIN + '/', 'User-Agent': UA, Cookie: cookie },
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      })
      const j = JSON.parse(await res.text())
      const id = pick((j?.result && j.result.songs) || [])
      if (id) return save(id)
    } catch { /* fallthrough */ }
    return ''
  }

  /** 视频站标题兜底：即便 probe 因会话顺序漏判，Node 层也拒接视频页。 */
  _isVideoTitle(title) {
    const t = String(title || '').toLowerCase()
    return ['bilibili', 'youtube', 'youtu.be', 'acfun', 'nicovideo'].some((m) => t.includes(m))
  }

  /** 把 SMTC 会话包装成与原生一致的 state 返回形状。 */
  _smtcResult(sm) {
    const status = /playing/i.test(String(sm.status || '')) ? 'Playing' : 'Paused'
    const now = {
      aumid: sm.aumid || 'msedge.exe',
      title: sm.title || '',
      artist: sm.artist || '',
      album: sm.album || '',
      songId: '',
      status,
      pos: Number(sm.pos) || 0,
      end: Number(sm.end) || 0,
      start: 0,
      positionSource: 'smtc-web',
      canPlay: sm.canPlay !== false,
      canPause: sm.canPause !== false,
      canNext: sm.canNext !== false,
      canPrev: sm.canPrev !== false,
      canSeek: sm.canSeek !== false,
      channel: 'web',
      mode: this.mode,
    }
    return {
      ok: true,
      now,
      volume: { level: this.volumeLevel, muted: this.muted, scope: 'process' },
      systemVolume: null,
      sessions: [],
      winrt: true,
      helper: {
        healthy: true, ready: true, backend: 'smtc-browser', platform: 'web',
        capabilities: this.capabilities, degraded: '',
      },
      serverTime: Date.now(),
    }
  }

  /**
   * 日推引擎（WinRT MediaPlayer）在播时，状态直接从引擎读——它不进 SMTC、也不在
   * 网页 DOM 里，CDP/SMTC 两条路都读不到它。返回的 now 形状与原生一致。
   */
  _winrtResult(st) {
    const song = this.winrtSong || {}
    const songId = String(st.songId || song.id || '')
    const status = (st.status === 'Playing' || st.status === 'Opening') ? 'Playing' : 'Paused'
    const now = {
      aumid: 'winrt',
      title: String(st.title || song.name || ''),
      artist: String(st.artist || song.artist || ''),
      album: '',
      songId,
      status,
      pos: Number(st.pos) || 0,
      end: Number(st.end) || 0,
      start: 0,
      positionSource: 'winrt',
      canPlay: true,
      canPause: true,
      canNext: this.queue.length > 0,
      canPrev: this.queue.length > 0,
      canSeek: true,
      channel: 'web',
      mode: this.mode,
    }
    return {
      ok: true,
      now,
      volume: { level: Number(st.volume) || this.volumeLevel, muted: !!st.muted, scope: 'process' },
      sessions: [],
      winrt: true,
      helper: {
        healthy: true, ready: true, backend: 'winrt-mediaplayer', platform: 'web',
        capabilities: this.capabilities, degraded: '',
      },
      serverTime: Date.now(),
    }
  }

  /** state：返回与原生后端一致的形状。 */
  async state() {
    // 日推引擎正在播时优先读它（零 CDP、零 SMTC spawn）。引擎在 SMTC 里看不见，
    // 若这时落回下面的 SMTC 分支会把「个人 Edge 里暂停的歌」当成当前曲，错。
    if (this.winrtPlaying && this.winrtAudio) {
      const st = await this.winrtAudio.state().catch(() => null)
      if (st && st.ok && st.active !== false) {
        const result = this._winrtResult(st)
        result.systemVolume = await this._readSystemVolume()
        await this._attachLiked(result.now, result.now.songId)
        return result
      }
    }
    const ready = await this.ensure()
    let s = null
    if (ready.ok) {
      try { s = await this._eval(READ_STATE_EXPR) } catch { s = null }
    }
    // ego-lite 网页是「去客户端播放」占位：getPlaying().track 只是残留态、页面无 <audio>。
    // 用户真正在放的歌在个人 Edge（无 CDP 端口）——只要 CDP 没有真实在播的 audio，
    // 就用 SMTC 系统媒体会话读标题/歌手/进度，这样才识别得到用户点的那首。
    const cdpReal = !!(s && s.hasAudio && s.status === 'Playing')
    if (!cdpReal && this._smtcEnabled()) {
      const sm = await this.smtc.readState().catch(() => null)
      if (sm && sm.ok && sm.title && !sm.artist && this._isVideoTitle(sm.title)) {
        // probe 已尽力排除视频标题；这里挡住任何穿透到 Node 层的视频会话（artist 空 + 站点标记）。
      } else if (sm && sm.ok && sm.title) {
        this.dataSource = 'smtc'
        this.smtcState = sm
        const result = this._smtcResult(sm)
        // SYS 读数与播放通道无关：从 native helper 读真实系统音量，让 SYS 能跟随系统
        result.systemVolume = await this._readSystemVolume()
        // 媒体会话不带 songId：按歌名+歌手搜一首（带缓存），这样红心能读/能点。
        const sid = await this._songIdBySearch(sm.title, sm.artist)
        if (sid) result.now.songId = sid
        await this._attachLiked(result.now, sid)
        return result
      }
    }
    this.dataSource = 'cdp'
    if (!ready.ok) return { ...ready, now: null, volume: null, systemVolume: null, sessions: [], serverTime: Date.now() }
    try {
      const audioIdForMeta = String(s?.audioSongId || '')
      const cur = audioIdForMeta
        ? (this.queue.find((q) => String(q?.id || q?.songId || '') === audioIdForMeta) || null)
        : (this.queue[this.queueIndex] || null)
      // 队列元数据（日推/播放列表带的歌名）比网页 DOM 标题更准——网页标题常是
      // "网易云音乐"，播放栏 DOM 也可能没渲染完。优先用它，DOM 兜底。
      const artistsText = Array.isArray(cur?.artists)
        ? cur.artists.map((a) => (typeof a === 'string' ? a : a.name)).join(' / ')
        : (cur?.artists || '')
      // 插件自己的 <audio> 正在放某首时，页面那首（用户手动点的）已经不是「当前曲」了，
      // 元数据必须以 audio 为准，否则会出现「在放 A、显示 B」的错位。
      const audioId = String(s?.audioSongId || '')
      const songId = String(audioId || cur?.id || s?.songId || '')
      // 队列空但页面在放歌 = 用户手动点的；记住它，play/pause/seek 才能接管。
      if (songId && songId !== 'undefined' && !cur) this.manualSongId = songId
      let title = (cur?.name || s?.title || '').trim()
      let artist = (artistsText || s?.artist || '').trim()
      let endMs = Number(s?.end) || 0
      // 用户手动放歌时 getPlaying().track 可能只是数字 songId，没带名字。
      // 用页面内同源 detail API 按 id 补元数据（带缓存），别再显示「网易云音乐」占位。
      if ((!title || title === '网易云音乐' || title === s?.pageTitle) && songId && songId !== 'undefined') {
        const meta = await this._songMeta(songId)
        if (meta) {
          title = title && title !== '网易云音乐' && title !== s?.pageTitle ? title : meta.name
          artist = artist || meta.artist
          if (!endMs && meta.durationMs) endMs = meta.durationMs
        }
      }
      const now = {
        aumid: 'web',
        title: title || (s?.pageTitle || '').trim(),
        artist,
        album: cur?.album || '',
        songId,
        status: s?.status === 'Playing' ? 'Playing' : 'Paused',
        // 与原生通道统一为「秒」：READ_STATE_EXPR 读的是 audio 毫秒，转成秒后上层 fmt() 才不会把毫秒当秒。
        pos: (Number(s?.pos) || 0) / 1000,
        end: endMs / 1000,
        start: 0,
        positionSource: 'web',
        canPlay: true,
        canPause: true,
        canNext: this.queue.length > 0,
        canPrev: this.queue.length > 0,
        // 有 audio 就能跳；手动点播的歌虽然暂时没 audio，但点一次 play 就能建起来
        canSeek: !!s?.hasAudio || (!!songId && songId !== 'undefined'),
        channel: 'web',
        mode: this.mode,
      }
      await this._attachLiked(now, songId || this.manualSongId)
      return {
        ok: true,
        now,
        volume: { level: this.volumeLevel, muted: this.muted, scope: 'process' },
        systemVolume: await this._readSystemVolume(),
        sessions: [],
        winrt: false,
        helper: {
          healthy: true,
          ready: true,
          backend: this.id,
          platform: 'web',
          capabilities: this.capabilities,
          degraded: this.lastError || '',
        },
        serverTime: Date.now(),
      }
    } catch (err) {
      const f = this._fail('web-cdp-error', String(err?.message || err))
      return { ...f, now: null, volume: null, systemVolume: null, sessions: [], serverTime: Date.now() }
    }
  }

  /** action：保持上层 action 形状不变。 */
  async action(action, extra = {}) {
    const allowed = ['play', 'pause', 'toggle', 'next', 'prev', 'seek', 'play_daily', 'set_mode', 'like']
    if (!allowed.includes(action)) return { ok: false, error: 'bad-action', detail: `unknown action: ${action}` }

    // set_mode 是纯本地状态（改队列怎么走 + now.mode 给前端切图标），不碰 CDP、
    // 不需要网页登录、也不依赖 SMTC。放在所有联网/连通性检查之前，个人 Edge
    // 放歌（SMTC 场景，通常没登录 ego CDP）时也能切。
    if (action === 'set_mode') {
      const value = String(extra.value || '').trim()
      const mapped = MODE_SHORT_TO_ENUM[value]
      if (!mapped) return { ok: false, error: 'bad-mode', detail: `unknown mode: ${value || '(empty)'}` }
      this.mode = mapped
      try { this.getConfig().webPlayMode = mapped } catch { /* volatile 配置可选 */ }
      const after = await this.state().catch(() => null)
      // 前端 run() 见 res.now!==undefined 会整体替换 now。若此刻读不到歌（SMTC 无会话、
      // CDP 页没开）state() 会返回 now:null，那会把前端状态清空、图标回退成默认「顺序」。
      // 所以 set_mode 无论读不读得到歌，都回一个带新 mode 的 now；其余字段尽量沿用。
      let outNow = after?.now
      if (!outNow) {
        // 尽量用上一次的 SMTC 快照重建，避免清空标题/进度
        try { outNow = this.smtcState ? this._smtcResult(this.smtcState).now : null } catch { outNow = null }
      }
      outNow = outNow
        ? { ...outNow, mode: this.mode }
        : { aumid: 'web', title: '', artist: '', songId: '', status: 'Paused', channel: 'web', mode: this.mode, positionSource: this.dataSource === 'smtc' ? 'smtc-web' : 'web' }
      return { ok: true, channel: 'web', action, value, mode: this.mode, now: outNow, volume: after?.volume || null }
    }

    // 日推：取数/取 URL/出声全走 Node 侧 + WinRT 后台引擎，零 CDP。必须放在 ensure() 之前，
    // 否则 ego 关着（browser.json 不存在）时下面的 ensure() 会直接返回 web-browser-unavailable，
    // 永远到不了 switch 里的 play_daily 分支——这正是「点日推报没有找到 ego 浏览器」的根因。
    if (action === 'play_daily') return await this._playDaily()

    // 日推引擎（WinRT）在播时点红心：收藏队列里当前这首，不碰 CDP/SMTC（ego 可能关着、
    // SMTC 里是个人 Edge 的旧歌）。_webLike 的 songId 优先级第一条就是 queue[queueIndex]。
    if (action === 'like' && this.winrtPlaying) {
      const r = await this._webLike(extra)
      if (r && r.ok === false) return r
      return { ok: true, channel: 'web', action, liked: r.liked, songId: r.songId, now: r.now || (await this.state()).now, volume: r.volume || null }
    }

    // 「喜欢」在 SMTC 场景（用户在个人 Edge 放歌、ego CDP 没开）必须走零 CDP 路径。
    // 不能复用下面那套依赖 probe.positionSource/dataSource 快照的分支：state() 会把
    // dataSource 改写成 cdp，快照一漂移 like 就掉进需要 ego 浏览器的 ensure() → 报
    // web-browser-unavailable / like-no-song。这里显式读一次 SMTC 拿歌名搜 songId。
    if (action === 'like' && this._smtcEnabled()) {
      const smtced = await this._smtcLike(extra)
      if (smtced) return smtced
    }

    // 日推引擎（WinRT）在播时，播放控制全走它——它不在 SMTC/CDP 里，别的通道管不到。
    if (this.winrtPlaying && this.winrtAudio && ['play', 'pause', 'toggle', 'next', 'prev', 'seek'].includes(action)) {
      let r
      if (action === 'next' || action === 'prev') {
        const to = this._advanceIndex(action === 'next' ? 1 : -1)
        if (to === null) {
          return { ok: true, channel: 'web', action, atEnd: action === 'next', atStart: action === 'prev', now: (await this.state()).now }
        }
        const played = await this._playWinrtIndex(to)
        if (!played.ok) return played
        r = played
      } else if (action === 'seek') {
        r = await this.winrtAudio.seek(Math.max(0, Math.round(Number(extra.positionMs) || 0)))
      } else if (action === 'play') {
        // 引擎里已有当前曲目 Source，续播用 resume；play(url) 是换歌用的，这里没 url。
        r = await this.winrtAudio.resume()
      } else {
        r = await this.winrtAudio[action]()
      }
      if (r && r.ok === false) return { ok: false, error: r.error || 'winrt-control-failed', message: '日推播放控制失败', detail: r.detail }
      const after = await this.state()
      return { ok: true, channel: 'web', action, now: after.now, volume: after.volume }
    }

    // 用户在个人 Edge 用网页版放歌（无 CDP 端口）时，状态来自 SMTC；这几种播放控制
    // 必须走同一个 SMTC 通道才生效。like/play_daily/set_mode 仍走原来的 CDP + API 逻辑。
    const SMTC_ACTIONS = ['play', 'pause', 'toggle', 'next', 'prev', 'seek']
    if (this._smtcEnabled() && (SMTC_ACTIONS.includes(action) || action === 'like')) {
      // 如果最近一次 state 已经确认数据源是 smtc，直接用那个快照判断，省掉一次
      // state() 里的 PowerShell spawn（前端刚轮询过，快照新鲜）。否则才重新 probe。
      let probe = null
      if (this.dataSource === 'smtc' && this.smtcState) {
        probe = { ok: true, now: this._smtcResult(this.smtcState).now }
      } else {
        probe = await this.state().catch(() => null)
      }
      if (probe && probe.ok && probe.now && probe.now.positionSource === 'smtc-web') {
        // 收藏不走 smtc.control（SMTC 没有"喜欢"语义），改用带浏览器 cookie 的 LikeService；
        // songId 由 state() 按歌名+歌手搜出来，纯 SMTC 场景也不依赖 ego CDP 的 ensure。
        if (action === 'like') {
          const r = await this._webLike(extra)
          if (r && r.ok === false) return r
          return { ok: true, channel: 'web', action, now: r.now || probe.now, volume: r.volume || probe.volume, liked: r.liked }
        }
        const r = await this.smtc.control(action, { positionMs: Number(extra.positionMs) || 0 }).catch(
          (err) => ({ ok: false, error: 'smtc-unavailable', detail: String(err?.message || err) }),
        )
        if (!r.ok) {
          return { ok: false, error: r.error || 'smtc-control-failed', message: '系统媒体控制失败', detail: r.detail }
        }
        // probe 的 control 已在同一个 PowerShell 进程里回读了状态，直接用它当 after，
        // 省掉再调一次 state()（那会 spawn 新 PowerShell，多花 ~280ms）。
        if (r.title) {
          this.dataSource = 'smtc'
          this.smtcState = r
          const after = this._smtcResult(r)
          after.systemVolume = await this._readSystemVolume()
          // songId 搜索有 60min 缓存、liked 有节流，都不 spawn PowerShell，补上让红心正确。
          const sid = await this._songIdBySearch(r.title, r.artist)
          if (sid) after.now.songId = sid
          await this._attachLiked(after.now, sid)
          return { ok: true, channel: 'web', action, now: after.now, volume: after.volume, systemVolume: after.systemVolume }
        }
        const after = await this.state()
        return { ok: true, channel: 'web', action, now: after.now, volume: after.volume }
      }
    }

    const ready = await this.ensure()
    if (!ready.ok) {
      // ego 关着（CDP 不可用）时的最后兜底：个人 Edge 放歌、SMTC 会话被视频顶掉，
      // 且插件刚重启（sticky 记忆空、state 读不到歌）时，控制流会落到这里的 CDP
      // ensure 失败。但下发 pause/next 到浏览器会话仍能作用于实际在响的媒体——
      // probe 对控制动作已放宽（视频标题也能定位会话）。直接尝试 SMTC 控制。
      if (this._smtcEnabled() && SMTC_ACTIONS.includes(action)) {
        const r = await this.smtc.control(action, { positionMs: Number(extra.positionMs) || 0 }).catch(
          (err) => ({ ok: false, error: 'smtc-unavailable', detail: String(err?.message || err) }),
        )
        if (r && r.ok) {
          this.dataSource = 'smtc'
          this.smtcState = r
          const after = this._smtcResult(r)
          after.systemVolume = await this._readSystemVolume()
          return { ok: true, channel: 'web', action, now: after.now, volume: after.volume, systemVolume: after.systemVolume }
        }
      }
      return ready
    }
    if (!(await this._isLoggedIn().catch(() => false))) return this._fail('web-not-logged-in', '')

    try {
      let r
      switch (action) {
        case 'play':
          if (this.queue.length && this.queueIndex >= 0) {
            r = await this._controlAudio('play')
            // 队列里有歌但 audio 还没建（插件重启过）→ 按队列重放这首
            if (r === false) r = await this._playQueueIndex(this.queueIndex)
          } else {
            r = await this._playManual()
          }
          break
        case 'pause':
          r = await this._pauseAny()
          break
        case 'toggle': {
          const s = await this._eval(READ_STATE_EXPR)
          if (s?.status === 'Playing') r = await this._pauseAny()
          else if (this.queue.length && this.queueIndex >= 0) {
            r = await this._controlAudio('play')
            if (r === false) r = await this._playQueueIndex(this.queueIndex)
          } else r = await this._playManual()
          break
        }
        case 'next': {
          const to = this._advanceIndex(1)
          if (to === null) return { ok: true, channel: 'web', action, atEnd: true, now: (await this.state()).now, volume: (this.volumeLevel !== undefined ? { level: this.volumeLevel, muted: this.muted, scope: 'process' } : null) }
          r = await this._playQueueIndex(to)
          break
        }
        case 'prev': {
          const to = this._advanceIndex(-1)
          if (to === null) return { ok: true, channel: 'web', action, atStart: true, now: (await this.state()).now, volume: { level: this.volumeLevel, muted: this.muted, scope: 'process' } }
          r = await this._playQueueIndex(to)
          break
        }
        case 'seek': {
          r = await this._controlAudio('seek', Math.max(0, Math.round(Number(extra.positionMs) || 0)))
          // 没有 <audio> 就没得跳：手动点的歌要先让插件接管（play 一次）才有时间轴
          if (r === false) return this._fail('web-no-audio-url', '这首还没被插件接管，先点一次播放再拖进度')
          break
        }
        case 'like':
          r = await this._webLike(extra)
          break
        case 'play_daily':
          return await this._playDaily()
        default:
          r = this._fail('web-action-failed', action)
      }
      if (r && r.ok === false) return r
      const after = await this.state()
      const out = { ok: true, channel: 'web', action, now: after.now, volume: after.volume }
      // like 的状态要透传给上层文案（index.js 读 res.liked 决定「已收藏/已取消」）
      if (r && typeof r.liked === 'boolean') out.liked = r.liked
      return out
    } catch (err) {
      return this._fail('web-action-failed', String(err?.message || err))
    }
  }

  /**
   * SMTC 场景的「喜欢」：全程零 CDP，不调 state()/ensure()。
   * 显式读一次 SMTC 会话拿歌名 → 搜 songId（CDP 有则快、没则 Node 兜底）→ LikeService 收藏。
   * SMTC 没有有效音乐会话（或读到视频）时返回 null，交回 action() 走原 CDP 路径。
   */
  async _smtcLike(extra) {
    const svc = this.likeWeb || this.like
    if (!svc) return null
    let sm = this.smtcState
    try {
      const fresh = await this.smtc.readState()
      if (fresh && fresh.ok && fresh.title) sm = fresh
    } catch { /* 用上一次快照 */ }
    const title = String(sm?.title || '')
    const artist = String(sm?.artist || '')
    if (!title || (!artist && this._isVideoTitle(title))) return null
    // songId 一律按当前歌名+歌手搜：songSearchCache 命中是纯内存（零网络零 spawn），
    // 且保证收藏的就是当前这首——别用 likedForSong，那可能是切歌前上一首的 id。
    let id = await this._songIdBySearch(title, artist)
    if (!id || id === '0' || id === 'undefined' || id === 'NaN') return null // 搜不到 → 交回原路径报错
    let want = extra?.like
    if (typeof want !== 'boolean') {
      const cur = await svc.isLiked(id)
      want = !(cur.ok ? cur.liked : false)
    }
    const res = await svc.setLiked(id, want)
    if (!res.ok) return { ok: false, channel: 'web', action: 'like', error: res.error || 'like-failed', message: res.message, detail: res.detail }
    svc.forget?.(id)
    this.likedForSong = id
    this.likedCheckedAt = Date.now()
    // 用 SMTC 快照构造 now（纯函数，零 spawn/fetch），直接回填刚设置的 liked，红心立即更新。
    const after = this._smtcResult(sm)
    after.now.songId = id
    after.now.liked = want
    after.systemVolume = await this._readSystemVolume()
    return { ok: true, channel: 'web', action: 'like', liked: want, songId: id, now: after.now, volume: after.volume, systemVolume: after.systemVolume }
  }

  async _webLike(extra) {
    const svc = this.likeWeb || this.like
    if (!svc) return { ok: false, error: 'like-unavailable', message: '网页版喜欢功能未接入' }
    // songId 来源优先级：插件队列 → 手动点播记住的 → 当前 state（SMTC 分支会按歌名搜出 id）
    let id = String((this.queue[this.queueIndex]?.id) || '')
    if (!id || id === 'undefined') id = String(this.manualSongId || '')
    let probe = null
    if (!id || id === 'undefined') {
      probe = await this.state().catch(() => null)
      id = String((probe?.now?.songId) || '')
    }
    if (!id || id === '0' || id === 'undefined' || id === 'NaN') {
      return { ok: false, error: 'like-no-song', message: '播放中才能喜欢' }
    }
    let want = extra?.like
    if (typeof want !== 'boolean') {
      const cur = await svc.isLiked(id)
      want = !(cur.ok ? cur.liked : false)
    }
    const res = await svc.setLiked(id, want)
    if (!res.ok) return { ok: false, error: res.error || 'like-failed', message: res.message, detail: res.detail }
    svc.forget?.(id)
    // 强制重读 liked：清掉节流状态后重新查一次，别用操作前的 probe（那样红心会停在旧值）。
    this.likedForSong = ''
    this.likedCheckedAt = 0
    const after = await this.state().catch(() => null)
    return { ok: true, liked: want, songId: id, now: after?.now || null, volume: after?.volume || null }
  }

  /**
   * 用 WinRT 常驻引擎播队列里的第 idx 首（取 URL → 交给引擎 → 出声）。
   * 全程不碰 CDP/ego/SMTC，个人 Edge 关着也能播。日推引擎在播时状态由引擎自己回报。
   */
  async _playWinrtIndex(idx) {
    if (!this.winrtAudio) return this._fail('web-no-audio-engine', '当前环境不支持后台音频引擎')
    const song = this.queue[idx]
    if (!song) return this._fail('web-no-song', '')
    const id = song.id || song.songId
    const got = await this._songUrl(id)
    if (!got.ok) return got
    this.queueIndex = idx
    this.winrtSong = { id, name: song.name, artist: song.artist }
    const artist = Array.isArray(song.artists)
      ? song.artists.map((a) => (typeof a === 'string' ? a : a.name)).join(' / ')
      : (song.artist || song.artists || '')
    const r = await this.winrtAudio.play({
      url: got.url,
      songId: String(id),
      title: song.name || '',
      artist,
      level: this.volumeLevel,
      muted: this.muted,
    })
    if (r && r.ok === false) {
      this.winrtPlaying = false
      return { ok: false, error: r.error || 'web-play-failed', message: '后台音频播放失败', detail: r.detail }
    }
    this.winrtPlaying = true
    return { ok: true, url: got.url, engine: r, song }
  }

  /**
   * 日推：复用 DailyService 的取数（cookie + 按天缓存），把结果灌进队列并从第一首播。
   * 出声走 WinRT 常驻后台引擎——不依赖 ego 浏览器 CDP、不弹任何页面、不进 SMTC。
   * 这样即使 ego 关着、个人 Edge 没开 CDP 端口，点日推也能立刻出声。
   */
  async _playDaily() {
    if (!this.daily) return this._fail('web-no-song', '日推服务未接入')
    try {
      const list = await this.daily.fetch({})
      if (!list.ok) return { ok: false, error: list.error, message: list.message, detail: list.detail }
      const songs = (list.songs || []).map((s) => ({
        id: s.id || s.songId,
        name: s.name,
        artists: s.artists || s.artistsName,
      })).filter((s) => s.id)
      if (!songs.length) return this._fail('web-no-song', '日推列表为空')
      this.queue = songs
      const played = await this._playWinrtIndex(0)
      if (!played.ok) return played
      const first = songs[0]
      const firstArtist = Array.isArray(first.artists)
        ? first.artists.map((a) => (typeof a === 'string' ? a : a.name)).join(' / ')
        : (first.artists || '')
      // 字段与原生通道 #playDaily 对齐（songCount/firstSong），上层 index.js 无需区分通道。
      return {
        ok: true,
        channel: 'web',
        action: 'play_daily',
        songCount: songs.length,
        firstSong: { id: first.id, name: first.name, artist: firstArtist },
        now: (await this.state()).now,
      }
    } catch (err) {
      return this._fail('web-action-failed', String(err?.message || err))
    }
  }

  /**
   * volume：系统音量走 native helper（Windows 端点，与播放通道无关、不依赖 CDP），
   * APP 音量走网页 <audio>。真正的声音来自个人 Edge 时 <audio> 不存在，那种情况下
   * APP 也落到系统音量，免得拖动没反应。
   */
  async volume({ level, muted, scope } = {}) {
    const wantScope = scope === 'system' ? 'system'
      : scope === 'process' ? 'process'
        : (String(this.getConfig().volumeScope || 'process'))
    // SYS：调系统端点。走 native helper，不需要 CDP，助手没连网页也能调。
    if (wantScope === 'system') {
      if (!this._hasSystemVolume()) {
        return { ok: false, error: 'volume-unsupported', detail: '当前环境不支持系统音量' }
      }
      try {
        const res = await this.systemVolumeService.volume({ level, muted, scope: 'system' })
        if (res && res.ok === false) return res
        return {
          ok: true,
          scope: 'system',
          volume: res?.volume || null,
          systemVolume: res?.systemVolume || res?.volume || null,
        }
      } catch (err) {
        return { ok: false, error: 'volume-failed', detail: String(err?.message || err) }
      }
    }
    // APP 音量：日推引擎在播时直接调 WinRT MediaPlayer 的音量，别去动网页 <audio>。
    if (typeof level === 'number' && level >= 0 && level <= 1) this.volumeLevel = level
    if (typeof muted === 'boolean') this.muted = muted
    if (this.winrtPlaying && this.winrtAudio) {
      const r = await this.winrtAudio.volume(this.volumeLevel, this.muted).catch(() => null)
      return {
        ok: true, scope: 'process',
        volume: { level: this.volumeLevel, muted: this.muted, scope: 'process' },
        systemVolume: await this._readSystemVolume(),
        engine: r?.ok === true,
      }
    }
    // SMTC 场景（个人 Edge 放歌）：真正出声在浏览器进程，没有插件自己的 <audio>。
    // APP 音量必须调浏览器的「进程音量」（Core Audio per-process session），绝不能
    // 回退到系统音量——否则用户拖 APP 音量会把 SYS 一起拖走（报过的 bug）。
    // 出声进程名取自 SMTC 会话的 aumid（msedge.exe → msedge）；helper 按 pid 精确
    // 命中有音频会话的那个进程，找不到就如实报失败、不回退。
    const smAumid = this.dataSource === 'smtc' ? String(this.smtcState?.aumid || '') : ''
    const smProc = smAumid.replace(/\.exe$/i, '').trim()
    if (smProc && this.systemVolumeService && this._hasSystemVolume()) {
      // 关键：只有当本次调用明确要改静音时才传 muted。native.volume() 只要收到
      // muted（非 undefined）就走 mute 命令，而 mute 命令不写 level——若拖滑杆时
      // 也带上 this.muted，level 根本不会生效，回读是旧值，前端滑杆就会「跳回」。
      const payload = {
        level: this.volumeLevel, scope: 'process',
        procName: smProc, noFallback: true,
      }
      if (typeof muted === 'boolean') payload.muted = muted
      const res = await this.systemVolumeService.volume(payload).catch(() => null)
      if (res && res.ok !== false) {
        // 回显用刚写入的目标值，不依赖助手回读（避免任何回读延迟让滑杆跳回）。
        return {
          ok: true, scope: 'process',
          volume: { level: this.volumeLevel, muted: this.muted, scope: 'process' },
          systemVolume: await this._readSystemVolume(),
          via: 'smtc-process',
        }
      }
      // 出声进程的音频会话不存在（用户已停播）→ 如实报错，绝不改系统音量
      return { ok: false, error: 'volume-no-session', message: '当前没有可单独调节的浏览器音频会话', detail: '' }
    }

    // APP：网页 <audio> 音量（非 SMTC 场景）。
    const ready = await this.ensure()
    if (!ready.ok && !this._hasSystemVolume()) return ready
    try {
      let appliedVia = 'audio'
      if (ready.ok) {
        const r = await this._eval(`(() => { const a=document.getElementById(${JSON.stringify(AUDIO_ID)}); if(!a) return false; a.volume=${this.volumeLevel};a.muted=${this.muted?'true':'false'}; return true })()`)
        appliedVia = r ? 'audio' : 'system'
      } else {
        appliedVia = 'system'
      }
      if (appliedVia === 'system' && this._hasSystemVolume()) {
        const res = await this.systemVolumeService.volume({ level, muted, scope: 'system' })
        const sys = res?.systemVolume || res?.volume || null
        return { ok: true, scope: 'process', volume: sys || { level: this.volumeLevel, muted: this.muted, scope: 'process' }, systemVolume: sys }
      }
      return { ok: true, scope: 'process', volume: { level: this.volumeLevel, muted: this.muted, scope: 'process' }, systemVolume: await this._readSystemVolume() }
    } catch (err) {
      return this._fail('web-action-failed', String(err?.message || err))
    }
  }

  /** 歌词：复用 LyricsService（Host 侧另一个实例），网页版只是把调用转给它。 */
  async lyrics(params) {
    if (!this.lyricsResolver) return { ok: false, error: 'lyrics-unavailable', message: '歌词服务未接入' }
    try { return await this.lyricsResolver(params) } catch (err) {
      return { ok: false, error: 'lyrics-failed', detail: String(err?.message || err) }
    }
  }

  async deepHealth() {
    const ready = await this.ensure()
    const smtcState = this._smtcEnabled() ? await this.smtc.readState().catch(() => null) : null
    const smtc = {
      enabled: this._smtcEnabled(),
      available: !!(smtcState && smtcState.ok),
      title: smtcState?.title || '',
      artist: smtcState?.artist || '',
      error: smtcState?.error || '',
    }
    if (!ready.ok) {
      // CDP 没连上但 SMTC 能读到个人浏览器在放的歌，也算网页通道可用
      if (smtc.available) {
        return {
          ok: true, backend: this.id, platform: 'web', capabilities: this.capabilities,
          helper: { healthy: true, backend: 'smtc-browser', degraded: '' },
          loggedIn: true, dataSource: 'smtc', smtc, lastError: '',
        }
      }
      return { ok: false, backend: this.id, platform: 'web', ...ready, smtc }
    }
    const loggedIn = await this._isLoggedIn().catch(() => false)
    return {
      ok: loggedIn || smtc.available,
      backend: this.id,
      platform: 'web',
      capabilities: this.capabilities,
      helper: { healthy: loggedIn || smtc.available, backend: this.id, degraded: (loggedIn || smtc.available) ? '' : 'web-not-logged-in' },
      loggedIn,
      injectedCookies: this.injectedCookies,
      queueSize: this.queue.length,
      manualSongId: this.manualSongId || '',
      dataSource: this.dataSource,
      smtc,
      lastError: this.lastError,
    }
  }

  async stop() {
    try { this.cdp?.close() } catch { /* ignore */ }
    this.cdp = null
    this.sessionId = null
    try { await this.winrtAudio?.close() } catch { /* ignore */ }
    this.winrtPlaying = false
    this.winrtSong = null
  }
}

export default WebBackend
