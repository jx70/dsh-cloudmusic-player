/**
 * test/lyrics.test.mjs —— lib/lyrics.mjs（译文合并）+ lib/cache.mjs（schema）的单元测试
 * ============================================================================
 * 跑法：node --test test/elog.test.mjs test/lyrics.test.mjs
 *      （目录形式 `node --test test/` 在 Node 22 上会报 Cannot find module，别用）
 *
 * 全部离线：网络用 `globalThis.fetch` 打桩，缓存写 `os.tmpdir()` 下的临时目录。
 * 样本直接抄自真机实测的网易云响应（God knows… / 越来越不懂）。
 * ============================================================================
 */
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mergeTranslation, parseLrc, LyricsService } from '../lib/lyrics.mjs'
import { LyricsCache, CACHE_SCHEMA } from '../lib/cache.mjs'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const made = []
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-test-'))
  made.push(dir)
  return dir
}

const realFetch = globalThis.fetch
after(() => {
  globalThis.fetch = realFetch
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** 打桩：按顺序返回给定的 JSON 体；记录被请求的 URL */
function stubFetch(bodies) {
  const calls = []
  let i = 0
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const body = bodies[Math.min(i, bodies.length - 1)]
    i += 1
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(body)
      },
    }
  }
  return calls
}

/** 造一个 LyricsService，配置可覆盖 */
function makeService(dir, cfg = {}) {
  const config = {
    lyricsEnabled: true,
    lyricsTranslation: true,
    lyricsApiBase: 'https://music.163.com/api',
    ...cfg,
  }
  return new LyricsService({ getConfig: () => config }, dir)
}

// 实测样本（2026-11 真机，songId 22826401 God knows…）
const LRC_JP = [
  '[00:00.000] 作词 : 畑 亜貴',
  '[00:01.000] 作曲 : 神前 暁',
  '[00:27.890]渇いた心で駆け抜ける',
  '[00:34.230]ごめんね 何もできなくて',
  '[00:40.640]痛みを分かち合うことさえ',
].join('\n')

const TLYRIC_JP = [
  '[00:27.890]带着干渴的心灵奔跑追逐',
  '[00:34.230]抱歉 我无力为你做什么',
  '[00:40.640]就连 欲为你分担痛苦一事',
].join('\n')

// 实测样本：中文歌没有译文（songId 208940 越来越不懂）
const LRC_CN = ['[00:00.000] 作词 : 蔡健雅', '[00:00.307]哦', '[00:04.602]什么都不懂'].join('\n')

// ---------------------------------------------------------------------------
// mergeTranslation
// ---------------------------------------------------------------------------

test('mergeTranslation: 时间戳精确相等时配对', () => {
  const lines = parseLrc(LRC_JP)
  const merged = mergeTranslation(lines, parseLrc(TLYRIC_JP))
  assert.equal(merged.length, 5)
  assert.equal(merged[0].tr, undefined, '署名行没有译文')
  assert.equal(merged[2].tr, '带着干渴的心灵奔跑追逐')
  assert.equal(merged[4].tr, '就连 欲为你分担痛苦一事')
  assert.equal(merged[2].text, '渇いた心で駆け抜ける', '原文不能被改动')
})

test('mergeTranslation: 偏 30ms 仍能配到（≤60ms 最近邻）', () => {
  const lines = [{ t: 27890, text: 'a' }]
  const trans = [{ t: 27920, text: '甲' }]
  assert.equal(mergeTranslation(lines, trans)[0].tr, '甲')
})

test('mergeTranslation: 偏 200ms 不配（宁缺不错）', () => {
  const lines = [{ t: 27890, text: 'a' }]
  const trans = [{ t: 28090, text: '甲' }]
  assert.equal(mergeTranslation(lines, trans)[0].tr, undefined)
})

test('mergeTranslation: 多个候选时取更近的那个', () => {
  const lines = [{ t: 1000, text: 'a' }]
  const trans = [
    { t: 950, text: '近' },
    { t: 1050, text: '远' },
  ]
  assert.equal(mergeTranslation(lines, trans)[0].tr, '近')
})

test('mergeTranslation: 译文与原文相同则不附加', () => {
  const lines = [{ t: 1000, text: 'Hello' }]
  const trans = [{ t: 1000, text: 'Hello' }]
  assert.equal(mergeTranslation(lines, trans)[0].tr, undefined)
})

test('mergeTranslation: 译文为空串/空白的行被忽略', () => {
  const lines = [{ t: 1000, text: 'a' }]
  const trans = [{ t: 1000, text: '   ' }]
  assert.equal(mergeTranslation(lines, trans)[0].tr, undefined)
})

test('mergeTranslation: 原文的空文本行（间奏标记）不附加译文', () => {
  const lines = [{ t: 1000, text: '' }]
  const trans = [{ t: 1000, text: '甲' }]
  assert.equal(mergeTranslation(lines, trans)[0].tr, undefined)
})

test('mergeTranslation: 译文的孤立时间点被丢弃，不新增行', () => {
  const lines = [{ t: 1000, text: 'a' }]
  const trans = [
    { t: 1000, text: '甲' },
    { t: 99999, text: '孤' },
  ]
  const merged = mergeTranslation(lines, trans)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].tr, '甲')
})

test('mergeTranslation: 不修改入参、未配对的行不带 tr 键', () => {
  const lines = [{ t: 1000, text: 'a' }]
  mergeTranslation(lines, [])
  assert.deepEqual(lines, [{ t: 1000, text: 'a' }])
  const merged = mergeTranslation([{ t: 1, text: 'x' }], [{ t: 1, text: 'y' }])
  assert.equal(JSON.stringify(merged[0]).includes('"tr"'), true)
  assert.equal(JSON.stringify(mergeTranslation([{ t: 1, text: 'x' }], [])[0]).includes('"tr"'), false)
})

test('mergeTranslation: 空译文/非数组输入一律原样返回', () => {
  assert.deepEqual(mergeTranslation([], []), [])
  assert.equal(mergeTranslation(null, []).length, 0)
  const lines = [{ t: 1, text: 'x' }]
  assert.equal(mergeTranslation(lines, null), lines)
})

// ---------------------------------------------------------------------------
// fetchLyric
// ---------------------------------------------------------------------------

test('fetchLyric: 原文 + 译文 → translated:true，逐行带 tr', async () => {
  stubFetch([{ code: 200, lrc: { lyric: LRC_JP }, tlyric: { lyric: TLYRIC_JP } }])
  const svc = makeService(tmpDir())
  const out = await svc.fetchLyric(22826401)
  assert.equal(out.ok, true)
  assert.equal(out.source, 'lrc')
  assert.equal(out.translated, true)
  assert.equal(out.lines.length, 5)
  assert.equal(out.lines[2].tr, '带着干渴的心灵奔跑追逐')
})

test('fetchLyric: 中文歌没有 tlyric → translated:false，行里没有 tr', async () => {
  stubFetch([{ code: 200, lrc: { lyric: LRC_CN }, tlyric: { lyric: '' } }])
  const svc = makeService(tmpDir())
  const out = await svc.fetchLyric(208940)
  assert.equal(out.ok, true)
  assert.equal(out.translated, false)
  assert.ok(out.lines.every((l) => l.tr === undefined))
})

test('fetchLyric: 关掉译文开关就不合并', async () => {
  stubFetch([{ code: 200, lrc: { lyric: LRC_JP }, tlyric: { lyric: TLYRIC_JP } }])
  const svc = makeService(tmpDir(), { lyricsTranslation: false })
  const out = await svc.fetchLyric(22826401)
  assert.equal(out.ok, true)
  assert.equal(out.translated, false)
  assert.ok(out.lines.every((l) => l.tr === undefined))
})

test('fetchLyric: 原文为空时退卡拉OK，并叠上译文', async () => {
  stubFetch([
    {
      code: 200,
      lrc: { lyric: '' },
      klyric: { lyric: LRC_JP },
      tlyric: { lyric: TLYRIC_JP },
    },
  ])
  const svc = makeService(tmpDir())
  const out = await svc.fetchLyric(1)
  assert.equal(out.source, 'klyric')
  assert.equal(out.translated, true)
})

test('fetchLyric: 只有 tlyric 时把它当正文，不再自我合并', async () => {
  stubFetch([{ code: 200, lrc: { lyric: '' }, tlyric: { lyric: TLYRIC_JP } }])
  const svc = makeService(tmpDir())
  const out = await svc.fetchLyric(2)
  assert.equal(out.source, 'tlyric')
  assert.equal(out.translated, false)
  assert.equal(out.lines.length, 3)
  assert.equal(out.lines[0].tr, undefined)
})

test('fetchLyric: 全空 → no-lyric-body 且 translated:false', async () => {
  stubFetch([{ code: 200, lrc: { lyric: '' }, tlyric: { lyric: '' } }])
  const svc = makeService(tmpDir())
  const out = await svc.fetchLyric(3)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'no-lyric-body')
  assert.equal(out.translated, false)
})

test('fetchLyric: 纯文本歌词（无时间戳）按 4 秒铺开，translated:false', async () => {
  stubFetch([{ code: 200, lrc: { lyric: '第一行\n第二行\n第三行' } }])
  const svc = makeService(tmpDir())
  const out = await svc.fetchLyric(4)
  assert.equal(out.source, 'plain')
  assert.equal(out.lines.length, 3)
  assert.equal(out.lines[2].t, 8000)
  assert.equal(out.translated, false)
})

// ---------------------------------------------------------------------------
// LyricsCache schema
// ---------------------------------------------------------------------------

test('LyricsCache: 写进去读出来带 schema 与 translated', () => {
  const dir = tmpDir()
  const cache = new LyricsCache(dir)
  cache.set(100, { lines: [{ t: 0, text: 'a', tr: '甲' }], source: 'lrc', translated: true })
  const raw = JSON.parse(fs.readFileSync(cache.fileOf(100), 'utf8'))
  assert.equal(raw.schema, CACHE_SCHEMA)
  assert.equal(raw.translated, true)
  const hit = cache.get(100)
  assert.equal(hit.translated, true)
  assert.equal(hit.source, 'lrc')
  assert.equal(hit.lines[0].tr, '甲')
})

test('LyricsCache: 没有 schema 的旧文件一律 miss（但文件不删）', () => {
  const dir = tmpDir()
  const cache = new LyricsCache(dir)
  fs.writeFileSync(
    cache.fileOf(200),
    JSON.stringify({ lines: [{ t: 0, text: 'a' }], source: 'lrc', fetchedAt: Date.now() }),
    'utf8',
  )
  assert.equal(cache.get(200), null)
  assert.equal(fs.existsSync(cache.fileOf(200)), true, 'miss 不应该顺手删文件')
})

test('LyricsCache: schema 对但过期了也 miss', () => {
  const dir = tmpDir()
  const cache = new LyricsCache(dir)
  fs.writeFileSync(
    cache.fileOf(300),
    JSON.stringify({ schema: CACHE_SCHEMA, lines: [{ t: 0, text: 'a' }], fetchedAt: Date.now() - 10_000 }),
    'utf8',
  )
  assert.equal(cache.get(300, 1000), null)
  assert.ok(cache.get(300, 60_000))
})

// ---------------------------------------------------------------------------
// resolve 端到端（含缓存往返）
// ---------------------------------------------------------------------------

test('resolve: 按 songId 取词 → 第二次命中缓存且译文还在', async () => {
  const dir = tmpDir()
  const svc = makeService(dir)
  const calls = stubFetch([{ code: 200, lrc: { lyric: LRC_JP }, tlyric: { lyric: TLYRIC_JP } }])

  const first = await svc.resolve({ songId: 22826401 })
  assert.equal(first.ok, true)
  assert.equal(first.translated, true)
  assert.equal(first.cached, undefined)
  assert.equal(calls.length, 1)

  const second = await svc.resolve({ songId: 22826401 })
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(second.translated, true)
  assert.equal(second.lines[2].tr, '带着干渴的心灵奔跑追逐')
  assert.equal(calls.length, 1, '缓存命中后不该再发请求')
})

test('resolve: 中文歌走完全流程也不带 tr', async () => {
  const svc = makeService(tmpDir())
  stubFetch([{ code: 200, lrc: { lyric: LRC_CN }, tlyric: { lyric: '' } }])
  const out = await svc.resolve({ songId: 208940 })
  assert.equal(out.ok, true)
  assert.equal(out.translated, false)
  assert.ok(out.lines.every((l) => !l.tr))
})

test('resolve: 缓存里是旧 schema → 重新取网并覆盖', async () => {
  const dir = tmpDir()
  const svc = makeService(dir)
  const cache = new LyricsCache(dir)
  // 先塞一条 v1 老缓存
  fs.writeFileSync(
    cache.fileOf(22826401),
    JSON.stringify({ lines: [{ t: 0, text: '旧' }], source: 'lrc', fetchedAt: Date.now() }),
    'utf8',
  )
  const calls = stubFetch([{ code: 200, lrc: { lyric: LRC_JP }, tlyric: { lyric: TLYRIC_JP } }])
  const out = await svc.resolve({ songId: 22826401 })
  assert.equal(calls.length, 1, '旧缓存必须失效并重取')
  assert.equal(out.translated, true)
  const raw = JSON.parse(fs.readFileSync(cache.fileOf(22826401), 'utf8'))
  assert.equal(raw.schema, CACHE_SCHEMA)
})

test('resolve: lyricsEnabled=false 时一个请求都不发', async () => {
  const svc = makeService(tmpDir(), { lyricsEnabled: false })
  const calls = stubFetch([{ code: 200 }])
  const out = await svc.resolve({ songId: 1 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'lyrics-disabled')
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// 防止回归：默认值
// ---------------------------------------------------------------------------

test('translationEnabled 默认开启，显式 false 才关', () => {
  assert.equal(makeService(tmpDir()).translationEnabled(), true)
  assert.equal(makeService(tmpDir(), { lyricsTranslation: false }).translationEnabled(), false)
  assert.equal(makeService(tmpDir(), { lyricsTranslation: undefined }).translationEnabled(), true)
})
