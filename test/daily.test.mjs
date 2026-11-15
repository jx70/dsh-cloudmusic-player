/**
 * test/daily.test.mjs —— lib/daily.mjs（日推取数）+ player 的 play_daily 分支
 * ============================================================================
 * 跑法：node --test test/daily.test.mjs
 *
 * 全部离线：cookie 解密与网络都打桩，不碰真机的 CEF profile。
 *
 * 这里盯的是几条容易回归的行为：
 *   1. 未登录时接口 200 + 空数组 —— 必须翻成「需要登录」，不能报「今天没有」；
 *   2. 401/403 与网络异常各走各的文案分支；
 *   3. 同日缓存命中不发第二次请求；连点两次共享第一次的 in-flight；
 *   4. PlayerService 把 helper 的 no-client / 其它错误翻成对外的错误码。
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DailyService, normalizeSongs } from '../lib/daily.mjs'
import { PlayerService } from '../lib/player.mjs'

// ---------------------------------------------------------------------------
// 造数据
// ---------------------------------------------------------------------------

/** 一条和真机响应同形的日推歌（字段只留用得上的） */
function song(id, name, artist, fee = 0) {
  return { id, name, ar: [{ name: artist }], fee }
}

function recommendBody(list) {
  return { code: 200, recommend: list }
}

/** 打桩的 fetchJson：记录调用，按顺序回放 */
function stubFetchJson(script) {
  const calls = []
  let i = 0
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    if (typeof step === 'function') return await step(url, opts)
    if (step instanceof Error) throw step
    return step
  }
  fn.calls = calls
  return fn
}

/** 打桩的 cookie 读取 */
function stubCookies(result) {
  const calls = []
  const fn = async (opts) => {
    calls.push(opts)
    return typeof result === 'function' ? result(opts) : result
  }
  fn.calls = calls
  return fn
}

const OK_COOKIE = { ok: true, cookie: 'MUSIC_U=abc; __csrf=def', uid: '42', profileDir: 'X' }

/** 把 PlayerService 里和助手进程无关的部分都换成桩 */
function fakePlayer({ daily, reply }) {
  const backend = {
    id: 'test',
    platform: 'win32',
    capabilities: { playback: true, sessionVolume: true, systemVolume: true, lyrics: true },
    command: () => ({ shell: 'x', args: [] }),
  }
  const player = new PlayerService({ backend, getConfig: () => ({}), log: () => {}, daily })
  const sent = []
  player.request = async (cmd, payload, timeoutMs) => {
    sent.push({ cmd, payload, timeoutMs })
    return typeof reply === 'function' ? reply(cmd, payload) : reply
  }
  player.state = async () => ({ ok: true, now: { title: '明天过后', artist: '张杰' }, volume: null })
  player.sent = sent
  return player
}

// ---------------------------------------------------------------------------
// normalizeSongs
// ---------------------------------------------------------------------------

test('normalizeSongs 认得 v1 的 recommend[]', () => {
  const songs = normalizeSongs(recommendBody([song(27588734, '明天过后', '张杰', 8)]))
  assert.equal(songs.length, 1)
  assert.deepEqual(songs[0], { id: '27588734', name: '明天过后', artist: '张杰', fee: 8 })
})

test('normalizeSongs 认得 v3 的 data.dailySongs[]', () => {
  const songs = normalizeSongs({ code: 200, data: { dailySongs: [song(1, 'A', 'B')] } })
  assert.equal(songs.length, 1)
  assert.equal(songs[0].id, '1')
})

test('normalizeSongs 丢掉没有 id 的项，账号字段兼容 artists', () => {
  const songs = normalizeSongs({
    recommend: [{ id: 0, name: 'bad' }, { id: 9, name: 'ok', artists: [{ name: 'X' }, { name: 'Y' }] }],
  })
  assert.equal(songs.length, 1)
  assert.equal(songs[0].artist, 'X/Y')
})

test('normalizeSongs 对空体 / 畸形体返回空数组', () => {
  assert.deepEqual(normalizeSongs(null), [])
  assert.deepEqual(normalizeSongs({}), [])
  assert.deepEqual(normalizeSongs({ recommend: 'nope' }), [])
})

// ---------------------------------------------------------------------------
// DailyService：正常路径
// ---------------------------------------------------------------------------

test('拿到歌单：带 cookie 打 v1 接口，返回归一化结果', async () => {
  const fetchJson = stubFetchJson([recommendBody([song(1, 'A', 'x'), song(2, 'B', 'y')])])
  const cookieLoader = stubCookies(OK_COOKIE)
  const daily = new DailyService({ cookieLoader, fetchJson, now: () => Date.parse('2026-11-15T10:00:00+08:00') })

  const res = await daily.fetch()
  assert.equal(res.ok, true)
  assert.equal(res.songs.length, 2)
  assert.equal(res.day, '2026-11-15')
  assert.equal(res.cached, false)
  assert.equal(fetchJson.calls.length, 1)
  assert.match(fetchJson.calls[0].url, /\/v1\/discovery\/recommend\/songs\?limit=50$/)
  assert.equal(fetchJson.calls[0].opts.cookie, OK_COOKIE.cookie)
  assert.ok(fetchJson.calls[0].opts.timeoutMs > 0)
})

test('同一天第二次走缓存，不再发请求', async () => {
  const fetchJson = stubFetchJson([recommendBody([song(1, 'A', 'x')])])
  const daily = new DailyService({ cookieLoader: stubCookies(OK_COOKIE), fetchJson })

  const first = await daily.fetch()
  const second = await daily.fetch()
  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(fetchJson.calls.length, 1)
})

test('force 跳过缓存', async () => {
  const fetchJson = stubFetchJson([recommendBody([song(1, 'A', 'x')]), recommendBody([song(2, 'B', 'y')])])
  const daily = new DailyService({ cookieLoader: stubCookies(OK_COOKIE), fetchJson })

  await daily.fetch()
  const forced = await daily.fetch({ force: true })
  assert.equal(fetchJson.calls.length, 2)
  assert.equal(forced.songs[0].id, '2')
})

test('跨天缓存失效', async () => {
  const fetchJson = stubFetchJson([recommendBody([song(1, 'A', 'x')])])
  let clock = Date.parse('2026-11-15T10:00:00+08:00')
  const daily = new DailyService({ cookieLoader: stubCookies(OK_COOKIE), fetchJson, now: () => clock })

  await daily.fetch()
  clock = Date.parse('2026-11-16T00:05:00+08:00')
  const next = await daily.fetch()
  assert.equal(next.cached, false)
  assert.equal(next.day, '2026-11-16')
  assert.equal(fetchJson.calls.length, 2)
})

test('并发两个 fetch 只打一次接口（in-flight 合并）', async () => {
  const fetchJson = stubFetchJson([recommendBody([song(1, 'A', 'x')])])
  const daily = new DailyService({ cookieLoader: stubCookies(OK_COOKIE), fetchJson })

  const [a, b] = await Promise.all([daily.fetch(), daily.fetch()])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(fetchJson.calls.length, 1)
})

test('limit 被配置限制在 1..200', async () => {
  const fetchJson = stubFetchJson([recommendBody([song(1, 'A', 'x')])])
  const daily = new DailyService({
    getConfig: () => ({ dailyLimit: 500 }),
    cookieLoader: stubCookies(OK_COOKIE),
    fetchJson,
  })
  await daily.fetch()
  assert.match(fetchJson.calls[0].url, /limit=200$/)
})

test('dailyApiBase 的尾部斜杠会被吃掉', async () => {
  const fetchJson = stubFetchJson([recommendBody([song(1, 'A', 'x')])])
  const daily = new DailyService({
    getConfig: () => ({ dailyApiBase: 'https://example.test/api//' }),
    cookieLoader: stubCookies(OK_COOKIE),
    fetchJson,
  })
  await daily.fetch()
  assert.equal(fetchJson.calls[0].url, 'https://example.test/api/v1/discovery/recommend/songs?limit=50')
})

// ---------------------------------------------------------------------------
// DailyService：失败路径
// ---------------------------------------------------------------------------

test('空列表 = 需要登录（未登录时接口 200 + 空数组，不是 401）', async () => {
  const daily = new DailyService({
    cookieLoader: stubCookies(OK_COOKIE),
    fetchJson: stubFetchJson([{ code: 200, recommend: [] }]),
  })
  const res = await daily.fetch()
  assert.equal(res.ok, false)
  assert.equal(res.error, 'daily-needs-login')
  assert.match(res.message, /登录/)
})

test('压根没 cookie 也是 needs-login，但 detail 标出来', async () => {
  const daily = new DailyService({
    cookieLoader: stubCookies({ ok: false, error: 'cookie-missing' }),
    fetchJson: stubFetchJson([{ code: 200, recommend: [] }]),
  })
  const res = await daily.fetch()
  assert.equal(res.ok, false)
  assert.equal(res.error, 'daily-needs-login')
  assert.equal(res.detail, 'no cookie')
})

test('cookie 解不开 → daily-no-cookie', async () => {
  const daily = new DailyService({
    cookieLoader: stubCookies({ ok: false, error: 'cookie-unsupported', detail: 'DPAPI failed' }),
    fetchJson: stubFetchJson([recommendBody([song(1, 'A', 'x')])]),
  })
  const res = await daily.fetch()
  assert.equal(res.ok, false)
  assert.equal(res.error, 'daily-no-cookie')
  assert.match(res.message, /登录/)
})

test('HTTP 401 → daily-needs-login', async () => {
  const err = new Error('HTTP 401')
  err.status = 401
  const daily = new DailyService({ cookieLoader: stubCookies(OK_COOKIE), fetchJson: stubFetchJson([err]) })
  const res = await daily.fetch()
  assert.equal(res.error, 'daily-needs-login')
})

test('HTTP 403 → daily-needs-login', async () => {
  const err = new Error('HTTP 403')
  err.status = 403
  const daily = new DailyService({ cookieLoader: stubCookies(OK_COOKIE), fetchJson: stubFetchJson([err]) })
  const res = await daily.fetch()
  assert.equal(res.error, 'daily-needs-login')
})

test('网络异常 → daily-network', async () => {
  const daily = new DailyService({
    cookieLoader: stubCookies(OK_COOKIE),
    fetchJson: stubFetchJson([new Error('getaddrinfo ENOTFOUND music.163.com')]),
  })
  const res = await daily.fetch()
  assert.equal(res.error, 'daily-network')
  assert.match(res.detail, /ENOTFOUND/)
})

test('HTTP 500 → daily-network（不是 needs-login）', async () => {
  const err = new Error('HTTP 500')
  err.status = 500
  const daily = new DailyService({ cookieLoader: stubCookies(OK_COOKIE), fetchJson: stubFetchJson([err]) })
  const res = await daily.fetch()
  assert.equal(res.error, 'daily-network')
})

test('cookie 读取自身抛错时降级成无 cookie 继续请求', async () => {
  const daily = new DailyService({
    cookieLoader: stubCookies(() => {
      throw new Error('boom')
    }),
    fetchJson: stubFetchJson([recommendBody([song(1, 'A', 'x')])]),
  })
  const res = await daily.fetch()
  assert.equal(res.ok, true)
})

test('失败不进缓存：下一次还会重试', async () => {
  const err = new Error('HTTP 500')
  err.status = 500
  const fetchJson = stubFetchJson([err, recommendBody([song(1, 'A', 'x')])])
  const daily = new DailyService({ cookieLoader: stubCookies(OK_COOKIE), fetchJson })

  const bad = await daily.fetch()
  assert.equal(bad.ok, false)
  const good = await daily.fetch()
  assert.equal(good.ok, true)
  assert.equal(fetchJson.calls.length, 2)
})

// ---------------------------------------------------------------------------
// PlayerService.play_daily
// ---------------------------------------------------------------------------

function dailyStub(result) {
  const calls = []
  return {
    calls,
    async fetch(opts) {
      calls.push(opts)
      return typeof result === 'function' ? result() : result
    },
  }
}

test('play_daily：没装 daily 服务时给 daily-unavailable', async () => {
  const player = fakePlayer({ daily: null, reply: { ok: true } })
  const res = await player.action('play_daily')
  assert.equal(res.ok, false)
  assert.equal(res.error, 'daily-unavailable')
})

test('play_daily：成功时投一条 playDaily，回填 now/首曲/数量', async () => {
  const daily = dailyStub({
    ok: true,
    day: '2026-11-15',
    cached: false,
    songs: [
      { id: '27588734', name: '明天过后', artist: '张杰' },
      { id: '3355872819', name: 'The truth', artist: 'Pianoboy' },
    ],
  })
  const player = fakePlayer({ daily, reply: { ok: true, channel: 'native' } })

  const res = await player.action('play_daily')
  assert.equal(res.ok, true)
  assert.equal(res.songCount, 2)
  assert.deepEqual(res.firstSong, { id: '27588734', name: '明天过后', artist: '张杰' })
  assert.equal(res.now.title, '明天过后')
  assert.equal(player.sent.length, 1)
  assert.equal(player.sent[0].cmd, 'playDaily')
  assert.deepEqual(player.sent[0].payload.ids, ['27588734', '3355872819'])
  assert.equal(player.sent[0].payload.first, '27588734')
  // 起播要等客户端拉详情，超时给得比普通动作宽
  assert.ok(player.sent[0].timeoutMs >= 10000)
})

test('play_daily：列表为空 → daily-empty（不是 needs-login）', async () => {
  const daily = dailyStub({ ok: true, day: '2026-11-15', cached: false, songs: [] })
  const player = fakePlayer({ daily, reply: { ok: true } })
  const res = await player.action('play_daily')
  assert.equal(res.ok, false)
  assert.equal(res.error, 'daily-empty')
})

test('play_daily：取数失败原样透传错误码与文案', async () => {
  const daily = dailyStub({ ok: false, error: 'daily-needs-login', message: '请先在网易云客户端登录后再试' })
  const player = fakePlayer({ daily, reply: { ok: true } })
  const res = await player.action('play_daily')
  assert.equal(res.ok, false)
  assert.equal(res.error, 'daily-needs-login')
  assert.match(res.message, /登录/)
  assert.equal(player.sent.length, 0)
})

test('play_daily：daily.fetch 抛错 → daily-network', async () => {
  const daily = dailyStub(() => {
    throw new Error('kaboom')
  })
  const player = fakePlayer({ daily, reply: { ok: true } })
  const res = await player.action('play_daily')
  assert.equal(res.error, 'daily-network')
  assert.match(res.detail, /kaboom/)
})

test('play_daily：客户端没开 → daily-no-client', async () => {
  const daily = dailyStub({ ok: true, day: 'd', cached: false, songs: [{ id: '1', name: 'A', artist: 'x' }] })
  const player = fakePlayer({ daily, reply: { ok: false, error: 'no-client', detail: '网易云客户端没在运行' } })
  const res = await player.action('play_daily')
  assert.equal(res.ok, false)
  assert.equal(res.error, 'daily-no-client')
  assert.match(res.message, /先打开/)
})

test('play_daily：helper 别的错误 → daily-failed，detail 带错误码', async () => {
  const daily = dailyStub({ ok: true, day: 'd', cached: false, songs: [{ id: '1', name: 'A', artist: 'x' }] })
  const player = fakePlayer({ daily, reply: { ok: false, error: 'play-failed', detail: 'shell-error:5' } })
  const res = await player.action('play_daily')
  assert.equal(res.error, 'daily-failed')
  assert.match(res.detail, /play-failed/)
  assert.match(res.detail, /shell-error:5/)
})

test('play_daily：连点两次只投一次（in-flight 合并）', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const daily = {
    async fetch() {
      await gate
      return { ok: true, day: 'd', cached: false, songs: [{ id: '1', name: 'A', artist: 'x' }] }
    },
  }
  const player = fakePlayer({ daily, reply: { ok: true, channel: 'native' } })

  const first = player.action('play_daily')
  const second = player.action('play_daily')
  release()
  const [a, b] = await Promise.all([first, second])

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(b.deduped, true)
  assert.equal(player.sent.length, 1, '第二次不应该再投 playDaily')
})
