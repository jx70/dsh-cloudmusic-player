// channel.mjs 单元测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelRouter, detectClientRunning } from '../lib/channel.mjs'

function fakeNative() {
  return {
    backend: { id: 'windows-powershell', platform: 'win32' },
    degraded: '', windowLeak: false, ready: true, restartLimit: 3,
    state: async () => ({ ok: true, via: 'native' }),
    action: async (a) => ({ ok: true, via: 'native', action: a }),
    volume: async () => ({ ok: true, via: 'native' }),
    readyInfo: () => ({ backend: 'windows-powershell', capabilities: {}, platform: 'win32' }),
    deepHealth: async () => ({ ok: true, platform: 'win32' }),
    on() {}, start() {}, stop() {}, restart: async () => ({ ok: true }),
  }
}
function fakeWeb(loggedIn = true) {
  return {
    id: 'web-cdp', capabilities: { playback: true }, lastError: '',
    _isLoggedIn: async () => loggedIn,
    ensure: async () => ({ ok: true }),
    state: async () => ({ ok: true, via: 'web' }),
    action: async (a) => ({ ok: true, via: 'web', action: a }),
    volume: async () => ({ ok: true, via: 'web' }),
    deepHealth: async () => ({ ok: true, platform: 'web' }),
    stop() {},
  }
}
function router(mode, online, webOk) {
  const r = new ChannelRouter({
    native: fakeNative(), web: fakeWeb(webOk),
    getConfig: () => ({ channelMode: mode, processName: 'cloudmusic' }),
    log: () => {},
  })
  r.clientOnline = async () => online
  r.webAvailable = async () => webOk
  return r
}

test('channelMode 四种模式选择正确', async () => {
  assert.equal(await router('client-only', true, true).pick(), 'native')
  assert.equal(await router('client-only', false, true).pick(), 'native')
  assert.equal(await router('web-only', true, true).pick(), 'web')
  assert.equal(await router('client-first', true, true).pick(), 'native')
  assert.equal(await router('client-first', false, true).pick(), 'web')
  assert.equal(await router('web-first', true, true).pick(), 'web')
  assert.equal(await router('web-first', true, false).pick(), 'native')
})

test('client-first 客户端在线时锁定 native，不读 web/浏览器 SMTC', async () => {
  const r = router('client-first', true, true)
  // 若实现又去探测哪条通道在播（web 通道会读浏览器 SMTC，被 B 站视频抢占），
  // 这里直接抛错让测试失败。客户端在线就必须锁 native。
  r.channelPlaying = async () => { throw new Error('client-first 不该调用 channelPlaying') }
  assert.equal(await r.pick(), 'native')
  assert.equal((await r.state()).via, 'native')
  assert.equal((await r.action('next')).via, 'native')
})

test('未知模式回退 client-first', async () => {
  assert.equal(await router('???', true, true).pick(), 'native')
  assert.equal(await router('???', false, true).pick(), 'web')
})

test('state/action/volume 走当前通道且形状一致', async () => {
  const r = router('client-first', false, true)
  assert.equal((await r.state()).via, 'web')
  assert.equal((await r.action('next')).via, 'web')
  assert.equal((await r.volume({ level: 0.5 })).via, 'web')
  r._clientCache = { at: 0, value: null }
  r.clientOnline = async () => true
  assert.equal((await r.state()).via, 'native')
  assert.equal((await r.action('next')).via, 'native')
})

test('backend/degraded/readyInfo 反映当前通道', async () => {
  const r = router('web-only', true, true)
  await r.pick()
  assert.equal(r.backend.id, 'web-cdp')
  assert.equal(r.readyInfo().backend, 'web-cdp')
  assert.equal(r.readyInfo().capabilities.playback, true)
})

test('detectClientRunning 非 win32 返回 false', async () => {
  if (process.platform !== 'win32') {
    assert.equal(await detectClientRunning({}), false)
  }
})

test('clientOnline 探测失败(undefined)时不缓存，回退用 helper 的 pids 判定在线', async () => {
  const r = new ChannelRouter({
    native: {
      ...fakeNative(),
      deepHealth: async () => ({ ok: true, pids: [1234, 5678] }),
    },
    web: fakeWeb(true),
    getConfig: () => ({ channelMode: 'client-first', processName: 'cloudmusic' }),
    log: () => {},
    detect: async () => undefined, // 模拟沙箱里 tasklist 的 pipe spawn 被拦
  })
  // 探测失败 → helper 回退拿到 pids → 判为在线，且缓存 true。
  assert.equal(await r.clientOnline(), true)
  assert.equal(r._clientCache.value, true)
  // client-first 下据此锁定 native，不切到 web。
  assert.equal(await r.pick(), 'native')

  // helper 也拿不到任何证据 → undefined，不应被缓存。
  const r2 = new ChannelRouter({
    native: { ...fakeNative(), deepHealth: async () => ({ ok: false, detail: 'EPERM' }), state: async () => ({ ok: false }) },
    web: fakeWeb(true),
    getConfig: () => ({ channelMode: 'client-first' }),
    log: () => {},
    detect: async () => undefined,
  })
  assert.equal(await r2.clientOnline(), undefined)
  assert.equal(r2._clientCache.value, null)
})
