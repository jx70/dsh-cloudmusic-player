# Changelog

All notable changes to this project are documented here.
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-08

首个公开版本（0.1.0 是内部开发版，未曾发布到 npm，也没有对外仓库）。

### Added

- **dsh 桌面版（dsh-desktop）适配**。桌面版不是另一份代码，是另一个 profile（`--profile desktop`）+ Electron 壳 + `WebContentsView` 加载同一个 Web UI，所以悬浮框、歌词、音量、模型工具全都原样可用 —— `client.js` 一行都没改。真正需要适配的是**传输层**：桌面版捆绑的 dsh 是 `0.1.0-rc.6`，那代 `connection` 只有 `get rpc()`，没有 `get fetch()` / `registerFetchRoute`（实测 `0.1.0-rc.6 / rc.7 / rc.8 / 0.1.1-rc.1` 全为 0，`0.1.5-rc.1` 才出现），所以原实现会直接「6 条路由全挂不上」。
- **`lib/transport.mjs`：三条传输车道，自动挑**。
  - `fetch`：`connection.fetch.register` 存在时用它，行为与 0.1.0 完全一致（宿主的 owner-peer 鉴权）。
  - `webserver`：否则用 `ctx.webServer.register({ kind:'exact' })`。`webServer` 在两代里签名一致，`match()` 都是「先 exact 表、再最长前缀」，所以自己注册的精确路径会先于 connection 的 `/api` 前缀命中，也不会把整个 `/api` 抢走。内部做 Fetch↔Node 适配（`Request`/`Response` ↔ `IncomingMessage`/`ServerResponse`），带 64 KiB body 上限（超限 413）、方法闸（405 + `allow`）、异常兜底（500 不泄栈）、注册前自愈残留同名路由。
  - `none`：两者都没有时只记日志，插件其余部分照常工作。
- **旧世代车道的信任栅栏**（绕开 connection 就没有 cookie 鉴权了，必须自己补）：① 自校验永远先跑 —— Host 必须回环（`localhost` / `*.localhost` / `127.0.0.0/8` 逐段校验，防 `127.0.0.1.evil.com` / `[::1]`），或 `DSH_TRUSTED_HOSTS` 白名单；`Sec-Fetch-Site: cross-site` 一律 403；带 `Origin` 必须与 Host 同源。② 宿主 `connection.requestRejection` 可用就委托、返回码照用，**抛异常按拒绝**（不 fail-open）。③ 都没有就只靠 ①，并在挂载时 warn。
- **`scripts/enable-desktop.mjs`**：桌面版每次启动都无条件重写 `profiles/desktop/package.json` 与它的 patch 层（`prepareDesktopProfile()`），手改活不过一次启动。脚本改为 ① 建 `profiles/desktop/node_modules/dsh-cloudmusic-player` junction（`installPlugin()` 不清邻居），② 往 `~/.dsh/cordis.patch.yml`（home 层，桌面版不覆盖）追加带标记的 insert，`disabled: !!js "!ctx.loader.entries().some((e) => e.options.name === '@dsh-desktop/client')"` —— 只在桌面 profile 激活，否则 web profile 会插第二个实例、两条车道抢同一批 exact 路由。幂等，支持 `--check` / `--remove`。
- `/health` 与模型工具 `health` 新增 `transport` / `transportNote`，一眼看出走的是哪条车道。
- `test/transport.test.mjs`：21 条，覆盖车道选择、Fetch↔Node 适配、body 上限、方法闸、异常兜底、`selfFence` 的六类边界（相似域名、非回环、cross-site、跨源 Origin、白名单）、宿主栅栏的委托/拒绝/抛异常三条路径。`npm test` 现为 **72 条**（elog 26 + lyrics 25 + transport 21）。
- `scripts/sync-github.ps1`（`npm run sync`）：一次性上传之后的日常同步。按「先确认仓库、再补 remote、再看有没有改动、最后 push」的顺序做，**origin 丢了会自动从 `package.json` 的 `repository.url` 补回** —— 目录被搬走、`.git` 没跟过来时，`git clone` 之后一条命令就能重新接上。暂存区里出现 `node_modules` 或 `.env` 直接拒绝提交。
- `docs/DESIGN.md`：实现层的完整说明（架构、三个传输车道怎么来的、Core Audio 的 vtable 与 COM 封送坑、elog 编解码与状态机边界、性能数字、完整排错表）。README 只留上手要用的部分。
- `.gitattributes`：仓库内统一 LF。本机 `core.autocrlf=true`，而 `lib/helper.ps1` 必须保持 LF + UTF-8 BOM 才能在 PowerShell 5.1 下正确读到中文注释。

### Changed

- `engines.dsh`：`>=0.1.7-rc.1` → **`>=0.1.0-rc.6`**。`0.1.0-rc.6` 语义上小于原下限，而它正是桌面版捆绑的版本；rc.6 本身不校验 `engines`，但放宽后将来桌面版打包更新版宿主也不会被拒。
- 大窗口里歌手名后面不再跟「客户端热键通道」/「系统媒体会话」——那行字在挤歌名的宽度，而通道信息本来只有模型工具 `status` 与 `health?deep=1` 需要。副标题现在只放歌手（没歌手就退到专辑名），拿不到时整行不渲染，不再留一条 16 px 的空行。

## [0.1.0] - 2026-11-07

首个可用版本。

### Added

- **悬浮播放器**（`shell.overlay` 槽，`position: fixed`）：拖动定位、收起成小胶囊、位置记进 localStorage。
- **两条控制车道，自动选**：
  - `smtc`：客户端向 Windows 注册了系统媒体会话时，直接调 `GlobalSystemMediaTransportControlsSession`（能读时间轴、能 seek）。
  - `native`：客户端没注册（网易云桌面版在 Win10 上就是这个情况）时，歌名/歌手/进度来自 `cloudmusic.elog`，控制通过 `keybd_event` 发 `Ctrl+Alt+P` / `Ctrl+Alt+←` / `Ctrl+Alt+→`，**只作用于网易云自己**。窗口标题 + 音频峰值退为日志不可用时的兜底。
- **真实时间轴（`lib/elog.mjs`）**：网易云 3.x 不注册 SMTC，但会把自己的播放事件写进 `%LOCALAPPDATA%\NetEase\CloudMusic\cloudmusic.elog`（逐字节替换的弱加密）。新模块解码这个日志并回放状态机，拿到**曲目 / `songId` / 时长 / 精确到毫秒的播放位置 / 暂停继续 / seek**。冷启动解码 8.9 MB、3 万行实测 **14–15 ms**；之后每 400 ms 只读新增尾巴（按字节保留半行，不会把 UTF-8 汉字劈坏；文件轮转变小时自动重预载）。从尾部按 1 MB 块向前扫，最多 16 MB，找到最近一条曲目事件就停 —— 日志再大也不会全量读。只读事件行，**不读也不落盘** `musicurl`（带签名的播放地址），不登录、不碰 cookie。解码表是按实测字节反推出来的位运算公式。
- **播放控制**：上一首 / 播放暂停 / 下一首 / 跳进度（跳进度仅 `smtc` 车道可用）。
- **音量**：`APP` 只调网易云自己的音量（枚举音频会话 → `IAudioSessionControl2.GetProcessId` 命中 pid → `ISimpleAudioVolume`），`SYS` 调系统端点音量（`IAudioEndpointVolume`）；支持静音切换；拖动会合并请求。两路是**各自独立的读数**，`/state` 同时返回 `volume` 与 `systemVolume`，界面按当前作用域显示对应那一路。
- **滚动歌词**：有 `songId` 时直接 `?songId=` 取词（无匹配歧义），否则按歌名 + 歌手 + 时长搜索；LRC 解析（一行多时间戳、`[mm:ss:xx]` 老格式都支持），当前行居中高亮、上下淡出；两车道都用 `serverTime` 做本地插值，不是两秒跳一格。
- **外语歌叠中文译文**：歌词接口的 `tlyric` 与 `lrc` 同格式（各带时间戳），按时间戳逐行配对后每行多一个 `tr`，悬浮框里外语原文下面显示一行小字中文。配对规则：时间戳精确相等的直接配；其余走 ≤60 ms 最近邻；译文与原文相同、译文为空、原文是间奏空行都不附加 —— 宁缺不错，窗口再开大就会把相邻两句错配。中文歌的 `tlyric` 本来就是空的，所以**不需要判语种**。实测 God knows 39/39、たぶん 62/62 全精确，Ref:rain 56 精确 + 1 条落在 60 ms 内。行高按行算（单行 22 px / 双行 34 px），滚动位移按实际累计高度累加，双行不会把高亮顶偏。开关 `lyricsTranslation`，默认开。歌词缓存 schema 升到 2 —— 旧缓存会在下次取词时作废重取，否则 30 天内还在看没有译文的旧数据。
- **常驻助手**：`lib/helper.ps1` 一个 `powershell.exe` 进程，JSONL over stdin/stdout。冷启动 399–556 ms，之后 `state` 7–130 ms（native 车道要采样峰值）、调音量 6–12 ms。
- **6 条同源 HTTP 路由**：`/api/cloudmusic-player/{state,action,volume,lyrics,health,restart}`，走 `connection.fetch.register` 过宿主信任栅栏。
- **模型工具** `cloudmusic_player`：`status / play / pause / toggle / next / prev / seek / volume / mute / lyrics / health`。
- **自检路由** `health?deep=1`：列出全部 SMTC 会话、全部音频会话（pid / 进程名 / 音量 / 静音）、每个网易云进程的窗口标题与峰值、当前热键、PowerShell 版本、助手 stderr 尾巴 —— 换机器时靠它定位 `processName` / `aumidPattern` / 热键是否对得上。
- **歌词磁盘缓存**：`<DSH_HOME>/cloudmusic-player/lyrics/<songId>.json`，TTL 30 天，超过 400 个文件按 mtime 清理。
- **可移植后端层**：`lib/backend.mjs` 里一个对象就是一个平台。非 Windows 自动降级为「只有 UI + 歌词」。

### Fixed

- **播放控制会打到别的程序**：早先的会话挑选逻辑有「系统里只有一个媒体会话就用它」这条兜底，而网易云根本不注册 SMTC，于是它接管了浏览器里正在播的视频 —— 按暂停暂停的是 B 站。现在只认 AUMID 正则或进程名命中，无命中就如实报「没有可控制的会话」，**绝不碰别人的会话**。
- **音量串台**：`IAudioSessionManager2::GetSimpleAudioVolume` 的第二个参数是音频会话 ID 而不是进程 ID，传 pid 拿到的是调用进程自己的默认会话，导致改一次音量全系统跟着变。改成枚举会话 → `GetProcessId` 匹配 → 对同一个 COM 对象 `QueryInterface` 到 `ISimpleAudioVolume`。
- **界面语言永远回落中文**：宿主 `locale.getSnapshot()` 返回的是 `{ active, locales, revision }`，代码却读 `snap.id`。
- **歌名偶尔显示成 `GDI+ Window (cloudmusic.exe)`**：窗口标题挑选只取最长文本，切歌瞬间会冒出更长的调试窗口名。改为按特征打分（含 ` - `、可见、`Orpheus*` 类名加分；含 `.exe`、`GDI+`、`Default IME` 等直接淘汰）。
- **深色主题下主按钮「白底白图标」看不见**：`--dsw-alias-brand-primary` 在这套设计系统里不是品牌色而是**前景墨色**（浅色 `#0f1115`、深色 `#f9fafb`），拿它当实心按钮底色，深色下就是 `#f9fafb` 底 + `#fff` 图标，整个按钮糊成一个白块，全靠外发光才勉强看出是个圆。改用插件自有的强调色变量 `--nc-accent` / `--nc-accent-ink` / `--nc-surface`，按 `body[data-ds-dark-theme]` 切换。
- **放大界面 / 高 DPI 下按钮的对比度不够**：浅色主题的 `#e5484d` 压白图标只有 3.91:1、自身对卡片 3.84:1，不到 WCAG AA 的 4.5:1。浅色改用 `#d9383f`（白图标 4.58:1、对卡片 4.49:1），深色用 `#ff5a60` + 深墨图标 `#1a0506`（6.44:1）。卡片面层、滑杆圆环、图标按钮的 hover 底色也一并按主题给值，不再借用 `bg-overlay` / `bg-layer-2`。
- **滚动歌词看着不跟歌走**：三个原因叠在一起。(1) LRC 里歌前常有十几二十秒只有「作词/作曲/编曲/制作人」四行署名（每行 1 秒），这段时间高亮本来就该停着 —— 现在署名行不再参与高亮定位（`CREDIT_RE`），滚动位置仍跟着它们走，高亮则等第一句真歌词出现才亮起。(2) `native` 车道原来拿不到时间轴，时钟起点 =「插件第一次看到这首歌的一刻」，**中途打开面板或刷新页面时并不知道歌已经播到哪儿**，于是永久滞后 —— 现在从 `cloudmusic.elog` 回放出真实位置，起点问题从根上消失。(3) 日志不可用时仍有兜底：**点歌词任意一行**即以该行的 LRC 时间戳为锚点校准本地时钟，锚点按歌记进 localStorage（30 分钟过期）。实测（兜底路径）：点 `42730 ms` 那行 → 时间行从 `0:11` 跳到 `0:43`，刷新后从 `0:48` 继续。
- **`native` 车道按暂停「按不动」或「越按越乱」**：`native` 的播放/暂停是同一个切换键，助手只能靠音频峰值猜当前状态，而客户端暂停后有约 900 ms 淡出、恢复后约 1 s 淡入，这段时间峰值还像在播。现在发键前先把日志回放出的真实 `playing` 灌给助手（`{"cmd":"intent"}`），助手优先信它，2.6 秒内有效。
- **`SYS` 音量拖完立刻弹回原值**：服务端只回一路读数，且恒为「APP 优先」（`Get-Volume` 先找网易云的音频会话，找不到才退系统端点）。于是写系统端点时回读的仍是 APP 那一路，界面每两秒轮询一次就把滑块盖回去 —— 真机上系统端点 36%、APP 49%，拖到 70% 后立刻显示回 49%。现在 `/state` 与 `/volume` 同时返回 `volume`（APP）与 `systemVolume`（SYS），写入后回读**实际写的那一路**（`Get-VolumeAt $applied`），前端 `scopeNow` / `activeVol` 决定滑块、百分比、静音图标、`SYS`/`APP` 标签看哪一路。同一根因下 `SYS` 作用域的静音键以前切的是 APP 那一路，也一并修好。
- **系统端点静音静默失败**：`IAudioEndpointVolume::SetMute` 与 `ISimpleAudioVolume::SetMute` 的 `bool` 参数没标 `[MarshalAs(UnmanagedType.Bool)]`，COM 默认按 2 字节 `VARIANT_BOOL` 封送，槽位错位导致 `SetMute(true)` 抛异常、被 `catch` 吞掉后返回 `false` —— 表现为「点了静音没反应」。加上封送声明后三条路径（系统端点 / APP 会话）的 `SetMute` / `GetMute` HRESULT 全是 `0x0`。

### Known limitations

- 只有 Windows 有真实后端。macOS / Linux 上悬浮框与歌词可用，播放控制与音量显示「本机不支持」。
- 必须 PowerShell 5.1；PowerShell 7 无 WinRT 投影，`winrt: false`。
- `native` 车道不能拖 seek：位置是读出来的（准到毫秒），但「跳到某处」没有可用的热键通道，`canSeek` 恒为 false。
- `native` 车的进度依赖客户端日志 `cloudmusic.elog`。日志读不到（旧版客户端 / 关了日志 / 路径不同）时降级为「本地计时 + 点歌词校准」，那一刻起点只能是猜的（滞后量 = 打开前已播的时长）。日志编码若被客户端改成新算法，需要重新对解码表。
- `native` 车道的播放/暂停是**切换键**，为了不出现「想暂停却开始播」，发键前先看 2.6 秒内的「意图缓存」，
  没有意图才采 ~150 ms 峰值判定当前状态。之所以要意图缓存：客户端暂停后有约 900 ms 淡出、恢复后约 1 s 淡入，
  这段时间只看峰值会让状态来回跳、也会让连点两次暂停把歌放回来。极安静的段落仍可能误判（有意图时不受影响）。
- `native` 车道发键前**不抢前台焦点**（全局热键不需要焦点，抢焦点反而打断用户）。
- `native` 车道依赖客户端自己的全局快捷键，必须和插件配置里的三项一致；快捷键被别的程序抢走就按不动。没有采用 `VK_MEDIA_PLAY_PAUSE` 媒体键，因为它会连浏览器里的视频一起暂停。
- `native` 车的歌名来自客户端日志的曲目事件；日志不可用时退回窗口标题，按最后一个 ` - ` 切歌名/歌手（歌名本身含 ` - ` 时可能切错）。
- 不登录、不搜索、不建歌单 —— 只接管正在播放的那首。
- 有 `songId` 时歌词直取，无匹配歧义；只有日志不可用时才靠「标题 + 歌手必须一致 + 时长 ±8 秒」打分匹配，Live / 加长版可能被淘汰而显示「暂无歌词」（宁可空着也不给错词）。
- 有版权限制的曲目（如周杰伦部分作品）搜索接口只返回翻唱，匹配器会把候选全部淘汰。
- 歌词来自网易云 web 接口（非公开），可能限流或改字段。
- 译文的**内容**由网易云提供：某些外语歌没有 `tlyric`、只翻了副歌、或整首没翻，插件不做补译也不做机器翻译；原文与译文时间戳差超过 60 ms 的行不配对（宁缺不错），所以偶尔会有某句外语下面没有小字。
