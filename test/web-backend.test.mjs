// web-backend.mjs 单元测试：ensure() 绝不新建浏览器窗口
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebBackend } from '../lib/web-backend.mjs'

function makeBrowserJson() {
  const dir = mkdtempSync(join(tmpdir(), 'cmp-web-'))
  const p = join(dir, 'browser.json')
  writeFileSync(p, JSON.stringify({ wsUrl: 'ws://127.0.0.1:9999/devtools/browser/test' }))
  return { dir, p }
}

/** 假 CDP：getTargets 只返回 about:blank（没有网易云页面），记录是否有人想 createTarget。 */
function mockCdpWithoutMusicPage(calls) {
  return {
    connect: async () => {},
    isAlive: () => false,
    close: () => {},
    cmd: async (method) => {
      calls.push(method)
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ type: 'page', url: 'about:blank', targetId: 'blank' }] }
      }
      throw new Error(`unexpected CDP call: ${method}`)
    },
  }
}

test('找不到网易云页面时返回 web-page-not-found，且不 createTarget（不弹新窗口）', async () => {
  const { dir, p } = makeBrowserJson()
  try {
    const calls = []
    const web = new WebBackend({
      getConfig: () => ({ webBrowserJson: p }),
      log: () => {},
      cdpFactory: () => mockCdpWithoutMusicPage(calls),
    })
    const r = await web.ensure()
    assert.equal(r.ok, false)
    assert.equal(r.error, 'web-page-not-found')
    assert.match(r.message || '', /music\.163\.com|未打开/)
    assert.ok(!calls.includes('Target.createTarget'), `不应调用 Target.createTarget，实际调用：${calls.join(',')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已有存活 CDP 连接时 ensure 直接复用，不读配置、不重建', async () => {
  const calls = []
  const web = new WebBackend({
    getConfig: () => ({ webBrowserJson: 'C:\\does\\not\\exist\\browser.json' }),
    log: () => {},
    cdpFactory: () => { throw new Error('不应创建 CDP') },
  })
  web.cdp = { isAlive: () => true }
  web.sessionId = 'session-1'
  web.lastError = 'stale error'
  const r = await web.ensure()
  assert.equal(r.ok, true)
  assert.equal(web.lastError, '', '成功后应清空陈旧错误')
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------- 接管网页手动点播

/** 造一个已经"连上"的 WebBackend：eval 结果按脚本返回，记录所有 eval 的表达式。
 *  smtcState 默认 ok:false（不回退），需要测 SMTC 时显式传入。 */
function fakeWeb(evalImpl, smtcState = { ok: false }) {
  const web = new WebBackend({ getConfig: () => ({}), log: () => {} })
  const seen = []
  const controlCalls = []
  const smtc = {
    readState: async () => smtcState,
    control: async (action, extra) => { controlCalls.push({ action, extra }); return { ok: true, action } },
  }
  web.smtc = smtc
  web.cdp = { isAlive: () => true, cmd: async () => ({}) }
  web.sessionId = 's1'
  web._eval = async (expr) => { seen.push(expr); return evalImpl(expr) }
  return { web, seen, smtc, controlCalls }
}

test('play 在队列为空时接管网页手动点的歌（按 songId 取 URL 并注入 audio）', async () => {
  const { web, seen } = fakeWeb((expr) => {
    if (expr === 'document.readyState') return 'complete'
    // READ_STATE_EXPR：页面正在放用户手动点的那首（裸 songId 形态）
    if (expr.includes('getPlaying')) return { status: 'Playing', songId: '33894312', title: '', artist: '', hasAudio: false, pos: 0, end: 0 }
    if (expr.includes('a.paused')) return 'none' // 页面里没有插件自己的 audio
    return true
  })
  web.queue = []
  web.queueIndex = -1
  web._songUrl = async (id) => ({ ok: true, url: `https://cdn.example/${id}.mp3` })
  web._playUrl = async (url) => ({ paused: false, readyState: 4, url })

  const r = await web._playManual()
  assert.equal(r.ok, true)
  assert.equal(r.songId, '33894312')
  assert.match(r.url, /33894312\.mp3/)
  assert.equal(web.manualSongId, '33894312', '应记住手动点播的 songId')
  assert.ok(seen.some((e) => e.includes('getPlaying')), '应读 getPlaying 拿当前歌')
})

test('play 遇到已经由插件播着的 audio 时只复用，不重新 load（进度不被打回 0）', async () => {
  const { web } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Playing', songId: '33894312', hasAudio: true, pos: 30000, end: 200000 }
    if (expr.includes('a.paused')) return 'playing'
    return true
  })
  web.queue = []
  web.queueIndex = -1
  let loaded = 0
  web._songUrl = async () => { loaded++; return { ok: true, url: 'https://cdn.example/x.mp3' } }
  web._playUrl = async () => { loaded++; return {} }

  const r = await web._playManual()
  assert.equal(r.ok, true)
  assert.equal(r.reused, true)
  assert.equal(loaded, 0, '不应重新取 URL / load audio')
})

test('pause 在页面没有 audio 时退到 window.player.pause()（手动点的歌也能停）', async () => {
  const seen = []
  const { web } = fakeWeb((expr) => {
    seen.push(expr)
    if (expr.includes('if(!a) return false')) return false // _controlAudio('pause') 没有 audio
    return true
  })
  const r = await web._pauseAny()
  assert.equal(r.ok, true)
  assert.equal(r.via, 'page-player')
  assert.ok(seen.some((e) => e.includes('window.player.pause')), '应调用页面播放器的 pause')
})

test('seek 在没有 audio 时返回可读错误，而不是静默成功', async () => {
  const { web } = fakeWeb((expr) => {
    if (expr.includes('if(!a) return false')) return false
    if (expr.includes('a.currentTime')) return false
    if (expr.includes('credentials')) return true // _isLoggedIn 的 fetch 探测
    return true
  })
  web.cdp = { isAlive: () => true, cmd: async (m) => (m === 'Storage.getCookies' ? { cookies: [{ name: 'MUSIC_U', value: 'x'.repeat(20), domain: '.music.163.com' }] } : {}) }
  web.sessionId = 's1'
  web.ensure = async () => ({ ok: true })
  const r = await web.action('seek', { positionMs: 30000 })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'web-no-audio-url')
})

// ---------------------------------------------------------------- SMTC 回退（个人浏览器放歌）

test('state 在 CDP 无真实在播音频时回退到 SMTC，标题/歌手/进度来自系统媒体会话', async () => {
  const sm = {
    ok: true, title: '会呼吸的痛', artist: '梁静茹', album: '崇拜',
    status: 'Paused', pos: 1.02, end: 272.97, aumid: 'msedge.exe',
    canPlay: true, canPause: false, canNext: true, canPrev: true, canSeek: true,
  }
  const { web } = fakeWeb((expr) => {
    // CDP 页面是「去客户端播放」残留态：没有 audio、playing=false
    if (expr.includes('getPlaying')) return { status: 'Paused', songId: '186016', title: '网易云音乐', hasAudio: false, pos: 0, end: 0 }
    return true
  }, sm)
  web.ensure = async () => ({ ok: true })
  const st = await web.state()
  assert.equal(st.ok, true)
  assert.equal(st.now.title, '会呼吸的痛')
  assert.equal(st.now.artist, '梁静茹')
  assert.equal(st.now.status, 'Paused')
  assert.equal(st.now.positionSource, 'smtc-web')
  assert.equal(st.now.channel, 'web')
  assert.equal(st.now.pos, 1.02)
  assert.equal(st.now.end, 272.97)
  assert.equal(web.dataSource, 'smtc')
})

test('SMTC 返回视频站标题且无歌手时，Node 层兜底拒绝（不误接管 B站/YouTube 视频）', async () => {
  const sm = {
    ok: true, title: '永恒不朽的经典《We are the world》_哔哩哔哩_bilibili', artist: '',
    status: 'Playing', pos: 0.015, end: 432, aumid: 'msedge.exe', canSeek: true,
  }
  const { web } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Paused', hasAudio: false }
    return true
  }, sm)
  web.ensure = async () => ({ ok: true })
  // CDP 无真实音频 + probe 意外透传视频标题 -> 应被 Node 层挡下，不返回 smtc-web
  const st = await web.state()
  assert.notEqual(st.now?.positionSource, 'smtc-web')
})

test('SMTC 数据源下的 play/pause/seek 走 smtc.control，like 仍走原逻辑', async () => {
  const sm = { ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Playing', pos: 10, end: 272, aumid: 'msedge.exe', canPlay: true, canPause: true, canSeek: true }
  const { web, controlCalls } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Paused', hasAudio: false }
    return true
  }, sm)
  web.ensure = async () => ({ ok: true })
  web.state = async () => ({ ok: true, now: { positionSource: 'smtc-web', status: 'Playing', title: sm.title }, volume: { level: 0.8 } })

  await web.action('play')
  await web.action('pause')
  await web.action('seek', { positionMs: 30000 })
  assert.deepEqual(controlCalls.map((c) => c.action), ['play', 'pause', 'seek'])
  assert.equal(controlCalls.find((c) => c.action === 'seek').extra.positionMs, 30000)
})

test('CDP 有真实在播 audio 时不回退 SMTC（插件自己播的歌不受个人浏览器干扰）', async () => {
  const sm = { ok: true, title: '个人浏览器在放的歌', status: 'Playing', pos: 5, end: 100 }
  const { web } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Playing', songId: '1', title: '插件在放的歌', hasAudio: true, pos: 20000, end: 200000, audioSongId: '1' }
    return true
  }, sm)
  web.ensure = async () => ({ ok: true })
  web.queue = [{ id: '1', name: '插件在放的歌', artists: [] }]
  web.queueIndex = 0
  const st = await web.state()
  assert.notEqual(st.now.positionSource, 'smtc-web', '插件自己 audio 在播时不能被 SMTC 顶掉')
  assert.equal(web.dataSource, 'cdp')
})

// ---------------------------------------------------------------- 喜欢（红心）

/** 内存版 LikeService：只关心 isLiked/setLiked/forget/cache 的形状。 */
function mockLike(initial = {}) {
  const store = { ...initial }
  return {
    store,
    cache: new Map(),
    isLiked: async (id) => ({ ok: true, liked: !!store[String(id)], cached: false }),
    setLiked: async (id, want) => { store[String(id)] = !!want; return { ok: true, liked: !!want } },
    forget(id) { this.cache.delete(String(id)) },
  }
}

test('state 的 CDP 分支把 liked 挂到 now 上（前端红心能亮）', async () => {
  const { web } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Paused', songId: '186016', title: '晴天', artist: '周杰伦', hasAudio: false, pos: 0, end: 269000 }
    return true
  })
  web.ensure = async () => ({ ok: true })
  web.likeWeb = mockLike({ 186016: true })
  const st = await web.state()
  assert.equal(st.ok, true)
  assert.equal(st.now.songId, '186016')
  assert.equal(st.now.liked, true, '已收藏的歌红心应为实心')
  assert.equal(st.now.positionSource, 'web')
})

test('state 的 SMTC 分支按歌名搜出 songId 并挂上 liked', async () => {
  const sm = {
    ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Paused', pos: 1, end: 272,
    aumid: 'msedge.exe', canPlay: true, canPause: false, canNext: true, canPrev: true, canSeek: true,
  }
  const { web } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Paused', hasAudio: false }
    if (expr.includes('/api/search/get')) return JSON.stringify([{ id: 254132, name: '会呼吸的痛' }])
    return true
  }, sm)
  web.ensure = async () => ({ ok: true })
  web.likeWeb = mockLike({ 254132: true })
  const st = await web.state()
  assert.equal(st.now.positionSource, 'smtc-web')
  assert.equal(st.now.songId, '254132', '标题搜歌应补出 songId')
  assert.equal(st.now.liked, true, '红心状态应来自 LikeService')
})

test('_songIdBySearch 在 CDP 搜不到时走 Node 侧明文 fetch 兜底（ego 浏览器没开也能搜到）', async () => {
  const { web } = fakeWeb(() => '[]') // CDP 页面内 fetch 返回空 → 触发兜底
  web._cfg = () => ({ requestTimeoutMs: 3000 })
  web._cookieForApi = async () => 'MUSIC_U=fake'
  const origFetch = globalThis.fetch
  let calledUrl = ''
  globalThis.fetch = async (url) => {
    calledUrl = String(url)
    return { text: async () => JSON.stringify({ code: 200, result: { songs: [{ id: 254132, name: '会呼吸的痛' }] } }) }
  }
  try {
    const id = await web._songIdBySearch('会呼吸的痛', '梁静茹')
    assert.equal(id, '254132', 'CDP 空时应走 Node fetch 兜底搜到 id')
    assert.ok(calledUrl.includes('/api/search/get'), '兜底应打明文 search 接口')
    // 第二次命中 60min 缓存，不再 fetch
    calledUrl = ''
    assert.equal(await web._songIdBySearch('会呼吸的痛', '梁静茹'), '254132')
    assert.equal(calledUrl, '', '缓存命中不应再发请求')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('SMTC 场景 action(like) 用搜出的 songId 收藏，并把 liked 透传给上层', async () => {
  const { web } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Paused', hasAudio: false }
    return true
  })
  web.ensure = async () => ({ ok: true })
  const like = mockLike({})
  web.likeWeb = like
  web.queue = []
  web.queueIndex = -1
  web.manualSongId = ''
  web.state = async () => ({ ok: true, now: { positionSource: 'smtc-web', songId: '254132', status: 'Paused', title: '会呼吸的痛' }, volume: { level: 0.8 } })
  const r = await web.action('like', { like: true })
  assert.equal(r.ok, true)
  assert.equal(r.liked, true, '上层 index.js 读 res.liked 决定文案')
  assert.equal(like.store['254132'], true, '应真的收藏这首歌')
})

test('SMTC like 走零 CDP 路径：ego 没开（ensure 抛错）也能收藏并回填红心', async () => {
  const sm = {
    ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Playing', pos: 10, end: 272,
    aumid: 'msedge.exe', canPlay: true, canPause: true, canNext: true, canPrev: true, canSeek: true,
  }
  const { web } = fakeWeb(() => true, sm)
  web.ensure = async () => { throw new Error('ego browser not open') } // 零 CDP：ensure 根本不该被调用
  web._cfg = () => ({ requestTimeoutMs: 3000 })
  web._cookieForApi = async () => 'MUSIC_U=fake'
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({ text: async () => JSON.stringify({ code: 200, result: { songs: [{ id: 254132, name: '会呼吸的痛' }] } }) })
  const like = mockLike({})
  web.likeWeb = like
  web.smtcState = sm
  try {
    const r = await web.action('like', { like: true })
    assert.equal(r.ok, true, 'ego 没开也要能收藏')
    assert.equal(r.error, undefined)
    assert.equal(like.store['254132'], true)
    assert.equal(r.liked, true)
    assert.equal(r.now.songId, '254132')
    assert.equal(r.now.liked, true, '回包的红心状态应更新，前端立即变红')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('SMTC like 连续切换不漂移：中间 state 把 dataSource 改成 cdp、ensure 抛错也不影响下一次', async () => {
  const sm = {
    ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Playing', pos: 10, end: 272,
    aumid: 'msedge.exe', canPlay: true, canPause: true, canNext: true, canPrev: true, canSeek: true,
  }
  const { web, smtc } = fakeWeb((expr) => {
    if (expr.includes('/api/search/get')) return JSON.stringify([{ id: 254132, name: '会呼吸的痛' }])
    return '[]'
  }, sm)
  web.smtc.readState = async () => sm
  web._cfg = () => ({ requestTimeoutMs: 3000 })
  web._cookieForApi = async () => 'MUSIC_U=fake'
  web.ensure = async () => { throw new Error('ego not open') }
  const like = mockLike({ 254132: false })
  web.likeWeb = like
  // 第一次收藏
  const r1 = await web.action('like', { like: true })
  assert.equal(r1.ok, true)
  assert.equal(r1.liked, true)
  // 模拟前端一次 state 轮询把 dataSource 改写成 cdp（漂移）
  web.dataSource = 'cdp'
  // 第二次取消：仍应走零 CDP 路径成功
  const r2 = await web.action('like', { like: false })
  assert.equal(r2.ok, true, 'dataSource 漂移后仍能收藏')
  assert.equal(r2.error, undefined, '不应冒出 web-browser-unavailable')
  assert.equal(like.store['254132'], false)
  assert.equal(r2.liked, false)
})

test('队列空且搜不到歌时 like 返回 like-no-song，不抛异常', async () => {
  const { web } = fakeWeb(() => true)
  web.ensure = async () => ({ ok: true })
  web.likeWeb = mockLike({})
  web.queue = []
  web.queueIndex = -1
  web.manualSongId = ''
  web.state = async () => ({ ok: true, now: { positionSource: 'smtc-web', songId: '', status: 'Paused' }, volume: {} })
  const r = await web.action('like', { like: true })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'like-no-song')
})

// ---------------------------------------------------------------- 系统音量

test('注入 systemVolumeService 后 capabilities.systemVolume 自动打开', () => {
  const { web } = fakeWeb(() => true)
  assert.equal(web.capabilities.systemVolume, false)
  if (process.platform === 'win32') {
    web.systemVolumeService = { state: async () => ({}), volume: async () => ({ ok: true }) }
    assert.equal(web.capabilities.systemVolume, true)
  }
})

test('volume(scope=system) 走 native helper，且不需要 CDP', async () => {
  const { web } = fakeWeb(() => true)
  let got = null
  web.systemVolumeService = {
    state: async () => ({}),
    volume: async (args) => { got = args; return { ok: true, volume: { level: 0.7, muted: false, scope: 'system' } } },
  }
  if (process.platform !== 'win32') return
  web.ensure = async () => { throw new Error('不应连 CDP') }
  const r = await web.volume({ level: 0.7, scope: 'system' })
  assert.equal(r.ok, true)
  assert.deepEqual(got, { level: 0.7, muted: undefined, scope: 'system' })
  assert.equal(r.systemVolume.level, 0.7)
})

test('state 的 systemVolume 跟随 native helper 读数', async () => {
  const sys = { scope: 'system', level: 0.42, muted: false }
  const { web } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Playing', hasAudio: true, audioSongId: '', pos: 0, end: 0 }
    return true
  })
  web.ensure = async () => ({ ok: true })
  web.systemVolumeService = { state: async () => ({ ok: true, systemVolume: sys }), volume: async () => ({ ok: true }) }
  if (process.platform !== 'win32') return
  web.likeWeb = mockLike({})
  const st = await web.state()
  assert.deepEqual(st.systemVolume, sys, 'systemVolume 应来自 native helper，而不是 null')
})

// ---------------------------------------------------------------- 播放顺序

test('set_mode 把短值映射成内部枚举，state().now.mode 回显给前端切图标', async () => {
  const { web } = fakeWeb(() => true)
  web.ensure = async () => ({ ok: true })
  web.state = async () => ({ ok: true, now: { mode: web.mode }, volume: {} })
  for (const [short, en] of Object.entries({ order: 'playOrder', cycle: 'playCycle', single: 'playOneCycle', random: 'playRandom' })) {
    const r = await web.action('set_mode', { value: short })
    assert.equal(r.ok, true)
    assert.equal(web.mode, en, `${short} 应映射成 ${en}`)
    assert.equal(r.mode, en)
  }
})

test('set_mode 在 state 读不到歌时仍返回带新 mode 的 now（前端图标不回退）', async () => {
  const { web } = fakeWeb(() => true)
  web.ensure = async () => ({ ok: true })
  // 读不到歌：state() 返回 now:null。前端 run() 见 res.now!==undefined 会整体替换，
  // 若这里是 null 就会把图标清回默认「顺序」——set_mode 必须兜底一个带新 mode 的 now。
  web.state = async () => ({ ok: true, now: null, volume: {} })
  const r = await web.action('set_mode', { value: 'random' })
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'playRandom')
  assert.ok(r.now, '必须返回 now，不能让前端清空')
  assert.equal(r.now.mode, 'playRandom', 'now.mode 必须是新值')
})

test('set_mode 非法值返回 bad-mode，不改动当前 mode', async () => {
  const { web } = fakeWeb(() => true)
  web.mode = 'playCycle'
  const r = await web.action('set_mode', { value: 'nonsense' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'bad-mode')
  assert.equal(web.mode, 'playCycle', '非法值不应改动当前 mode')
})

test('_advanceIndex：order 到头返回 null，cycle 回环，single 原地，random 换一首', async () => {
  const { web } = fakeWeb(() => true)
  web.queue = [{ id: 1 }, { id: 2 }, { id: 3 }]
  web.queueIndex = 2
  web.mode = 'playOrder'
  assert.equal(web._advanceIndex(1), null, '顺序模式到最后一首没有下一首')
  assert.equal(web._advanceIndex(-1), 1)
  web.mode = 'playCycle'
  assert.equal(web._advanceIndex(1), 0, '列表循环应回到第一首')
  assert.equal(web._advanceIndex(-1), 1)
  web.mode = 'playOneCycle'
  assert.equal(web._advanceIndex(1), 2, '单曲循环原地')
  web.mode = 'playRandom'
  const ri = web._advanceIndex(1)
  assert.ok(ri >= 0 && ri < 3 && ri !== 2, '随机应换一首不同的')
})

test('state().now.mode 回显当前 this.mode（前端据此切播放顺序图标）', async () => {
  const { web } = fakeWeb((expr) => {
    if (expr.includes('getPlaying')) return { status: 'Playing', hasAudio: true, audioSongId: '', pos: 0, end: 0 }
    return true
  })
  web.ensure = async () => ({ ok: true })
  web.likeWeb = mockLike({})
  web.systemVolumeService = null
  web.mode = 'playRandom'
  const st = await web.state()
  assert.equal(st.now.mode, 'playRandom', 'CDP 分支应回显 this.mode')
  // SMTC 分支
  const { web: web2 } = fakeWeb(() => true, { ok: true, title: '会呼吸的痛', artist: '梁静茹', status: 'Paused', pos: 1, end: 272, aumid: 'msedge.exe', canPlay: true, canPause: true, canNext: true, canPrev: true, canSeek: true })
  web2.ensure = async () => ({ ok: true })
  web2._songIdBySearch = async () => '254132'
  web2._attachLiked = async () => {}
  web2._readSystemVolume = async () => null
  web2.mode = 'playSingle' // 无效值仅测透传，真实模式为 playOneCycle
  web2.mode = 'playOneCycle'
  const st2 = await web2.state()
  assert.equal(st2.now.mode, 'playOneCycle', 'SMTC 分支也应回显 this.mode')
})

// ---------------------------------------------------------------- 日推（WinRT 后台音频引擎）

/** 假 WinRT 引擎：记录命令，返回带进度的 state。默认已在播（对应 winrtPlaying=true）。 */
function mockWinrt() {
  const calls = []
  let playing = true
  let pos = 0
  return {
    calls,
    play: async (p) => { calls.push({ cmd: 'play', ...p }); playing = true; pos = 0; return { ok: true, status: 'Playing', pos: 0, end: 200, ...p } },
    pause: async () => { calls.push({ cmd: 'pause' }); playing = false; return { ok: true, status: 'Paused', pos } },
    resume: async () => { calls.push({ cmd: 'resume' }); playing = true; return { ok: true, status: 'Playing', pos } },
    toggle: async () => { calls.push({ cmd: 'toggle' }); playing = !playing; return { ok: true, status: playing ? 'Playing' : 'Paused', pos } },
    seek: async (ms) => { calls.push({ cmd: 'seek', ms }); pos = ms / 1000; return { ok: true, status: 'Playing', pos } },
    volume: async (level, muted) => { calls.push({ cmd: 'volume', level, muted }); return { ok: true } },
    state: async () => { calls.push({ cmd: 'state' }); return { ok: true, active: true, status: playing ? 'Playing' : 'Paused', pos, end: 200, songId: calls.find((c) => c.cmd === 'play')?.songId || '', title: 'probe', artist: 'artist', volume: 0.8, muted: false } },
    close: async () => { calls.push({ cmd: 'close' }) },
  }
}

test('play_daily 去 CDP 依赖：ego 关着（ensure 失败）也能取数并经 WinRT 起播', async () => {
  const calls = []
  const web = new WebBackend({
    getConfig: () => ({}),
    log: () => {},
    winrtAudio: mockWinrt(),
    daily: { fetch: async () => ({ ok: true, songs: [
      { id: 111, name: 'A', artists: ['甲'] },
      { id: 222, name: 'B', artists: ['乙'] },
    ] }) },
  })
  web.ensure = async () => { calls.push('ensure'); return { ok: false, error: 'web-browser-unavailable' } }
  web._songUrl = async (id) => ({ ok: true, url: `https://cdn/${id}.mp3` })
  web._attachLiked = async (now) => now
  web._readSystemVolume = async () => null

  const r = await web.action('play_daily')
  assert.equal(r.ok, true, 'ego 关着也应起播')
  assert.equal(r.songCount, 2)
  assert.equal(r.firstSong.id, 111)
  assert.ok(!calls.includes('ensure'), 'play_daily 不应调 ensure（零 CDP）')
  assert.equal(web.winrtPlaying, true)
  assert.equal(web.queueIndex, 0)
  const playCall = web.winrtAudio.calls.find((c) => c.cmd === 'play')
  assert.equal(playCall.songId, '111')
  assert.equal(r.now.positionSource, 'winrt')
})

test('日推引擎在播时 state/next/seek/volume 全走 WinRT，不碰 CDP/SMTC', async () => {
  const web = new WebBackend({ getConfig: () => ({}), log: () => {}, winrtAudio: mockWinrt() })
  web.ensure = async () => { throw new Error('不应调 ensure（CDP/ego 关着）') }
  web._songUrl = async (id) => ({ ok: true, url: `https://cdn/${id}.mp3` })
  web._attachLiked = async (now) => now
  web._readSystemVolume = async () => null
  web.queue = [{ id: 111, name: 'A' }, { id: 222, name: 'B' }]
  web.winrtSong = { id: 111, name: 'A', artist: '甲' }
  web.winrtPlaying = true
  web.winrtAudio.play({ songId: '111' }) // 引擎当前正播第一首

  const st = await web.state()
  assert.equal(st.now.positionSource, 'winrt')
  assert.equal(st.now.songId, '111')

  const nx = await web.action('next')
  assert.equal(nx.ok, true)
  assert.equal(web.queueIndex, 1)
  assert.equal(web.winrtAudio.calls.filter((c) => c.cmd === 'play').at(-1).songId, '222')

  await web.action('seek', { positionMs: 30000 })
  assert.equal(web.winrtAudio.calls.find((c) => c.cmd === 'seek').ms, 30000)

  await web.volume({ level: 0.5, scope: 'process' })
  assert.equal(web.winrtAudio.calls.find((c) => c.cmd === 'volume').level, 0.5)

  await web.action('pause')
  const p = await web.state()
  assert.equal(p.now.status, 'Paused')
})

test('日推引擎在播时 like 收藏队列当前曲目，不碰 SMTC/CDP', async () => {
  const web = new WebBackend({ getConfig: () => ({}), log: () => {}, winrtAudio: mockWinrt() })
  web.ensure = async () => { throw new Error('不应调 ensure') }
  web._attachLiked = async (now) => now
  web._readSystemVolume = async () => null
  web.queue = [{ id: 111, name: 'A' }]
  web.queueIndex = 0
  web.winrtPlaying = true
  web.winrtAudio.play({ songId: '111' }) // 让引擎 state() 有 active 歌曲
  web.likeWeb = mockLike({})
  const smtcCalls = []
  web.smtc = { readState: async () => { smtcCalls.push('readState'); return { ok: false } } }

  const r = await web.action('like', { like: true })
  assert.equal(r.ok, true)
  assert.equal(r.liked, true)
  assert.equal(r.songId, '111')
  assert.equal(smtcCalls.length, 0, '日推引擎在播时不应读 SMTC')
})

test('SMTC 场景调 APP 音量只动浏览器进程音量，绝不回退系统音量', async () => {
  const { web } = fakeWeb(() => true, { ok: true, title: 'Letting Go', artist: '蔡健雅', status: 'Playing', pos: 1, end: 263, aumid: 'msedge.exe', canPlay: true, canPause: true, canNext: true, canPrev: true, canSeek: true })
  web.ensure = async () => ({ ok: false, error: 'web-page-not-found' })
  web._readSystemVolume = async () => ({ level: 0.7, muted: false, scope: 'system' })
  const volCalls = []
  web.systemVolumeService = {
    volume: async (p) => { volCalls.push(p); return { ok: true, volume: { level: p.level, muted: p.muted, scope: 'process' } } },
  }
  web.capabilities.systemVolume = true
  web.dataSource = 'smtc'
  web.smtcState = { aumid: 'msedge.exe', title: 'Letting Go', artist: '蔡健雅' }

  const r = await web.volume({ level: 0.42, scope: 'process' })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'smtc-process')
  assert.equal(volCalls.length, 1)
  assert.equal(volCalls[0].scope, 'process')
  assert.equal(volCalls[0].procName, 'msedge')
  assert.equal(volCalls[0].noFallback, true, '必须禁止回退系统音量')
  assert.equal(volCalls[0].muted, undefined, '拖音量时不能带 muted——否则 native 走 mute 命令不写 level，回读旧值让滑杆跳回')
  assert.equal(r.volume.level, 0.42, '回显必须是本次写入的目标值')
})

test('SMTC 场景 mute 只传 muted，不影响 level 写入语义', async () => {
  const { web } = fakeWeb(() => true)
  web.ensure = async () => ({ ok: false })
  web._readSystemVolume = async () => ({ level: 0.7, muted: false, scope: 'system' })
  const volCalls = []
  web.systemVolumeService = { volume: async (p) => { volCalls.push(p); return { ok: true } } }
  web.capabilities.systemVolume = true
  web.dataSource = 'smtc'
  web.smtcState = { aumid: 'msedge.exe', title: 'x', artist: 'y' }

  await web.volume({ muted: true, scope: 'process' })
  assert.equal(volCalls[0].muted, true, 'mute 调用必须带 muted')
  assert.equal(volCalls[0].level, web.volumeLevel, 'mute 时 level 用现值即可')
})

test('SMTC 场景找不到出声进程音频会话时报错，不改系统音量', async () => {
  const { web } = fakeWeb(() => true)
  web.ensure = async () => ({ ok: false, error: 'web-page-not-found' })
  web._readSystemVolume = async () => ({ level: 0.7, muted: false, scope: 'system' })
  web.systemVolumeService = { volume: async () => ({ ok: false, error: 'volume-no-session' }) }
  web.capabilities.systemVolume = true
  web.dataSource = 'smtc'
  web.smtcState = { aumid: 'msedge.exe', title: 'x', artist: 'y' }

  const r = await web.volume({ level: 0.42, scope: 'process' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'volume-no-session')
})
