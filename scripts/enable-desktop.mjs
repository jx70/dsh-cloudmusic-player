#!/usr/bin/env node
/**
 * scripts/enable-desktop.mjs —— 把本插件接进 dsh 桌面版（dsh-desktop）
 * ============================================================================
 * 为什么不能像 web profile 那样改 `profiles/desktop/package.json`：
 *
 *   dsh-desktop 的 `prepareDesktopProfile()`（src/main/first-run.ts）**每次启动**
 *   都无条件 `writeFileSync` 重写 `profiles/desktop/package.json` 与
 *   `profiles/desktop/cordis.patch.yml`，没有任何 exists 判断。手改的东西下一次
 *   启动就没了。
 *
 * 所以本脚本做两件不冲突的持久化：
 *
 *   1. 建 junction：`<DSH_HOME>/profiles/desktop/node_modules/dsh-cloudmusic-player`
 *      → 本包目录。`install.ts` 的 `copyPluginLib()` 只写 `@dsh-desktop/client`
 *      这一个目录，不清理别的 node_modules 条目，所以 junction 能活下来。
 *
 *   2. 往 `<DSH_HOME>/cordis.patch.yml`（home patch 层）追加一个带标记的块。
 *      这层在 profile patch **之上**，且桌面版不会覆盖它。条目带条件 `disabled`：
 *      只有当加载树里存在 `@dsh-desktop/client`（= 当前是桌面 profile）时才启用，
 *      否则禁用 —— 不然 web profile 也会再插一个实例，两条车道都去注册同一批
 *      exact 路径，宿主直接抛 `webserver: duplicate exact route`。
 *
 * 用法：
 *   node scripts/enable-desktop.mjs            # 安装 / 更新（幂等）
 *   node scripts/enable-desktop.mjs --remove   # 卸载（删块 + 删 junction）
 *   node scripts/enable-desktop.mjs --check    # 只看状态，不改任何东西
 * ============================================================================
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_NAME = 'dsh-cloudmusic-player'
const ENTRY_ID = 'cloudmusic-player-desktop'
const MARK_BEGIN = '# --- dsh-cloudmusic-player desktop (managed; re-run scripts/enable-desktop.mjs) ---'
const MARK_END = '# --- end dsh-cloudmusic-player desktop ---'

const DESKTOP_MARKER_EXPR =
  "!ctx.loader.entries().some((e) => e.options.name === '@dsh-desktop/client')"

/** 本包根目录（这个文件在 <pkg>/scripts/ 下） */
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function dshHome() {
  const env = String(process.env.DSH_HOME || '').trim()
  return env ? resolve(env) : join(homedir(), '.dsh')
}

function profileDir(home) {
  return join(home, 'profiles', 'desktop')
}

function linkPath(home) {
  return join(profileDir(home), 'node_modules', PKG_NAME)
}

function patchPath(home) {
  return join(home, 'cordis.patch.yml')
}

function readPatchBlock() {
  return [
    MARK_BEGIN,
    '# 桌面版每次启动都会重写 profiles/desktop/*，所以插件行只能落在这层（home patch）。',
    '# disabled 用 !!js 表达式求值：只在加载树里出现 @dsh-desktop/client 时启用，',
    '# 免得 web profile 里再插一个实例、两条车道抢同一批 exact 路由。',
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    `      name: ${PKG_NAME}`,
    `      disabled: !!js "${DESKTOP_MARKER_EXPR}"`,
    MARK_END,
  ].join('\n')
}

function stripBlock(text) {
  const i = text.indexOf(MARK_BEGIN)
  if (i < 0) return { text, removed: false }
  const j = text.indexOf(MARK_END, i)
  if (j < 0) return { text, removed: false, malformed: true }
  const after = j + MARK_END.length
  // 顺手吃掉紧跟其后的空行，避免反复运行堆空行
  const tail = text.slice(after).replace(/^\s*\n/, '\n')
  const head = text.slice(0, i).replace(/\s*$/, '')
  return { text: `${head}${head ? '\n' : ''}${tail.replace(/^\n/, '')}`, removed: true }
}

/** 判断已有链接指向哪里 */
function linkState(path, target) {
  if (!existsSync(path)) {
    // existsSync 对断链返回 false，用 lstat 再确认一次
    try {
      const st = lstatSync(path)
      if (st.isSymbolicLink()) return { state: 'broken', to: readlinkSync(path) }
    } catch {
      return { state: 'missing' }
    }
    return { state: 'missing' }
  }
  try {
    const st = lstatSync(path)
    if (!st.isSymbolicLink()) return { state: 'not-a-link' }
    const to = readlinkSync(path)
    const norm = (p) => String(p).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase()
    return { state: norm(to) === norm(target) ? 'ok' : 'wrong-target', to }
  } catch (error) {
    return { state: 'error', detail: String(error?.message ?? error) }
  }
}

function ensureLink(path, target, log) {
  const found = linkState(path, target)
  if (found.state === 'ok') {
    log(`· junction 已就绪：${path}`)
    return false
  }
  if (found.state === 'wrong-target' || found.state === 'not-a-link' || found.state === 'error') {
    // wrong-target：包目录被搬走过，junction 还指着旧路径 —— 这是最常见的一种。
    log(`· 现有 ${path} 指向 ${found.to || found.detail || '(非链接)'}，先删掉再重建`)
    rmSync(path, { recursive: true, force: true })
  } else if (found.state === 'broken') {
    rmSync(path, { force: true })
  }
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, 'junction')
  log(`· 已建 junction：${path} → ${target}`)
  return true
}

function removeLink(path, log) {
  if (!existsSync(path)) {
    try {
      lstatSync(path)
    } catch {
      log('· junction 不存在，跳过')
      return false
    }
  }
  rmSync(path, { recursive: true, force: true })
  log(`· 已删 junction：${path}`)
  return true
}

function main() {
  const args = process.argv.slice(2)
  const remove = args.includes('--remove')
  const checkOnly = args.includes('--check')
  const log = (msg) => process.stdout.write(`${msg}\n`)

  const home = dshHome()
  const dir = profileDir(home)
  const link = linkPath(home)
  const patch = patchPath(home)

  log(`dsh home: ${home}`)
  log(`本包目录: ${PKG_DIR}`)

  // 没有 desktop profile 说明这台机器没装/没跑过桌面版。此时什么都不做 ——
  // 建一个孤零零的 junction 反而是垃圾；等桌面版首次启动后再跑一次即可。
  if (!existsSync(dir)) {
    log('· 没找到 profiles/desktop：这台机器还没跑过 dsh 桌面版。')
    log('  先启动一次 dsh-desktop（它会生成 desktop profile），再回来跑本脚本。')
    process.exitCode = 0
    return
  }

  if (remove) {
    removeLink(link, log)
    if (existsSync(patch)) {
      const text = readFileSync(patch, 'utf8')
      const { text: next, removed } = stripBlock(text)
      if (!removed) {
        log('· home patch 里没有本插件的块，跳过')
      } else if (checkOnly) {
        log('· [check] home patch 里有一处本插件的块（未改动）')
      } else {
        writeFileSync(patch, next, 'utf8')
        log(`· 已从 home patch 移除插件块：${patch}`)
      }
    }
    log('完成（卸载）。')
    return
  }

  if (checkOnly) {
    const found = linkState(link, PKG_DIR)
    const verdict =
      found.state === 'ok'
        ? 'ok'
        : found.state === 'wrong-target'
          ? '需重建（指向旧路径）'
          : found.state === 'broken'
            ? '需重建（断链）'
            : found.state === 'not-a-link'
              ? '需重建（不是 junction）'
              : '缺失（装一下就好）'
    log(`· junction: ${found.state} → ${verdict}${found.to ? `（当前指向 ${found.to}）` : ''}`)
    if (existsSync(patch)) {
      const text = readFileSync(patch, 'utf8')
      log(`· home patch: ${text.includes(MARK_BEGIN) ? '已有本插件块' : '没有本插件块'}`)
    } else {
      log('· home patch: 文件不存在')
    }
    if (found.state !== 'ok') process.exitCode = 2
    return
  }

  ensureLink(link, PKG_DIR, log)

  const block = readPatchBlock()
  let text = ''
  if (existsSync(patch)) {
    text = readFileSync(patch, 'utf8')
    const { text: stripped, malformed } = stripBlock(text)
    if (malformed) {
      log(`· 警告：${patch} 里的标记块没有结束行，按原文追加，请人工检查`)
    }
    text = stripped
  }
  if (!text.trim()) {
    text = `${block}\n`
  } else {
    text = `${text.replace(/\s*$/, '')}\n\n${block}\n`
  }
  writeFileSync(patch, text, 'utf8')
  log(`· 已写入 home patch：${patch}`)
  log('完成。重启 dsh-desktop 后生效（桌面版每次启动都会重读这层 patch）。')
}

main()
