/**
 * lib/elog.mjs —— 从网易云客户端日志里读真实播放位置
 * ============================================================================
 * 为什么需要这个文件：
 *
 * 网易云客户端 3.x 在 Windows 上**不注册 SMTC 会话**（它的 SMTCWrapper 自己
 * 就在报 `Failed to set play status`），所以系统层看不到它；而悬浮框要滚歌词，
 * 就必须知道「这首歌放到第几秒」。
 *
 * 客户端会把播放事件写进自己的日志：
 *
 *   %LOCALAPPDATA%\NetEase\CloudMusic\cloudmusic.elog
 *
 * 日志是**逐字节替换编码**过的（不是压缩、不是加密），替换表是个 16 行的
 * 位运算公式；解码之后是普通文本行，每行一个带毫秒 uptime 的时间戳，以及
 * 事件名 + JSON 负载。里面能拿到：
 *
 *   · 曲目详情：songId / 歌名 / 歌手 / 专辑 / 时长
 *   · 播放状态：native播放state 1=播放 2=暂停
 *   · 起播时刻：native播放资源load完成，开始播放
 *   · 拖拽位置：setPlayingPosition（秒）
 *   · 播完时刻：onPlayEnd handle reason（playedTime 毫秒）
 *
 * 「位置」不是被动记录的，而是**回放算出来的**：找到最近一次「曲目开始 / 起播 /
 * 拖拽 / 暂停→播放」的锚点，再用「现在 - 锚点时刻」外推。暂停时位置冻结。
 *
 * 三条设计约束：
 *   1. **不能全量读**。日志会无限增长（本机测试时已 8.8 MB），启动时只从尾部
 *      按块向前扫，找到最近一条曲目事件就停，然后只回放它之后的行。
 *   2. **不能假设一次读到的正好是整行**。按字节找换行，剩下的半行留到下次
 *      （`carry`），否则会把一个汉字劈成两半、解出乱码。
 *   3. **日志结构变化不能让插件崩**。任何解析失败都返回 null 跳过该行，
 *      整体给 `available: false`，上层自动回落「窗口标题 + 音频峰值」。
 *
 * 只在 Windows 上有意义；别的平台 `defaultElogPath()` 返回空串。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// 解码表
// ---------------------------------------------------------------------------

/**
 * 逐字节替换表。做的是「把每个字节按高 4 位 / 低 4 位做一次异或与位拼接」，
 * 不是加密，只是让日志不好直接 grep。
 */
export const DECODE_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let b = 0; b < 256; b += 1) {
    const high = b >> 4
    const low = b & 0x0f
    const hex = ((high ^ ((low + 8) % 16)) % 16) | 0
    table[b] = (hex * 16 + (b >> 6) * 4 + ((~high) & 3)) & 0xff
  }
  return table
})()

/** 反表：解码后的字节 → 原始字节。只给 encodeElog（造测试样本）和后文算换行用 */
const ENCODE_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let b = 0; b < 256; b += 1) table[DECODE_TABLE[b]] = b
  return table
})()

/** 编码后的「换行字节」。**必须算出来**，硬编码会在别的版本上错位 */
export const ENCODED_NEWLINE = ENCODE_TABLE[0x0a]

/** 把原始日志字节解成可读文本 */
export function decodeElog(buf) {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i += 1) out[i] = DECODE_TABLE[buf[i]]
  return out.toString('utf8')
}

/** 把文本编码成日志字节（测试造样本用） */
export function encodeElog(text) {
  const src = Buffer.from(String(text), 'utf8')
  const out = Buffer.allocUnsafe(src.length)
  for (let i = 0; i < src.length; i += 1) out[i] = ENCODE_TABLE[src[i]]
  return out
}

// ---------------------------------------------------------------------------
// 行解析
// ---------------------------------------------------------------------------

/**
 * 行头：
 *   [16364:1792:1107/214204:19629515:INFO:app.cpp(1231)] [2026-11-07 21:42:04] 【playing】,...
 *    ↑pid ↑tid ↑月日/时分秒 ↑开机毫秒 ↑级别 ↑文件(行)        ↑墙钟（秒精度）
 *
 * 分组：1 pid · 3 月日 · 4 时分秒 · 5 开机毫秒 · 6 级别 · 7 文件 · 8 行号 · 9 墙钟
 */
const HEADER_RE =
  /^\[(\d+):(\d+):(\d{4})\/(\d{6}):(\d+):([A-Z]+):([\w.-]+)\((\d+)\)\](?:\s+\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\])?/

/** 行头之后的分类标签，如 `【playing】` */
const TAG_RE = /^\s*(?:【[^】]*】)?\s*/

/**
 * @typedef {object} ElogHeader
 * @property {number} pid
 * @property {number} uptimeMs   进程启动以来的毫秒数（毫秒精度，位置计算用它）
 * @property {number} wallMs     墙钟毫秒（秒精度，用来交叉校验 uptime）
 * @property {string} rest       行头之后的正文
 */

/**
 * 解出一行的头。解不出返回 null（旋转产生的残行、二进制垃圾都会走到这里）。
 * @param {string} line
 * @returns {ElogHeader | null}
 */
export function parseElogHeader(line) {
  if (typeof line !== 'string' || line.length < 20) return null
  const m = HEADER_RE.exec(line)
  if (!m) return null
  const pid = Number(m[1])
  const uptimeMs = Number(m[5])
  if (!Number.isFinite(pid) || !Number.isFinite(uptimeMs)) return null

  let wallMs = 0
  if (m[9]) {
    const y = Number(m[9])
    const mo = Number(m[10])
    const d = Number(m[11])
    const hh = Number(m[12])
    const mm = Number(m[13])
    const ss = Number(m[14])
    const t = new Date(y, mo - 1, d, hh, mm, ss, 0).getTime()
    if (Number.isFinite(t)) wallMs = t
  }

  return { pid, uptimeMs, wallMs, rest: line.slice(m[0].length).replace(TAG_RE, '') }
}

/**
 * 把「开机毫秒」换算成 Unix 时间戳。
 *
 * 优先用 uptime（毫秒精度），再与墙钟交叉校验：两者差超过 5 秒说明中间发生过
 * 待机/时间同步，此时改用墙钟（虽然只有秒精度，但至少不会偏几分钟）。
 *
 * @param {ElogHeader} header
 * @param {number} nowMs
 * @param {number} uptimeNowMs  当前系统的开机毫秒数
 */
export function eventTimeOf(header, nowMs, uptimeNowMs) {
  const base = nowMs - (uptimeNowMs - header.uptimeMs)
  if (header.wallMs > 0 && Math.abs(header.wallMs - base) > 5000) return header.wallMs
  return base
}

// ---------------------------------------------------------------------------
// 曲目字段提取
// ---------------------------------------------------------------------------

/** 从 JSON 片段里取第一个字符串字段（容忍 JSON 被截断） */
function firstString(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = re.exec(text)
  return m ? m[1] : ''
}

/** 从 JSON 片段里取第一个数字字段 */
function firstNumber(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`)
  const m = re.exec(text)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isFinite(n) ? n : 0
}

/**
 * 从曲目 JSON 里抠出我们要的四个字段。
 *
 * 这里**不用 JSON.parse**：客户端的 `checkPlayPrivilege` 那条日志本身就被截断了
 * （末尾半句 `"originResourceType","track","scene",` 不是合法 JSON），parse 一定抛。
 * 正则取字段对截断免疫，而且只跑在行首几百字节上，够快。
 *
 * @param {string} text
 * @returns {{ songId: string, title: string, artist: string, album: string, durationMs: number } | null}
 */
export function extractTrack(text) {
  if (typeof text !== 'string') return null
  const head = text.slice(0, 6000)
  const songId = firstString(head, 'id')
  if (!songId) return null
  const title = firstString(head, 'name')
  if (!title) return null

  // artists: [ { "id": "...", "name": "..." }, ... ] —— 取第一位歌手
  let artist = ''
  const am = /"artists"\s*:\s*\[\s*\{[\s\S]{0,400}?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
  if (am) artist = am[1]

  // album: { "id": "...", "name": "..." , ... }
  let album = ''
  const bm = /"album"\s*:\s*\{[\s\S]{0,300}?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
  if (bm) album = bm[1]

  const durationMs = firstNumber(head, 'duration')

  return { songId, title, artist, album, durationMs: durationMs > 0 ? durationMs : 0 }
}

/** JSON 字符串里的转义还原（歌名里可能有引号） */
function unescapeJson(str) {
  if (!str || str.indexOf('\\') < 0) return str
  try {
    return JSON.parse(`"${str}"`)
  } catch {
    return str
  }
}

// ---------------------------------------------------------------------------
// 事件分类
// ---------------------------------------------------------------------------

const MARK_TRACK_PLAY = '"playOneTrackInPlayingList"'
const MARK_TRACK_PRIV = '"checkPlayPrivilege"'
const MARK_STARTED = 'native播放资源load完成，开始播放'
const MARK_STATE = '"native播放state"'
const MARK_SEEK = '"setPlayingPosition"'
const MARK_END = '"onPlayEnd handle reason"'
const MARK_EXIT_APP = 'exitApp'
const MARK_PROC_EXIT_RE = /Process\s+(\d+)\s+exited/

/**
 * @typedef {object} ElogEvent
 * @property {'track'|'started'|'state'|'seek'|'end'|'exit-app'|'exit-process'} type
 * @property {string} rest
 */

/**
 * 判断一行属于哪种事件。返回 null 表示这行与我们无关（日志里 99% 是别的）。
 * @param {string} rest
 * @returns {ElogEvent | null}
 */
export function classifyLine(rest) {
  if (typeof rest !== 'string' || rest.length === 0) return null
  // 顺序有讲究：'native播放资源load完成，开始播放' 里也含 'native播放'，
  // 必须先判它；'native播放资源开始load' 是另一条事件，不算起播。
  if (rest.indexOf(MARK_TRACK_PLAY) >= 0) return { type: 'track', rest }
  if (rest.indexOf(MARK_TRACK_PRIV) >= 0) return { type: 'track', rest }
  if (rest.indexOf(MARK_STARTED) >= 0) return { type: 'started', rest }
  if (rest.indexOf(MARK_STATE) >= 0) return { type: 'state', rest }
  if (rest.indexOf(MARK_SEEK) >= 0) return { type: 'seek', rest }
  if (rest.indexOf(MARK_END) >= 0) return { type: 'end', rest }
  if (rest.indexOf(MARK_EXIT_APP) >= 0) return { type: 'exit-app', rest }
  if (MARK_PROC_EXIT_RE.test(rest)) return { type: 'exit-process', rest }
  return null
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/** 默认日志路径（非 Windows 返回空串 → 上层当作不可用） */
export function defaultElogPath() {
  if (process.platform !== 'win32') return ''
  const base = process.env.LOCALAPPDATA
  if (!base) return ''
  return path.join(base, 'NetEase', 'CloudMusic', 'cloudmusic.elog')
}

/**
 * @typedef {object} ElogState
 * @property {boolean} available   日志存在且至少解出过一次曲目
 * @property {object|null} track   { songId, title, artist, album, durationMs }
 * @property {boolean} playing
 * @property {number} positionMs
 * @property {number} durationMs
 * @property {string} songId
 * @property {number} lastEventAt  最后一条相关事件的 Unix 毫秒
 * @property {string} reason       不可用/无曲目的原因，给 /health 看
 */

export class ElogWatcher {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath]     日志路径，默认按平台推
   * @param {number} [options.pollMs]       轮询间隔，默认 400
   * @param {(msg: string) => void} [options.log]
   * @param {number} [options.maxScanBytes] 启动时向前扫的最大字节数，默认 16MB
   */
  constructor(options = {}) {
    this.filePath = options.filePath || defaultElogPath()
    this.pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 400
    this.log = options.log || (() => {})
    this.maxScanBytes = Number(options.maxScanBytes) > 0 ? Number(options.maxScanBytes) : 16 * 1024 * 1024

    /** 已读到的字节偏移 */
    this.offset = 0
    /** 上次读到的半行（原始字节，不解码） */
    this.carry = Buffer.alloc(0)
    this.timer = null
    this.stopped = false

    /** @type {{songId:string,title:string,artist:string,album:string,durationMs:number}|null} */
    this.track = null
    this.songId = ''
    /** 锚点：{ at: 事件时间戳, positionMs } */
    this.anchor = null
    this.pausing = true
    this.ended = false
    this.lastEventAt = 0
    this.lastTrackStartAt = 0
    /** 从行头记下来的客户端主进程 pid，用于识别「客户端退出了」 */
    this.appPid = 0
    this.reason = 'not-started'
    this.available = false
    /** 上一次 stat 的大小，用来判断轮转 */
    this.lastSize = 0
    this.lastPollAt = 0
    this.pollCount = 0
    this.lineCount = 0
    this.errorCount = 0
  }

  // -------------------------------------------------------------- 生命周期

  start() {
    if (this.stopped) return this
    if (!this.filePath) {
      this.available = false
      this.reason = 'unsupported-platform'
      return this
    }
    this.#preload()
    this.timer = setInterval(() => this.poll(), this.pollMs)
    if (this.timer.unref) this.timer.unref()
    return this
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ------------------------------------------------------------------ 读

  #stat() {
    try {
      return fs.statSync(this.filePath)
    } catch {
      return null
    }
  }

  /**
   * 启动预载：从尾部按块向前扫，直到找到最近一条曲目事件，再正序回放它之后的行。
   *
   * 为什么不从头读：日志可以长到几百 MB，客户端一整天的运行都写在这里。
   * 为什么必须找到「曲目事件」才停：只回放状态事件的话，拿不到歌名/时长。
   */
  #preload() {
    const st = this.#stat()
    if (!st || !st.isFile()) {
      this.available = false
      this.reason = 'log-missing'
      return
    }
    this.lastSize = st.size
    const CHUNK = 1024 * 1024
    const limit = Math.min(st.size, this.maxScanBytes)
    let tailText = ''
    let scanned = 0
    let foundTrack = false
    /** 扫描窗口是否从文件开头开始。只有不是从头开始时，第一行才可能是被截断的半行 */
    let startedAtZero = false

    while (scanned < limit) {
      const readSize = Math.min(CHUNK, limit - scanned)
      const start = st.size - scanned - readSize
      if (start <= 0) startedAtZero = true
      let chunk
      try {
        chunk = this.#readBytes(start, readSize)
      } catch (err) {
        this.reason = `log-read-failed: ${err && err.message ? err.message : err}`
        this.available = false
        return
      }
      const text = decodeElog(chunk)
      tailText = text + tailText
      scanned += readSize
      // 扫够一个块就看看有没有曲目事件；找到就不用继续往前
      if (tailText.indexOf(MARK_TRACK_PLAY) >= 0 || tailText.indexOf(MARK_TRACK_PRIV) >= 0) {
        foundTrack = true
        break
      }
    }

    // 只有在文件中途开始扫（startedAtZero=false）时，第一行才是残缺的半行要丢掉。
    // 从头开始扫的话第一行是完整的，丢掉会直接漏掉最近的那条曲目事件。
    let body = tailText
    if (!startedAtZero) {
      const firstNl = tailText.indexOf('\n')
      body = firstNl >= 0 ? tailText.slice(firstNl + 1) : ''
    } else if (body.length > 0 && body.charCodeAt(0) === 0x000a) {
      body = body.slice(1)
    }

    // 从最近一条曲目事件开始回放（之前的都是历史曲目，回放了也只会被后面的覆盖）
    if (foundTrack) {
      const a = body.lastIndexOf(MARK_TRACK_PLAY)
      const b = body.lastIndexOf(MARK_TRACK_PRIV)
      const cut = Math.max(a, b)
      if (cut > 0) {
        const lineStart = body.lastIndexOf('\n', cut)
        if (lineStart >= 0) body = body.slice(lineStart + 1)
      }
    }

    this.offset = st.size
    this.carry = Buffer.alloc(0)
    this.#replay(body, Date.now())
    this.available = !!this.track
    this.reason = this.track ? 'ok' : foundTrack ? 'track-incomplete' : 'no-track-yet'
    this.lastPollAt = Date.now()
  }

  #readBytes(start, length) {
    const fd = fs.openSync(this.filePath, 'r')
    try {
      const buf = Buffer.allocUnsafe(length)
      const read = fs.readSync(fd, buf, 0, length, start)
      return read === length ? buf : buf.subarray(0, read)
    } finally {
      fs.closeSync(fd)
    }
  }

  /** 增量读：只处理上次之后新增的字节 */
  poll() {
    if (this.stopped || !this.filePath) return
    this.pollCount += 1
    this.lastPollAt = Date.now()
    const st = this.#stat()
    if (!st || !st.isFile()) {
      this.available = false
      this.reason = 'log-missing'
      return
    }
    // 变小了说明日志被轮转/清空：从头重来
    if (st.size < this.offset) {
      this.offset = 0
      this.carry = Buffer.alloc(0)
      this.track = null
      this.songId = ''
      this.anchor = null
      this.reason = 'log-rotated'
      this.#preload()
      return
    }
    this.lastSize = st.size
    if (st.size === this.offset) return

    let chunk
    try {
      chunk = this.#readBytes(this.offset, st.size - this.offset)
    } catch (err) {
      this.errorCount += 1
      this.reason = `log-read-failed: ${err && err.message ? err.message : err}`
      return
    }
    this.offset = st.size

    // 只处理到最后一个换行字节，剩下的半行留给下次
    const merged = Buffer.concat([this.carry, chunk])
    const lastNl = merged.lastIndexOf(ENCODED_NEWLINE)
    if (lastNl < 0) {
      this.carry = merged.length > 1024 * 1024 ? Buffer.alloc(0) : merged
      return
    }
    const complete = merged.subarray(0, lastNl + 1)
    this.carry = Buffer.from(merged.subarray(lastNl + 1))
    this.#replay(decodeElog(complete), Date.now())
    if (this.track && !this.available) {
      this.available = true
      this.reason = 'ok'
    }
  }

  #replay(text, nowMs) {
    if (!text) return
    const uptimeNowMs = os.uptime() * 1000
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line || line.charCodeAt(0) !== 0x5b /* [ */) continue
      this.lineCount += 1
      const header = parseElogHeader(line)
      if (!header) continue
      if (header.pid) this.appPid = header.pid
      const ev = classifyLine(header.rest)
      if (!ev) continue
      const t = eventTimeOf(header, nowMs, uptimeNowMs)
      this.#apply(ev, header.rest, t)
    }
  }

  #apply(ev, rest, t) {
    switch (ev.type) {
      case 'track': {
        const raw = extractTrack(rest.slice(rest.indexOf('{')))
        if (!raw) return
        const track = {
          songId: raw.songId,
          title: unescapeJson(raw.title),
          artist: unescapeJson(raw.artist),
          album: unescapeJson(raw.album),
          durationMs: raw.durationMs,
        }
        const sameSong = this.track && this.track.songId === track.songId
        // 同一次起播会连发 playOneTrackInPlayingList + checkPlayPrivilege（同毫秒），
        // 只认第一次，别把锚点重置两遍
        const duplicate = sameSong && this.lastTrackStartAt > 0 && Math.abs(t - this.lastTrackStartAt) < 1500
        this.track = track
        this.songId = track.songId
        if (!duplicate) {
          this.anchor = { at: t, positionMs: 0 }
          this.pausing = false
          this.ended = false
        }
        this.lastTrackStartAt = t
        this.lastEventAt = t
        return
      }
      case 'started': {
        // 真正出声的那一刻，比 playOneTrack 准（中间隔了资源加载）
        const m = /"songId"\s*:\s*"(\d+)"/.exec(rest)
        const dur = /"songDuration"\s*:\s*"(\d+)"/.exec(rest)
        const id = m ? m[1] : ''
        if (id && (!this.track || this.track.songId !== id)) {
          // 详情还没到，先占位，等 checkPlayPrivilege 补全
          this.songId = id
          this.track = this.track || { songId: id, title: '', artist: '', album: '', durationMs: 0 }
          this.track.songId = id
        }
        if (dur && this.track && !this.track.durationMs) this.track.durationMs = Number(dur[1]) || 0
        this.anchor = { at: t, positionMs: 0 }
        this.pausing = false
        this.ended = false
        this.lastEventAt = t
        return
      }
      case 'state': {
        const pos = rest.indexOf(MARK_STATE)
        const restAfter = rest.slice(pos + MARK_STATE.length)
        const m = /^\s*,\s*(\d+)/.exec(restAfter)
        if (!m) return
        const flag = Number(m[1])
        // 切换锚点之前，先把当前位置算出来，否则会跳
        const at = this.#positionAt(t)
        this.anchor = { at: t, positionMs: at }
        this.pausing = flag === 2
        if (!this.pausing) this.ended = false
        // 顺带从 "553755659_7VEUXG" 里补 songId
        const idm = /"(\d+)_[^"]*"/.exec(restAfter)
        if (idm && this.track && !this.track.songId) {
          this.track.songId = idm[1]
          this.songId = idm[1]
        }
        this.lastEventAt = t
        return
      }
      case 'seek': {
        const pos = rest.indexOf(MARK_SEEK)
        const m = /^\s*,\s*(-?\d+(?:\.\d+)?)/.exec(rest.slice(pos + MARK_SEEK.length))
        if (!m) return
        const sec = Number(m[1])
        if (!Number.isFinite(sec) || sec < 0) return
        this.anchor = { at: t, positionMs: sec * 1000 }
        this.ended = false
        this.lastEventAt = t
        return
      }
      case 'end': {
        const dur = this.track && this.track.durationMs ? this.track.durationMs : 0
        this.anchor = { at: t, positionMs: dur }
        this.pausing = true
        this.ended = true
        this.lastEventAt = t
        return
      }
      case 'exit-app': {
        this.#reset()
        return
      }
      case 'exit-process': {
        const m = MARK_PROC_EXIT_RE.exec(rest)
        // 只有主进程退出才算；子进程（网络、音频线程）退出不影响播放
        if (m && this.appPid && Number(m[1]) === this.appPid) this.#reset()
        return
      }
      default:
        return
    }
  }

  #reset() {
    this.track = null
    this.songId = ''
    this.anchor = null
    this.pausing = true
    this.ended = false
    this.lastEventAt = Date.now()
    this.available = false
    this.reason = 'client-exited'
  }

  /** 某个时刻的位置（毫秒）。暂停时冻结在锚点 */
  #positionAt(nowMs) {
    if (!this.anchor) return 0
    const dur = this.track && this.track.durationMs ? this.track.durationMs : 0
    const delta = this.pausing ? 0 : Math.max(0, nowMs - this.anchor.at)
    const pos = this.anchor.positionMs + delta
    if (dur > 0) return Math.min(dur, Math.max(0, pos))
    return Math.max(0, pos)
  }

  /**
   * @param {number} [nowMs]
   * @returns {ElogState}
   */
  getState(nowMs = Date.now()) {
    const track = this.track && this.track.title ? this.track : null
    const durationMs = track && track.durationMs ? track.durationMs : 0
    return {
      available: !!(this.available && track),
      track,
      playing: !!track && !this.pausing && !this.ended,
      positionMs: track ? Math.round(this.#positionAt(nowMs)) : 0,
      durationMs,
      songId: track ? track.songId : '',
      lastEventAt: this.lastEventAt,
      reason: this.reason,
    }
  }

  /** /health?deep=1 用的诊断信息 */
  getDebug() {
    const st = this.#stat()
    return {
      path: this.filePath,
      exists: !!st,
      size: st ? st.size : 0,
      offset: this.offset,
      pollMs: this.pollMs,
      polls: this.pollCount,
      lines: this.lineCount,
      errors: this.errorCount,
      appPid: this.appPid,
      songId: this.songId,
      track: this.track,
      playing: !this.pausing && !this.ended,
      anchorAt: this.anchor ? this.anchor.at : 0,
      anchorPositionMs: this.anchor ? this.anchor.positionMs : 0,
      lastEventAt: this.lastEventAt,
      reason: this.reason,
      available: this.available,
    }
  }
}
