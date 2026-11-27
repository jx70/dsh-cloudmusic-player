/**
 * lib/like.mjs —— "我喜欢的音乐"（红心）
 * ============================================================================
 * 为什么不走 webcmd：客户端 3.1.43 的 onWebMessage 命令表没有 like，
 * 而且任何 orpheus:// 消息都会触发 showWindow 抢焦点（helper.ps1:1425-1428）。
 * 这里直接用 Node fetch 打网易云 Web API，凭证从客户端 CEF profile 读
 * （lib/cookies.mjs，纯本地文件读），全程不跟客户端进程通信、不弹窗。
 *
 * 跟日推（lib/daily.mjs）同源：同一份 cookie、同一个 API base 风格。
 * "喜欢"状态按 songId 缓存 60 秒，切歌按新 id 重新查，不串状态。
 * ============================================================================
 */
import { loadCookieHeader } from './cookies.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.43.205627'
const HTTP_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 60 * 1000

/** 默认接口基址，和 dailyApiBase / lyricsApiBase 一个风格 */
export const DEFAULT_API_BASE = 'https://music.163.com/api'

/**
 * 网易云用 code=301/401 同时表达两件事：「需要登录」和「下架歌曲无法收藏」。
 * 只按 code 判会把下架歌误报成 like-needs-login，前端再硬映射成「请先登录客户端」，
 * 网页版根本不需要客户端登录，文案完全错。这里按服务端文案分流：
 * 含下架/版权类关键词 → like-unavailable-song（新错误码，前端给专门文案）；
 * 其余才是真的需要登录 → like-needs-login。非 301/401 一律 like-failed。
 */
export function classifyLikeError(code, serverMsg = '') {
  const needLogin = Number(code) === 301 || Number(code) === 401
  if (!needLogin) return 'like-failed'
  const msg = String(serverMsg || '')
  if (/下架|下线|版权|无版权|无法收藏|已删除|不可用|unavailable|copyright/i.test(msg)) {
    return 'like-unavailable-song'
  }
  return 'like-needs-login'
}

/** 从 cookie 串里取 __csrf（网易云 form 接口要 csrf_token） */
export function csrfOf(cookie) {
  const m = /(?:^|;\s*)__csrf=([^;]+)/.exec(cookie || '')
  return m ? decodeURIComponent(m[1].trim()) : ''
}

/** form-urlencoded POST；测试可通过 deps.fetchJson 整体替换 */
async function postForm(url, fields, { cookie = '', timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers = {
      'user-agent': UA,
      accept: 'application/json,text/plain,*/*',
      referer: 'https://music.163.com/',
      'content-type': 'application/x-www-form-urlencoded',
    }
    if (cookie) headers.cookie = cookie
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers,
      body: new URLSearchParams(fields).toString(),
    })
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const text = await res.text()
    if (!text || !text.trim()) throw new Error('empty body')
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

function toBool(v) {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === '1' || v === 'true') return true
  if (v === 0 || v === '0' || v === 'false') return false
  return null
}

/**
 * 兼容几种返回形状：
 *   - /api/song/like/check（主用）：{ ids: [已喜欢的id...], code: 200 }
 *     —— 只返回已喜欢的 id；传入的 songId 不在 ids 里即为未喜欢（false）。
 *   - 旧 /api/song/like/get 及第三方实现可能返回：
 *     { songs: { "123": true, "456": false } } / { data: { "123": true } }
 *     { songs: [{ id: 123, liked: true }] } / { data: [{ id: 123, starred: true }] }
 * 返回 true/false；读不出来返回 null，交给上层报错。
 */
export function normalizeLiked(body, songId) {
  const id = String(songId)
  // check 语义：ids 是「已喜欢 id 列表」，命中 true，不命中 false（缺失即未喜欢）。
  if (Array.isArray(body?.ids)) {
    return body.ids.some((v) => String(v) === id)
  }
  const sources = [body?.songs, body?.data, body?.likedMap, body]
  for (const src of sources) {
    if (src == null) continue
    if (typeof src === 'boolean') return src
    if (Array.isArray(src)) {
      for (const item of src) {
        if (String(item?.id ?? item?.songId ?? '') === id) {
          const v = toBool(item?.liked ?? item?.starred ?? item?.fav ?? item?.value)
          if (v != null) return v
        }
      }
      continue
    }
    if (typeof src === 'object') {
      const v = toBool(src[id])
      if (v != null) return v
      // 单曲查询有时直接返回 { liked: true } / { starred: false }，不带 id 键
      if (src === body) {
        const top = toBool(src.liked ?? src.starred ?? src.fav ?? src.value)
        if (top != null) return top
      }
    }
  }
  return null
}

/** 喜欢服务。依赖注入点都是为了单测不用真解 cookie / 打网络。 */
export class LikeService {
  constructor(deps = {}) {
    this.getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({})
    this.log = typeof deps.log === 'function' ? deps.log : () => {}
    this.cookieLoader = deps.cookieLoader || loadCookieHeader
    this.fetchJson = deps.fetchJson || postForm
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now()
    /** @type {Map<string,{liked:boolean,at:number}>} */
    this.cache = new Map()
    /** @type {Map<string,Promise>} 同 id 的状态查询在途合并 */
    this.lookupInflight = new Map()
    /** @type {Map<string,Promise>} 同 id+目标的写入在途合并 */
    this.setInflight = new Map()
  }

  invalidate() {
    this.cache.clear()
  }

  forget(songId) {
    this.cache.delete(String(songId))
  }

  #opts() {
    const cfg = this.getConfig() || {}
    return {
      apiBase: String(cfg.likeApiBase || cfg.dailyApiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),
      profileDir: String(cfg.dailyProfileDir || ''),
      timeoutMs: Number(cfg.requestTimeoutMs) > 0 ? Number(cfg.requestTimeoutMs) + 4000 : HTTP_TIMEOUT_MS,
    }
  }

  /** 读 cookie；任何失败都归一化成 { error, message }，不抛 */
  async #cookie(opts) {
    let got
    try {
      got = await this.cookieLoader({ profileDir: opts.profileDir, timeoutMs: opts.timeoutMs, log: this.log })
    } catch (err) {
      return { error: 'like-no-cookie', message: '读不到登录凭证，请先在网易云登录后再试（客户端或网页版）', detail: String(err?.message || err) }
    }
    if (got?.ok && got.cookie) return { cookie: got.cookie }
    if (got?.error === 'cookie-unsupported') {
      return { error: 'like-unavailable', message: '这个功能只支持 Windows 上的网易云客户端', detail: got.detail || '' }
    }
    return { error: 'like-needs-login', message: '请先在网易云登录后再试（客户端或网页版）', detail: got?.detail || '' }
  }

  /**
   * 查当前歌曲是否已喜欢。
   * @param {string|number} songId
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<{ok:true,liked:boolean,cached:boolean}|{ok:false,error:string,message:string,detail?:string}>}
   */
  async isLiked(songId, opts = {}) {
    const id = String(songId || '')
    if (!id || id === '0') return { ok: false, error: 'like-no-song', message: '播放中才能喜欢' }
    const hit = this.cache.get(id)
    if (!opts.force && hit && this.now() - hit.at < CACHE_TTL_MS) {
      return { ok: true, liked: hit.liked, cached: true }
    }
    if (this.lookupInflight.has(id)) return await this.lookupInflight.get(id)
    const task = this.#doIsLiked(id)
    this.lookupInflight.set(id, task)
    try {
      return await task
    } finally {
      this.lookupInflight.delete(id)
    }
  }

  async #doIsLiked(id) {
    const opts = this.#opts()
    const c = await this.#cookie(opts)
    if (c.error) return { ok: false, error: c.error, message: c.message, detail: c.detail }
    let body
    try {
      // /song/like/get 会忽略 ids 返回全量列表，无法单曲判定；
      // /song/like/check 才是「传入 trackIds，只返回其中已喜欢的 id」。
      // id 保持字符串原样，避免大 id 经 Number 丢精度。
      body = await this.fetchJson(
        `${opts.apiBase}/song/like/check`,
        { trackIds: JSON.stringify([id]), csrf_token: csrfOf(c.cookie) },
        { cookie: c.cookie, timeoutMs: opts.timeoutMs },
      )
    } catch (err) {
      const status = Number(err?.status || 0)
      if (status === 401 || status === 403) {
        return { ok: false, error: 'like-needs-login', message: '请先在网易云登录后再试（客户端或网页版）', detail: String(err?.message || err) }
      }
      return { ok: false, error: 'like-network', message: '读取喜欢状态失败，检查网络后重试', detail: String(err?.message || err) }
    }
    if (body?.code != null && Number(body.code) !== 200) {
      // 服务端会带更准的业务文案（如「下架歌曲无法收藏」「需要登录」），优先透传，
      // 并按文案分流：下架/版权类不再误判成 like-needs-login（前端会硬映射成「请先登录客户端」）。
      const serverMsg = String(body.message || body.msg || '').trim()
      const error = classifyLikeError(body.code, serverMsg)
      return {
        ok: false,
        error,
        message: serverMsg || (error === 'like-needs-login' ? '请先在网易云登录后再试' : '读不到这首歌的喜欢状态'),
        detail: `code=${body.code}${serverMsg ? ' ' + serverMsg : ''}`,
      }
    }
    const liked = normalizeLiked(body, id)
    if (liked == null) return { ok: false, error: 'like-failed', message: '读不到这首歌的喜欢状态', detail: '' }
    this.cache.set(id, { liked, at: this.now() })
    return { ok: true, liked, cached: false }
  }

  /**
   * 设置喜欢状态（true=收藏到"我喜欢的音乐"，false=取消）。
   * 成功后写缓存；失败时不动缓存，下一次 state 轮询会纠正 UI。
   */
  async setLiked(songId, liked) {
    const id = String(songId || '')
    if (!id || id === '0') return { ok: false, error: 'like-no-song', message: '播放中才能喜欢' }
    const want = !!liked
    const key = `${id}:${want}`
    if (this.setInflight.has(key)) return await this.setInflight.get(key)

    const task = this.#doSetLiked(id, want)
    this.setInflight.set(key, task)
    try {
      return await task
    } finally {
      this.setInflight.delete(key)
    }
  }

  async #doSetLiked(id, want) {
    const opts = this.#opts()
    const c = await this.#cookie(opts)
    if (c.error) return { ok: false, error: c.error, message: c.message, detail: c.detail }
    let body
    try {
      // 明文 api 通道的参数名是 trackId（songid 会返回 code 400 请求参数错误）；
      // userid 可省略，like 用字符串 'true'/'false'。
      body = await this.fetchJson(
        `${opts.apiBase}/song/like`,
        { trackId: id, like: want ? 'true' : 'false', csrf_token: csrfOf(c.cookie) },
        { cookie: c.cookie, timeoutMs: opts.timeoutMs },
      )
    } catch (err) {
      const status = Number(err?.status || 0)
      if (status === 401 || status === 403) {
        return { ok: false, error: 'like-needs-login', message: '请先在网易云登录后再试（客户端或网页版）', detail: String(err?.message || err) }
      }
      return { ok: false, error: 'like-network', message: '操作失败，检查网络后重试', detail: String(err?.message || err) }
    }
    if (body?.code != null && Number(body.code) !== 200) {
      const serverMsg = String(body.message || body.msg || '').trim()
      const error = classifyLikeError(body.code, serverMsg)
      return {
        ok: false,
        error,
        message: serverMsg || (error === 'like-needs-login' ? '请先在网易云登录后再试' : '操作失败，请重试'),
        detail: `code=${body.code}${serverMsg ? ' ' + serverMsg : ''}`,
      }
    }
    this.cache.set(id, { liked: want, at: this.now() })
    return { ok: true, liked: want }
  }
}
