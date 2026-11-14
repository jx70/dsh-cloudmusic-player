/**
 * index.js —— dsh-cloudmusic-player 的 Host 半端
 * ============================================================================
 * 它做三件事：
 *   1. 管一个常驻 powershell.exe 助手（lib/helper.ps1），拿系统的 SMTC 会话
 *      与 Core Audio 音量 —— 也就是「控制本机正在放歌的那个客户端」。
 *   2. 开 6 条同源 HTTP 路由，让浏览器里的悬浮框能读到状态、点播放、拖音量、
 *      取歌词。传输有三条车道（见 lib/transport.mjs）：
 *      · 新世代（0.1.5-rc.1 起）走 ctx.connection.fetch.register —— DSH 把整个
 *        /api 前缀挂在 connection 的信任栅栏后面，栅栏里的 admit() 要求请求带
 *        浏览器 cookie，否则 401；fetch 路由注册在栅栏内部，按 pathname 精确
 *        分发，正好是「页面自己 fetch 自己」的场景。
 *      · 旧世代（dsh-desktop 捆绑的 0.1.0-rc.6，connection 只有 rpc）退到
 *        ctx.webServer.register({ kind:'exact' }) + 自建的回环/同源栅栏。
 *      · 两者都没有就只记日志，插件其余部分照常工作。
 *   3. 给模型注册一个 cloudmusic_player 工具（profile 里没有 tools 服务时静默跳过）。
 *
 * 不 import 任何 @deepseek-ai/dsh-* 包：工具与路由都用标准 JSON/JS 对象描述，
 * 这样插件在任何 profile 里都能加载，不会因为宿主树解析不到依赖而整个挂掉。
 * 唯一的外部依赖是 @deepseek-ai/schemastery（Config 的 schema 语法）。
 * ============================================================================
 */
import z from '@deepseek-ai/schemastery'
import { selectBackend } from './lib/backend.mjs'
import { homeDirOf } from './lib/cache.mjs'
import { LyricsService } from './lib/lyrics.mjs'
import { PlayerService, PLAYER_DEFAULTS } from './lib/player.mjs'
import { mountTransport } from './lib/transport.mjs'

export const name = 'cloudmusic-player'
/** 路由必需；tools 用可选注入，没有就不注册工具。webServer 用 get() 取，不当注入项。 */
export const inject = ['connection']

/**
 * 插件配置。
 *
 * 标了 `.volatile()` 的字段会出现在设置页表单里、改完即时生效；
 * 其余是「装配期」参数（改了要重载插件），默认值直接对齐 v3 计划。
 */
export const Config = z.object({
  // ── 换机器时唯一需要动的东西 ───────────────────────────────────────────
  processName: z
    .string()
    .default('cloudmusic')
    .description('网易云进程名（不含 .exe）。按它取 pid，再匹配音频会话，所以只动这个客户端的音量'),
  aumidPattern: z
    .string()
    .default('cloudmusic|netease|wangyi')
    .description('系统媒体会话的 AppUserModelId 正则。商店/UWP 版可能要改成 CloudMusic.exe 之类，用 /health?deep=1 查'),

  // ── 音量 ────────────────────────────────────────────────────────────────
  volumeScope: z
    .union([z.const('process'), z.const('system')])
    .default('process')
    .description('process = 只调网易云自己的音量（不动系统总音量）；system = 调系统端点音量')
    .volatile(),

  // ── 歌词 ────────────────────────────────────────────────────────────────
  lyricsEnabled: z
    .boolean()
    .default(true)
    .description('取歌词。关掉之后插件一个外网请求都不发')
    .volatile(),
  lyricsTranslation: z
    .boolean()
    .default(true)
    .description('外语歌在原文下面显示网易云自带的中文译文（中文歌本来就没有译文，关掉只影响外语歌）')
    .volatile(),
  lyricsApiBase: z
    .string()
    .default('https://music.163.com/api')
    .description('歌词接口前缀，方便换成镜像/反代'),
  lyricsOffsetMs: z
    .number()
    .step(50)
    .min(-5000)
    .max(5000)
    .default(0)
    .description('歌词整体时间补偿（毫秒）。正数=歌词推后')
    .volatile(),

  // ── 播放控制（native 车道）──────────────────────────────────────────────
  // FAQ：为什么不是「用 SMTC 就完了」。网易云桌面版在 Win10 上注册 SMTC 会失败，
  // 系统里根本没有它的会话；这时只能靠客户端自己的全局快捷键。这三项要和客户端
  // 「设置 → 快捷键 → 全局快捷键」里那三条完全一致。
  hotkeyPlayPause: z
    .string()
    .default('Ctrl+Alt+P')
    .description('播放/暂停的全局快捷键（要和网易云客户端里设置的一致）'),
  hotkeyNext: z
    .string()
    .default('Ctrl+Alt+Right')
    .description('下一首的全局快捷键'),
  hotkeyPrev: z
    .string()
    .default('Ctrl+Alt+Left')
    .description('上一首的全局快捷键'),

  // ── 进度来源（客户端日志）────────────────────────────────────────────────
  // FAQ：进度条为什么能动了。网易云 3.x 不注册 SMTC，但它把播放事件写进
  // %LOCALAPPDATA%\NetEase\CloudMusic\cloudmusic.elog —— 里面有 songId、时长、
  // seek、暂停/恢复。读这个文件就能拿到真时间轴，不用登录、不碰 Cookie、
  // 也不会去读里面那段带签名的 musicurl。
  elogEnabled: z
    .boolean()
    .default(true)
    .description('从客户端日志读真实播放进度（关掉就退回「峰值估算」，进度条不可用）')
    .volatile(),
  elogPath: z
    .string()
    .default('')
    .description('日志路径。留空 = 自动定位 %LOCALAPPDATA%\\NetEase\\CloudMusic\\cloudmusic.elog'),
  elogPollMs: z
    .number()
    .step(50)
    .min(100)
    .max(5000)
    .default(400)
    .description('日志增量读取间隔（毫秒）')
    .volatile(),

  // ── 助手进程 ────────────────────────────────────────────────────────────
  powershellPath: z
    .string()
    .default('powershell.exe')
    .description('PowerShell 可执行文件。必须是 5.1（Windows PowerShell）：PowerShell 7 没有 WinRT 投影，播放控制会不可用'),
  helperPath: z
    .string()
    .default('')
    .description('助手脚本路径。留空 = 用包内的 lib/helper.ps1（正常情况都留空）'),
  requestTimeoutMs: z
    .number()
    .step(100)
    .min(500)
    .max(30000)
    .default(PLAYER_DEFAULTS.requestTimeoutMs)
    .description('单条助手请求超时（毫秒）')
    .volatile(),
  restartLimit: z
    .number()
    .step(1)
    .min(0)
    .max(20)
    .default(PLAYER_DEFAULTS.restartLimit)
    .description('助手崩溃后最多自动重启几次；超了就停下来等用户点重试')
    .volatile(),
})

/** 默认配置；用户可以在 profile 的 patch 层覆盖（升级不丢） */
export const DEFAULTS = {
  processName: 'cloudmusic',
  aumidPattern: 'cloudmusic|netease|wangyi',
  volumeScope: 'process',
  lyricsEnabled: true,
  lyricsTranslation: true,
  lyricsApiBase: 'https://music.163.com/api',
  lyricsOffsetMs: 0,
  powershellPath: 'powershell.exe',
  helperPath: '',
  hotkeyPlayPause: 'Ctrl+Alt+P',
  hotkeyNext: 'Ctrl+Alt+Right',
  hotkeyPrev: 'Ctrl+Alt+Left',
  elogEnabled: true,
  elogPath: '',
  elogPollMs: 400,
  requestTimeoutMs: PLAYER_DEFAULTS.requestTimeoutMs,
  restartLimit: PLAYER_DEFAULTS.restartLimit,
}

/** 路由前缀：一段合法 ENDPOINT_SEGMENT（字母数字 _ $ . -），落在 /api 之下 */
const NS = '/api/cloudmusic-player'

const ROUTES = {
  state: `${NS}/state`,
  action: `${NS}/action`,
  volume: `${NS}/volume`,
  lyrics: `${NS}/lyrics`,
  health: `${NS}/health`,
  restart: `${NS}/restart`,
}

/**
 * 解包 volatile 引用：schemastery 的 `.volatile()` 字段在 apply() 里是
 * cosmokit 的引用对象，得 `.get()` 才是当前值（设置页改完即时生效靠这个）。
 */
function unwrapVolatile(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

function jsonResponse(payload, status = 200, extraHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(extraHeaders || {}),
    },
  })
}

/** 读 JSON body；坏了就返回 null，让调用方给 400 而不是 500 */
async function readJson(request) {
  try {
    const text = await request.text()
    if (!text || !text.trim()) return {}
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 数字参数解析：非法/缺省都给 fallback */
function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }

  const log = (msg) => {
    try {
      ctx.logger?.(name)?.info?.(msg)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  /** 每次现读配置，volatile 字段跟着设置页实时走 */
  const getConfig = () => ({
    ...settings,
    ...(config ?? {}),
    volumeScope: unwrapVolatile(config?.volumeScope) ?? settings.volumeScope,
    lyricsEnabled: unwrapVolatile(config?.lyricsEnabled) ?? settings.lyricsEnabled,
    lyricsTranslation: unwrapVolatile(config?.lyricsTranslation) ?? settings.lyricsTranslation,
    lyricsOffsetMs: unwrapVolatile(config?.lyricsOffsetMs) ?? settings.lyricsOffsetMs,
    elogEnabled: unwrapVolatile(config?.elogEnabled) ?? settings.elogEnabled,
    elogPollMs: unwrapVolatile(config?.elogPollMs) ?? settings.elogPollMs,
    requestTimeoutMs: unwrapVolatile(config?.requestTimeoutMs) ?? settings.requestTimeoutMs,
    restartLimit: unwrapVolatile(config?.restartLimit) ?? settings.restartLimit,
  })

  const backend = selectBackend()
  const player = new PlayerService({ backend, getConfig, log })
  const cacheDir = homeDirOf(ctx)
  const lyrics = new LyricsService({ getConfig }, cacheDir)

  /** 路由最终走的是哪条车道（fetch / webserver / none），/health 会报出去 */
  let transportState = { transport: 'pending', note: '' }

  // 进程生命周期：插件卸了就先把助手 quit 掉，再兜底 kill，不留孤儿 powershell
  ctx.effect(() => () => {
    player.stop().catch(() => {})
  }, 'cloudmusic-player: 助手进程')

  player.on('degraded', (reason) => log(`助手进入降级态：${reason}`))

  // ── 路由 ────────────────────────────────────────────────────────────────
  // 统一包装：任何异常都变成 { ok:false } + 200，让悬浮框能稳定显示错误文案，
  // 而不是拿一个 500 白屏。
  const guard = (fn) => async (request) => {
    try {
      return await fn(request)
    } catch (error) {
      const detail = String(error?.message ?? error)
      log(`路由异常：${detail}`)
      return jsonResponse({ ok: false, error: 'internal', detail })
    }
  }

  const routes = [
    {
      path: ROUTES.state,
      methods: ['GET'],
      handler: guard(async () => jsonResponse(await player.state({ fresh: true }))),
    },
    {
      path: ROUTES.action,
      methods: ['POST'],
      handler: guard(async (request) => {
        const body = await readJson(request)
        if (!body) return jsonResponse({ ok: false, error: 'bad-body' }, 400)
        const action = String(body.action || '').trim()
        const result = await player.action(action, { positionMs: num(body.positionMs, 0) })
        return jsonResponse(result)
      }),
    },
    {
      path: ROUTES.volume,
      methods: ['POST'],
      handler: guard(async (request) => {
        const body = await readJson(request)
        if (!body) return jsonResponse({ ok: false, error: 'bad-body' }, 400)
        const hasMuted = body.muted !== undefined && body.muted !== null
        const hasLevel = body.level !== undefined && body.level !== null
        if (!hasMuted && !hasLevel) return jsonResponse({ ok: false, error: 'bad-body' }, 400)
        const result = await player.volume({
          level: hasLevel ? num(body.level, 0) : undefined,
          muted: hasMuted ? !!body.muted : undefined,
          scope: body.scope === 'system' || body.scope === 'process' ? body.scope : undefined,
        })
        return jsonResponse(result)
      }),
    },
    {
      path: ROUTES.lyrics,
      methods: ['GET'],
      handler: guard(async (request) => {
        const url = new URL(request.url)
        const q = url.searchParams
        const result = await lyrics.resolve({
          title: q.get('title') || '',
          artist: q.get('artist') || '',
          durationMs: num(q.get('durationMs'), 0),
          songId: q.get('songId') ? num(q.get('songId'), 0) : 0,
        })
        if (!result.ok) {
          // 取不到歌词不是错误状态，UI 要显示「暂无歌词」而不是报错
          return jsonResponse({ ok: false, ...result })
        }
        return jsonResponse(
          {
            ok: true,
            songId: result.songId,
            source: result.source,
            translated: result.translated === true,
            cached: !!result.cached,
            lines: result.lines,
          },
          200,
          { 'cache-control': 'public, max-age=3600' },
        )
      }),
    },
    {
      path: ROUTES.health,
      methods: ['GET'],
      handler: guard(async (request) => {
        const url = new URL(request.url)
        const deep = url.searchParams.get('deep') === '1'
        if (deep) {
          return jsonResponse({
            ...(await player.deepHealth()),
            transport: transportState.transport,
            transportNote: transportState.note,
          })
        }
        const helper = player.readyInfo()
        return jsonResponse({
          ok: true,
          platform: backend.platform,
          backend: backend.id,
          transport: transportState.transport,
          transportNote: transportState.note,
          capabilities: helper.capabilities,
          // seek 的副作用：走 orpheus:// 协议投递时，客户端会顺手把主窗口 show
          // 出来（哪怕它正收在托盘）。前端据此决定要不要在拖进度前提示一句。
          seekWindowLeak: player.windowLeak !== false,
          helper,
          lyrics: { enabled: lyrics.enabled(), base: lyrics.base() },
        })
      }),
    },
    {
      path: ROUTES.restart,
      methods: ['POST'],
      handler: guard(async () => {
        try {
          const info = await player.restart()
          return jsonResponse({ ok: true, ...info })
        } catch (error) {
          return jsonResponse({
            ok: false,
            error: player.degraded || 'helper-unavailable',
            detail: String(error?.message ?? error),
          })
        }
      }),
    },
  ]

  // 传输车道：新世代走 connection.fetch（带 owner-peer 鉴权），旧世代
  // （dsh-desktop 捆绑的 0.1.0-rc.6）退到 webServer 的 exact 路由 + 自建栅栏。
  // 具体选择在 lib/transport.mjs 里，这里只负责把服务取出来喂进去。
  const mountRoutes = (scope) => {
    const pick = (key) => {
      // 注意：cordis 里未 inject 时读 ctx.<service> 会直接抛
      // `cannot get property "x" without inject`，所以一律走 get()。
      if (typeof scope.get === 'function') {
        try {
          return scope.get(key)
        } catch {
          return undefined
        }
      }
      return scope[key]
    }

    const mounted = mountTransport({
      connection: pick('connection'),
      webServer: pick('webServer'),
      routes,
      effect: typeof scope.effect === 'function'
        ? (factory, label) => scope.effect(factory, label)
        : undefined,
      log,
    })

    transportState = { transport: mounted.transport, note: mounted.note }
    log(`已挂载 ${routes.length} 条路由于 ${NS}（车道 ${mounted.transport}：${mounted.note}）`)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], mountRoutes)
  } else {
    mountRoutes(ctx)
  }

  // ── 模型工具（可选） ────────────────────────────────────────────────────
  // 一个操作只有一个实现：工具和路由都调 PlayerService，不存在两份逻辑。
  const mountTool = (scope) => {
    if (!scope.tools || typeof scope.tools.register !== 'function') {
      log('没有 tools 服务，跳过 cloudmusic_player 工具')
      return
    }
    scope.tools.register({
      name: 'cloudmusic_player',
      description:
        '控制本机网易云音乐客户端：播放/暂停/切歌、跳进度、调音量（默认只调网易云自己的音量，不动系统总音量）、'
        + '看当前在放什么。还可以取当前这首歌的歌词（带时间轴，LRC 解析后的行数组）。'
        + '客户端没开时会返回 ok:false 与提示，不抛错。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'play', 'pause', 'toggle', 'next', 'prev', 'seek', 'volume', 'mute', 'lyrics', 'health'],
            description: '要做什么。status 看当前状态；volume 需要 level；mute 需要 muted；seek 需要 positionMs',
          },
          positionMs: { type: 'integer', description: 'seek 的目标位置（毫秒）' },
          level: { type: 'number', description: 'volume 的目标音量，0..1' },
          muted: { type: 'boolean', description: 'mute 的目标状态' },
          scope: {
            type: 'string',
            enum: ['process', 'system'],
            description: 'volume/mute 的作用域：process 只改网易云，system 改系统总音量。省略用插件配置',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const action = String(args?.action || 'status')
        const signal = exec?.signal

        const describe = (st) => {
          if (!st || !st.now) {
            return st && st.ok === false
              ? `网易云没在放歌（${st.error || 'no-session'}）。${st.hint || ''}`.trim()
              : '没找到网易云客户端：先打开它并播放一首歌。'
          }
          const n = st.now
          const status = n.status === 'Playing' ? '播放中' : n.status === 'Paused' ? '已暂停' : n.status || '?'
          const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
          const pct = (o) => (o ? Math.round(Number(o.level) * 100) : null)
          let vol = st.volume
            ? `音量 ${pct(st.volume)}%（${st.volume.scope === 'process' ? '网易云' : '系统'}）${st.volume.muted ? ' 静音' : ''}`
            : ''
          // 两路读数各自独立：只在确实不同时补一句，免得每次都说「系统也是 49%」。
          const appPct = pct(st.volume)
          const sysPct = pct(st.systemVolume)
          if (vol && appPct !== null && sysPct !== null && Math.abs(appPct - sysPct) > 1) {
            vol += `（系统 ${sysPct}%${st.systemVolume.muted ? ' 静音' : ''}）`
          }
          // 进度来源有三种：smtc（系统给的准值）、elog（客户端日志，靠 orpheus 协议 seek）、
          // peak（峰值估算，没有时间轴）。别在 peak 状态下报一个假的 0:00 / 0:00。
          const hasTimeline = Number(n.end) > 0
          const src = n.positionSource === 'elog' ? '客户端日志' : n.positionSource === 'smtc' ? '系统媒体会话' : '峰值估算'
          const progress = hasTimeline
            ? `进度 ${fmt(n.pos)} / ${fmt(n.end)}（来自${src}${n.canSeek ? '，可 seek' : '，不能 seek'}）`
            : `进度：${src}拿不到时间轴（无法 seek）`
          const lane = n.channel === 'native' ? '原生车道（窗口标题 + 音频峰值 + 客户端全局热键 + orpheus 协议 seek）' : '系统媒体会话（SMTC）'
          return [
            `${status} · ${n.title || '(无标题)'}${n.artist ? ` - ${n.artist}` : ''}`,
            progress,
            vol,
            `通道 ${lane}`,
          ].filter(Boolean).join('\n')
        }

        try {
          if (action === 'status') {
            return { text: describe(await player.state({ fresh: true })) }
          }
          if (action === 'health') {
            const h = await player.deepHealth()
            return {
              text: [
                `平台 ${h.platform} · 后端 ${h.backend} · PowerShell ${h.ps || '?'} · WinRT ${h.winrt ? 'ok' : '不可用'} · 窗口 ${h.window ? 'ok' : '不可用'}`,
                `进程 ${(h.pids || []).join(', ') || '(无)'} · 目标会话 ${h.target || '(SMTC 未匹配，走原生车道)'}`,
                `媒体会话：${(h.media || []).map((m) => `${m.aumid}${m.title ? `(${m.title})` : ''}`).join(' / ') || '(无)'}`,
                `原生车道：${(h.native || []).map((n) => `pid ${n.pid} ${n.title || '(无标题)'} peak ${n.peak}`).join(' / ') || '(无)'}`,
                h.hotkeys ? `热键：${h.hotkeys.playPause} / ${h.hotkeys.next} / ${h.hotkeys.prev}` : '',
                h.elog
                  ? `日志车道：${h.elog.available ? 'ok' : `不可用(${h.elog.reason || '?'})`} · ${h.elog.exists ? `${Math.round((h.elog.size || 0) / 1024)} KB` : '文件不存在'}${h.elog.track ? ` · ${h.elog.track.title} - ${h.elog.track.artist}` : ''}`
                  : '日志车道：未启用',
                `HTTP 车道：${h.transport || transportState.transport}${h.transportNote ? `（${h.transportNote}）` : ''}`,
                h.lastError ? `最后错误：${h.lastError}` : '',
              ].filter(Boolean).join('\n'),
            }
          }
          if (action === 'lyrics') {
            const st = await player.state({ fresh: true })
            if (!st.now) return { text: '现在没有在放歌，取不到歌词。' }
            const result = await lyrics.resolve({
              title: st.now.title,
              artist: st.now.artist,
              durationMs: Math.round((st.now.end || 0) * 1000),
              // 日志车道能给出真 songId，直接按 id 取词，绕开搜索的版权误配
              songId: st.now.songId || '',
            })
            if (!result.ok) return { text: `这首歌没取到歌词（${result.reason}）。` }
            if (signal?.aborted) throw new Error('aborted')
            const body = result.lines
              .map((l) => {
                const head = `[${(l.t / 1000).toFixed(1)}] ${l.text}`
                return typeof l.tr === 'string' && l.tr ? `${head}\n      ⟶ ${l.tr}` : head
              })
              .join('\n')
            const tag = result.translated ? '，含译文' : ''
            return { text: `${st.now.title} - ${st.now.artist}（来源 ${result.source}${tag}）\n${body}` }
          }
          if (action === 'volume' || action === 'mute') {
            if (action === 'volume' && args?.level === undefined) {
              return { text: 'volume 需要 level（0..1）。' }
            }
            if (action === 'mute' && args?.muted === undefined) {
              return { text: 'mute 需要 muted（true/false）。' }
            }
            const res = await player.volume({
              level: args?.level === undefined ? undefined : num(args.level, 0),
              muted: action === 'mute' ? !!args?.muted : undefined,
              scope: args?.scope === 'system' || args?.scope === 'process' ? args.scope : undefined,
            })
            if (!res.ok) return { text: `改音量失败：${res.error || 'unknown'}${res.detail ? ` (${res.detail})` : ''}` }
            const v = res.volume
            return {
              text: v
                ? `音量已设为 ${Math.round(v.level * 100)}%（${v.scope === 'process' ? '网易云' : '系统'}）${v.muted ? '，静音中' : ''}`
                : '音量已设置。',
            }
          }
          const res = await player.action(action, { positionMs: num(args?.positionMs, 0) })
          if (!res.ok) {
            return { text: `操作失败：${res.error || 'unknown'}${res.detail ? ` (${res.detail})` : ''}` }
          }
          return { text: `已执行 ${action}。\n${describe({ ok: true, now: res.now, volume: res.volume })}` }
        } catch (error) {
          return { text: `调用失败：${String(error?.message ?? error)}` }
        }
      },
    })
    log('已注册工具 cloudmusic_player')
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], mountTool)
  } else {
    mountTool(ctx)
  }

  // 首帧就把助手拉起来：悬浮框一出现就有数据，不用等第一次轮询。
  // 失败了也无所谓 —— 轮询时会重试，并且 UI 有降级态。
  player.start().catch((err) => log(`助手首启失败：${String(err?.message ?? err)}`))

  log(`就绪：后端 ${backend.id}，平台 ${backend.platform}，歌词 ${lyrics.enabled() ? 'on' : 'off'}`)
}
