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
import { DailyService } from './lib/daily.mjs'
import { LikeService } from './lib/like.mjs'
import { LyricsService } from './lib/lyrics.mjs'
import { PlayerService, PLAYER_DEFAULTS } from './lib/player.mjs'
import { WebBackend } from './lib/web-backend.mjs'
import { ChannelRouter } from './lib/channel.mjs'
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

  // ── 播放通道 ────────────────────────────────────────────────────────────
  // k65：客户端没装/没开时，用 ego 浏览器驱动网易云网页版跑同样的 action。
  // 默认「客户端优先」——客户端在线时行为完全不变；探测到助手不可用时自动切网页。
  channelMode: z
    .union([z.const('client-first'), z.const('web-first'), z.const('client-only'), z.const('web-only')])
    .default('client-first')
    .description('播放通道：client-first=客户端优先（默认，掉线自动切网页）/ web-first=网页优先 / client-only=仅客户端 / web-only=仅网页版')
    .volatile(),
  webBrowserJson: z
    .string()
    .default('')
    .description('ego 浏览器 browser.json 路径。留空 = 自动（Windows 用 %LOCALAPPDATA%\\ego-lite-linux\\browser.json）'),
  webLoginCookie: z
    .string()
    .default('')
    .description('网页版登录 cookie（Cookie 头原文）。留空 = 自动复用客户端解出的 cookie 或浏览器已登录会话'),
  webAutoInjectCookie: z
    .boolean()
    .default(true)
    .description('自动把客户端解出的登录 cookie 注入 ego 浏览器，复用登录态（默认开）')
    .volatile(),
  webSongUrlLevel: z
    .union([z.const('standard'), z.const('exhigh'), z.const('lossless'), z.const('hires')])
    .default('standard')
    .description('网页版音频质量（standard/exhigh/lossless/hires）。无损需 VIP，拿不到会自动降级'),

  // k65 补：网页版走系统媒体会话（SMTC）识别/控制个人浏览器正在放的歌。
  // ego-lite 网页是「去客户端播放」占位、用户真正在放的浏览器没有 CDP 端口——
  // SMTC 是唯一能读到那首歌的公共通道。默认开；关掉则只走 CDP。
  smtcEnabled: z
    .boolean()
    .default(true)
    .description('网页版通道用系统媒体会话(SMTC)识别/控制个人浏览器正在放的歌（默认开）')
    .volatile(),
  smtcBrowserAumid: z
    .string()
    .default('msedge\\.exe|chrome\\.exe|firefox\\.exe|MSWebView2|msedgewebview2')
    .description('SMTC 命中的浏览器进程 AUMID 正则。留空 = 用默认的 Edge/Chrome/Firefox/WebView2 白名单'),

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
  hotkeyLike: z
    .string()
    .default('Ctrl+Alt+L')
    .description('喜欢/取消喜欢的全局快捷键（默认 love=Ctrl+Alt+L；在 DSH 里点红心会用它同步客户端本地红心，需与客户端设置一致）'),

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

  // ── 每日推荐 ────────────────────────────────────────────────────────────
  // 客户端 3.1.43 的 webcmd 命令表里没有「播放日推」，所以列表必须由插件自己拿：
  // 借客户端已登录的 cookie 调接口，拿到 songId 之后再用 orpheus:// 逐条喂。
  dailyApiBase: z
    .string()
    .default('https://music.163.com/api')
    .description('每日推荐接口前缀，方便换成镜像/反代'),
  dailyLimit: z
    .number()
    .step(1)
    .min(1)
    .max(200)
    .default(50)
    .description('每日推荐取多少首（接口一般给 30~50）'),
  dailyProfileDir: z
    .string()
    .default('')
    .description('客户端 CEF profile 目录。留空 = 自动找 %LOCALAPPDATA%\\NetEase\\CloudMusic\\webapp* 里 Cookies 最新的那个'),

  // ── 喜欢（红心）────────────────────────────────────────────────────────────
  // 走网易云 Web API + 客户端 cookie（不投 webcmd、不弹客户端窗口）。
  likeApiBase: z
    .string()
    .default('')
    .description('喜欢接口前缀。留空 = 跟随 dailyApiBase；方便换成镜像/反代'),
  likeSyncMs: z
    .number()
    .step(1000)
    .min(2000)
    .max(60000)
    .default(8000)
    .description('同一首歌期间同步红心状态的间隔（毫秒）。客户端日志无喜欢事件，只能轮询；越小越及时、请求越多')
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
  channelMode: 'client-first',
  webBrowserJson: '',
  webLoginCookie: '',
  webAutoInjectCookie: true,
  webSongUrlLevel: 'standard',
  smtcEnabled: true,
  smtcBrowserAumid: 'msedge\\.exe|chrome\\.exe|firefox\\.exe|MSWebView2|msedgewebview2',
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
  hotkeyLike: 'Ctrl+Alt+L',
  elogEnabled: true,
  elogPath: '',
  elogPollMs: 400,
  dailyApiBase: 'https://music.163.com/api',
  dailyLimit: 50,
  dailyProfileDir: '',
  likeApiBase: '',
  likeSyncMs: 8000,
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
    channelMode: unwrapVolatile(config?.channelMode) ?? settings.channelMode,
    webAutoInjectCookie: unwrapVolatile(config?.webAutoInjectCookie) ?? settings.webAutoInjectCookie,
    smtcEnabled: unwrapVolatile(config?.smtcEnabled) ?? settings.smtcEnabled,
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
  const cacheDir = homeDirOf(ctx)
  const daily = new DailyService({ getConfig, log })
  const like = new LikeService({ getConfig, log })
  const native = new PlayerService({ backend, getConfig, log, daily, like })
  const lyrics = new LyricsService({ getConfig }, cacheDir)

  // k65：网页版通道。歌词/LRC 解析复用同一个 LyricsService，登录态由后端自己
  // 从客户端 cookie 注入 ego 浏览器。上层只认 player（ChannelRouter），接口形状
  // 与原生 PlayerService 一致，client-first 模式下客户端在线时走的路跟以前一模一样。
  const web = new WebBackend({ getConfig, log, daily })
  web.like = like
  web.lyricsResolver = (params) => lyrics.resolve(params)
  // 系统音量是 Windows 端点级、与播放通道无关：网页版通道复用 native helper 的
  // 音量读写（不依赖客户端进程，独立实测可读）。这样切到 SYS 能调、也能跟随系统。
  web.systemVolumeService = native
  const player = new ChannelRouter({ native, web, getConfig, log })

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
        const result = await player.action(action, {
          positionMs: num(body.positionMs, 0),
          value: body.value == null ? undefined : String(body.value),
          like: body.like == null ? undefined : !!body.like,
        })
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
          platform: helper.platform || backend.platform,
          backend: helper.backend || backend.id,
          channel: player.active,
          transport: transportState.transport,
          transportNote: transportState.note,
          capabilities: helper.capabilities,
          // seek 的副作用：走 orpheus:// 协议投递时，客户端会顺手把主窗口 show
          // 出来（哪怕它正收在托盘）。前端据此决定要不要在拖进度前提示一句。
          seekWindowLeak: player.windowLeak !== false,
          helper,
          lyrics: { enabled: lyrics.enabled(), base: lyrics.base() },
          // k65：网页版和客户端都能拉日推（网页版靠注入的 cookie 走同一套 Web API）
          daily: { available: backend.platform === 'win32' || player.active === 'web' },
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
        + 'play_daily 会把它切到「每日推荐」并从第一首开始播（借客户端已登录的 cookie 取日推列表）。'
        + 'set_mode 切换播放顺序（顺序/列表循环/单曲循环/随机）。'
        + 'like 收藏/取消收藏当前歌曲到「我喜欢的音乐」（会同步客户端本地红心，走客户端全局热键不弹窗；失败回退 Web API，需要客户端已登录）。'
        + '客户端没开时会返回 ok:false 与提示，不抛错。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'play', 'pause', 'toggle', 'next', 'prev', 'seek', 'volume', 'mute', 'lyrics', 'health', 'play_daily', 'set_mode', 'like'],
            description:
              '要做什么。status 看当前状态；volume 需要 level；mute 需要 muted；seek 需要 positionMs；'
              + 'play_daily 播放每日推荐（替换队列，从第一首开始）；'
              + 'set_mode 切换播放顺序（value 取 cycle 列表循环 / single 单曲循环 / random 随机 / order 顺序）；'
              + 'like 收藏/取消收藏当前歌曲（like 为 true 收藏、false 取消，省略则切换）',
          },
          positionMs: { type: 'integer', description: 'seek 的目标位置（毫秒）' },
          level: { type: 'number', description: 'volume 的目标音量，0..1' },
          muted: { type: 'boolean', description: 'mute 的目标状态' },
          value: {
            type: 'string',
            enum: ['cycle', 'single', 'random', 'order'],
            description: 'set_mode 的目标播放顺序：cycle 列表循环 / single 单曲循环 / random 随机 / order 顺序',
          },
          like: {
            type: 'boolean',
            description: 'like 的目标状态：true=收藏到「我喜欢的音乐」，false=取消；省略则按当前状态切换',
          },
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
          const src = n.positionSource === 'elog' ? '客户端日志' : n.positionSource === 'smtc' ? '系统媒体会话' : n.positionSource === 'smtc-web' ? '系统媒体（浏览器）' : n.positionSource === 'winrt' ? '日推后台播放' : n.positionSource === 'web' ? '网页版' : '峰值估算'
          const progress = hasTimeline
            ? `进度 ${fmt(n.pos)} / ${fmt(n.end)}（来自${src}${n.canSeek ? '，可 seek' : '，不能 seek'}）`
            : `进度：${src}拿不到时间轴（无法 seek）`
          const lane = n.channel === 'web' ? '网页版（ego 浏览器 + 在线音频）'
            : n.channel === 'native' ? '原生车道（窗口标题 + 音频峰值 + 客户端全局热键 + orpheus 协议 seek）' : '系统媒体会话（SMTC）'
          return [
            `${status} · ${n.title || '(无标题)'}${n.artist ? ` - ${n.artist}` : ''}${n.liked === true ? ' ♥ 已喜欢' : ''}`,
            progress,
            vol,
            `通道 ${lane}`,
            n.mode && { playOrder: 1, playCycle: 1, playOneCycle: 1, playRandom: 1 }[n.mode]
              ? `播放顺序 ${{ playOrder: '顺序', playCycle: '列表循环', playOneCycle: '单曲循环', playRandom: '随机' }[n.mode]}`
              : '',
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
                `当前通道 ${h.channel || player.active}${h.loggedIn !== undefined ? ` · 网页登录 ${h.loggedIn ? '已登录' : '未登录'}` : ''}${h.clientOnline !== undefined ? ` · 客户端进程 ${h.clientOnline ? '在线' : '离线'}` : ''}`,
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
          if (action === 'play_daily') {
            const res = await player.action('play_daily')
            if (!res.ok) return { text: `播放日推失败：${res.message || res.error || 'unknown'}${res.detail ? ` (${res.detail})` : ''}` }
            const first = res.firstSong
            return {
              text: [
                `已切到每日推荐（${res.songCount} 首）${first ? `，正在播 ${first.name}${first.artist ? ` - ${first.artist}` : ''}` : ''}。`,
                describe({ ok: true, now: res.now, volume: res.volume }),
              ].filter(Boolean).join('\n'),
            }
          }
          if (action === 'set_mode') {
            const value = String(args?.value || '').trim()
            const labels = { cycle: '列表循环', single: '单曲循环', random: '随机', order: '顺序' }
            if (!labels[value]) return { text: 'set_mode 需要 value（cycle 列表循环 / single 单曲循环 / random 随机 / order 顺序）。' }
            const res = await player.action('set_mode', { value })
            if (!res.ok) return { text: `切换播放顺序失败：${res.message || res.error || 'unknown'}${res.detail ? ` (${res.detail})` : ''}` }
            return { text: `播放顺序已切到 ${labels[value]}。` }
          }
          if (action === 'like') {
            const res = await player.action('like', { like: args?.like })
            if (!res.ok) return { text: `${res.message || '操作失败'}（${res.error || 'unknown'}${res.detail ? `, ${res.detail}` : ''}）` }
            return { text: `${res.liked ? '已收藏到「我喜欢的音乐」' : '已取消喜欢'}。${describe({ ok: true, now: res.now, volume: res.volume })}` }
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
