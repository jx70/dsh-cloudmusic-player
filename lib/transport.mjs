/**
 * lib/transport.mjs —— 把 6 条 HTTP 路由挂到不同世代的宿主上
 * ============================================================================
 * 为什么需要这一层：
 *
 *   dsh 有两个世代同时在用：
 *     · 0.2.x（本机 web profile）—— `/api` 前缀被 connection 独占，插件必须用
 *       `connection.fetch.register({ path, methods, requestBody, fetch })`，
 *       由 connection 的 owner-peer 鉴权兜住。
 *     · 0.1.0-rc.6（dsh-desktop 捆绑的那代）—— connection 只有 `get rpc()`，
 *       **没有 fetch、没有 requestRejection**。此时唯一可用的通道是
 *       `ctx.webServer.register({ kind:'exact', path, handler })`，handler 是
 *       Node 风格 `(req, res)`。
 *
 *   webServer 在两代里签名完全一致（`register({kind,path,handler})` +
 *   `match()` 先 exact 表再最长前缀），所以自己注册 exact `/api/...` 会先于
 *   connection 的 `/api` 前缀命中 —— 这正是旧世代插件生态的通用做法。
 *
 * 代价：绕开 connection 就没有 owner-peer 鉴权了，必须自己补一道信任栅栏。
 * 这里用三层：
 *   ① 自校验永远先跑：Host 必须回环（或环境变量白名单）、拒绝
 *      `Sec-Fetch-Site: cross-site`、带 Origin 时必须与 Host 同源；
 *   ② 宿主的 `connection.requestRejection` 可用就委托它（里面还有浏览器鉴权
 *      401 那一层），返回码照用，**它抛异常按拒绝处理**；
 *   ③ 都没有 → 只靠 ①，并在挂载时打一条醒目 warn。
 *
 * 反过来：新世代优先走 fetch，不去抢 webServer 的 exact 表 —— 那等于主动
 * 把安全水位降一档。
 * ============================================================================
 */

/** 请求体上限：这六条路由最大的 body 是 `{level, muted, scope}`，64 KiB 已经宽松 */
export const MAX_BODY_BYTES = 64 * 1024

/** 额外信任的权威（host[:port]），逗号分隔。默认空，只认回环。 */
const TRUSTED_ENV = 'DSH_TRUSTED_HOSTS'

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  // 逐段校验：挡掉 `127.0.0.1.evil.com` 这类相似域名，也挡 `127.1.2.999`
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function trustedAuthorities(env = process.env) {
  return String(env?.[TRUSTED_ENV] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 自校验栅栏（不依赖宿主）。
 * @returns {number|null} 通过 → null；否则应当拒绝的 HTTP 状态码
 */
export function selfFence(request, env = process.env) {
  const headers = request?.headers || {}
  const read = (key) => {
    const v = headers[key] ?? headers[key.toLowerCase()]
    return Array.isArray(v) ? v[0] : v
  }

  const host = String(read('host') || '').trim()
  if (!host) return 403
  // host 可能是 `127.0.0.1:3080` 或 `[::1]:3080`
  let hostname = host
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host)
  if (bracketed) hostname = bracketed[1]
  else if (/^[^:]+:\d+$/.test(host)) hostname = host.slice(0, host.lastIndexOf(':'))
  const allowed = isLoopbackHostname(hostname)
    || trustedAuthorities(env).includes(host.toLowerCase())
    || trustedAuthorities(env).includes(hostname.toLowerCase())
  if (!allowed) return 403

  const site = String(read('sec-fetch-site') || '').toLowerCase()
  if (site === 'cross-site') return 403

  const origin = read('origin')
  if (origin === undefined || origin === null || origin === '') return null
  try {
    return new URL(String(origin)).host.toLowerCase() === host.toLowerCase() ? null : 403
  } catch {
    return 403
  }
}

/** 把 Buffer/undefined 的 body 收成一个可读字符串，超限抛错 */
async function readBody(req, limit = MAX_BODY_BYTES) {
  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return undefined
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) {
      const err = new Error(`body too large (> ${limit} bytes)`)
      err.code = 'BODY_TOO_LARGE'
      throw err
    }
    chunks.push(chunk)
  }
  if (total === 0) return undefined
  return Buffer.concat(chunks).toString('utf8')
}

function absoluteUrl(req, fallbackAuthority) {
  const raw = String(req?.url || '/')
  if (/^https?:\/\//i.test(raw)) return raw
  const authority = String(req?.headers?.host || fallbackAuthority || '127.0.0.1')
  return `http://${authority}${raw.startsWith('/') ? raw : `/${raw}`}`
}

/** Fetch 语义的 Response 写回 Node 的 res */
async function writeResponse(res, response) {
  const headers = {}
  response.headers?.forEach?.((value, key) => {
    headers[key] = value
  })
  const status = Number(response.status) || 200
  const body = status === 204 || status === 304 ? null : Buffer.from(await response.arrayBuffer())
  res.writeHead(status, headers)
  res.end(body ?? undefined)
}

function plainResponse(status, payload, extraHeaders) {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(extraHeaders || {}),
    },
  })
}

/**
 * 把一条 `{ path, methods, handler }` 路由包成 Node handler。
 * handler 仍是 Fetch 语义 `(request) => Response`，这里负责两个方向的适配。
 */
export function toNodeHandler(route, options = {}) {
  const {
    connection,
    fallbackAuthority,
    env = process.env,
    log = () => {},
    maxBodyBytes = MAX_BODY_BYTES,
  } = options
  const methods = (route.methods || ['GET']).map((m) => String(m).toUpperCase())

  return async function nodeHandler(req, res) {
    // ① 自校验
    const rejected = selfFence(req, env)
    if (rejected !== null) {
      try {
        res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejected === 403 ? 'forbidden' : 'rejected')
      } catch {
        /* 已经发过响应就算了 */
      }
      return
    }

    // ② 宿主栅栏可用就委托；它抛异常按拒绝处理（旧实现是 fail-open，这里不跟）
    if (connection && typeof connection.requestRejection === 'function') {
      let verdict
      try {
        verdict = connection.requestRejection(req)
      } catch (error) {
        log(`${route.path} 的宿主栅栏抛异常，按拒绝处理：${error?.message ?? error}`)
        try {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
        } catch {
          /* ignore */
        }
        return
      }
      if (verdict !== undefined && verdict !== null) {
        try {
          res.writeHead(Number(verdict) || 403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('forbidden')
        } catch {
          /* ignore */
        }
        return
      }
    }

    // 方法闸
    const method = String(req.method || 'GET').toUpperCase()
    if (methods.length > 0 && !methods.includes(method)) {
      try {
        await writeResponse(res, plainResponse(405, { ok: false, error: 'method-not-allowed' }, {
          allow: methods.join(', '),
        }))
      } catch {
        /* ignore */
      }
      return
    }

    // ③ 组 Request
    let request
    try {
      const body = await readBody(req, maxBodyBytes)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers || {})) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const item of value) headers.append(key, String(item))
        else headers.set(key, String(value))
      }
      request = new Request(absoluteUrl(req, fallbackAuthority), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      })
    } catch (error) {
      const tooLarge = error?.code === 'BODY_TOO_LARGE'
      try {
        await writeResponse(res, plainResponse(tooLarge ? 413 : 400, {
          ok: false,
          error: tooLarge ? 'body-too-large' : 'bad-request',
          detail: String(error?.message ?? error),
        }))
      } catch {
        /* ignore */
      }
      return
    }

    // ④ 交给 Fetch 语义的 handler，再把 Response 写回
    try {
      const response = await route.handler(request)
      await writeResponse(res, response)
    } catch (error) {
      log(`${route.path} 处理失败：${error?.message ?? error}`)
      try {
        await writeResponse(res, plainResponse(500, {
          ok: false,
          error: 'internal',
          detail: String(error?.message ?? error),
        }))
      } catch {
        /* 响应已经发出去一部分，没法再补 */
      }
    }
  }
}

/**
 * 按能力挑一条车道并把路由挂上去。
 *
 * @param {object} params
 * @param {object} [params.connection]  宿主 connection 服务（可能有 .fetch / .requestRejection）
 * @param {object} [params.webServer]   宿主 webServer 服务（有 .register）
 * @param {Array<{path:string, methods:string[], handler:Function}>} params.routes
 * @param {(factory: () => (() => void), label: string) => void} [params.effect]
 *        把注册绑到插件生命周期上（cordis 的 ctx.effect）；不给就直接注册
 * @param {(msg: string) => void} [params.log]
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {{ transport: 'fetch' | 'webserver' | 'none', disposers: Array<() => void>, note: string }}
 */
export function mountTransport(params) {
  const {
    connection,
    webServer,
    routes,
    effect,
    log = () => {},
    env = process.env,
  } = params

  const bind = (factory, label) => {
    if (typeof effect === 'function') return effect(factory, label)
    return factory()
  }

  // ── 车道 1：新世代，connection 的 exact fetch 路由（带 owner-peer 鉴权）──
  if (connection && typeof connection.fetch?.register === 'function') {
    const disposers = []
    for (const route of routes) {
      try {
        const dispose = bind(
          () => connection.fetch.register({
            path: route.path,
            methods: route.methods,
            requestBody: 'buffered',
            fetch: route.handler,
          }),
          `cloudmusic-player: ${route.path} 路由`,
        )
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        log(`${route.path} 没挂上：${error?.message ?? error}`)
      }
    }
    return { transport: 'fetch', disposers, note: 'connection.fetch' }
  }

  // ── 车道 2：旧世代（dsh-desktop 捆绑的 rc.6），自己挂 exact 路由 ──
  if (webServer && typeof webServer.register === 'function') {
    const fallbackAuthority = (() => {
      try {
        if (typeof webServer.getOrigin === 'function') {
          return String(new URL(webServer.getOrigin()).host)
        }
      } catch {
        /* 还没 listen，拿不到 origin */
      }
      const port = typeof webServer.port === 'number' ? webServer.port : undefined
      return port ? `127.0.0.1:${port}` : '127.0.0.1'
    })()

    const hasFence = !!connection && typeof connection.requestRejection === 'function'
    if (!hasFence) {
      log(
        '宿主没有 connection.requestRejection（旧世代）：改用插件自带的回环/同源校验，'
        + `只认 127.0.0.1 / localhost / ::1，或用 ${TRUSTED_ENV} 显式声明信任的权威`,
      )
    }

    const disposers = []
    for (const route of routes) {
      const handler = toNodeHandler(route, { connection, fallbackAuthority, env, log })
      try {
        const dispose = bind(
          () => {
            // 自愈：热重载/崩溃后宿主表里可能残留同一路径，register 会直接抛 duplicate
            const table = webServer.exact || webServer.prefixes
            if (table && typeof table.delete === 'function' && table.has?.(route.path)) {
              table.delete(route.path)
            }
            return webServer.register({ kind: 'exact', path: route.path, handler })
          },
          `cloudmusic-player: ${route.path} 路由（webServer）`,
        )
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        log(`${route.path} 没挂上（webServer）：${error?.message ?? error}`)
      }
    }
    return { transport: 'webserver', disposers, note: hasFence ? 'webServer + 宿主栅栏' : 'webServer + 自校验' }
  }

  // ── 车道 3：都没有 ──
  log('宿主既没有 connection.fetch 也没有 webServer，悬浮框的 HTTP 路由挂不上')
  return { transport: 'none', disposers: [], note: 'none' }
}
