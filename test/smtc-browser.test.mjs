// smtc-browser.mjs 单元测试：mock PowerShell spawn，验证 JSON 解析 / seek tick 换算 / 失败降级 / 白名单
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SmtcBrowser, DEFAULT_BROWSER_AUMID } from '../lib/smtc-browser.mjs'

/** 造一个假的子进程：emit stdout 行 + close。 */
function fakeChild(stdoutLines, stderr = '') {
  const c = new EventEmitter()
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kill = () => {}
  setImmediate(() => {
    for (const l of stdoutLines) c.stdout.emit('data', Buffer.from(l + '\n'))
    if (stderr) c.stderr.emit('data', Buffer.from(stderr))
    c.emit('close', 0)
  })
  return c
}

test('readState 解析 probe 输出的 JSON（含中文标题、秒单位 pos/end）', async () => {
  const calls = []
  const s = new SmtcBrowser({
    spawnFactory: (exe, args) => { calls.push({ exe, args }); return fakeChild([
      JSON.stringify({ ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Paused', pos: 1.02, end: 272.97, aumid: 'msedge.exe' }),
    ]) },
  })
  const r = await s.readState()
  assert.equal(r.ok, true)
  assert.equal(r.title, '会呼吸的痛')
  assert.equal(r.pos, 1.02)
  assert.equal(r.end, 272.97)
  assert.match(calls[0].exe, /WindowsPowerShell.*powershell\.exe/, '必须用绝对路径 powershell.exe')
  assert.ok(calls[0].args.includes('-Action') && calls[0].args.includes('state'))
})

test('control seek 把 positionMs 毫秒传给 probe（底层再换算 100ns tick）', async () => {
  let captured
  const s = new SmtcBrowser({
    spawnFactory: (exe, args) => { captured = args; return fakeChild([JSON.stringify({ ok: true, action: 'seek' })]) },
  })
  const r = await s.control('seek', { positionMs: 30000 })
  assert.equal(r.ok, true)
  const i = captured.indexOf('-SeekMs')
  assert.ok(i >= 0)
  assert.equal(captured[i + 1], '30000')
})

test('probe 无 JSON / spawn 失败时返回 ok:false 不抛异常', async () => {
  const s1 = new SmtcBrowser({ spawnFactory: () => fakeChild(['not json'], 'probe crashed') })
  const r1 = await s1.readState()
  assert.equal(r1.ok, false)
  assert.equal(r1.error, 'smtc-unavailable')

  const s2 = new SmtcBrowser({ spawnFactory: () => { throw new Error('ENOENT') } })
  const r2 = await s2.readState()
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'smtc-unavailable')
  assert.match(r2.detail, /ENOENT/)
})

test('smtcEnabled=false 时不 spawn，直接返回 smtc-disabled', async () => {
  let spawned = false
  const s = new SmtcBrowser({
    getConfig: () => ({ smtcEnabled: false }),
    spawnFactory: () => { spawned = true; return fakeChild([]) },
  })
  const r = await s.readState()
  assert.equal(r.ok, false)
  assert.equal(r.error, 'smtc-disabled')
  assert.equal(spawned, false)
})

test('自定义浏览器 AUMID 白名单透传给 probe', async () => {
  let captured
  const s = new SmtcBrowser({
    getConfig: () => ({ smtcBrowserAumid: 'mybrowser\\.exe' }),
    spawnFactory: (exe, args) => { captured = args; return fakeChild([JSON.stringify({ ok: false, error: 'no-browser-music-session' })]) },
  })
  const r = await s.readState()
  assert.equal(r.ok, false)
  assert.equal(r.error, 'no-browser-music-session')
  const i = captured.indexOf('-AumidPattern')
  assert.equal(captured[i + 1], 'mybrowser\\.exe')
})

test('readState TTL 缓存：连续两次读只 spawn 一次，pos 按经过时间推进', async () => {
  let spawnCount = 0
  const s = new SmtcBrowser({
    cacheTtlMs: 1000,
    spawnFactory: (exe, args) => {
      spawnCount++
      return fakeChild([JSON.stringify({ ok: true, title: '晴天', artist: '周杰伦', status: 'Playing', pos: 10, end: 269, aumid: 'msedge.exe' })])
    },
  })
  const a = await s.readState()
  const b = await s.readState()
  assert.equal(a.pos, 10)
  assert.equal(spawnCount, 1, 'TTL 内第二次读不能重复 spawn PowerShell')
  assert.ok(b.pos >= 10, '缓存命中时进度按经过时间推进，不倒退')
  // 过期后重新 probe
  s._stateCacheAt = Date.now() - 5000
  await s.readState()
  assert.equal(spawnCount, 2, 'TTL 过期后要重新 probe')
})

test('readState 并发合并：同一瞬间多次读共享一次 probe', async () => {
  let spawnCount = 0
  const s = new SmtcBrowser({
    spawnFactory: () => { spawnCount++; return fakeChild([JSON.stringify({ ok: true, title: 'X', artist: '歌手X', status: 'Paused' })]) },
  })
  const [a, b, c] = await Promise.all([s.readState(), s.readState(), s.readState()])
  assert.equal(spawnCount, 1, '并发三次读只 spawn 一次')
  assert.equal(a.title, 'X')
  assert.equal(b.title, 'X')
  assert.equal(c.title, 'X')
})

test('control 后缓存失效，下一次 readState 重新 probe', async () => {
  let spawnCount = 0
  const s = new SmtcBrowser({
    spawnFactory: (exe, args) => {
      spawnCount++
      const isState = args.includes('state')
      return fakeChild([JSON.stringify(isState
        ? { ok: true, title: '旧歌', status: 'Playing', pos: 5, end: 200 }
        : { ok: true, action: args[args.indexOf('-Action') + 1] })])
    },
  })
  await s.readState()
  assert.equal(spawnCount, 1)
  await s.control('next')
  assert.equal(spawnCount, 2, 'control 本身 spawn 一次')
  await s.readState()
  assert.equal(spawnCount, 3, 'control 后旧缓存失效，readState 要重新 probe')
})

test('control(play) 回读 status 滞后仍推断为 Playing（歌词高亮节拍能起来）', async () => {
  // 真实 SMTC：刚点 play，probe 回读仍是 Paused；若不推断，前端 playing=false，歌词不动。
  const s = new SmtcBrowser({
    spawnFactory: (exe, args) => {
      const isState = args.includes('state')
      return fakeChild([JSON.stringify(isState
        ? { ok: true, title: '晴天', artist: '周杰伦', status: 'Paused', pos: 10, end: 269 }
        : { ok: true, title: '晴天', artist: '周杰伦', status: 'Paused', pos: 10, end: 269 })])
    },
  })
  await s.readState() // 先记录 before=Paused
  const r = await s.control('play')
  assert.equal(r.status, 'Playing', 'control 回读被判定为播放态，哪怕 probe 报 Paused')
  const cached = await s.readState()
  assert.equal(cached.status, 'Playing', '回填缓存也是 Playing，前端 200ms 节拍才起')
})

test('pos 锚点：SMTC 卡住不推进时进度靠时钟单调前进，不横跳回退', async () => {
  let probePos = 32
  const s = new SmtcBrowser({
    cacheTtlMs: 10, // 极短 TTL，逼每次都重新 probe
    spawnFactory: () => fakeChild([JSON.stringify({ ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Playing', pos: probePos, end: 272 })]),
  })
  const a = await s.readState()
  assert.equal(a.pos, 32)
  // 模拟播放 3 秒后 SMTC 探针仍卡在 32（Windows/Edge 上报滞后）
  await new Promise((r) => setTimeout(r, 60))
  const b = await s.readState()
  assert.ok(b.pos > 32, `锚点推进后的进度应 >32，实际 ${b.pos}`)
  assert.ok(b.pos <= 272, '进度不超 end')
  // 换歌：新 title 用探针新 pos，不套旧锚点
  probePos = 5
  s._stateCacheAt = 0
  s._posAnchor = { pos: 100, at: Date.now(), end: 200, title: '旧歌' }
  const c = await s.readState()
  assert.equal(c.pos, 5, '换歌后应重建锚点用探针新 pos，不把旧歌进度顶到新歌')
})

test('默认白名单包含 Edge/Chrome/Firefox', () => {
  assert.match(DEFAULT_BROWSER_AUMID, /msedge/)
  assert.match(DEFAULT_BROWSER_AUMID, /chrome/)
  assert.match(DEFAULT_BROWSER_AUMID, /firefox/)
})

test('视频抢占 SMTC 后用最近一次真实音乐（暂停态）兜底，不丢失识别', async () => {
  let probeResult = { ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Playing', pos: 10, end: 272, aumid: 'msedge.exe' }
  const s = new SmtcBrowser({
    spawnFactory: () => fakeChild([JSON.stringify(probeResult)]),
  })
  const first = await s.readState()
  assert.equal(first.title, '会呼吸的痛')
  assert.equal(first.sticky, undefined, '正常读到音乐时不应是兜底')

  // 用户去 B 站放视频：probe 找不到音乐会话了
  s.invalidate()
  probeResult = { ok: false, error: 'no-browser-music-session' }
  const sticky = await s.readState()
  assert.equal(sticky.ok, true, '视频抢占时应兜底返回 ok')
  assert.equal(sticky.title, '会呼吸的痛', '应记住刚才那首歌')
  assert.equal(sticky.artist, '梁静茹')
  assert.equal(sticky.status, 'Playing', '兜底应保留记住那一刻的真实播放态，不能被视频操作带成暂停')
  assert.equal(sticky.sticky, true)

  // 视频标题（无歌手）不应污染兜底记忆
  s.invalidate()
  probeResult = { ok: true, title: 'xxx_bilibili', artist: '', status: 'Playing', pos: 1, end: 100 }
  const video = await s.readState()
  assert.equal(video.title, '会呼吸的痛', '视频会话不能覆盖兜底记忆')
})

test('网易云暂停时 SMTC 清空 artist，但歌名与记住的一致 → 补回歌手照常识别', async () => {
  let probeResult = { ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Playing', pos: 10, end: 272, aumid: 'msedge.exe' }
  const s = new SmtcBrowser({ spawnFactory: () => fakeChild([JSON.stringify(probeResult)]) })
  const first = await s.readState()
  assert.equal(first.artist, '梁静茹')

  // 暂停后 SMTC 会话 artist 变空，但 title 仍是这首歌
  s.invalidate()
  probeResult = { ok: true, title: '会呼吸的痛', artist: '', status: 'Paused', pos: 20, end: 272, aumid: 'msedge.exe' }
  const paused = await s.readState()
  assert.equal(paused.ok, true, '暂停的歌应照常识别，不能被当成视频挡掉')
  assert.equal(paused.title, '会呼吸的痛')
  assert.equal(paused.artist, '梁静茹', '应用 sticky 记忆补回被清空的歌手')
  assert.equal(paused.status, 'Paused')
})

test('控制作业回读到视频标题时用 sticky 歌名覆盖，保持显示网易云歌', async () => {
  let controlResult = { ok: true, action: 'pause', title: 'xxx_bilibili', artist: '', status: 'Paused', pos: 5, end: 100 }
  const s = new SmtcBrowser({
    spawnFactory: () => fakeChild([JSON.stringify(controlResult)]),
  })
  // 模拟之前记住的网易云歌
  s._lastMusic = { ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Playing', pos: 100, end: 272, aumid: 'msedge.exe' }
  s._lastMusicAt = Date.now()

  const r = await s.control('pause', {})
  assert.equal(r.ok, true)
  assert.equal(r.title, '会呼吸的痛', '视频标题应被 sticky 歌名覆盖')
  assert.equal(r.artist, '梁静茹')
  assert.equal(r.status, 'Paused')
})

test('兜底记忆超时后不再返回旧歌', async () => {
  let probeResult = { ok: false, error: 'no-browser-music-session' }
  const s = new SmtcBrowser({
    stickyGraceMs: 50,
    spawnFactory: () => fakeChild([JSON.stringify(probeResult)]),
  })
  // 手动注入一条最近音乐（模拟之前读到过）
  s._lastMusic = { ok: true, title: '晴天', artist: '周杰伦', status: 'Playing', pos: 1, end: 269, aumid: 'msedge.exe' }
  s._lastMusicAt = Date.now()
  const hit = await s.readState()
  assert.equal(hit.title, '晴天')
  // 超时
  s.invalidate()
  await new Promise((r) => setTimeout(r, 80))
  const miss = await s.readState()
  assert.equal(miss.ok, false, '兜底超时后应如实报找不到')
})
