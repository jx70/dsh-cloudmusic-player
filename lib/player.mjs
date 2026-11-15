/**
 * lib/player.mjs —— 助手进程管理 + 状态缓存
 * ============================================================================
 * 一个常驻的 powershell.exe 子进程，JSONL over stdin/stdout。
 *
 * 为什么常驻：每次操作重新起 PowerShell 要重新加载 WinRT、重新编译 C#，
 * 单次 300ms+；常驻之后 state 只要 25–60ms，ping 接近 0。悬浮框 2 秒轮询
 * 一次，差距直接体现在「拖音量跟不跟手」上。
 *
 * 三条容易踩的坑，都在这里处理掉：
 *   1. **必须持续排空 stderr**。PowerShell 一旦往 stderr 写满管道缓冲就会
 *      阻塞在写入上，然后 stdin 不再被读 —— 表现为「助手忽然不响应了」。
 *   2. **请求必须按 seq 配对**，不能假设「发一条收一条」：ready 之后的异步
 *      回复、以及将来可能的并发请求都会错位。
 *   3. **`quit` 之后要能兜底 kill**。PowerShell 里 `break` 只跳出 switch
 *      不跳出 while，一旦写错就是「退出时卡 3 秒再强杀」。
 *
 * 失败策略：连续失败 → 按 restartLimit 次指数退避重启 → 超限进入 degraded，
 * 上层拿到的是 `{ok:false, error:'helper-unavailable'}` 而不是异常/500。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

import { ElogWatcher, defaultElogPath } from './elog.mjs'

/** 默认值；index.js 的 DEFAULTS 与这里保持一致 */
export const PLAYER_DEFAULTS = {
  requestTimeoutMs: 3000,
  restartLimit: 3,
}

/** 重启退避（毫秒），索引超过数组长度就用最后一个 */
const BACKOFF_MS = [300, 800, 2000, 3000]

/**
 * @typedef {object} PlayerState
 * @property {boolean} ok
 * @property {object|null} now      SMTC 当前会话
 * @property {object|null} volume   { scope, pid, level, muted }
 * @property {string[]} sessions
 * @property {boolean} winrt
 * @property {object} helper        { healthy, restarts, pid, lastError }
 * @property {number} serverTime    Date.now()，前端拿它做位置插值
 */

export class PlayerService extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./backend.mjs').MediaBackend} options.backend
   * @param {() => object} options.getConfig  每次调用都取最新配置（设置页热改）
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options) {
    super()
    this.backend = options.backend
    this.getConfig = options.getConfig
    this.log = options.log || (() => {})
    /**
     * 日推取数服务（可选）。客户端 3.1.43 的 webcmd 命令表里没有「播放日推」，
     * 只能由插件自己拿到列表再逐条喂给客户端，所以这里挂一个 DailyService。
     */
    this.daily = options.daily || null
    /** 连点合并：同一次日推请求在途时，第二次直接复用第一次的结果 */
    this.dailyInflight = null
    /**
     * 日推整份列表的「已知真名」：songId → { title, artist }，带过期时间。
     *
     * webcmd 起播（日推走的正是这条）客户端只发 started（有 songId、没歌名），
     * 歌名只能靠窗口标题兜底；而窗口标题一是会滞后一两轮，二是 Title() 自己
     * 还有 400ms 缓存，于是面板会长时间显示上一首。这里记下插件自己从日推
     * 列表拿到的那份真名，songId 对上就优先用它；对不上（用户自己切歌）就
     * 自然落回窗口标题，不会张冠李戴。
     * @type {{ until: number, names: Map<string, { title: string, artist: string }> } | null}
     */
    this.dailyNames = null

    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    this.rl = null
    this.starting = null
    this.seq = 0
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
    this.pending = new Map()

    this.ready = false
    this.readyMs = 0
    this.winrt = false
    this.audio = false
    this.psVersion = ''
    this.restarts = 0
    this.lastError = ''
    this.degraded = ''
    /** stderr 环形缓冲：只留最后 8KB，报错文案从这里取 */
    this.stderrTail = ''
    /** 状态缓存：同一 tick 内的并发请求共享一次助手往返 */
    this.stateCache = null
    this.stateCacheAt = 0
    this.stateInflight = null
    this.stopped = false

    /**
     * 网易云客户端日志监听器：真正的时间轴来源。
     *
     * 为什么放在 PlayerService 里而不是另起一个 service：位置/状态/曲目本来就是
     * 同一份「播放器状态」，拆开之后两条数据流要在路由层再合一次，反而更容易
     * 出现「标题是这首、进度是那首」的错配。
     */
    this.elog = null
    /**
     * 协议投递会不会把客户端窗口顶到前台。
     *
     * orpheus:// 消息进客户端后会走 activeWindow effect，那句 `from==='webmsg' &&
     * put({type:'showWindow'})` 在分支判断之外，所以任何一条消息都会让它 show。
     * 这是当前唯一可用的 seek 通道，代价就是这一次 show。
     *
     * helper 侧的窗口守卫（GuardWindow）已经把这次 show 全部按回去：托盘隐藏态一帧
     * 不露、最小化态窗口始终停在屏外 -25600、正常显示态位置不动且焦点归还。所以
     * 这里取 false —— 前端不再提示「拖进度会唤起窗口」。只有守卫本身失效
     * （helper 回报 windowLeaked）才该提示，那是运行时按次判断，不是全局能力。
     */
    this.windowLeak = false
    if (this.backend.platform === 'win32') {
      const cfg = this.getConfig() || {}
      if (cfg.elogEnabled !== false) {
        const filePath = String(cfg.elogPath || '') || defaultElogPath()
        if (filePath) {
          this.elog = new ElogWatcher({
            filePath,
            pollMs: cfg.elogPollMs,
            log: (m) => this.log(`elog: ${m}`),
          })
        }
      }
    }
  }

  // ---------------------------------------------------------------- 生命周期

  /** 起助手（幂等）。返回 ready 信息。 */
  async start() {
    if (this.stopped) throw new Error('player service stopped')
    // 日志监听与助手进程互不依赖：即使 PowerShell 起不来，只要日志能读，
    // 曲目/进度/状态仍然是准的。所以这里先起它，失败也不影响主流程。
    if (this.elog && !this.elog.timer) {
      try {
        this.elog.start()
      } catch (err) {
        this.log(`elog start failed: ${err && err.message ? err.message : err}`)
      }
    }
    if (this.ready && this.child) return this.readyInfo()
    if (this.starting) return this.starting
    this.starting = this.#spawnOnce().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  #caps() {
    return this.backend.capabilities || {}
  }

  async #spawnOnce() {
    const cfg = this.getConfig() || {}
    const caps = this.#caps()
    if (!caps.playback && !caps.sessionVolume && !caps.systemVolume) {
      // 平台不支持：不 spawn、不报错，直接给静态能力
      this.ready = false
      this.degraded = this.backend.reason || 'unsupported-platform'
      this.winrt = false
      throw new Error(this.degraded)
    }

    const { shell, args } = this.backend.command({
      processName: cfg.processName,
      aumidPattern: cfg.aumidPattern,
      powershellPath: cfg.powershellPath,
      helperPath: cfg.helperPath,
      hotkeyPlayPause: cfg.hotkeyPlayPause,
      hotkeyNext: cfg.hotkeyNext,
      hotkeyPrev: cfg.hotkeyPrev,
    })
    if (!shell) throw new Error('no shell command for backend')

    const startedAt = Date.now()
    const child = spawn(shell, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.ready = false
    this.stderrTail = ''

    // 坑 1：不排空 stderr 会死锁
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8192)
    })
    child.stdin.on('error', (err) => {
      this.lastError = `stdin: ${err && err.message ? err.message : err}`
    })

    const readyInfo = await new Promise((resolve, reject) => {
      let settled = false
      const timeoutMs = Math.max(4000, Number(cfg.requestTimeoutMs) || PLAYER_DEFAULTS.requestTimeoutMs * 3)
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`helper did not become ready in ${timeoutMs}ms ${this.stderrTail.slice(-300)}`))
      }, timeoutMs)

      this.rl = createInterface({ input: child.stdout })
      this.rl.on('line', (line) => {
        const text = String(line).trim()
        if (!text) return
        let msg
        try {
          msg = JSON.parse(text)
        } catch {
          // 非 JSON 行（例如 PowerShell 的警告）只记日志，不影响请求配对
          this.log(`helper non-json: ${text.slice(0, 200)}`)
          return
        }
        if (msg && msg.type === 'ready') {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.ready = true
          this.readyMs = Date.now() - startedAt
          this.winrt = !!msg.winrt
          this.audio = !!msg.audio
          this.psVersion = String(msg.ps || '')
          this.lastError = ''
          this.degraded = ''
          resolve(this.readyInfo())
          return
        }
        if (msg && msg.type === 'reply') {
          const waiter = this.pending.get(Number(msg.seq))
          if (!waiter) return
          this.pending.delete(Number(msg.seq))
          clearTimeout(waiter.timer)
          waiter.resolve(msg)
        }
      })

      child.on('error', (err) => {
        this.lastError = `spawn: ${err && err.message ? err.message : err}`
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      })

      child.on('exit', (code, signal) => {
        this.ready = false
        this.child = null
        if (this.rl) {
          try {
            this.rl.close()
          } catch {
            /* ignore */
          }
          this.rl = null
        }
        // 所有在飞的请求立刻失败，别让调用方白等到超时
        for (const [, waiter] of this.pending) {
          clearTimeout(waiter.timer)
          waiter.reject(new Error(`helper exited (code=${code}, signal=${signal})`))
        }
        this.pending.clear()
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`helper exited before ready (code=${code}) ${this.stderrTail.slice(-300)}`))
          return
        }
        if (!this.stopped) {
          this.lastError = `helper exited (code=${code})`
          this.emit('exit', { code, signal })
          this.#scheduleRestart()
        }
      })
    })

    return readyInfo
  }

  #scheduleRestart() {
    if (this.stopped) return
    const cfg = this.getConfig() || {}
    const limit = Number(cfg.restartLimit)
    const max = Number.isFinite(limit) && limit >= 0 ? limit : PLAYER_DEFAULTS.restartLimit
    if (this.restarts >= max) {
      this.degraded = 'helper-unavailable'
      this.log(`helper gave up after ${this.restarts} restarts`)
      this.emit('degraded', this.degraded)
      return
    }
    const delay = BACKOFF_MS[Math.min(this.restarts, BACKOFF_MS.length - 1)]
    this.restarts += 1
    const timer = setTimeout(() => {
      this.start().catch((err) => {
        this.lastError = String(err && err.message ? err.message : err)
        // spawn 失败也算一次失败，继续退避
        this.#scheduleRestart()
      })
    }, delay)
    if (timer.unref) timer.unref()
  }

  /** 重置「放弃重启」状态，让用户点重试时能手工拉起来 */
  async restart() {
    this.restarts = 0
    this.degraded = ''
    this.lastError = ''
    this.stderrTail = ''
    await this.#killChild()
    return this.start()
  }

  async #killChild() {
    const child = this.child
    this.child = null
    this.ready = false
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('helper stopped'))
    }
    this.pending.clear()
    this.stateCache = null
    this.stateInflight = null
    if (!child) return
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ seq: 0, cmd: 'quit' }) + '\n')
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.once('exit', finish)
      setTimeout(finish, 1500)
    })
    if (this.child === child) this.child = null
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    } catch {
      /* ignore */
    }
  }

  /** 卸载时调用：先 quit，再兜底 kill，不留孤儿进程 */
  async stop() {
    this.stopped = true
    if (this.elog) {
      try {
        this.elog.stop()
      } catch {
        /* ignore */
      }
    }
    await this.#killChild()
    this.removeAllListeners()
  }

  readyInfo() {
    return {
      healthy: this.ready,
      readyMs: this.readyMs,
      winrt: this.winrt,
      audio: this.audio,
      ps: this.psVersion,
      pid: this.child ? this.child.pid : 0,
      restarts: this.restarts,
      degraded: this.degraded,
      capabilities: this.#caps(),
      backend: this.backend.id,
      lastError: this.lastError,
    }
  }

  // ------------------------------------------------------------------ 请求

  /**
   * 发一条请求并等回复。
   * @param {string} cmd
   * @param {object} [payload]
   * @param {number} [timeoutMs]
   */
  async request(cmd, payload = {}, timeoutMs) {
    if (this.stopped) throw new Error('player service stopped')
    if (!this.ready || !this.child) {
      await this.start()
    }
    const child = this.child
    if (!child || !child.stdin || child.stdin.destroyed) throw new Error('helper stdin is gone')

    const cfg = this.getConfig() || {}
    const wait = Number(timeoutMs) > 0 ? Number(timeoutMs) : Number(cfg.requestTimeoutMs) || PLAYER_DEFAULTS.requestTimeoutMs
    const seq = ++this.seq
    const body = JSON.stringify({ seq, cmd, ...payload })

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        this.lastError = `timeout: ${cmd} after ${wait}ms`
        reject(new Error(this.lastError))
      }, wait)
      this.pending.set(seq, { resolve, reject, timer })
      try {
        child.stdin.write(body + '\n')
      } catch (err) {
        this.pending.delete(seq)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  /** 把一个失败转成路由层统一的形状，不让异常冒到 HTTP 500 */
  #failure(err) {
    const message = String(err && err.message ? err.message : err)
    return {
      ok: false,
      error: this.degraded || 'helper-unavailable',
      detail: message,
      hint: '点重试，或确认网易云客户端在运行；仍不行就看 /health?deep=1',
    }
  }

  // ------------------------------------------------------------------ 业务

  /**
   * 当前状态。带 400ms 的缓存 + 并发合并：悬浮框 2 秒轮询一次，
   * 但设置页弹开时两个组件可能同时请求，没必要打两趟助手。
   * @param {{ fresh?: boolean }} [opts]
   * @returns {Promise<PlayerState>}
   */
  async state(opts = {}) {
    const now = Date.now()
    if (!opts.fresh && this.stateCache && now - this.stateCacheAt < 400) return this.stateCache
    if (this.stateInflight) return this.stateInflight

    this.stateInflight = (async () => {
      try {
        const msg = await this.request('state')
        const result = {
          ok: msg.ok !== false,
          now: this.#mergeElog(msg.now || null),
          volume: msg.volume || null,
          // APP 与 SYS 是两套独立读数：前端切到 SYS 时必须能拿到系统端点那一路，
          // 否则拖完只能回落 APP 值，看起来就像「弹回原值」。
          systemVolume: msg.systemVolume || null,
          sessions: Array.isArray(msg.sessions) ? msg.sessions : [],
          winrt: msg.winrt !== false,
          helper: this.readyInfo(),
          serverTime: Date.now(),
        }
        this.stateCache = result
        this.stateCacheAt = Date.now()
        return result
      } catch (err) {
        const failed = { ...this.#failure(err), now: null, volume: null, systemVolume: null, sessions: [], serverTime: Date.now() }
        // 失败不缓存：下一次轮询要能立刻恢复
        this.stateCache = null
        return failed
      } finally {
        this.stateInflight = null
      }
    })()
    return this.stateInflight
  }

  /**
   * 把日志车道（elog）的真实时间轴合并进助手给的播放状态。
   *
   * 优先级：
   *   1. elog 可用且曲目对得上 → 用 elog 的曲目 / 位置 / 时长 / 播放态，
   *      助手的峰值判断退为旁证（起播缓冲时峰值为 0 而实际在播，信 elog）。
   *   2. elog 不可用 → 原样返回助手的状态（窗口标题 + 峰值估算，pos/end = 0）。
   *
   * `channel` 保持不变（'native' 或 'smtc'）：车道指的是「控制走哪条路」，
   * `positionSource` 才说明「进度从哪来」。
   *
   * @param {object|null} now  助手返回的 now
   * @returns {object|null}
   */
  #mergeElog(now) {
    const elog = this.elog
    if (!elog) {
      return now ? { ...now, positionSource: now.channel === 'smtc' ? 'smtc' : 'peak' } : null
    }
    // SMTC 车道（别的播放器）完全不归 elog 管：那边的 pos/end 是系统给的准值
    if (now && now.channel === 'smtc' && Number(now.end) > 0) {
      return { ...now, positionSource: 'smtc' }
    }

    const es = elog.getState()
    if (!es.available || !es.track) {
      return now ? { ...now, positionSource: 'peak' } : { ...this.#emptyNow(), positionSource: 'peak', positionSourceReason: es.reason }
    }

    const track = es.track
    // 曲目对不上说明助手的窗口标题还没跟上（或者读到的是别的窗口），
    // 这时候以 elog 为准 —— 它带 songId，是客户端自己的事件
    //
    // 唯一的例外是歌名/歌手/专辑：webcmd 起播（日推走这条）客户端只发
    // `started`，那条事件有 songId 和时长、没有歌名。elog 里空着的字段就
    // 保留助手读到的窗口标题，别把面板刷成空白。
    // 日推起播后，歌名/歌手优先用插件自己那份列表（见 dailyNames 注释）。
    // 过期或当前 songId 不在列表里就自然落回窗口标题兜底。
    const dn = this.dailyNames
    if (dn && Date.now() > dn.until) this.dailyNames = null
    const known = this.dailyNames ? this.dailyNames.names.get(String(track.songId)) : null
    const keep = (mine, fallback) => (mine ? mine : fallback || '')
    const endSec = es.durationMs > 0 ? es.durationMs / 1000 : 0
    const cfg = this.getConfig() || {}
    return {
      aumid: now && now.aumid ? now.aumid : `native:${cfg.processName || 'cloudmusic'}`,
      title: keep(track.title, known && known.title) || (now && now.title) || '',
      artist: keep(track.artist, known && known.artist) || (now && now.artist) || '',
      album: keep(track.album, now && now.album),
      songId: track.songId,
      status: es.playing ? 'Playing' : 'Paused',
      pos: Math.round(es.positionMs) / 1000,
      end: endSec,
      start: 0,
      canPlay: true,
      canPause: true,
      canNext: true,
      canPrev: true,
      // native 车道的 seek 走 orpheus:// 协议（helper 翻译成 webcmd），
      // 客户端收到后自己 setPlayingPosition → 原生 DoSeek，是真跳。
      canSeek: true,
      // windowLeak: 投递协议时客户端必然把主窗口 show 出来（它的 activeWindow
      // effect 对 from:'webmsg' 无条件 dispatch showWindow）。helper 会在投递后
      // 把窗口按回原状，压不住才算泄露。前端据此决定「拖进度前提示一句」还是
      // 「当作纯后台操作，什么都不说」。
      windowLeak: this.windowLeak !== false,
      peak: now ? now.peak : undefined,
      pid: now ? now.pid : undefined,
      channel: 'native',
      positionSource: 'elog',
      durationMs: es.durationMs,
      mode: es.mode || '',
    }
  }

  #emptyNow() {
    return {
      aumid: '',
      title: '',
      artist: '',
      album: '',
      songId: '',
      status: 'Paused',
      pos: 0,
      end: 0,
      start: 0,
      canPlay: false,
      canPause: false,
      canNext: false,
      canPrev: false,
      canSeek: false,
      channel: 'native',
      mode: '',
    }
  }

  /** 清掉状态缓存，让下一次 state() 一定回源（操作之后调用） */
  invalidate() {
    this.stateCache = null
    this.stateCacheAt = 0
  }

  /**
   * 播放动作。
   * @param {'play'|'pause'|'toggle'|'next'|'prev'|'seek'|'play_daily'|'set_mode'} action
   * @param {{ positionMs?: number, value?: string }} [extra]
   */
  async action(action, extra = {}) {
    const allowed = ['play', 'pause', 'toggle', 'next', 'prev', 'seek', 'play_daily', 'set_mode']
    if (!allowed.includes(action)) {
      return { ok: false, error: 'bad-action', detail: `unknown action: ${action}` }
    }
    if (!this.#caps().playback) {
      return { ok: false, error: 'playback-unsupported', detail: this.backend.reason || 'backend has no playback' }
    }
    // 日推是一条独立链路（取数 → 投递 → 回读），语义和"按一下播放键"完全不同，
    // 所以单独走 #playDaily，不混进下面那段 payload/msg 的通用处理。
    if (action === 'play_daily') return await this.#playDaily()
    // 切播放顺序同样独立：它不走热键/SMTC，只投一条 mode webcmd，且 value 是
    // 白名单枚举，交给 #setMode 单独校验。
    if (action === 'set_mode') return await this.#setMode(extra)
    try {
      // 先把「现在到底在不在播」的权威答案灌给助手：native 车道的播放/暂停是
      // 同一个切换键，助手只能靠峰值猜（淡出要 900ms），猜错就会「按暂停反而
      // 开始播」。日志车道的状态是客户端自己写的，比峰值可靠。
      await this.#primeIntent(action)
      const payload = {}
      if (action === 'seek') payload.ms = Math.max(0, Math.round(Number(extra.positionMs) || 0))
      const msg = await this.request(action, payload)
      // 日志落盘有延迟：先告诉 watcher 目标位置，滑块才不会先弹回旧位置
      if (action === 'seek' && msg.ok !== false && this.elog) this.elog.noteSeek(payload.ms)
      this.invalidate()
      const after = await this.state({ fresh: true })
      return {
        ok: msg.ok !== false,
        error: msg.ok === false ? msg.error || 'action-failed' : undefined,
        scope: msg.scope,
        // channel: 'smtc' | 'native' —— 这次操作实际走的是哪条车道
        channel: msg.channel,
        // skipped: 'already-playing' | 'already-paused'
        // native 车道的播放/暂停是同一个切换键，已经处于目标状态时不会重复按
        skipped: msg.skipped,
        // restored: 窗口原本被收起/最小化，客户端唤起后已被按回原样（seek 专用）
        restored: msg.restored,
        // windowLeaked: 尝试恢复但客户端的 show 没压住，窗口被留在前台（seek 专用）
        windowLeaked: msg.windowLeaked,
        now: after.now,
        volume: after.volume,
      }
    } catch (err) {
      return this.#failure(err)
    }
  }

  /**
   * 切换播放顺序（顺序/列表循环/单曲循环/随机）。
   *
   * 为什么独立成一条 action：切顺序既不走 SMTC（本机没有会话），也不走热键
   * （网易云没有对应热键），只投一条 `{"cmd":"mode","value":...}` webcmd。
   * 客户端收到后写「播放模式切换」日志，这里回读 elog 把新枚举带回去。
   */
  async #setMode(extra = {}) {
    const value = String(extra?.value || '').trim()
    const valid = ['cycle', 'single', 'random', 'order']
    if (!valid.includes(value)) {
      return { ok: false, error: 'bad-mode', detail: `unknown mode: ${value || '(empty)'}` }
    }
    let msg
    try {
      msg = await this.request('setMode', { value }, 6000)
    } catch (err) {
      return this.#failure(err)
    }
    if (msg?.ok === false) {
      const code = String(msg.error || '')
      if (code === 'no-client') {
        return { ok: false, error: 'mode-no-client', message: '没找到网易云客户端，先打开它再试', detail: msg.detail || '' }
      }
      return { ok: false, error: code || 'mode-failed', message: '客户端没接住切换指令', detail: msg.detail || '' }
    }
    this.invalidate()
    const after = await this.state({ fresh: true })
    return {
      ok: true,
      error: undefined,
      channel: msg.channel,
      value,
      mode: after.now ? after.now.mode : '',
      now: after.now,
      volume: after.volume,
    }
  }

  /**
   * 播放每日推荐。
   *
   * 为什么要绕这么大一圈（插件取列表 → 两条 webcmd）：
   * 客户端 3.1.43 的 `onWebMessage()` switch 里**没有** dailyRecommend 这个资源
   * 类型（只认 song/program/album/playlist/audio），能触发日推 playAll 的只有
   * native 推给渲染层的 systemUIHint，外部伪造不了。实测 `daysong_notify/btn_2`
   * 与 `orpheus://nm/play/dailySong` 都没有任何反应。所以只能自己拿列表，
   * 用 `{"cmd":"play","type":"song"}` 起播第一首，再用
   * `{"cmd":"playingList","type":"addToNext"}` 把剩下的追加进队列。
   *
   * 连点两次：第二次直接复用第一次的 promise（`dailyInflight`），不会重复起播。
   */
  async #playDaily() {
    if (!this.daily) {
      return { ok: false, error: 'daily-unavailable', message: '这个平台还没接每日推荐' }
    }
    if (this.dailyInflight) {
      try {
        const shared = await this.dailyInflight
        return { ...shared, deduped: true }
      } catch {
        /* 前一次失败了，让这次重新走一遍 */
      }
    }
    const task = this.#doPlayDaily()
    this.dailyInflight = task
    try {
      return await task
    } finally {
      this.dailyInflight = null
    }
  }

  async #doPlayDaily() {
    let list
    try {
      list = await this.daily.fetch()
    } catch (err) {
      const detail = String(err?.message || err)
      return { ok: false, error: 'daily-network', message: '拉每日推荐失败，检查网络后重试', detail }
    }
    if (!list || list.ok !== true) {
      return {
        ok: false,
        error: list?.error || 'daily-failed',
        message: list?.message || '拉每日推荐失败',
        detail: list?.detail || '',
      }
    }
    const songs = Array.isArray(list.songs) ? list.songs : []
    if (songs.length === 0) {
      return { ok: false, error: 'daily-empty', message: '今天的日推是空的，可能还没生成' }
    }

    const ids = songs.map((s) => s.id)
    const first = songs[0]

    // 首曲正好就是「此刻在播的那首」时，客户端的 play 会被当成「已经在放了」
    // 而完全不动 —— 尤其是这首刚好停在结尾（pos 会一直卡在 dur 上、状态还是
    // Playing），用户看到的就是「按了日推毫无反应，歌词歌手也没换」。
    // 本机日推第一首经常就是刚才在放的那首，这个坑踩到概率不低。
    // 让助手补一条 seek 0，把「从第一首开始播」的语义坐实。
    let restart = false
    if (this.elog && this.elog.pollCount) {
      const es = this.elog.getState()
      const cur = es.track ? String(es.track.songId || '') : ''
      if (cur && cur === String(first.id)) {
        const dur = Number(es.durationMs) || 0
        const pos = Number(es.positionMs) || 0
        const atEnd = dur > 0 && pos >= dur - 1500
        // 只在「这首已经停在结尾」或「本来就是暂停的」时候拉回 0；
        // 正常播到一半时别动它，不然点一下日推会把进度重置，很烦。
        restart = atEnd || es.playing === false
        if (restart) this.log?.(`play_daily: 首曲就是当前这首（${cur}，` + (atEnd ? '停在结尾' : '暂停中') + '），让助手回到 0 重播')
      }
    }

    let msg
    try {
      // 第一条 webcmd 之后客户端要拉曲目详情才会真的换队列，12s 够它走完
      msg = await this.request('playDaily', { ids, first: String(first.id), restart }, 12000)
    } catch (err) {
      const failure = this.#failure(err)
      return { ...failure, message: '投递日推给客户端失败' }
    }

    if (msg?.ok === false) {
      const code = String(msg.error || '')
      if (code === 'no-client') {
        return {
          ok: false,
          error: 'daily-no-client',
          message: '没找到网易云客户端，先打开它再试',
          detail: msg.detail || '',
        }
      }
      if (code === 'bad-ids') {
        return { ok: false, error: 'daily-failed', message: '日推列表是空的', detail: msg.detail || '' }
      }
      return {
        ok: false,
        error: 'daily-failed',
        message: '客户端没接住日推指令',
        detail: [code, msg.detail].filter(Boolean).join(': '),
      }
    }

    this.invalidate()
    // 投递成功 ≠ 客户端已经出声：它还要再拉一次曲目详情才发 started。
    // 这里短暂等日志追上（最多 2.4 秒），好让返回的 now 就是新歌，
    // 前端 run() 拿 res.now 回填，点完立刻就对。
    // 等不到也无所谓 —— 下一轮轮询会刷新（验收②要的就是「下一轮正常刷新」）。
    await this.#waitForElogSong(String(first.id), 2400)
    const after = await this.state({ fresh: true })
    // 起播瞬间客户端只发 started（带 songId 和时长、不带歌名），
    // 已知日推首曲叫什么，直接补上，别让面板闪一下空白。
    //
    // 而且不能只补这一下：面板每 2 秒轮询一次，下一轮的 elog 里 title 仍是
    // 空的，又会退回窗口标题 —— 客户端换歌后窗口标题要滞后一两轮才更新，
    // 于是面板一直显示上一首。所以把它记进 this.dailyNow，让后面几轮都
    // 优先用这份真名（songId 对不上或超时自动作废，见 #mergeElog）。
    if (first.name || first.artist) {
      const names = new Map()
      for (const s of songs) {
        if (s && s.id != null && (s.name || s.artist)) {
          names.set(String(s.id), { title: s.name || '', artist: s.artist || '' })
        }
      }
      this.dailyNames = { until: Date.now() + 6 * 60 * 60 * 1000, names }
    }
    const now = after.now ? { ...after.now } : after.now
    if (now && String(now.songId) === String(first.id)) {
      if (!now.title && first.name) now.title = first.name
      if (!now.artist && first.artist) now.artist = first.artist
    }
    return {
      ok: true,
      message: `已切到每日推荐（${songs.length} 首）`,
      songCount: songs.length,
      firstSong: { id: first.id, name: first.name, artist: first.artist },
      day: list.day,
      cached: list.cached === true,
      channel: msg?.channel || 'native',
      restored: msg?.restored,
      restarted: msg?.restarted,
      windowLeaked: msg?.windowLeaked,
      now,
      volume: after.volume,
    }
  }

  /**
   * 等日志车道认领某一首（webcmd 起播后客户端会发 started）。
   * 只是让 play_daily 的返回更好看，等不到就算了。
   * @param {string} songId
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async #waitForElogSong(songId, timeoutMs) {
    // 没在轮询的日志车道（没启动 / 单测里只有个空壳）就别等了
    if (!this.elog || !this.elog.pollCount || !songId) return false
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
    for (;;) {
      const es = this.elog.getState()
      if (es.track && String(es.track.songId) === songId) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  /**
   * 在真实操作之前，把日志里的播放态告诉助手（可选优化）。
   * 失败静默 —— 助手自己有峰值兜底，这条只是让它更准。
   * @param {string} action
   */
  async #primeIntent(action) {
    if (!this.elog) return
    if (action !== 'play' && action !== 'pause' && action !== 'toggle') return
    const es = this.elog.getState()
    if (!es.available) return
    try {
      await this.request('intent', { playing: es.playing }, 800)
    } catch {
      /* 静默：助手不支持 intent 也不影响操作 */
    }
  }

  /**
   * 音量 / 静音。level 是 0..1；muted 给了就改静音。
   * scope 默认取配置里的 volumeScope（process = 只动网易云）。
   */
  async volume({ level, muted, scope } = {}) {
    const cfg = this.getConfig() || {}
    const wantScope = scope === 'system' || scope === 'process' ? scope : String(cfg.volumeScope || 'process')
    const caps = this.#caps()
    if (wantScope === 'system' && !caps.systemVolume) {
      return { ok: false, error: 'volume-unsupported', detail: this.backend.reason || '' }
    }
    if (wantScope === 'process' && !caps.sessionVolume && !caps.systemVolume) {
      return { ok: false, error: 'volume-unsupported', detail: this.backend.reason || '' }
    }
    const payload = { scope: wantScope }
    let cmd = 'volume'
    if (muted !== undefined && muted !== null) {
      cmd = 'mute'
      payload.muted = !!muted
      if (level !== undefined && level !== null) payload.level = Number(level)
    } else {
      const n = Number(level)
      if (!Number.isFinite(n)) return { ok: false, error: 'bad-level' }
      payload.level = Math.min(1, Math.max(0, n))
    }
    try {
      const msg = await this.request(cmd, payload)
      this.invalidate()
      return {
        ok: msg.ok !== false,
        error: msg.ok === false ? msg.error || 'volume-failed' : undefined,
        scope: msg.scope || wantScope,
        volume: msg.volume || null,
        systemVolume: msg.systemVolume || null,
      }
    } catch (err) {
      return this.#failure(err)
    }
  }

  /** 换机器自检：列出全部 SMTC 会话与全部音频会话 */
  async deepHealth() {
    try {
      const msg = await this.request('deep', {}, 8000)
      return {
        ok: msg.ok !== false,
        platform: this.backend.platform,
        backend: this.backend.id,
        capabilities: this.#caps(),
        winrt: !!msg.winrt,
        winrtError: msg.winrtError || '',
        window: !!msg.window,
        windowError: msg.windowError || '',
        hotkeys: msg.hotkeys || null,
        ps: msg.ps || this.psVersion,
        helperPid: this.child ? this.child.pid : 0,
        pids: Array.isArray(msg.pids) ? msg.pids : [],
        target: msg.target || '',
        media: Array.isArray(msg.media) ? msg.media : [],
        sessions: Array.isArray(msg.sessions) ? msg.sessions : [],
        // native 车道现状：客户端有没有窗口、窗口标题是不是歌名、峰值多少
        native: Array.isArray(msg.native) ? msg.native : [],
        // 日志车道现状：文件路径、已读到哪、解出的曲目/位置
        elog: this.elog ? this.elog.getDebug() : null,
        restarts: this.restarts,
        lastError: this.lastError,
        stderr: this.stderrTail.slice(-1200),
      }
    } catch (err) {
      return {
        ok: false,
        platform: this.backend.platform,
        backend: this.backend.id,
        capabilities: this.#caps(),
        ...this.#failure(err),
        stderr: this.stderrTail.slice(-1200),
      }
    }
  }
}
