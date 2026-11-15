/**
 * lib/cookies.mjs —— 从网易云客户端的 CEF profile 里取登录 cookie
 * ============================================================================
 * 为什么要读客户端的 cookie：日推接口（`/api/v1/discovery/recommend/songs`）
 * 依赖登录态。本插件不自己登录，借用客户端已经登录好的那份 —— 这样用户
 * 在客户端里登录一次，插件就能一直用。
 *
 * 踩过的坑（2026-11-14 实测，客户端 3.1.43.205627）：
 *
 *   1. Cookies 是个 SQLite 库（`<profile>/Cookies`），客户端运行时被**独占锁**，
 *      直接 readFileSync 会 `EBUSY`。必须先复制到临时目录再读副本。
 *   2. 所有 cookie 的 `encrypted_value` 都是 `v10` 前缀 —— Chrome 的 OSCrypt：
 *      `v10` + 12 字节 nonce + 密文 + 16 字节 GCM tag，AES-256-GCM。
 *   3. 那把 AES key 由 DPAPI 保护，存在 `<profile>/LocalPrefs.json` 的
 *      `os_crypt.encrypted_key`（注意：不是 Chrome 那个叫 `Local State` 的文件，
 *      网易云把它塞进了 LocalPrefs.json）。base64 解出来前 5 字节是 ASCII
 *      `DPAPI`，去掉之后交给 `CryptUnprotectData`（当前用户作用域）才是 32 字节 key。
 *   4. DPAPI 只能在 Windows 上调。Node 没有内置绑定，所以这里 spawn 一次
 *      powershell 调 `[System.Security.Cryptography.ProtectedData]::Unprotect`。
 *      解出来的 key 按文件 mtime 缓存，同一个 profile 只解一次。
 *
 * 安全性：cookie 只在内存里拼成 header 串，不落盘、不进日志。错误信息里也
 * 不带 cookie 内容（只报错误码与原因）。
 * ============================================================================
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createDecipheriv } from 'node:crypto'
import { spawn } from 'node:child_process'

/** CEF profile 的默认落点（`webapp91x64` 之类的版本号会变，所以按前缀找） */
const PROFILE_ROOT = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'NetEase', 'CloudMusic')

/** 我们真的用得到的那些 cookie，按实测可用的顺序拼 */
const WANTED = [
  'MUSIC_U',
  'MUSIC_R_U',
  'MUSIC_A_T',
  'MUSIC_R_T',
  '__csrf',
  'NMTID',
  'JSESSIONID-WYYY',
  'WEVNSM',
  'WNMCID',
  '_iuqxldmzr_',
  'appver',
  'channel',
  'clientSign',
  'deviceId',
  'mode',
  'os',
  'osver',
  '_ntes_nnid',
  '_ntes_nuid',
]

/** 同一把 key 反复解没意义，按 profile 目录缓存 */
const keyCache = new Map()

/**
 * 找 CEF profile 目录：`<CloudMusic>/webapp*`，取 mtime 最新的那个。
 * @param {string} [root]
 * @returns {string}
 */
export function findProfileDir(root = PROFILE_ROOT) {
  try {
    const names = readdirSync(root).filter((n) => /^webapp/i.test(n))
    let best = ''
    let bestAt = -1
    for (const name of names) {
      const dir = join(root, name)
      try {
        if (!statSync(join(dir, 'Cookies')).isFile()) continue
      } catch {
        continue
      }
      let at = 0
      try {
        at = statSync(join(dir, 'Cookies')).mtimeMs
      } catch {
        at = 0
      }
      if (at > bestAt) {
        bestAt = at
        best = dir
      }
    }
    if (best) return best
  } catch {
    /* root 不存在就走兜底 */
  }
  return ''
}

/**
 * 把 Cookies 复制到临时目录 —— 客户端运行时原文件被独占锁，读不了。
 * @param {string} profileDir
 * @returns {string} 副本路径（调用方负责删）
 */
export function copyCookies(profileDir) {
  const src = join(profileDir, 'Cookies')
  if (!existsSync(src)) throw new Error('cookies-not-found')
  const dst = join(tmpdir(), `cm-cookies-${process.pid}-${Date.now()}.sqlite`)
  copyFileSync(src, dst)
  return dst
}

/**
 * 读 `os_crypt.encrypted_key`（base64，前 5 字节 `DPAPI`）。
 * @param {string} profileDir
 * @returns {Buffer|null} 去掉 DPAPI 前缀后的密文
 */
export function readEncryptedKey(profileDir) {
  const file = join(profileDir, 'LocalPrefs.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const b64 = parsed?.os_crypt?.encrypted_key
  if (typeof b64 !== 'string' || b64 === '') return null
  let buf
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return null
  }
  if (buf.length < 6 || buf.subarray(0, 5).toString('latin1') !== 'DPAPI') return null
  return buf.subarray(5)
}

/**
 * 用 DPAPI 解出 AES key（32 字节）。Windows only。
 * @param {Buffer} blob
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export function dpapiUnprotect(blob, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000
  if (process.platform !== 'win32') return Promise.reject(new Error('cookie-unsupported'))
  // 走 base64 而不是 hex：PS 5.1 跑在 .NET Framework 上，没有
  // [Convert]::FromHexString / ToHexString（那是 .NET 5+ 才有的）。
  const b64 = blob.toString('base64')
  // 用 -EncodedCommand 传脚本，避免引号/转义在黑盒里出岔子
  const script = [
    'Add-Type -AssemblyName System.Security | Out-Null',
    `$blob = [Convert]::FromBase64String('${b64}')`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($plain)',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(
        join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (err) {
      reject(err)
      return
    }
    const out = []
    const errOut = []
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`dpapi-timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => errOut.push(c))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(out).toString('utf8').trim()
      if (code !== 0 || text === '') {
        const why = Buffer.concat(errOut).toString('utf8').trim().split(/\r?\n/)[0] || `exit ${code}`
        reject(new Error(`dpapi-failed: ${why}`))
        return
      }
      let plain
      try {
        plain = Buffer.from(text.split(/\r?\n/).pop().trim(), 'base64')
      } catch {
        reject(new Error('dpapi-failed: bad base64 output'))
        return
      }
      if (plain.length !== 32) {
        reject(new Error(`dpapi-failed: key length ${plain.length}`))
        return
      }
      resolve(plain)
    })
  })
}

/**
 * 解一条 v10 cookie。非 v10/v11 前缀直接抛（客户端升级换加密方式时要能看出来）。
 * @param {Buffer} key 32 字节
 * @param {Buffer} enc
 */
export function decryptValue(key, enc) {
  if (!Buffer.isBuffer(enc) || enc.length < 3 + 12 + 16) throw new Error('cookie-short')
  const prefix = enc.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') throw new Error(`cookie-unsupported:${prefix}`)
  const nonce = enc.subarray(3, 15)
  const tag = enc.subarray(enc.length - 16)
  const body = enc.subarray(15, enc.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, nonce)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(body), d.final()]).toString('utf8')
}

/**
 * 把一行行 cookie 拼成 header 串。导出是为了单测能直接喂假数据。
 * @param {Array<{name:string, value:string}>} rows
 * @returns {string}
 */
export function buildCookieHeader(rows) {
  const map = new Map()
  for (const row of rows || []) {
    const name = String(row?.name || '')
    if (!name) continue
    if (!map.has(name)) map.set(name, String(row?.value ?? ''))
  }
  const out = []
  for (const name of WANTED) {
    if (!map.has(name)) continue
    const value = map.get(name)
    if (value === '') continue
    out.push(`${name}=${value}`)
  }
  return out.join('; ')
}

/**
 * 读 profile 里的全部 cookie 行并解密。
 * @param {{ profileDir?: string, timeoutMs?: number, log?: (msg:string)=>void }} [opts]
 * @returns {Promise<{ok:boolean, cookie?:string, uid?:string, profileDir?:string,
 *                    error?:string, detail?:string}>}
 */
export async function loadCookieHeader(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  if (process.platform !== 'win32') return { ok: false, error: 'cookie-unsupported', detail: 'only windows' }
  const profileDir = String(opts.profileDir || '') || findProfileDir()
  if (!profileDir) return { ok: false, error: 'cookie-missing', detail: 'client profile not found' }

  const encKey = readEncryptedKey(profileDir)
  if (!encKey) return { ok: false, error: 'cookie-missing', detail: 'LocalPrefs.os_crypt.encrypted_key not found' }

  let key = keyCache.get(profileDir)
  if (!key) {
    try {
      key = await dpapiUnprotect(encKey, { timeoutMs: opts.timeoutMs })
    } catch (err) {
      return { ok: false, error: 'cookie-unsupported', detail: String(err?.message || err) }
    }
    if (!key || key.length !== 32) return { ok: false, error: 'cookie-unsupported', detail: 'bad aes key length' }
    keyCache.set(profileDir, key)
  }

  let tmpFile = ''
  try {
    tmpFile = copyCookies(profileDir)
  } catch (err) {
    return { ok: false, error: 'cookie-missing', detail: String(err?.message || err) }
  }

  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    tryUnlink(tmpFile)
    return { ok: false, error: 'cookie-unsupported', detail: 'node:sqlite unavailable (need node >= 22.5)' }
  }

  let db
  try {
    db = new DatabaseSync(tmpFile, { readOnly: true })
    const stmt = db.prepare("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%music.163.com'")
    const rows = []
    for (const row of stmt.all()) {
      const enc = Buffer.isBuffer(row.encrypted_value) ? row.encrypted_value : Buffer.from(row.encrypted_value || [])
      try {
        rows.push({ name: String(row.name || ''), value: decryptValue(key, enc) })
      } catch (err) {
        const msg = String(err?.message || err)
        if (msg.startsWith('cookie-unsupported')) {
          return { ok: false, error: 'cookie-unsupported', detail: msg }
        }
        /* 单条坏了不算致命，跳过 */
      }
    }
    const cookie = buildCookieHeader(rows)
    if (!cookie) return { ok: false, error: 'cookie-missing', detail: 'no music.163.com cookies' }
    const uid = rows.find((r) => r.name === 'MUSIC_U')?.value || ''
    log(`cookies: ${rows.length} rows -> ${cookie.length} chars`)
    return { ok: true, cookie, uid, profileDir }
  } catch (err) {
    return { ok: false, error: 'cookie-missing', detail: String(err?.message || err) }
  } finally {
    try {
      db?.close?.()
    } catch {
      /* ignore */
    }
    tryUnlink(tmpFile)
  }
}

function tryUnlink(file) {
  if (!file) return
  try {
    unlinkSync(file)
  } catch {
    /* ignore */
  }
}

/** 测试用：清掉缓存的 key */
export function resetKeyCache() {
  keyCache.clear()
}
