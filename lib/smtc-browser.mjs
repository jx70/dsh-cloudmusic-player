/**
 * smtc-browser.mjs — 通过 Windows SMTC 读取/控制「浏览器（Edge/Chrome）正在放的网页音乐」。
 *
 * 为什么需要它：网易云网页版在 ego-lite 浏览器里是「打开客户端播放」模式，
 * 页面无 <audio>、getPlaying().track 只是残留态；而用户实际放歌的那个浏览器
 * （DSH Web GUI 所在的个人 Edge）没有 CDP 调试端口，插件的 CDP 通道读不到它。
 * 系统媒体会话（SMTC）是唯一能同时读到「歌名/歌手/进度」并下发播放控制的公共通道。
 *
 * 底层是同目录的 smtc-probe.ps1（PowerShell 5.1 + WinRT）。本模块只负责：
 *   - 用绝对路径 spawn powershell.exe（宿主 PATH 里没有裸名，会 ENOENT）；
 *   - 解析 stdout 首个 JSON 行；
 *   - 任何失败都返回 {ok:false,error,detail}，绝不抛未捕获异常。
 */

import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE_SCRIPT = resolve(HERE, 'smtc-probe.ps1')
const PS_EXE = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const DEFAULT_TIMEOUT_MS = 6000
// readState 每次都要冷启一个 PowerShell（实测 ~280ms），但前端每 2 秒才轮询一次、
// 一个播放 action 内部还会连调 2~3 次 state()。加个短 TTL 缓存 + 并发合并：
// 同一瞬间多次读共享一次 probe；轮询后 1.5s 内的点击直接命中缓存，不用等 PowerShell。
// 前端 /state 轮询间隔是 2000ms，TTL 要略大于它，正常轮询才能命中缓存；
// 用户主动操作走 control() 会立即失效+回填，不受影响。
const DEFAULT_STATE_CACHE_TTL_MS = 2500
// 视频站点标记：即便 probe（score 判据）漏判，Node 层也挡一道，别把视频当音乐。
const VIDEO_TITLE_MARKERS = ['bilibili', 'youtube', 'youtu.be', 'acfun', 'nicovideo', 'gimy', '劇迷', '剧迷']

function isVideoTitle(title) {
  const t = String(title || '').toLowerCase()
  return VIDEO_TITLE_MARKERS.some((m) => t.includes(m))
}

/** 默认浏览器 AUMID 白名单（正则）。与 smtc-probe.ps1 默认值保持一致。 */
export const DEFAULT_BROWSER_AUMID = 'msedge\\.exe|chrome\\.exe|firefox\\.exe|MSWebView2|msedgewebview2'

export class SmtcBrowser {
  /**
   * @param {{ getConfig?:()=>any, log?:(msg:string)=>void,
   *          spawnFactory?:Function, timeoutMs?:number }} deps
   */
  constructor(deps = {}) {
    this.getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({})
    this.log = typeof deps.log === 'function' ? deps.log : () => {}
    this._spawn = typeof deps.spawnFactory === 'function' ? deps.spawnFactory : spawn
    this.timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = Number(deps.cacheTtlMs) > 0 ? Number(deps.cacheTtlMs) : DEFAULT_STATE_CACHE_TTL_MS
    this.id = 'smtc-browser'
    this._stateCache = null
    this._stateCacheAt = 0
    this._stateInflight = null
    // 进度锚点：Windows SMTC 的 Position 上报常常卡住/滞后（个人 Edge 上实测卡在
    // 同一秒不动）。记一次播放起点，之后纯靠时钟推进，probe 回读的旧值不得让它回退。
    this._posAnchor = null
    // 视频抢占兜底：个人 Edge（Chromium）只上报一个 SMTC 会话。用户在网易云放歌后
    // 又去 B 站放视频，视频会话会把歌顶掉，probe 于是返回 no-browser-music-session。
    // 记住最近一次真实音乐（有歌手），这段时间内用它（标记 paused）兜底，
    // 别让插件「识别不到歌」；用户切回音乐页后 probe 自然恢复。
    this._lastMusic = null
    this._lastMusicAt = 0
    this.stickyGraceMs = Number(deps.stickyGraceMs) > 0 ? Number(deps.stickyGraceMs) : 15 * 60 * 1000
  }

  /** 视频抢占 SMTC 时的兜底：最近一次真实音乐，以暂停态返回（超时则返回 null）。 */
  _stickyMusic() {
    if (!this._lastMusic) return null
    if (Date.now() - this._lastMusicAt > this.stickyGraceMs) return null
    // 保留记住那一刻的真实播放态，不要写死 Paused：网易云的 SMTC 会话被 B 站视频
    // 顶掉后读不到，但歌其实还在放。写死 Paused 会导致「暂停 B 站视频」时歌明明在放、
    // 悬浮窗却显示暂停，像是被视频操作带着暂停了。用户真正去操作网易云时 probe 会
    // 重新读到它的会话、更新 _lastMusic，状态自然跟着真实情况走。
    return { ...this._lastMusic, sticky: true }
  }

  _cfg() {
    const c = this.getConfig() || {}
    return {
      smtcEnabled: c.smtcEnabled !== false,
      smtcBrowserAumid: String(c.smtcBrowserAumid || DEFAULT_BROWSER_AUMID),
      requestTimeoutMs: Number(c.requestTimeoutMs) > 0 ? Number(c.requestTimeoutMs) : this.timeoutMs,
    }
  }

  /** 跑一次 probe，返回解析后的 JSON；失败返回 {ok:false,error,detail}。 */
  _run(action, extra = {}) {
    const cfg = this._cfg()
    if (!cfg.smtcEnabled) return Promise.resolve({ ok: false, error: 'smtc-disabled', detail: 'smtcEnabled=false' })
    return new Promise((resolveP) => {
      let child
      const args = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROBE_SCRIPT,
        '-Action', action,
        '-AumidPattern', cfg.smtcBrowserAumid,
      ]
      if (action === 'seek') args.push('-SeekMs', String(Math.max(0, Math.round(Number(extra.positionMs) || 0))))
      try {
        child = this._spawn(PS_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolveP({ ok: false, error: 'smtc-unavailable', detail: `spawn failed: ${String(err?.message || err)}` })
        return
      }
      let stdout = ''
      let stderr = ''
      let done = false
      const finish = (result) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolveP(result)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        finish({ ok: false, error: 'smtc-unavailable', detail: 'probe timeout' })
      }, cfg.requestTimeoutMs)

      child.stdout?.on('data', (b) => { stdout += b.toString('utf8') })
      child.stderr?.on('data', (b) => { stderr += b.toString('utf8') })
      child.on('error', (err) => finish({ ok: false, error: 'smtc-unavailable', detail: String(err?.message || err) }))
      child.on('close', () => {
        // probe 永远输出一行 JSON；取第一行能解析的
        const lines = String(stdout).split(/\r?\n/)
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('{')) continue
          try {
            const obj = JSON.parse(t)
            finish(obj)
            return
          } catch { /* 不是 JSON，继续找下一行 */ }
        }
        finish({ ok: false, error: 'smtc-unavailable', detail: String(stderr).trim().slice(0, 300) || 'no json from probe' })
      })
    })
  }

  /** 由锚点按墙上时钟推算当前进度（秒）；无锚点返回 null。不超 end。 */
  _posFromAnchor(nowMs) {
    const a = this._posAnchor
    if (!a) return null
    const adv = Number(a.pos || 0) + (nowMs - a.at) / 1000
    const cap = Number(a.end) > 0 ? Number(a.end) : Infinity
    return Math.min(Math.max(0, adv), cap)
  }

  /** 建/重置进度锚点：从 pos 出发靠时钟推进。title 用于识别换歌。 */
  _setAnchor(pos, end, atMs, title = '') {
    this._posAnchor = { pos: Math.max(0, Number(pos) || 0), end: Number(end) || 0, at: atMs, title: String(title || '') }
  }

  /** 探针原始 pos 与锚点推进值取较大者，杜绝 SMTC 卡住时进度回退横跳。 */
  _monotonicPos(rawPos, end, nowMs) {
    const raw = Math.max(0, Number(rawPos) || 0)
    const anchored = this._posFromAnchor(nowMs)
    return anchored == null ? raw : Math.max(raw, anchored)
  }

  /**
   * 读浏览器音乐会话状态。返回 {ok,title,artist,album,status,pos,end,aumid,...}（pos/end 秒）。
   * TTL 缓存成功结果 + 并发合并，避免前端轮询和单个 action 内多次读反复冷启 PowerShell。
   * 命中缓存且正在播放时按锚点/经过时间推进 pos（不超 end），进度条才不会卡住或回退。
   */
  async readState() {
    const now = Date.now()
    if (this._stateCache && now - this._stateCacheAt < this.cacheTtlMs) {
      const hit = this._stateCache
      if (/playing/i.test(String(hit.status || ''))) {
        const advanced = this._posFromAnchor(now)
        const pos = advanced == null
          ? Math.min(Number(hit.pos || 0) + (now - this._stateCacheAt) / 1000, Number(hit.end) > 0 ? Number(hit.end) : Infinity)
          : advanced
        return { ...hit, pos }
      }
      return { ...hit }
    }
    if (this._stateInflight) return this._stateInflight
    this._stateInflight = (async () => {
      try {
        let r = await this._run('state')
        // Node 层兜底挡视频/网页媒体：音乐会话一定有歌手，artist 空就不是音乐。
        // 之前只靠站点标记（bilibili/youtube/gimy...）判视频，漏掉了「笨蛋教学…
        // 压枪的第一性原理」这类无站点后缀、artist 也空的 B 站视频——它被当成歌显示。
        // 判据改为：没有歌手（artist 空）即非音乐，走 sticky 兜底（有记住的歌就显示歌，
        // 没有则如实报无音乐会话），绝不把视频/网页媒体当歌。
        if (r && r.ok && r.title && !String(r.artist || '').trim()) {
          // 例外：网易云「暂停」时 SMTC 会把 artist 清空，但 title 还是刚才那首歌。
          // 若歌名与 sticky 记住的一致，用记忆里的歌手补回，照常识别，别当视频挡掉。
          const last = this._stickyMusic()
          const sameSong = last && String(last.title || '').trim().toLowerCase() === String(r.title).trim().toLowerCase()
          if (sameSong) {
            r = { ...r, artist: last.artist || '', album: last.album || last.albumTitle || '' }
          } else {
            r = { ok: false, error: 'video-session', detail: isVideoTitle(r.title) ? 'video title' : 'no artist' }
          }
        }
        if (r && r.ok && r.title && String(r.artist || '').trim()) {
          // 只把「有歌手」的真实音乐记为最近一次——视频标题（无歌手）不会污染兜底。
          this._lastMusic = { ...r }
          this._lastMusicAt = Date.now()
        }
        if (r && r.ok) {
          // 新 probe 的 pos 可能卡在旧值：与锚点推进取较大者，避免进度横跳回退。
          // 但若换了歌（用户在浏览器手动切），旧锚点不能套到新歌上——重建锚点。
          const playing = /playing/i.test(String(r.status || ''))
          const anchor = this._posAnchor
          const titleChanged = anchor && anchor.title && r.title && anchor.title !== r.title
          if (playing && (!anchor || titleChanged)) {
            // 第一次读到播放态 / 换歌：以探针 pos 为起点建锚点。之后靠时钟推进。
            this._setAnchor(r.pos, r.end, Date.now(), r.title)
          } else if (playing) {
            const advanced = this._posFromAnchor(Date.now())
            if (advanced != null) r.pos = this._monotonicPos(r.pos, r.end, Date.now())
          }
          this._stateCache = r
          this._stateCacheAt = Date.now()
        } else if (!r || !r.ok) {
          // 视频抢占 / 无音乐会话：用最近一次真实音乐（暂停态）兜底，避免插件「识别不到歌」。
          const sticky = this._stickyMusic()
          if (sticky) {
            this._stateCache = sticky
            this._stateCacheAt = Date.now()
            return sticky
          }
        }
        return r
      } catch (err) {
        return { ok: false, error: 'smtc-unavailable', detail: String(err?.message || err) }
      } finally {
        this._stateInflight = null
      }
    })()
    return this._stateInflight
  }

  /** 下发控制：play/pause/toggle/next/prev/seek。seek 用 positionMs 毫秒。 */
  async control(action, extra = {}) {
    const allowed = ['play', 'pause', 'toggle', 'next', 'prev', 'seek']
    if (!allowed.includes(action)) return { ok: false, error: 'smtc-bad-action', detail: `unknown action: ${action}` }

    // 操作前的播放态（用于推断目标状态 + toggle 取反）。
    const before = this._stateCache && (Date.now() - this._stateCacheAt) < Math.max(this.cacheTtlMs, 10000)
      ? this._stateCache : null
    const wasPlaying = /playing/i.test(String(before?.status || ''))

    // 关键：control 回读的 status 常常滞后一次采样（刚点 play 仍报 Paused）。
    // 直接用它回填缓存会让前端 playing=false、200ms 高亮节拍不起。这里按动作语义
    // 推断目标状态，覆盖滞后的回读值。
    let targetStatus = null
    if (action === 'play') targetStatus = 'Playing'
    else if (action === 'pause') targetStatus = 'Paused'
    else if (action === 'toggle') targetStatus = before ? (wasPlaying ? 'Paused' : 'Playing') : null
    else if (before) targetStatus = wasPlaying ? 'Playing' : 'Paused' // next/prev/seek 保持播放/暂停态

    // 控制会改变播放态，旧缓存立即失效；成功后回填「推断后」的状态。
    this._stateCache = null
    this._stateCacheAt = 0
    try {
      const r = await this._run(action, extra)
      if (r && r.ok && r.title) {
        const now = Date.now()
        // 控制作业在视频会话上回读时，title 是视频标题（B 站抢占后 SMTC 只剩它）。
        // 但命令实际作用于浏览器正在响的媒体（网易云的歌）。用 sticky 记住的歌
        // 元数据覆盖回读标题/歌手，保持显示网易云歌；status/pos/end 用回读的真实值
        // （targetStatus 下面还会按动作语义修正状态）。
        if (isVideoTitle(r.title) && !String(r.artist || '').trim()) {
          const sticky = this._stickyMusic()
          if (sticky) {
            r.title = sticky.title
            r.artist = sticky.artist
            if (sticky.album) r.album = sticky.album
          }
        }
        if (targetStatus) r.status = targetStatus
        if (/playing/i.test(String(r.status || ''))) {
          let startPos = Number(r.pos || 0)
          if (action === 'seek') startPos = Math.max(0, Number(extra.positionMs || 0) / 1000)
          else if (action === 'next' || action === 'prev') startPos = 0 // 切歌从头播，probe 回读可能是上一首的旧进度
          else {
            const advanced = this._posFromAnchor(now)
            if (advanced != null) startPos = Math.max(startPos, advanced)
          }
          this._setAnchor(startPos, r.end, now, r.title)
          r.pos = startPos
        } else {
          // 暂停：pos 取旧锚点推进值与探针值的较大者，避免进度回退；然后清锚点。
          const advanced = this._posFromAnchor(now)
          if (advanced != null && Number(r.pos || 0) < advanced) r.pos = advanced
          this._posAnchor = null
        }
        this._stateCache = r
        this._stateCacheAt = now
      }
      return r
    } catch (err) {
      return { ok: false, error: 'smtc-unavailable', detail: String(err?.message || err) }
    }
  }

  /** 让下一次 readState 强制 probe（外部状态可能已变时调用）。 */
  invalidate() {
    this._stateCache = null
    this._stateCacheAt = 0
    this._posAnchor = null
  }

  /** 可用性探测：能读到状态即算可用。 */
  async available() {
    const s = await this.readState()
    return { ok: s.ok === true, error: s.error, detail: s.detail }
  }
}

export default SmtcBrowser
