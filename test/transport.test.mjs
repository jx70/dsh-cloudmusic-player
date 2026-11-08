/**
 * test/transport.test.mjs —— lib/transport.mjs 的单元测试
 * ============================================================================
 * 重点不是覆盖率，而是把三件事钉死：
 *   1. 有 connection.fetch 时**绝不**碰 webServer（web profile 的行为锁死）；
 *   2. 只有 webServer 时注册成 exact 路由，路径精确等于 ROUTES；
 *   3. 栅栏真的挡得住 cross-site / 非回环 Host / 跨源 Origin，且宿主栅栏
 *      可用时被委托、抛异常时按拒绝处理。
 * ============================================================================
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountTransport, selfFence, toNodeHandler } from '../lib/transport.mjs'

// ── 假宿主 ────────────────────────────────────────────────────────────────

function fakeConnection({ fetch = true, requestRejection } = {}) {
  const registered = []
  const conn = {}
  if (fetch) {
    conn.fetch = {
      register(route) {
        registered.push(route)
        return () => {
          const i = registered.indexOf(route)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    }
  }
  if (requestRejection) conn.requestRejection = requestRejection
  conn.registered = registered
  return conn
}

function fakeWebServer() {
  const exact = new Map()
  const prefixes = new Map()
  return {
    port: 4567,
    exact,
    prefixes,
    registered: [],
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      this.registered.push(route)
      return () => {
        table.delete(route.path)
      }
    },
  }
}

const ROUTES = [
  { path: '/api/cloudmusic-player/state', methods: ['GET'], handler: async () => new Response('{}') },
  { path: '/api/cloudmusic-player/action', methods: ['POST'], handler: async () => new Response('{}') },
]

// ── 假 req/res（够 Node handler 用就行）────────────────────────────────────

function fakeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  const payload = body === null ? null : Buffer.from(body)
  return {
    method,
    url,
    headers: lower,
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload
    },
  }
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers || {}
      return res
    },
    end(chunk) {
      res.body = chunk === undefined ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    },
  }
  return res
}

const LOOPBACK = { host: '127.0.0.1:3080' }

// ── mountTransport：车道选择 ───────────────────────────────────────────────

test('有 connection.fetch 时走 fetch 车道，webServer 一条都不注册', () => {
  const connection = fakeConnection()
  const webServer = fakeWebServer()
  const out = mountTransport({ connection, webServer, routes: ROUTES })
  assert.equal(out.transport, 'fetch')
  assert.equal(connection.registered.length, 2)
  assert.equal(webServer.registered.length, 0)
  assert.equal(connection.registered[0].requestBody, 'buffered')
  assert.deepEqual(connection.registered[0].methods, ['GET'])
  assert.equal(typeof connection.registered[0].fetch, 'function')
})

test('没有 fetch 有 webServer 时注册 exact 路由，路径精确匹配', () => {
  const connection = fakeConnection({ fetch: false })
  const webServer = fakeWebServer()
  const out = mountTransport({ connection, webServer, routes: ROUTES })
  assert.equal(out.transport, 'webserver')
  assert.equal(webServer.exact.size, 2)
  assert.ok(webServer.exact.has('/api/cloudmusic-player/state'))
  assert.ok(webServer.exact.has('/api/cloudmusic-player/action'))
  assert.equal(webServer.prefixes.size, 0)
  for (const route of webServer.registered) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
})

test('两条车道都没有 → none，且不抛', () => {
  const out = mountTransport({ routes: ROUTES })
  assert.equal(out.transport, 'none')
  assert.deepEqual(out.disposers, [])
})

test('effect 被用来绑定注册（cordis 生命周期）', () => {
  const connection = fakeConnection()
  const labels = []
  mountTransport({
    connection,
    routes: ROUTES,
    effect: (factory, label) => {
      labels.push(label)
      return factory()
    },
  })
  assert.equal(labels.length, 2)
  assert.match(labels[0], /cloudmusic-player: \/api\/cloudmusic-player\/state/)
})

test('disposer 能把路由摘掉', () => {
  const connection = fakeConnection()
  const out = mountTransport({ connection, routes: ROUTES })
  assert.equal(connection.registered.length, 2)
  for (const d of out.disposers) d()
  assert.equal(connection.registered.length, 0)
})

test('webServer 里残留同名路由时自愈（不抛 duplicate）', () => {
  const connection = fakeConnection({ fetch: false })
  const webServer = fakeWebServer()
  // 模拟热重载前的残留
  webServer.exact.set('/api/cloudmusic-player/state', { kind: 'exact', path: '/api/cloudmusic-player/state', handler: () => {} })
  const out = mountTransport({ connection, webServer, routes: ROUTES })
  assert.equal(out.transport, 'webserver')
  assert.equal(webServer.exact.size, 2)
})

// ── toNodeHandler：Request/Response 适配 ──────────────────────────────────

test('GET 带着 query 转成 Fetch Request', async () => {
  let seen = null
  const route = {
    path: '/api/x/state',
    methods: ['GET'],
    handler: async (request) => {
      seen = request
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  const handler = toNodeHandler(route)
  const res = fakeRes()
  await handler(fakeReq({ url: '/api/x/state?deep=1', headers: LOOPBACK }), res)
  assert.equal(seen.method, 'GET')
  assert.equal(new URL(seen.url).searchParams.get('deep'), '1')
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).ok, true)
})

test('POST 的 JSON body 原样透传', async () => {
  let body = null
  const route = {
    path: '/api/x/action',
    methods: ['POST'],
    handler: async (request) => {
      body = await request.text()
      return new Response('{"ok":true}')
    },
  }
  const handler = toNodeHandler(route)
  const res = fakeRes()
  await handler(fakeReq({
    method: 'POST',
    url: '/api/x/action',
    headers: { ...LOOPBACK, 'content-type': 'application/json' },
    body: '{"action":"toggle"}',
  }), res)
  assert.equal(body, '{"action":"toggle"}')
  assert.equal(res.statusCode, 200)
})

test('body 超过上限 → 413', async () => {
  const route = { path: '/api/x/a', methods: ['POST'], handler: async () => new Response('{}') }
  const handler = toNodeHandler(route, { maxBodyBytes: 16 })
  const res = fakeRes()
  await handler(fakeReq({
    method: 'POST',
    url: '/api/x/a',
    headers: LOOPBACK,
    body: 'x'.repeat(64),
  }), res)
  assert.equal(res.statusCode, 413)
  assert.equal(JSON.parse(res.body).error, 'body-too-large')
})

test('方法不在 methods 里 → 405 + allow 头', async () => {
  const route = { path: '/api/x/a', methods: ['POST'], handler: async () => new Response('{}') }
  const handler = toNodeHandler(route)
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', url: '/api/x/a', headers: LOOPBACK }), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('handler 抛异常 → 500，不把异常漏出去', async () => {
  const route = {
    path: '/api/x/a',
    methods: ['GET'],
    handler: async () => {
      throw new Error('boom')
    },
  }
  const handler = toNodeHandler(route, { log: () => {} })
  const res = fakeRes()
  await handler(fakeReq({ url: '/api/x/a', headers: LOOPBACK }), res)
  assert.equal(res.statusCode, 500)
  assert.match(JSON.parse(res.body).detail, /boom/)
})

test('204 不写 body', async () => {
  const route = { path: '/api/x/a', methods: ['GET'], handler: async () => new Response(null, { status: 204 }) }
  const handler = toNodeHandler(route)
  const res = fakeRes()
  await handler(fakeReq({ url: '/api/x/a', headers: LOOPBACK }), res)
  assert.equal(res.statusCode, 204)
  assert.equal(res.body, '')
})

// ── selfFence：自校验 ────────────────────────────────────────────────────

test('selfFence 放行回环 localhost / 127.x / ::1', () => {
  for (const host of ['127.0.0.1:3080', 'localhost:3080', 'LOCALHOST', '[::1]:3080', '127.5.6.7:9']) {
    assert.equal(selfFence({ headers: { host } }, {}), null, host)
  }
})

test('selfFence 挡掉非回环 Host 与相似域名', () => {
  for (const host of ['evil.com', '127.0.0.1.evil.com', '192.168.1.5:3080', '127.0.0.1:3080@evil.com']) {
    assert.equal(selfFence({ headers: { host } }, {}), 403, host)
  }
  assert.equal(selfFence({ headers: {} }, {}), 403)
})

test('selfFence 挡掉 Sec-Fetch-Site: cross-site', () => {
  assert.equal(selfFence({ headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' } }, {}), 403)
  assert.equal(selfFence({ headers: { ...LOOPBACK, 'sec-fetch-site': 'same-origin' } }, {}), null)
})

test('selfFence 的 Origin 必须与 Host 同源', () => {
  assert.equal(selfFence({ headers: { ...LOOPBACK, origin: 'http://127.0.0.1:3080' } }, {}), null)
  assert.equal(selfFence({ headers: { ...LOOPBACK, origin: 'http://evil.com' } }, {}), 403)
  assert.equal(selfFence({ headers: { ...LOOPBACK, origin: 'not a url' } }, {}), 403)
})

test('selfFence 认 DSH_TRUSTED_HOSTS 白名单', () => {
  const env = { DSH_TRUSTED_HOSTS: 'harness.lan:8080' }
  assert.equal(selfFence({ headers: { host: 'harness.lan:8080' } }, env), null)
  assert.equal(selfFence({ headers: { host: 'harness.lan:9999' } }, env), 403)
})

// ── 栅栏委托宿主 ─────────────────────────────────────────────────────────

test('宿主 requestRejection 的拒绝码被照用', async () => {
  const connection = fakeConnection({ fetch: false, requestRejection: () => 401 })
  const route = { path: '/api/x/a', methods: ['GET'], handler: async () => new Response('{}') }
  const handler = toNodeHandler(route, { connection })
  const res = fakeRes()
  await handler(fakeReq({ url: '/api/x/a', headers: LOOPBACK }), res)
  assert.equal(res.statusCode, 401)
})

test('宿主 requestRejection 通过时正常处理', async () => {
  const connection = fakeConnection({ fetch: false, requestRejection: () => undefined })
  const route = {
    path: '/api/x/a',
    methods: ['GET'],
    handler: async () => new Response('{"ok":true}', { status: 200 }),
  }
  const handler = toNodeHandler(route, { connection })
  const res = fakeRes()
  await handler(fakeReq({ url: '/api/x/a', headers: LOOPBACK }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).ok, true)
})

test('宿主 requestRejection 抛异常 → 按拒绝处理（不 fail-open）', async () => {
  const connection = fakeConnection({
    fetch: false,
    requestRejection: () => {
      throw new Error('gate exploded')
    },
  })
  const route = {
    path: '/api/x/a',
    methods: ['GET'],
    handler: async () => new Response('{"ok":true}'),
  }
  const handler = toNodeHandler(route, { connection, log: () => {} })
  const res = fakeRes()
  await handler(fakeReq({ url: '/api/x/a', headers: LOOPBACK }), res)
  assert.equal(res.statusCode, 403)
  assert.notEqual(res.body, '{"ok":true}')
})

test('没有宿主栅栏时，自校验仍然生效（cross-site 被挡）', async () => {
  const route = { path: '/api/x/a', methods: ['GET'], handler: async () => new Response('{"ok":true}') }
  const handler = toNodeHandler(route, { log: () => {} })
  const res = fakeRes()
  await handler(fakeReq({
    url: '/api/x/a',
    headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' },
  }), res)
  assert.equal(res.statusCode, 403)
})
