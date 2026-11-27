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
