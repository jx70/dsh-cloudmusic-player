/**
 * channel.mjs — 播放通道选择器（k65）
 *
 * 在原有 native（客户端）通道之外，加一条 web（网页版）通道。对上层（index.js
 * 的 6 条路由 + cloudmusic_player 工具）暴露与 PlayerService 完全一致的形状，
 * 调用方无需知道当前是哪条通道在干活。
 *
 * 四种模式（Config.channelMode，默认 client-first）：
 *   client-only : 永远走 native，行为与 k65 之前完全一致；
 *   web-only    : 永远走 web；
 *   client-first: 客户端进程在 → native（不变）；不在 → web；
 *   web-first   : web 可用（浏览器通 + 已登录）→ web；否则 → native。
 *
 * 「客户端在线」的判据是进程是否存在，而不是 helper 是否 ready——helper 是
 * powershell，客户端没开它也能起来，只是没会话；按进程判才能避免「开着客户端
 * 没播歌」被误判成离线。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CLIENT_CHECK_MS = 3000
const PLAYING_CHECK_MS = 1500

/** 探测网易云客户端进程是否存在。非 Windows 视为无客户端。 */
export async function detectClientRunning(cfg = {}) {
  if (process.platform !== 'win32') return false
  const names = new Set(['cloudmusic', 'neteasecloudmusic', 'netease cloud music'])
  const pn = String(cfg.processName || '').toLowerCase().replace(/\.exe$/, '')
  if (pn) names.add(pn)
  try {
    // 用绝对路径：DSH 宿主进程的 PATH 未必含 System32，裸 'tasklist' 会 ENOENT
    // 落进 catch。独立脚本能跑只因 shell 补了 PATH——这正是「诊断脚本对、运行时错」的根源。
    const tasklist = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tasklist.exe`
    const { stdout } = await execFileAsync(tasklist, ['/FO', 'CSV', '/NH'], {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    const lower = stdout.toLowerCase()
    for (const n of names) {
      if (lower.includes(`${n}.exe`)) return true
    }
    return false
  } catch {
    // tasklist 在宿主运行时里可能因 cwd/PATH 差异失败（独立脚本却正常）。
    // 以前这里 return true（判客户端在线），会让 client-first 兜底误选 native，
    // 于是「网页版正在放歌」被显示成已暂停·无标题。现在 pick() 已有 channelPlaying
    // 前置判据——客户端真在播会优先选 native，所以探测失败时判「不在」更安全：
    // 网页在播能切过去，都没播则走 web 便于插件起播。
    return false
  }
}

export class ChannelRouter {
  /**
   * @param {{ native: any, web: import('./web-backend.mjs').WebBackend,
   *          getConfig: () => any, log?: (msg:string)=>void }} deps
   */
  constructor({ native, web, getConfig, log = () => {} }) {
    this.native = native
    this.web = web
    this.getConfig = getConfig
    this.log = log
    this.active = 'native'
    this._clientCache = { at: 0, value: null }
    this._webCache = { at: 0, value: null }
    this._playingCache = { native: { at: 0, value: false }, web: { at: 0, value: false } }
  }

  mode() { return this.getConfig().channelMode || 'client-first' }

  async clientOnline() {
    const now = Date.now()
    if (this._clientCache.value !== null && now - this._clientCache.at < CLIENT_CHECK_MS) {
      return this._clientCache.value
    }
    const value = await detectClientRunning(this.getConfig())
    this._clientCache = { at: now, value }
    return value
  }

  async webAvailable() {
    const now = Date.now()
    if (this._webCache.value !== null && now - this._webCache.at < CLIENT_CHECK_MS) {
      return this._webCache.value
    }
    let value = false
    try {
      const ready = await this.web.ensure()
      value = ready.ok !== false && await this.web._isLoggedIn().catch(() => false)
    } catch { value = false }
    this._webCache = { at: now, value }
    return value
  }

  /**
   * 判定某条通道当前是否真的在放歌。判据：state 拿到 now 且 status=Playing
   * 且有有效标题（不是 (无标题)/网易云音乐 占位）。带短缓存，避免每次轮询连 CDP。
   */
  async channelPlaying(ch) {
    const cache = this._playingCache[ch]
    const now = Date.now()
    if (cache.value && now - cache.at < PLAYING_CHECK_MS) return true
    let playing = false
    try {
      const st = ch === 'web' ? await this.web.state() : await this.native.state({ fresh: true })
      const n = st?.now
      const title = String(n?.title || '').trim()
      const validTitle = title && title !== '(无标题)' && title !== '网易云音乐' && title !== '无标题'
      playing = !!(st?.ok !== false && n && validTitle && (
        n.status === 'Playing' || n.status === 'playing' || n.playing === true
      ))
    } catch { playing = false }
    this._playingCache[ch] = { at: now, value: playing }
    return playing
  }

  /** 选定本次调用走哪条通道，并记到 this.active（供 health/describe 报告）。
   *  client-first / web-first 都先看「谁真的在播」，谁在播跟谁；都没播才按可用性兜底。 */
  async pick() {
    const m = this.mode()
    let chosen
    switch (m) {
      case 'client-only':
        chosen = 'native'; break
      case 'web-only':
        chosen = 'web'; break
      case 'web-first':
        if (await this.channelPlaying('web')) chosen = 'web'
        else if (await this.channelPlaying('native')) chosen = 'native'
        else chosen = (await this.webAvailable()) ? 'web' : 'native'
        break
      case 'client-first':
      default:
        if (await this.channelPlaying('native')) chosen = 'native'
        else if (await this.channelPlaying('web')) chosen = 'web'
        else chosen = (await this.clientOnline()) ? 'native' : 'web'
        break
    }
    if (chosen !== this.active) {
      this.log(`播放通道切换：${this.active} → ${chosen}（模式 ${m}）`)
      this.active = chosen
    }
    return chosen
  }

  get backend() { return this.active === 'web' ? this.web : this.native.backend }
  get degraded() { return this.active === 'web' ? (this.web.lastError || '') : (this.native.degraded || '') }
  get windowLeak() { return this.active === 'web' ? false : this.native.windowLeak }
  get ready() { return this.active === 'web' ? true : this.native.ready }
  get restartLimit() { return this.native.restartLimit }

  on(...args) { return this.native.on(...args) }
  start(...args) { return this.native.start(...args) }

  async state(opts = {}) {
    const ch = await this.pick()
    if (ch === 'web') return this.web.state()
    return this.native.state(opts)
  }

  async action(action, extra = {}) {
    const ch = await this.pick()
    if (ch === 'web') return this.web.action(action, extra)
    return this.native.action(action, extra)
  }

  async volume(opts = {}) {
    const ch = await this.pick()
    if (ch === 'web') return this.web.volume(opts)
    return this.native.volume(opts)
  }

  readyInfo() {
    if (this.active === 'web') {
      return {
        healthy: true,
        ready: true,
        backend: this.web.id,
        platform: 'web',
        capabilities: this.web.capabilities,
        degraded: this.web.lastError || '',
      }
    }
    return this.native.readyInfo()
  }

  async restart() {
    // 重启的是 native 助手进程；web 通道没进程可重启，ensure 会自愈。
    if (this.active === 'web') {
      this.web.stop()
      return { backend: this.web.id, note: '网页版通道已重连' }
    }
    return this.native.restart()
  }

  async deepHealth() {
    const ch = await this.pick()
    if (ch === 'web') {
      const h = await this.web.deepHealth()
      return {
        ...h,
        channel: 'web',
        channels: {
          native: { backend: this.native.backend.id, platform: this.native.backend.platform, degraded: this.native.degraded || '' },
          web: { backend: this.web.id, platform: 'web', reachable: h.ok !== false },
        },
      }
    }
    const h = await this.native.deepHealth()
    return {
      ...h,
      channel: 'native',
      channels: {
        native: { backend: this.native.backend.id, platform: this.native.backend.platform, degraded: this.native.degraded || '' },
        web: { backend: this.web.id, platform: 'web', reachable: await this.webAvailable() },
      },
    }
  }

  stop() {
    try { this.native.stop() } catch { /* ignore */ }
    try { this.web.stop() } catch { /* ignore */ }
  }
}

export default ChannelRouter
