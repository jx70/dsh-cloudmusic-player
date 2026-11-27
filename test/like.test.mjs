/**
 * test/like.test.mjs —— lib/like.mjs（红心）+ player 的 like 分支
 * ============================================================================
 * 跑法：node --test test/like.test.mjs
 *
 * 全部离线：cookie 解密与网络都打桩，不碰真机 CEF profile、不打真接口。
 *
 * 盯住几条容易回归的行为：
 *   1. csrfOf / normalizeLiked 认得网易云那几种返回形状（含 check 的命中 id 列表）；
 *   2. isLiked 打 /song/like/check 带 trackIds，按 songId 缓存 60s，同 id 查询 in-flight 合并；
 *   3. setLiked 写对 form 字段（trackId/like/csrf_token），成功后写缓存；
 *   4. 未登录 / 网络异常各走各的错误码；
 *   5. PlayerService.action('like') 用 elog 的 songId、回填 liked。
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LikeService, csrfOf, normalizeLiked, classifyLikeError, DEFAULT_API_BASE } from '../lib/like.mjs'
import { PlayerService } from '../lib/player.mjs'

const OK_COOKIE = { ok: true, cookie: 'MUSIC_U=abc; __csrf=tok42', uid: '42', profileDir: 'X' }

/** 打桩 fetchJson：记录调用，按顺序回放 */
function stubFetch(script) {
  const calls = []
  let i = 0
  const fn = async (url, fields, opts) => {
    calls.push({ url, fields, opts })
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    if (typeof step === 'function') return await step(url, fields, opts)
    if (step instanceof Error) throw step
    return step
  }
  fn.calls = calls
  return fn
}

/** 固定时钟，方便测 60s 缓存 */
function svc({ fetchJson, cookie = OK_COOKIE, getConfig = () => ({}), log } = {}) {
  let clock = 1_000_000
  const s = new LikeService({
    getConfig,
    log: log || (() => {}),
    cookieLoader: async () => (typeof cookie === 'function' ? cookie() : cookie),
    fetchJson: fetchJson || stubFetch([]),
    now: () => clock,
  })
  s.__advance = (ms) => (clock += ms)
  return s
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('csrfOf 从 cookie 串里取 __csrf（含 URL 编码）', () => {
  assert.equal(csrfOf('MUSIC_U=abc; __csrf=tok42'), 'tok42')
  assert.equal(csrfOf('__csrf=a%2Bb; other=1'), 'a+b')
  assert.equal(csrfOf('MUSIC_U=abc'), '')
  assert.equal(csrfOf(''), '')
})

test('classifyLikeError 把下架歌的 401 和真需要登录的 401 分开', () => {
  // 下架/版权类 401 → 新错误码，不再误报 like-needs-login（前端会硬映射成「请先登录客户端」）
  assert.equal(classifyLikeError(401, '下架歌曲无法收藏'), 'like-unavailable-song')
  assert.equal(classifyLikeError(401, '该歌曲版权受限，无法收藏'), 'like-unavailable-song')
  assert.equal(classifyLikeError(301, '歌曲已下线'), 'like-unavailable-song')
  assert.equal(classifyLikeError(401, 'This song is unavailable'), 'like-unavailable-song')
  // 真正的需要登录 → 保留 like-needs-login
  assert.equal(classifyLikeError(401, '需要登录'), 'like-needs-login')
  assert.equal(classifyLikeError(301, ''), 'like-needs-login')
  assert.equal(classifyLikeError(401), 'like-needs-login')
  // 非 301/401 → like-failed
  assert.equal(classifyLikeError(500, '下架歌曲无法收藏'), 'like-failed')
  assert.equal(classifyLikeError(200), 'like-failed')
})

test('normalizeLiked 认得 map / 数组 / 布尔多种形状', () => {
  assert.equal(normalizeLiked({ songs: { '123': true, '456': false } }, 123), true)
  assert.equal(normalizeLiked({ songs: { '123': true } }, '123'), true)
  assert.equal(normalizeLiked({ data: { '456': false } }, 456), false)
  assert.equal(normalizeLiked({ songs: [{ id: 123, liked: true }] }, 123), true)
  assert.equal(normalizeLiked({ data: [{ songId: '456', starred: 1 }] }, 456), true)
  assert.equal(normalizeLiked({ liked: false }, 999), false)
  assert.equal(normalizeLiked({ songs: { '123': true } }, 999), null)
  assert.equal(normalizeLiked({}, 123), null)
  assert.equal(normalizeLiked({ songs: { '123': 1 } }, 123), true)
  assert.equal(normalizeLiked({ songs: { '123': 'false' } }, 123), false)
})

test('normalizeLiked 认得 /song/like/check 的命中 id 数组（主用形状）', () => {
  // check 只返回已喜欢的 id：命中 true，不在数组里 false，空数组 false
  assert.equal(normalizeLiked({ ids: [1859245776, 999], code: 200 }, 1859245776), true)
  assert.equal(normalizeLiked({ ids: [1859245776, 999], code: 200 }, 12345), false)
  assert.equal(normalizeLiked({ ids: ['1859245776'], code: 200 }, '1859245776'), true)
  assert.equal(normalizeLiked({ ids: [], code: 200 }, 1859245776), false)
  // 大 id 以字符串传入时按原样比对，不能被 Number 精度改写
  assert.equal(normalizeLiked({ ids: ['9007199254740993'], code: 200 }, '9007199254740993'), true)
})

test('DEFAULT_API_BASE 是网易云接口前缀', () => {
  assert.equal(DEFAULT_API_BASE, 'https://music.163.com/api')
})

// ---------------------------------------------------------------------------
// LikeService.isLiked
// ---------------------------------------------------------------------------

test('isLiked 打 /song/like/check，带 trackIds 与 csrf_token，并写缓存', async () => {
  const fetchJson = stubFetch([{ code: 200, ids: [123] }])
  const s = svc({ fetchJson })
  const res = await s.isLiked(123)
  assert.deepEqual(res, { ok: true, liked: true, cached: false })
  assert.equal(fetchJson.calls.length, 1)
  assert.equal(fetchJson.calls[0].url, `${DEFAULT_API_BASE}/song/like/check`)
  assert.equal(fetchJson.calls[0].fields.trackIds, '["123"]')
  assert.equal(fetchJson.calls[0].fields.csrf_token, 'tok42')
  assert.equal(fetchJson.calls[0].opts.cookie, OK_COOKIE.cookie)
  // 第二次命中缓存，不发请求
  const again = await s.isLiked(123)
  assert.equal(again.cached, true)
  assert.equal(fetchJson.calls.length, 1)
})

test('isLiked 端到端回放：check 命中列表决定 liked，空列表即未喜欢', async () => {
  const f1 = stubFetch([{ ids: [1859245776], code: 200 }])
  assert.deepEqual(await svc({ fetchJson: f1 }).isLiked(1859245776), { ok: true, liked: true, cached: false })
  const f2 = stubFetch([{ ids: [], code: 200 }])
  assert.deepEqual(await svc({ fetchJson: f2 }).isLiked(12345), { ok: true, liked: false, cached: false })
  // 大 id 走字符串原样，不被 Number 截断
  const f3 = stubFetch([{ ids: ['9007199254740993'], code: 200 }])
  assert.deepEqual(await svc({ fetchJson: f3 }).isLiked('9007199254740993'), { ok: true, liked: true, cached: false })
  assert.equal(f3.calls[0].fields.trackIds, '["9007199254740993"]')
})

test('isLiked 60 秒后过期重查；force 强制重查', async () => {
  const fetchJson = stubFetch([{ code: 200, ids: [1] }, { code: 200, ids: [] }])
  const s = svc({ fetchJson })
  await s.isLiked(1)
  await s.isLiked(1) // 缓存
  assert.equal(fetchJson.calls.length, 1)
  s.__advance(61_000)
  const res = await s.isLiked(1)
  assert.equal(res.liked, false)
  assert.equal(fetchJson.calls.length, 2)
  await s.isLiked(1, { force: true })
  assert.equal(fetchJson.calls.length, 3)
})

test('isLiked 同 id 并发只读一次（in-flight 合并）', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const fetchJson = stubFetch([async () => (await gate, { code: 200, ids: [7] })])
  const s = svc({ fetchJson })
  const p1 = s.isLiked(7)
  const p2 = s.isLiked(7)
  release()
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a.liked, true)
  assert.equal(b.liked, true)
  assert.equal(fetchJson.calls.length, 1)
})

test('isLiked 无 songId 直接 like-no-song，不打接口', async () => {
  const fetchJson = stubFetch([])
  const s = svc({ fetchJson })
  for (const id of ['', '0', null]) {
    const res = await s.isLiked(id)
    assert.equal(res.ok, false)
    assert.equal(res.error, 'like-no-song')
  }
  assert.equal(fetchJson.calls.length, 0)
})

test('isLiked 未登录（code 301）翻成 like-needs-login', async () => {
  const s = svc({ fetchJson: stubFetch([{ code: 301 }]) })
  const res = await s.isLiked(1)
  assert.equal(res.ok, false)
  assert.equal(res.error, 'like-needs-login')
})

test('isLiked 其它非零 code 翻成 like-failed', async () => {
  const s = svc({ fetchJson: stubFetch([{ code: 500 }]) })
  const res = await s.isLiked(1)
  assert.equal(res.error, 'like-failed')
})

test('isLiked 网络异常 / 401 走不同错误码', async () => {
  const e = new Error('boom')
  e.status = 500
  const s1 = svc({ fetchJson: stubFetch([e]) })
  assert.equal((await s1.isLiked(1)).error, 'like-network')
  const e2 = new Error('unauthorized')
  e2.status = 401
  const s2 = svc({ fetchJson: stubFetch([e2]) })
  assert.equal((await s2.isLiked(1)).error, 'like-needs-login')
})

test('isLiked 读不到登录凭证时返回 like-needs-login / like-unavailable', async () => {
  const s1 = svc({ fetchJson: stubFetch([]), cookie: () => ({ ok: false }) })
  assert.equal((await s1.isLiked(1)).error, 'like-needs-login')
  const s2 = svc({ fetchJson: stubFetch([]), cookie: () => ({ ok: false, error: 'cookie-unsupported' }) })
  assert.equal((await s2.isLiked(1)).error, 'like-unavailable')
  const s3 = svc({ fetchJson: stubFetch([]), cookie: () => { throw new Error('fs') } })
  assert.equal((await s3.isLiked(1)).error, 'like-no-cookie')
})

test('isLiked 读不认识的返回形状报 like-failed', async () => {
  const s = svc({ fetchJson: stubFetch([{ code: 200, nope: 1 }]) })
  assert.equal((await s.isLiked(1)).error, 'like-failed')
})

// ---------------------------------------------------------------------------
// LikeService.setLiked
// ---------------------------------------------------------------------------

test('setLiked 写对 form 字段并写缓存（收藏）', async () => {
  const fetchJson = stubFetch([{ code: 200 }])
  const s = svc({ fetchJson })
  const res = await s.setLiked(123, true)
  assert.deepEqual(res, { ok: true, liked: true })
  assert.equal(fetchJson.calls[0].url, `${DEFAULT_API_BASE}/song/like`)
  assert.equal(fetchJson.calls[0].fields.trackId, '123')
  assert.equal(fetchJson.calls[0].fields.like, 'true')
  assert.equal(fetchJson.calls[0].fields.csrf_token, 'tok42')
  // songid 是错的旧参数名（会返回 code 400），绝不能回归
  assert.equal(fetchJson.calls[0].fields.songid, undefined)
  assert.equal(s.cache.get('123').liked, true)
})

test('setLiked(false) 取消收藏，like 字段是 false 字符串', async () => {
  const fetchJson = stubFetch([{ code: 200 }])
  const s = svc({ fetchJson })
  await s.setLiked(123, false)
  assert.equal(fetchJson.calls[0].fields.like, 'false')
  assert.equal(s.cache.get('123').liked, false)
})

test('setLiked/isLiked 下架歌曲 401 → like-unavailable-song（不再误报 needs-login）', async () => {
  const s1 = svc({ fetchJson: stubFetch([{ code: 401, message: '下架歌曲无法收藏' }]) })
  const r1 = await s1.setLiked(9, true)
  assert.equal(r1.ok, false)
  assert.equal(r1.error, 'like-unavailable-song')
  assert.match(r1.message, /下架/)
  const s2 = svc({ fetchJson: stubFetch([{ code: 401, message: '下架歌曲无法收藏' }]) })
  const r2 = await s2.isLiked(9)
  assert.equal(r2.error, 'like-unavailable-song')
  // 真「需要登录」的 401 仍保留 needs-login，原生通道真未登录照常提示
  const s3 = svc({ fetchJson: stubFetch([{ code: 401, message: '需要登录' }]) })
  assert.equal((await s3.setLiked(9, true)).error, 'like-needs-login')
})

test('setLiked 失败时不动缓存', async () => {
  const s = svc({ fetchJson: stubFetch([{ code: 500 }]) })
  const res = await s.setLiked(9, true)
  assert.equal(res.ok, false)
  assert.equal(res.error, 'like-failed')
  assert.equal(s.cache.has('9'), false)
})

test('setLiked 同 id+目标并发合并成一次写入', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const fetchJson = stubFetch([async () => (await gate, { code: 200 })])
  const s = svc({ fetchJson })
  const p1 = s.setLiked(5, true)
  const p2 = s.setLiked(5, true)
  release()
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(fetchJson.calls.length, 1)
})

test('apiBase 走 likeApiBase > dailyApiBase > 默认', async () => {
  const f1 = stubFetch([{ code: 200, ids: [1] }])
  await svc({ fetchJson: f1, getConfig: () => ({ likeApiBase: 'http://x/api/', dailyApiBase: 'http://y/api' }) }).isLiked(1)
  assert.equal(f1.calls[0].url, 'http://x/api/song/like/check')
  const f2 = stubFetch([{ code: 200, ids: [1] }])
  await svc({ fetchJson: f2, getConfig: () => ({ dailyApiBase: 'http://y/api' }) }).isLiked(1)
  assert.equal(f2.calls[0].url, 'http://y/api/song/like/check')
})

// ---------------------------------------------------------------------------
// PlayerService.action('like')
// ---------------------------------------------------------------------------

function fakeLikePlayer({ like, songId = '123', cachedLiked = null } = {}) {
  const backend = {
    id: 'test',
    platform: 'win32',
    capabilities: { playback: true, sessionVolume: true, systemVolume: true, lyrics: true },
    command: () => ({ shell: 'x', args: [] }),
  }
  const player = new PlayerService({ backend, getConfig: () => ({}), log: () => {}, like })
  player.elog = { pollCount: 1, getState: () => ({ track: { songId } }) }
  if (cachedLiked != null) like?.cache.set(String(songId), { liked: cachedLiked, at: Date.now() })
  player.invalidate = () => {}
  player.state = async () => ({ ok: true, now: { songId, liked: cachedLiked ?? false }, volume: null })
  return player
}

test('player.action(like) 用 elog 的 songId，显式 like 目标态，回填 liked', async () => {
  const setLiked = async (id, want) => {
    assert.equal(id, '123')
    assert.equal(want, true)
    return { ok: true, liked: true }
  }
  const player = fakeLikePlayer({ like: { setLiked, cache: new Map() } })
  const res = await player.action('like', { like: true })
  assert.equal(res.ok, true)
  assert.equal(res.liked, true)
  assert.match(res.message, /我喜欢的音乐/)
})

test('player.action(like) 省略 like 时按缓存取反', async () => {
  let got
  const player = fakeLikePlayer({
    like: { setLiked: async (id, want) => { got = want; return { ok: true, liked: want } }, cache: new Map([['123', { liked: true, at: Date.now() }]]) },
    cachedLiked: true,
  })
  await player.action('like')
  assert.equal(got, false)
})

test('player.action(like) 没注入 like 服务回 like-unavailable', async () => {
  const player = fakeLikePlayer({ like: null })
  const res = await player.action('like', { like: true })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'like-unavailable')
})

test('player.action(like) 没有 songId 回 like-no-song', async () => {
  const player = fakeLikePlayer({ like: { setLiked: async () => ({ ok: true, liked: true }), cache: new Map() }, songId: '' })
  const res = await player.action('like', { like: true })
  assert.equal(res.error, 'like-no-song')
})

test('player.action(like) 服务失败透传错误码', async () => {
  const player = fakeLikePlayer({
    like: { setLiked: async () => ({ ok: false, error: 'like-needs-login', message: '先登录' }), cache: new Map() },
  })
  const res = await player.action('like', { like: true })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'like-needs-login')
  assert.equal(res.message, '先登录')
})

// ---------------------------------------------------------------------------
// 红心与客户端同步：state() 里的 likeSyncMs 节流状态机
// ---------------------------------------------------------------------------
//
// 客户端 elog 没有 like 事件，只能靠 state() 轮询服务器。下面这组盯住
// "切歌立即查 / 同曲每 likeSyncMs 强制重查 / 节流窗口读缓存 / 失败退避"，
// 防止再退回"同一首歌只查一次、客户端点红心永远不同步"的老状态机。

function syncPlayer({ like, songId = '123', likeSyncMs = 8000 } = {}) {
  const backend = {
    id: 'test',
    platform: 'win32',
    capabilities: { playback: true },
    command: () => ({ shell: 'x', args: [] }),
  }
  const player = new PlayerService({ backend, getConfig: () => ({ likeSyncMs }), log: () => {}, like })
  player.elog = {
    pollCount: 1,
    noteSeek: () => {},
    getState: () => ({
      available: true, playing: true, positionMs: 0, durationMs: 1000, mode: '',
      track: { songId, title: 't', artist: 'a', album: 'b' },
    }),
  }
  player.request = async () => ({ ok: true, now: { songId, channel: 'native', peak: 0 }, volume: null })
  player.invalidate = () => {}
  return player
}

/** isLiked 桩：记录 force 参数，并像真 LikeService 一样回写 cache */
function likeStub(calls, { liked = true, ok = true, throwErr = false } = {}) {
  const cache = new Map()
  const isLiked = async (id, opts) => {
    calls.push({ id, force: !!opts?.force })
    if (throwErr) throw new Error('boom')
    if (ok) cache.set(String(id), { liked, at: Date.now() })
    return ok ? { ok: true, liked } : { ok: false, error: 'like-failed' }
  }
  return { cache, isLiked }
}

test('state 初次查 liked 用 force:true 强制回源，并回填 now.liked', async () => {
  const calls = []
  const like = likeStub(calls, { liked: true })
  const p = syncPlayer({ like })
  const s = await p.state({ fresh: true })
  assert.equal(s.now.liked, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, '123')
  assert.equal(calls[0].force, true)
})

test('state 节流窗口内再查不重打服务器，从缓存读 liked', async () => {
  const calls = []
  const like = likeStub(calls, { liked: true })
  const p = syncPlayer({ like })
  await p.state({ fresh: true })
  // 服务器值改成 false，若这一轮真去查了会变 false；只读缓存则应保持 true
  like.cache.set('123', { liked: true, at: Date.now() })
  const s2 = await p.state({ fresh: true })
  assert.equal(calls.length, 1)
  assert.equal(s2.now.liked, true)
})

test('state 到期后按 likeSyncMs 强制重查，覆盖缓存旧值（客户端点红心能同步）', async () => {
  const calls = []
  const like = likeStub(calls, { liked: true })
  const p = syncPlayer({ like, likeSyncMs: 2000 })
  await p.state({ fresh: true })
  // 缓存伪造旧值 false，且把上次查询时间拉到 3s 前（>2000 窗口）
  like.cache.set('123', { liked: false, at: Date.now() })
  p.likedCheckedAt = Date.now() - 3000
  const s = await p.state({ fresh: true })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].force, true)
  assert.equal(s.now.liked, true) // 服务器 true 覆盖缓存 false
})

test('state 切歌立即重查，不等 likeSyncMs 窗口', async () => {
  const calls = []
  const like = likeStub(calls, { liked: false })
  const p = syncPlayer({ like, songId: '456' })
  await p.state({ fresh: true })
  // 换歌：likedForSong 还停在旧 id，likedCheckedAt 是刚刚 → 只靠 changed 触发
  p.elog.getState = () => ({
    available: true, playing: true, positionMs: 0, durationMs: 1000, mode: '',
    track: { songId: '789', title: 't2', artist: 'a2', album: 'b2' },
  })
  p.request = async () => ({ ok: true, now: { songId: '789', channel: 'native', peak: 0 }, volume: null })
  const s = await p.state({ fresh: true })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].id, '789')
  assert.equal(s.now.songId, '789')
  assert.equal(s.now.liked, false)
})

test('state liked 查询失败后 15s 内退避，不每轮轮询都打失败接口', async () => {
  const calls = []
  const like = likeStub(calls, { ok: false })
  const p = syncPlayer({ like })
  await p.state({ fresh: true })
  assert.equal(calls.length, 1)
  // 窗口到期但失败未满 15s → retryOk=false，不查
  p.likedCheckedAt = Date.now() - 9000
  const s2 = await p.state({ fresh: true })
  assert.equal(calls.length, 1)
  assert.equal(s2.now.liked, null)
  // 失败超过 15s → 允许重试
  p.likedFailAt = Date.now() - 20000
  await p.state({ fresh: true })
  assert.equal(calls.length, 2)
})

test('state isLiked 抛异常也记 likedCheckedAt/likedFailAt，避免抖动', async () => {
  const calls = []
  const like = likeStub(calls, { throwErr: true })
  const p = syncPlayer({ like })
  const s = await p.state({ fresh: true })
  assert.equal(s.now.liked, null)
  assert.ok(p.likedCheckedAt > 0)
  assert.ok(p.likedFailAt > 0)
  assert.ok(p.likedFailAt >= p.likedCheckedAt)
})

test('toggleLike 成功后刷新 likedCheckedAt，下一轮 state 不立即重复回源', async () => {
  const calls = []
  const like = {
    cache: new Map(),
    isLiked: async (id, opts) => { calls.push({ id, force: !!opts?.force }); return { ok: true, liked: true } },
    setLiked: async (id, want) => { like.cache.set(String(id), { liked: want, at: Date.now() }); return { ok: true, liked: want } },
  }
  const p = syncPlayer({ like })
  p.likedCheckedAt = 0
  const res = await p.action('like', { like: true })
  assert.equal(res.ok, true)
  assert.ok(p.likedCheckedAt > 0)
  assert.equal(res.now.liked, true) // #toggleLike 内 state 回填读缓存
  // native 幂等路径会用 isLiked 查一次服务端作代理；记下这次调用数
  const callsAfterToggle = calls.length
  // toggleLike 之后紧接着的 state 落在窗口内，不再额外回源
  await p.state({ fresh: true })
  assert.equal(calls.length, callsAfterToggle)
})

// ---------------------------------------------------------------------------
// DSH 点红心 → 同步客户端本地红心（native 全局 love 热键，不弹窗）
// ---------------------------------------------------------------------------
//
// 首选路径：force 查服务端作客户端状态代理，不一致就按热键让客户端自己 toggle
// 并写服务端，再 force 回填。native 不可用/失败一律回退 Web API（不弹窗）。

/** 带 setLike 请求桩的 player：requests 记录 helper 收到的 cmd */
function nativeLikePlayer({ liked = false, likeOk = true, setLikeReply = { ok: true, channel: 'native' }, setLikedCalls = null, requestThrow = false, playback = true } = {}) {
  const requests = []
  const cache = new Map()
  const isLikedCalls = []
  const like = {
    cache,
    isLiked: async (id, opts) => {
      isLikedCalls.push({ id, force: !!opts?.force })
      if (likeOk) cache.set(String(id), { liked, at: Date.now() })
      return likeOk ? { ok: true, liked } : { ok: false, error: 'like-failed' }
    },
    setLiked: async (id, want) => {
      if (setLikedCalls) setLikedCalls.push({ id, want })
      cache.set(String(id), { liked: want, at: Date.now() })
      return { ok: true, liked: want }
    },
  }
  const backend = {
    id: 'test', platform: 'win32',
    capabilities: { playback, sessionVolume: true, systemVolume: true, lyrics: true },
    command: () => ({ shell: 'x', args: [] }),
  }
  const player = new PlayerService({ backend, getConfig: () => ({}), log: () => {}, like })
  player.elog = { pollCount: 1, getState: () => ({ track: { songId: '123' } }) }
  player.request = async (cmd, payload, timeout) => {
    requests.push({ cmd, payload, timeout })
    if (requestThrow) throw new Error('helper gone')
    return setLikeReply
  }
  player.invalidate = () => {}
  player.state = async () => ({ ok: true, now: { songId: '123', liked: cache.get('123')?.liked ?? null }, volume: null })
  player.likeSettleMs = 0 // 测试不真等 800ms
  return { player, requests, isLikedCalls, setLikedCalls, cache }
}

test('native 同步：服务端 liked≠want 时按 setLike 热键并 force 回填（channel=native，不弹窗）', async () => {
  // 服务端当前未喜欢（liked=false），目标 true → 按一次热键；客户端写服务端后
  // isLiked 桩仍回 false（桩不变），回填应回退到 want=true（乐观）
  const { player, requests } = nativeLikePlayer({ liked: false })
  const res = await player.action('like', { like: true })
  assert.equal(res.ok, true)
  assert.equal(res.channel, 'native')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].cmd, 'setLike')
})

test('native 同步：服务端 liked===want 时幂等，不按热键', async () => {
  const { player, requests } = nativeLikePlayer({ liked: true })
  const res = await player.action('like', { like: true })
  assert.equal(res.ok, true)
  assert.equal(res.channel, 'native')
  assert.equal(res.skipped, 'already-set')
  assert.equal(requests.length, 0)
})

test('native 失败（request 抛异常）回退 Web API setLiked', async () => {
  const setLikedCalls = []
  const { player } = nativeLikePlayer({ liked: false, requestThrow: true, setLikedCalls })
  const res = await player.action('like', { like: true })
  assert.equal(res.ok, true)
  assert.equal(res.channel, 'web')
  assert.equal(setLikedCalls.length, 1)
  assert.equal(setLikedCalls[0].id, '123')
  assert.equal(setLikedCalls[0].want, true)
})

test('native 无客户端会话（setLike 回 ok:false）回退 Web API setLiked', async () => {
  const setLikedCalls = []
  const { player } = nativeLikePlayer({ liked: false, setLikeReply: { ok: false, error: 'no-client' }, setLikedCalls })
  const res = await player.action('like', { like: true })
  assert.equal(res.ok, true)
  assert.equal(res.channel, 'web')
  assert.equal(setLikedCalls.length, 1)
})

test('native 不可用（backend.playback=false）直接走 Web API setLiked', async () => {
  const setLikedCalls = []
  const { player, requests } = nativeLikePlayer({ playback: false, setLikedCalls })
  const res = await player.action('like', { like: true })
  assert.equal(res.ok, true)
  assert.equal(res.channel, 'web')
  assert.equal(requests.length, 0)
  assert.equal(setLikedCalls.length, 1)
})

// ---------------------------------------------------------------------------
// 大卡片副标题：elog 的来源 / 专辑透传到 now（前端据此显示）
// ---------------------------------------------------------------------------

/** 不注入 like（state 跳过 liked 查询），专测 #mergeElog 的 source/album 合成 */
function sourcePlayer(source) {
  const backend = {
    id: 'test',
    platform: 'win32',
    capabilities: { playback: true },
    command: () => ({ shell: 'x', args: [] }),
  }
  const player = new PlayerService({ backend, getConfig: () => ({}), log: () => {} })
  player.elog = {
    pollCount: 1,
    noteSeek: () => {},
    getState: () => ({
      available: true,
      playing: true,
      positionMs: 0,
      durationMs: 1000,
      mode: '',
      track: { songId: '555', title: '歌', artist: '歌手', album: '专辑' },
      source,
    }),
  }
  player.request = async () => ({ ok: true, now: { songId: '555', channel: 'native', peak: 0 }, volume: null })
  player.invalidate = () => {}
  return player
}

test('state：elog 的 source 透传到 now.source（大卡片「来源：xxx」）', async () => {
  const src = { scene: 'playlist', href: '/playlist/18334824318', text: '临时' }
  const p = sourcePlayer(src)
  const s = await p.state({ fresh: true })
  assert.deepEqual(s.now.source, src)
  assert.equal(s.now.album, '专辑')
})

test('state：elog 无 source 时 now.source 为 null（前端不显示来源）', async () => {
  const p = sourcePlayer(null)
  const s = await p.state({ fresh: true })
  assert.equal(s.now.source, null)
})

