/**
 * winrt-audio.mjs — Node 侧行协议封装，驱动 lib/winrt-audio.ps1 常驻 WinRT 后台音频引擎。
 *
 * 为什么需要它：日推要在「个人 Edge 无 CDP + ego 关着 + 不弹任何页面」的前提下精确
 * 播指定歌。网页 <audio> 要 CDP、SMTC 只能控制不能指定曲目、WMP COM 解不了 m4a 也不
 * 注册媒体会话——只有 WinRT MediaPlayer 满足全部约束（无窗口、不弹页、不依赖 CDP）。
 *
 * 协议：stdin 一行一个 JSON 请求 {seq,cmd,...}，stdout 一行一个 JSON 响应 {seq,...}。
 * 第一行是 ready 握手 {seq:0,ok:true,ready:true}。沿用 player.mjs 的 seq 配对模式。
 * 不依赖任何 npm 包；PowerShell 走 System32 绝对路径（宿主 PATH 裸名会 ENOENT）。
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PS1 = join(HERE, 'winrt-audio.ps1')

/** System32 里 PowerShell 5.1 的固定路径；优先 env.SystemRoot，兜底 C:\Windows。 */
export function resolvePowershell() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

const READY_TIMEOUT_MS = 8000
const DEFAULT_TIMEOUT_MS = 6000

export class WinrtAudio {
  constructor(opts = {}) {
    this.log = typeof opts.log === 'function' ? opts.log : () => {}
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({})
    this.psPath = opts.psPath || resolvePowershell()
    this.ps1Path = opts.ps1Path || PS1
    this.requestTimeoutMs = Number(opts.requestTimeoutMs) || DEFAULT_TIMEOUT_MS

    this.child = null
    this.rl = null
    this.starting = null
    this.stopped = false
    this.ready = false
    this.lastError = ''
    this.seq = 0
    /** @type {Map<number,{resolve:Function,reject:Function,timer:any}>} */
    this.pending = new Map()
  }

  /** 起常驻引擎（幂等）。返回 ready 信息。 */
  async start() {
    if (this.stopped) throw new Error('winrt audio stopped')
    if (this.ready && this.child && !this.child.killed) return this._readyInfo()
    if (this.starting) return this.starting
    this.starting = this.#spawnOnce().finally(() => { this.starting = null })
    return this.starting
  }

  async #spawnOnce() {
    const child = spawn(this.psPath, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.ps1Path,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.ready = false
    this.stderrTail = ''

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4096)
    })
    child.stdin.on('error', (err) => {
      this.lastError = `stdin: ${err && err.message ? err.message : err}`
    })
    child.on('exit', (code) => {
      this.ready = false
      this.child = null
      // 所有在途请求立刻失败，别挂到超时
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`winrt audio exited (code=${code}) ${this.stderrTail.slice(-200)}`))
      }
      this.pending.clear()
    })

    const ready = await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch { /* ignore */ }
        reject(new Error(`winrt audio not ready in ${READY_TIMEOUT_MS}ms ${this.stderrTail.slice(-300)}`))
      }, READY_TIMEOUT_MS)

      this.rl = createInterface({ input: child.stdout })
      this.rl.on('line', (line) => {
        const text = String(line).trim()
        if (!text) return
        let msg
        try { msg = JSON.parse(text) } catch {
          this.log(`winrt-audio non-json: ${text.slice(0, 160)}`)
          return
        }
        if (msg && msg.seq === 0 && msg.ready === true) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (msg.ok === false) { reject(new Error(msg.detail || msg.error || 'winrt unavailable')); return }
          this.ready = true
          this.lastError = ''
          resolve(this._readyInfo())
          return
        }
        this.#dispatch(msg)
      })
    })
    return ready
  }

  #dispatch(msg) {
    if (!msg || typeof msg.seq !== 'number') return
    const p = this.pending.get(msg.seq)
    if (!p) return
    this.pending.delete(msg.seq)
    clearTimeout(p.timer)
    p.resolve(msg)
  }

  _readyInfo() {
    return { ok: true, ready: true, backend: 'winrt-mediaplayer', engine: this.ps1Path }
  }

  /** 发一条命令，等配对响应。 */
  async request(cmd, payload = {}, timeoutMs) {
    try { await this.start() } catch (err) {
      return { ok: false, error: 'winrt-unavailable', detail: String(err?.message || err) }
    }
    const seq = ++this.seq
    const msg = { seq, cmd, ...payload }
    const timeout = Number(timeoutMs) || this.requestTimeoutMs
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        resolve({ ok: false, error: 'winrt-timeout', detail: `${cmd} timed out in ${timeout}ms` })
      }, timeout)
      this.pending.set(seq, { resolve, reject: (err) => resolve({ ok: false, error: 'winrt-error', detail: String(err?.message || err) }), timer })
      try {
        this.child.stdin.write(JSON.stringify(msg) + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(seq)
        resolve({ ok: false, error: 'winrt-write-failed', detail: String(err?.message || err) })
      }
    })
    if (res && res.ok === true) this.lastError = ''
    else if (res && res.detail) this.lastError = String(res.detail)
    return res
  }

  /** 播一首（URL 来自明文 song/url API）。 */
  play({ url, songId, title, artist, positionMs, level, muted } = {}) {
    return this.request('play', { url, songId, title, artist, positionMs, level, muted })
  }
  pause() { return this.request('pause') }
  resume() { return this.request('resume') }
  toggle() { return this.request('toggle') }
  seek(positionMs) { return this.request('seek', { positionMs }) }
  volume(level, muted) { return this.request('volume', { level, muted }) }
  state() { return this.request('state') }
  stop() { return this.request('stop') }

  async close() {
    this.stopped = true
    if (this.child && !this.child.killed) {
      try { this.child.stdin.write(JSON.stringify({ seq: ++this.seq, cmd: 'quit' }) + '\n') } catch { /* ignore */ }
      try { this.child.kill() } catch { /* ignore */ }
    }
    this.child = null
    this.rl = null
    this.ready = false
    for (const [, p] of this.pending) { clearTimeout(p.timer); try { p.resolve({ ok: false, error: 'winrt-closed' }) } catch { /* ignore */ } }
    this.pending.clear()
  }
}

export default WinrtAudio
