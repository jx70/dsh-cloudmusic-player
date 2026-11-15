/**
 * lib/daily.mjs —— 每日推荐（日推）取数
 * ============================================================================
 * 为什么由插件自己取，而不是让客户端取：客户端 3.1.43 的 webcmd 命令表里
 * **没有**「播放日推」这一条（`onWebMessage` 只认 play/download 的
 * song|program|album|playlist|audio）。真正能触发日推 playAll 的只有 native
 * 推给渲染层的 `systemUIHint`（daysong_notify / btn_2），外部伪造不了 ——
 * 实测 `{cmd:"daysong_notify",action:"btn_2"}` 与 `orpheus://nm/play/dailySong`
 * 都没有任何反应。
 *
 * 所以路线是：插件拿列表（借客户端已登录的 cookie）→ 逐条喂给客户端。
 *
 * 一个必须记住的接口行为（实测）：**未登录时接口不报 401**，而是 HTTP 200 +
 * `{"code":200,"recommend":[]}`。所以「需要登录」只能靠空数组判定。
 * ============================================================================
 */
import { loadCookieHeader } from './cookies.mjs'

/** 和客户端自己用的 UA 对齐；换掉容易被判定成非官方客户端 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.43.205627'

const HTTP_TIMEOUT_MS = 8000

/** 默认接口基址，和 lyricsApiBase 一个风格，可被配置覆盖 */
export const DEFAULT_API_BASE = 'https://music.163.com/api'

/** 日推最多取多少首；接口默认给 30~50，取 50 够用了 */
const DEFAULT_LIMIT = 50

/**
 * 带超时的 fetch。cookie 缺失时不带 cookie 头（好让接口照常返回空数组，
 * 由上层判定成「需要登录」而不是抛错）。
 */
async function fetchJson(url, { cookie = '', timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers = {
      'user-agent': UA,
      accept: 'application/json,text/plain,*/*',
      referer: 'https://music.163.com/',
    }
    if (cookie) headers.cookie = cookie
    const res = await fetch(url, { signal: ctrl.signal, headers })
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const text = await res.text()
    if (!text || text.trim() === '') throw new Error('empty body')
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

/** 艺人字段有 `ar`（新）和 `artists`（旧）两套，都兜住 */
function artistOf(song) {
  const list = song?.ar || song?.artists || []
  if (!Array.isArray(list)) return ''
  return list
    .map((a) => String(a?.name ?? ''))
    .filter(Boolean)
    .join('/')
}

/**
 * 把接口响应归一化成 `{ id, name, artist, fee }`。
 * 同时兼容 `/api/v1/...`（`recommend[]`）与 `/api/v3/...`（`data.dailySongs[]`）
 * 两种形状 —— 换个 endpoint 不用改上层。
 * @param {any} body
 * @returns {Array<{id:string,name:string,artist:string,fee:number}>}
 */
export function normalizeSongs(body) {
  const list =
    (Array.isArray(body?.recommend) && body.recommend) ||
    (Array.isArray(body?.data?.dailySongs) && body.data.dailySongs) ||
    (Array.isArray(body?.data?.recommend) && body.data.recommend) ||
    (Array.isArray(body?.songs) && body.songs) ||
    []
  const out = []
  for (const song of list) {
    const id = String(song?.id ?? '')
    // 网易云的无效 id 是 0 / 空 / null，这些项喂给客户端只会让它拉空详情
    if (!id || id === '0' || id === 'NaN') continue
    out.push({
      id,
      name: String(song?.name ?? ''),
      artist: artistOf(song),
      fee: Number(song?.fee ?? 0) || 0,
    })
  }
  return out
}

/** `yyyy-mm-dd`（本地时区）—— 日推按天变，用本地日切缓存 */
function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * 日推服务。
 *
 * 依赖注入点（都是为了单测能跑起来，不用真去解 cookie / 打网络）：
 *   - `cookieLoader`：默认 loadCookieHeader
 *   - `fetchJson`：默认就是上面那个
 */
export class DailyService {
  /**
   * @param {{ getConfig?: () => any, log?: (msg:string)=>void,
   *           cookieLoader?: typeof loadCookieHeader,
   *           fetchJson?: typeof fetchJson, now?: () => number }} [deps]
   */
  constructor(deps = {}) {
    this.getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({})
    this.log = typeof deps.log === 'function' ? deps.log : () => {}
    this.cookieLoader = deps.cookieLoader || loadCookieHeader
    this.fetchJson = deps.fetchJson || fetchJson
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now()
    /** @type {{day:string, uid:string, songs:any[]}|null} */
    this.cache = null
    /** 连点合并：同一天同一个人只要一份数据 */
    this.inflight = null
  }

  invalidate() {
    this.cache = null
  }

  /** 读配置里的基址/上限/profile，缺省走默认 */
  #opts() {
    const cfg = this.getConfig() || {}
    return {
      apiBase: String(cfg.dailyApiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),
      limit: Number(cfg.dailyLimit) > 0 ? Math.min(200, Math.trunc(Number(cfg.dailyLimit))) : DEFAULT_LIMIT,
      profileDir: String(cfg.dailyProfileDir || ''),
      timeoutMs: Number(cfg.requestTimeoutMs) > 0 ? Number(cfg.requestTimeoutMs) + 4000 : HTTP_TIMEOUT_MS,
    }
  }

  /**
   * 取日推列表。返回结构固定，上层只认 `ok` / `error` / `message`，
   * 与 PlayerService 其它返回值保持同一种风格。
   *
   * @param {{ limit?: number, force?: boolean }} [opts]
   * @returns {Promise<{ok:true, songs:any[], day:string, cached:boolean}
   *                 | {ok:false, error:string, message:string, detail?:string}>}
   */
  async fetch(opts = {}) {
    const cfg = this.#opts()
    const limit = Number(opts.limit) > 0 ? Math.trunc(Number(opts.limit)) : cfg.limit
    const day = dayKey(this.now())

    if (!opts.force && this.cache && this.cache.day === day && this.cache.songs.length > 0) {
      return { ok: true, songs: this.cache.songs.slice(0, limit), day, cached: true }
    }
    if (this.inflight) return await this.inflight

    this.inflight = this.#doFetch({ ...cfg, limit, day })
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }

  async #doFetch({ apiBase, limit, profileDir, timeoutMs, day }) {
    let cookie = ''
    try {
      const got = await this.cookieLoader({ profileDir, timeoutMs, log: this.log })
      if (got?.ok && got.cookie) cookie = got.cookie
      else if (got?.error === 'cookie-unsupported') {
        return {
          ok: false,
          error: 'daily-no-cookie',
          message: '读不到客户端的登录凭证，请在网易云客户端里登录后再试',
          detail: got.detail || '',
        }
      }
      /* cookie-missing 不算致命：接口会返回空数组，由下面统一判成「需要登录」 */
    } catch (err) {
      this.log(`daily: cookie loader failed: ${String(err?.message || err)}`)
    }

    const url = `${apiBase}/v1/discovery/recommend/songs?limit=${limit}`
    let body
    try {
      body = await this.fetchJson(url, { cookie, timeoutMs })
    } catch (err) {
      const status = Number(err?.status || 0)
      const detail = String(err?.message || err)
      if (status === 401 || status === 403) {
        return { ok: false, error: 'daily-needs-login', message: '请先在网易云客户端登录后再试', detail }
      }
      return {
        ok: false,
        error: 'daily-network',
        message: '拉每日推荐失败，检查网络后重试',
        detail,
      }
    }

    const songs = normalizeSongs(body)
    if (songs.length === 0) {
      // 接口未登录时就是 200 + 空数组，这里必须当成「要登录」，不能当成「今天没有」
      return {
        ok: false,
        error: 'daily-needs-login',
        message: '请先在网易云客户端登录后再试',
        detail: cookie ? 'empty recommend list' : 'no cookie',
      }
    }

    this.cache = { day, uid: '', songs }
    return { ok: true, songs: songs.slice(0, limit), day, cached: false }
  }
}
