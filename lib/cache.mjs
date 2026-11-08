/**
 * lib/cache.mjs —— 歌词磁盘缓存
 * ============================================================================
 * 落盘位置：`<DSH_HOME>/cloudmusic-player/lyrics/<songId>.json`
 *
 * 为什么不写进插件包目录：装到 node_modules 之后可能只读，升级也会被覆盖。
 * 为什么不塞 localStorage：歌词几 KB 到几十 KB，塞 localStorage 会顶爆 5MB 配额。
 *
 * DSH_HOME 的取法踩过坑（见 dsh-bili-scroll/lib/state.mjs 的注释）：
 *   `ctx.get('dshHomePath')` 返回的是**函数**不是字符串：
 *       dshHomePath(...segments) => join(resolveDshHome(), ...segments)
 *   当字符串用（String(p)）会得到「函数源码 + 目录名」，mkdir 直接 ENOENT。
 * ============================================================================
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 缓存默认存活 30 天；歌词基本不变，长一点没关系 */
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 缓存内容版本。改这一条 = 让所有旧缓存自动作废重取。
 *
 * v1 → v2：歌词行多了 `tr`（网易云自带译文），payload 多了 `translated`。
 * 不升版本的话，用户升级插件后 30 天内都还在看没有译文的旧缓存，
 * 只会以为是「功能没生效」。
 */
export const CACHE_SCHEMA = 2

/** 超过这个条数就顺手清一次最老的，避免无限膨胀 */
const MAX_FILES = 400

/**
 * 解析本插件的家目录（`<DSH_HOME>/cloudmusic-player`），并确保存在。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function homeDirOf(ctx) {
  let base = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('cloudmusic-player')
      if (v) base = String(v)
    } else if (typeof p === 'string' && p) {
      base = join(p, 'cloudmusic-player')
    }
  } catch {
    /* 拿不到就走兜底 */
  }
  if (!base) base = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cloudmusic-player')
  try {
    mkdirSync(base, { recursive: true })
  } catch {
    /* 只读环境：后面写缓存会失败，但主功能不受影响 */
  }
  return base
}

export class LyricsCache {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir
    this.ready = false
  }

  ensure() {
    if (this.ready) return true
    try {
      mkdirSync(this.dir, { recursive: true })
      this.ready = true
    } catch {
      this.ready = false
    }
    return this.ready
  }

  fileOf(songId) {
    return join(this.dir, `${String(songId).replace(/[^0-9A-Za-z_-]/g, '_')}.json`)
  }

  /**
   * 读缓存。命中返回 `{ lines, source, translated, fetchedAt }`，否则 null。
   * 过期、JSON 坏掉、或 schema 版本对不上都当作 miss。
   *
   * schema 过期**不删文件** —— 紧接着的 set() 会用同一个文件名覆盖，
   * 删了反而多一次 unlink；而且删除失败（比如被占用）也没意义。
   */
  get(songId, ttlMs = DEFAULT_TTL_MS) {
    if (!this.ensure()) return null
    const file = this.fileOf(songId)
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
      try {
        unlinkSync(file)
      } catch {
        /* ignore */
      }
      return null
    }
    if (!parsed || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return null
    // 老版本写的缓存（没有 schema 字段，或版本更低）→ 当作没有，让上层重取
    if (parsed.schema !== CACHE_SCHEMA) return null
    const age = Date.now() - Number(parsed.fetchedAt || 0)
    if (!(age >= 0) || age > ttlMs) return null
    return {
      lines: parsed.lines,
      source: parsed.source || 'cache',
      translated: parsed.translated === true,
      fetchedAt: parsed.fetchedAt,
    }
  }

  /** 写缓存；失败静默（缓存不是主链路） */
  set(songId, payload) {
    if (!this.ensure()) return
    try {
      writeFileSync(
        this.fileOf(songId),
        JSON.stringify({ ...payload, schema: CACHE_SCHEMA, fetchedAt: Date.now() }),
        'utf8',
      )
      this.prune()
    } catch {
      /* ignore */
    }
  }

  /** 超过 MAX_FILES 时按 mtime 删最老的 */
  prune() {
    if (!this.ensure()) return
    let names
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    } catch {
      return
    }
    if (names.length <= MAX_FILES) return
    const stamps = names.map((n) => {
      let mtime = 0
      try {
        mtime = statSync(join(this.dir, n)).mtimeMs
      } catch {
        /* ignore */
      }
      return { n, mtime }
    })
    stamps.sort((a, b) => a.mtime - b.mtime)
    for (const { n } of stamps.slice(0, stamps.length - MAX_FILES)) {
      try {
        unlinkSync(join(this.dir, n))
      } catch {
        /* ignore */
      }
    }
  }

  clear() {
    if (!this.ensure()) return 0
    let n = 0
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue
        try {
          unlinkSync(join(this.dir, name))
          n += 1
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return n
  }
}
