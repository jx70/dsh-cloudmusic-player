/**
 * test/elog.test.mjs —— lib/elog.mjs 的单元测试
 * ============================================================================
 * 跑法：node --test test/
 *
 * 全部用**合成日志**，不依赖真机、不依赖 Windows：先用 encodeElog 把明文编成
 * 客户端那种字节，再喂给 ElogWatcher。这样能精确构造边界情况（半行、轮转、
 * 截断的 JSON、exitApp）。
 * ============================================================================
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DECODE_TABLE,
  ENCODED_NEWLINE,
  decodeElog,
  encodeElog,
  parseElogHeader,
  eventTimeOf,
  extractTrack,
  classifyLine,
  ElogWatcher,
  defaultElogPath,
} from '../lib/elog.mjs'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

let seq = 0
const madeDirs = []
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elog-test-'))
  madeDirs.push(dir)
  return path.join(dir, `cloudmusic-${seq++}.elog`)
}

after(() => {
  for (const dir of madeDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 收尾失败不影响结论 */
    }
  }
})

const PID = 16488

/**
 * 造一行日志。
 * @param {string} rest        「【playing】,`"xxx`"」之后的部分，例如 `,"native播放state",1,"123_abc"`
 * @param {number} agoMs       事件发生在多少毫秒之前
 * @param {string} [tag]       `【playing】` 这类分类标签
 */
function line(rest, agoMs = 0, tag = '【playing】') {
  const uptimeMs = Math.round(os.uptime() * 1000 - agoMs)
  const wall = new Date(Date.now() - agoMs)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${pad(wall.getMonth() + 1)}${pad(wall.getDate())}/${pad(wall.getHours())}${pad(
    wall.getMinutes(),
  )}${pad(wall.getSeconds())}`
  const wallText = `${wall.getFullYear()}-${pad(wall.getMonth() + 1)}-${pad(wall.getDate())} ${pad(
    wall.getHours(),
  )}:${pad(wall.getMinutes())}:${pad(wall.getSeconds())}`
  return `[${PID}:1792:${stamp}:${uptimeMs}:INFO:app.cpp(1231)] [${wallText}] ${tag}${rest}`
}

/** 造「曲目详情」那条（playOneTrackInPlayingList / checkPlayPrivilege 同形） */
function trackLine({ id, name, artist, duration }, agoMs, kind = 'playOneTrackInPlayingList') {
  const json = `{"id":"${id}","displayOrder":1,"track":{"id":"${id}","duration":${duration},"name":"${name}","artists":[{"id":"1","name":"${artist}"}],"album":{"id":"2","name":"专辑名"}}}`
  return line(`,"${kind}",${json}`, agoMs)
}

const startedLine = (id, duration, agoMs) =>
  line(`,"native播放资源load完成，开始播放",{"songId":"${id}","songDuration":"${duration}"}`, agoMs)

const stateLine = (flag, id, agoMs) => line(`,"native播放state",${flag},"${id}_7VEUXG"`, agoMs)

const seekLine = (sec, agoMs) => line(`,"setPlayingPosition",${sec}`, agoMs)

const endLine = (playedTime, agoMs) =>
  line(`,"onPlayEnd handle reason",{"reason":"end","code":0,"playedTime":${playedTime}}`, agoMs)

function writeLog(file, lines) {
  const bytes = Buffer.concat(lines.map((t) => encodeElog(t + '\n')))
  fs.writeFileSync(file, bytes)
  return bytes
}

function appendLog(file, lines) {
  fs.appendFileSync(file, Buffer.concat(lines.map((t) => encodeElog(t + '\n'))))
}

// ---------------------------------------------------------------------------
// 编解码
// ---------------------------------------------------------------------------

test('DECODE_TABLE 是一一映射（反表存在且无冲突）', () => {
  const seen = new Set()
  for (let b = 0; b < 256; b += 1) {
    const out = DECODE_TABLE[b]
    assert.ok(out >= 0 && out < 256)
    assert.equal(seen.has(out), false, `输出字节 ${out} 重复`)
    seen.add(out)
  }
  assert.equal(seen.size, 256)
})

test('ENCODED_NEWLINE 是换行字节的编码值', () => {
  const enc = encodeElog('\n')
  assert.equal(enc.length, 1)
  assert.equal(ENCODED_NEWLINE, enc[0])
  // 反过来解回去必须是 0x0A
  assert.equal(decodeElog(Buffer.from([ENCODED_NEWLINE])), '\n')
})

test('encodeElog / decodeElog 往返，含中文与 emoji', () => {
  const text = '【playing】,"可不可以",张紫豪 — 专辑《可不可以》🎵\n第二行'
  const round = decodeElog(encodeElog(text))
  assert.equal(round, text)
})

// ---------------------------------------------------------------------------
// 行解析
// ---------------------------------------------------------------------------

test('parseElogHeader 解出 pid / uptime / 墙钟 / 正文', () => {
  const l = line(',"native播放state",2,"553755659_7VEUXG"', 1000)
  const h = parseElogHeader(l)
  assert.ok(h)
  assert.equal(h.pid, PID)
  assert.ok(h.uptimeMs > 0)
  assert.ok(h.wallMs > 0)
  assert.equal(h.rest, ',"native播放state",2,"553755659_7VEUXG"')
})

test('parseElogHeader 对垃圾行返回 null', () => {
  assert.equal(parseElogHeader(''), null)
  assert.equal(parseElogHeader('not a log line at all'), null)
  assert.equal(parseElogHeader('{"uniKey":"page:dailyRecommend"}'), null)
})

test('eventTimeOf：uptime 与墙钟一致时用 uptime（毫秒精度）', () => {
  const now = Date.now()
  const uptimeNow = os.uptime() * 1000
  const h = parseElogHeader(line(',"x"', 3000))
  const t = eventTimeOf(h, now, uptimeNow)
  assert.ok(Math.abs(t - (now - 3000)) < 1500, `偏差 ${Math.abs(t - (now - 3000))}ms`)
})

test('eventTimeOf：墙钟与 uptime 差超过 5 秒时改用墙钟', () => {
  const now = Date.now()
  const uptimeNow = os.uptime() * 1000
  // 造一条「uptime 说 1 小时前、墙钟说 2 分钟前」的行 —— 模拟待机后 uptime 漂移
  const h = { pid: PID, uptimeMs: Math.round(uptimeNow - 3600_000), wallMs: now - 120_000, rest: '' }
  const t = eventTimeOf(h, now, uptimeNow)
  assert.equal(t, now - 120_000)
})

// ---------------------------------------------------------------------------
// 曲目字段
// ---------------------------------------------------------------------------

test('extractTrack 能从被截断的 JSON 里取字段', () => {
  // checkPlayPrivilege 这条日志在真机上就是截断的（末尾半句不是合法 JSON）
  const text =
    '{"id":"553755659","duration":240889,"name":"可不可以","artists":[{"id":"13906123","name":"张紫豪"}],"album":{"id":"38385235","name":"可不可以"},"originResourceType","track","scene",'
  const t = extractTrack(text)
  assert.deepEqual(t, {
    songId: '553755659',
    title: '可不可以',
    artist: '张紫豪',
    album: '可不可以',
    durationMs: 240889,
  })
})

test('extractTrack 对没有 id / name 的片段返回 null', () => {
  assert.equal(extractTrack('{"foo":1}'), null)
  assert.equal(extractTrack('{"id":"1"}'), null)
  assert.equal(extractTrack(undefined), null)
})

test('classifyLine 区分「开始load」与「load完成，开始播放」', () => {
  // 「native播放资源开始load」是另一条事件（还没出声），不能当成起播
  assert.equal(classifyLine(',"native播放资源开始load",{"songId":"1"}'), null)
  assert.equal(classifyLine(',"native播放资源load完成，开始播放",{"songId":"1"}').type, 'started')
})

test('classifyLine 识别全部六类事件', () => {
  assert.equal(classifyLine(trackLine({ id: '1', name: 'a', artist: 'b', duration: 1 }, 0).split('】,')[1]).type, 'track')
  assert.equal(classifyLine(',"native播放state",1,"1_x"').type, 'state')
  assert.equal(classifyLine(',"setPlayingPosition",12.5').type, 'seek')
  assert.equal(classifyLine(',"onPlayEnd handle reason",{"playedTime":1}').type, 'end')
  assert.equal(classifyLine(',exitApp').type, 'exit-app')
  assert.equal(classifyLine(',Process 16488 exited').type, 'exit-process')
  assert.equal(classifyLine(',"unrelated","event"'), null)
})

// ---------------------------------------------------------------------------
// Watcher：主流程
// ---------------------------------------------------------------------------

test('Watcher 从尾部预载并算出位置', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '553755659', name: '可不可以', artist: '张紫豪', duration: 240889 }, 30_000),
    startedLine('553755659', 240889, 29_900),
    stateLine(1, '553755659', 29_800),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const s = w.getState()
    assert.equal(s.available, true)
    assert.equal(s.playing, true)
    assert.equal(s.songId, '553755659')
    assert.equal(s.durationMs, 240889)
    assert.equal(s.track.title, '可不可以')
    // 起播在 29.9 秒前 → 位置应接近 29.9 秒
    assert.ok(s.positionMs > 28_000 && s.positionMs < 31_500, `pos=${s.positionMs}`)
  } finally {
    w.stop()
  }
})

test('Watcher：暂停后位置冻结，恢复后继续', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '1', name: '暂停测试', artist: 'A', duration: 300_000 }, 60_000),
    startedLine('1', 300_000, 60_000),
    stateLine(2, '1', 20_000), // 20 秒前暂停，那时已播 40 秒
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const paused = w.getState()
    assert.equal(paused.playing, false)
    assert.ok(Math.abs(paused.positionMs - 40_000) < 1500, `pos=${paused.positionMs}`)

    // 恢复播放
    appendLog(file, [stateLine(1, '1', 0)])
    w.poll()
    const resumed = w.getState()
    assert.equal(resumed.playing, true)
    assert.ok(Math.abs(resumed.positionMs - 40_000) < 2000, `pos=${resumed.positionMs}`)
  } finally {
    w.stop()
  }
})

test('Watcher：seek 会把锚点挪过去', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '1', name: '拖拽', artist: 'A', duration: 300_000 }, 60_000),
    startedLine('1', 300_000, 60_000),
    seekLine(137.611, 5000),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const s = w.getState()
    // 5 秒前拖到 137.611 秒 → 现在约 142.6 秒
    assert.ok(Math.abs(s.positionMs - 142_600) < 1500, `pos=${s.positionMs}`)
  } finally {
    w.stop()
  }
})

test('Watcher：播完后位置夹在时长上，且不再算 playing', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '1', name: '播完', artist: 'A', duration: 100_000 }, 200_000),
    startedLine('1', 100_000, 200_000),
    endLine(100_000, 100_000),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const s = w.getState()
    assert.equal(s.playing, false)
    assert.equal(s.positionMs, 100_000)
  } finally {
    w.stop()
  }
})

test('Watcher：位置永远不超过时长', () => {
  const file = tmpFile()
  // 起播在 10 分钟前，但歌只有 100 秒
  writeLog(file, [
    trackLine({ id: '1', name: '越界', artist: 'A', duration: 100_000 }, 600_000),
    startedLine('1', 100_000, 600_000),
    stateLine(1, '1', 599_000),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    assert.equal(w.getState().positionMs, 100_000)
  } finally {
    w.stop()
  }
})

test('Watcher：切歌后曲目与位置都换新', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '1', name: '第一首', artist: 'A', duration: 200_000 }, 120_000),
    startedLine('1', 200_000, 120_000),
    trackLine({ id: '2', name: '第二首', artist: 'B', duration: 180_000 }, 10_000),
    startedLine('2', 180_000, 9_900),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const s = w.getState()
    assert.equal(s.songId, '2')
    assert.equal(s.track.title, '第二首')
    assert.ok(s.positionMs > 8_000 && s.positionMs < 12_000, `pos=${s.positionMs}`)
  } finally {
    w.stop()
  }
})

test('Watcher：exitApp 后状态清空', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '1', name: '退出', artist: 'A', duration: 100_000 }, 10_000),
    startedLine('1', 100_000, 10_000),
    line(',exitApp', 1000),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const s = w.getState()
    assert.equal(s.available, false)
    assert.equal(s.track, null)
  } finally {
    w.stop()
  }
})

test('Watcher：子进程退出不影响，主进程退出才清空', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '1', name: '子进程', artist: 'A', duration: 100_000 }, 10_000),
    startedLine('1', 100_000, 10_000),
    line(',Process 999999 exited', 5000),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    assert.equal(w.getState().available, true)
    appendLog(file, [line(',Process 16488 exited', 0)])
    w.poll()
    assert.equal(w.getState().available, false)
  } finally {
    w.stop()
  }
})

// ---------------------------------------------------------------------------
// Watcher：增量读的边界
// ---------------------------------------------------------------------------

test('Watcher：半行被劈开时不产生乱码，补齐后再解', () => {
  const file = tmpFile()
  writeLog(file, [trackLine({ id: '1', name: '半行', artist: 'A', duration: 100_000 }, 5000)])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    // 只有曲目事件时按「正在播」处理（歌曲详情到达就表示起播）
    assert.equal(w.getState().playing, true)

    // 追加「暂停」那条日志的一半字节（故意劈在中文中间）
    const whole = encodeElog(stateLine(2, '1', 0) + '\n')
    fs.appendFileSync(file, whole.subarray(0, 40))
    w.poll()
    assert.equal(w.getState().playing, true, '半行不该被解析成事件')

    // 补齐剩下的字节
    fs.appendFileSync(file, whole.subarray(40))
    w.poll()
    const s = w.getState()
    assert.equal(s.playing, false, '补齐后应解出暂停事件')
    assert.ok(!JSON.stringify(s.track).includes('\uFFFD'), '出现了替换字符，说明劈开了 UTF-8')
    assert.equal(s.track.title, '半行')
  } finally {
    w.stop()
  }
})

test('Watcher：日志被轮转（变小）后重新预载', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '1', name: '旧', artist: 'A', duration: 100_000 }, 60_000),
    startedLine('1', 100_000, 60_000),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    assert.equal(w.getState().track.title, '旧')

    // 模拟轮转：整个文件被新内容替换，且更小
    fs.writeFileSync(
      file,
      Buffer.concat([
        encodeElog(trackLine({ id: '2', name: '新', artist: 'B', duration: 50_000 }, 3000) + '\n'),
        encodeElog(startedLine('2', 50_000, 2900) + '\n'),
      ]),
    )
    w.poll()
    const s = w.getState()
    assert.equal(s.track.title, '新')
    assert.equal(s.songId, '2')
  } finally {
    w.stop()
  }
})

test('Watcher：日志不存在时 available=false 且不抛', () => {
  const w = new ElogWatcher({ filePath: path.join(os.tmpdir(), 'no-such-dir', 'none.elog') })
  w.start()
  try {
    const s = w.getState()
    assert.equal(s.available, false)
    assert.equal(s.track, null)
    assert.equal(w.getDebug().exists, false)
    w.poll() // 不该抛
  } finally {
    w.stop()
  }
})

test('Watcher：日志里还没有曲目事件时如实报 no-track-yet', () => {
  const file = tmpFile()
  writeLog(file, [line(',"some unrelated event",1', 1000)])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const s = w.getState()
    assert.equal(s.available, false)
    assert.equal(s.reason, 'no-track-yet')
  } finally {
    w.stop()
  }
})

test('Watcher：同一次起播的两条 track 日志不会把锚点重置两遍', () => {
  const file = tmpFile()
  writeLog(file, [
    trackLine({ id: '1', name: '双条', artist: 'A', duration: 200_000 }, 20_000, 'playOneTrackInPlayingList'),
    trackLine({ id: '1', name: '双条', artist: 'A', duration: 200_000 }, 20_000, 'checkPlayPrivilege'),
  ])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const s = w.getState()
    assert.ok(s.positionMs > 19_000 && s.positionMs < 21_500, `pos=${s.positionMs}`)
  } finally {
    w.stop()
  }
})

test('Watcher：只有 started 没有详情时先占位 songId', () => {
  const file = tmpFile()
  writeLog(file, [startedLine('777', 123_000, 1000)])
  const w = new ElogWatcher({ filePath: file })
  w.start()
  try {
    const d = w.getDebug()
    assert.equal(d.songId, '777')
    assert.equal(w.getState().available, false, '没有歌名时不算可用')

    appendLog(file, [trackLine({ id: '777', name: '补全', artist: 'Z', duration: 123_000 }, 0)])
    w.poll()
    const s = w.getState()
    assert.equal(s.available, true)
    assert.equal(s.track.title, '补全')
    assert.equal(s.durationMs, 123_000)
  } finally {
    w.stop()
  }
})

test('defaultElogPath 在非 Windows 上返回空串', () => {
  if (process.platform === 'win32') {
    assert.ok(defaultElogPath().endsWith(path.join('NetEase', 'CloudMusic', 'cloudmusic.elog')))
  } else {
    assert.equal(defaultElogPath(), '')
  }
})
