# Changelog

All notable changes to this project are documented here.
格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.7.22] - 2026-11-27

### Fixed

- 修复「客户端暂停后再放 B 站视频、插件识别不到歌」。根因：client-first 模式原来会按「哪条通道正在播」动态选路，Chromium（Edge/Chrome）只向系统上报一个 SMTC 会话，B 站视频一放就顶掉音乐会话，web 通道的 SMTC 回退于是把视频当媒体/误判无歌。改为：client-first 下**客户端进程在线就锁定 native 通道**，完全不碰 web/浏览器 SMTC；只有客户端进程不在时才让网页版接管。客户端在线时行为与适配网页版之前完全一致。网页优先请显式切 web-first / web-only。
- 顺带修 detectClientRunning：宿主 env.SystemRoot 异常时 tasklist 绝对路径拼错导致 ENOENT，改为多候选路径逐个试 + 裸名兜底。health 增加「客户端进程 在线/离线」诊断字段。

## [0.7.21] - 2026-11-27

### Fixed

- 修复 0.7.20 引入的回归：网易云「暂停」时 SMTC 会话的 artist 常被清空，被「artist 空即非音乐」判据误当成视频挡掉，导致暂停后识别不到歌。改为：artist 空但歌名与 sticky 记忆一致时用记忆里的歌手补回、照常识别；只有无歌手且歌名不匹配（真正的视频/网页媒体）才挡下。SmtcBrowser 与 web-backend 两层同步。

## [0.7.20] - 2026-11-27

### Fixed

- 客户端打开但未播放时，SMTC 里可能出现无歌手、无站点后缀的 B 站/网页视频会话（如「笨蛋教学，高维理解：压枪的第一性原理」），旧判据只靠站点标记漏判，把视频标题当成正在播放的歌显示。改为「artist 为空即非音乐」：smtc-browser 与 web-backend 两层统一按此判据挡下，走 sticky 兜底（有记住的歌显示歌，否则如实报无音乐会话），不再把视频当歌。

### 维护

- 文档、包元数据与同步脚本中的仓库地址改为占位符，移除个人信息；本地 git 署名改为中性 contributors。无功能变更。

## [0.7.19] - 2026-11-22

修复操作过 B 站视频后，插件无法暂停网易云歌（报 no-browser-music-session / 没反应）的问题。

### Fixed

- **`lib/smtc-probe.ps1`**：control 动作（play/pause/toggle/next/prev/seek）在没有合格音乐会话时，退而使用当前唯一的浏览器 SMTC 会话下发命令。Chromium 只上报一个 SMTC 会话，B 站视频把歌的会话顶掉后，这个会话是唯一还能触达浏览器实际媒体（网易云音频仍在响）的通道；之前视频标题被硬挡导致 `$target=null`，暂停命令根本没下发。state 动作仍保持严格音乐判据（由 Node sticky 兜底）。
- **`lib/smtc-browser.mjs`**：control 回读若是视频标题（无歌手），用 sticky 记住的网易云歌元数据覆盖标题/歌手，状态/进度仍用真实回读值，避免暂停后悬浮窗显示成视频。
- **`lib/web-backend.mjs`**：CDP `ensure()` 失败时（ego 关着）且是控制动作，增加 SMTC 控制兜底——覆盖「插件刚重启、sticky 记忆空、state 读不到歌、控制流落到 CDP 失败」的场景。
- `test/smtc-browser.test.mjs`：新增 1 例（控制回读视频标题时用 sticky 歌名覆盖）。

### Notes

- 实测 probe 层：当前现场 SMTC 只剩 B 站视频会话时，`control('pause')` 返回 ok=true、标题正确显示为记住的网易云歌。211 项单测全绿。

## [0.7.18] - 2026-11-22

修复 B 站视频暂停时插件里的网易云歌跟着显示成暂停的问题。

### Fixed

- **`lib/smtc-browser.mjs`**：sticky 兜底之前把状态写死为 `Paused`。网易云的 SMTC 会话被 B 站视频顶掉后 probe 读不到歌的真实播放态，于是无论视频播放还是暂停，插件都返回「暂停态的歌」——用户暂停 B 站视频时，歌明明还在放，悬浮窗却显示暂停，像是被视频带着暂停了。现在兜底保留记住那一刻的真实播放态（当时 Playing 就返回 Playing），视频操作不再影响歌的显示。用户真正操作网易云时 probe 会重新读到它的会话、更新记忆，状态自然跟随真实情况。
- `test/smtc-browser.test.mjs`：兜底断言改为保留 Playing 态。

## [0.7.17] - 2026-11-22

修复网易云放歌后再放 B 站视频，插件识别不到歌的问题。

### Fixed

- **`lib/smtc-browser.mjs`**：
  - 加 sticky 兜底记忆：读到真实音乐（有歌手）时记下 `_lastMusic` + 时间戳（默认 15min 有效）。当 SMTC 会话被 B 站视频抢占、probe 找不到音乐会话时，兜底返回最近一次记住的歌（暂停态 + `sticky:true`），不再识别不到。Chromium 只上报一个 SMTC 会话，视频会把音乐顶掉——这是针对该行为的兜底。
  - Node 层加视频标题硬挡（`VIDEO_TITLE_MARKERS`：bilibili/youtube/youtu.be/acfun/nicovideo/gimy/劇迷/剧迷）：probe 命中的视频标题（无歌手）转成无会话，既防止误识别也不污染 sticky 记忆。
- `test/smtc-browser.test.mjs`：新增 2 例（视频抢占后兜底返回记住的歌、兜底超时后如实报失败）。

### Notes

- sticky 记忆在插件进程内维护：插件一直在运行时，网易云放歌阶段已记下记忆，切到视频后可兜底；新启动进程且此刻只有视频会话时会如实报识别不到（无历史可兜底）。

## [0.7.16] - 2026-11-22

修复 SMTC 场景（个人浏览器放歌）拖 APP 音量滑杆后数值「跳回」旧值的问题。

### Fixed

- **`lib/web-backend.mjs`**：SMTC 场景调 APP 音量时，之前无条件把 `this.muted`（恒为布尔）一起传给 native。而 `native.volume()` 只要收到 `muted`（非 undefined）就走 mute 命令，mute 不写 level——导致拖滑杆时 level 根本没写进去，助手回读旧值，前端据此回填就跳回。现在只有本次调用明确带 `muted` 时才透传（toggleMute 路径），拖音量只传 level；回显直接用本次写入的目标值，不依赖助手回读。
- `test/web-backend.test.mjs`：新增 2 例（拖音量不能带 muted、mute 调用带 muted 且保留 level）。

## [0.7.15] - 2026-11-22

修复网页版（SMTC 数据源，个人浏览器放歌）调 APP 音量会连带改动系统音量的问题。

### Fixed

- **`lib/helper.ps1`**：音量/静音命令新增 `procName` + `noFallback` 参数。指定进程名时只调该进程音频会话（`SetProcVol`）；找不到会话且 `noFallback` 为真时如实报错返回空，绝不回退系统端点。`Get-VolumeAt` 也按指定进程回读。原生通道不传这两个参数，行为不变。
- **`lib/player.mjs`**：`volume()` 透传 `procName`/`noFallback` 给 helper。
- **`lib/web-backend.mjs`**：SMTC 场景调 APP 音量改为调出声浏览器进程的进程音量（`procName` 取自 SMTC 会话 aumid，如 `msedge.exe` → `msedge`），`noFallback:true`。找不到会话报 `volume-no-session`，不再改系统音量。彻底解决「拖 APP 音量 SYS 跟着变」。
- **`test/web-backend.test.mjs`**：新增 2 例（SMTC 调音量只动浏览器进程、找不到会话时报错不改系统）。

### Notes

- 编辑 `helper.ps1` 后需保留 UTF-8 BOM：PS 5.1 无 BOM 会按 GBK 解码，内联 C# 的中文字面量会乱码导致编译失败。
- 实测：APP 80%→42% 时系统音量稳定保持 70%；APP 静音/取消、SYS 独立调到 30% 两路互不干扰。

## [0.7.14] - 2026-11-22

网页版「一键日推」改为常驻 WinRT 后台音频引擎出声：不依赖 ego 浏览器 CDP、不弹任何页面、不进 SMTC，个人 Edge 关着也能照常播日推。

### Added

- **`lib/winrt-audio.ps1`**：常驻 Windows.Media.Playback.MediaPlayer 后台引擎，纯 ASCII 注释。stdin 一行一 JSON 命令、stdout 一行一 JSON 响应；play/pause/resume/toggle/seek/volume/state/stop/quit。播歌走 `MediaSource.CreateFromUri([System.Uri]$url)`（Source 必须是 MediaSource 而非裸 Uri）。
- **`lib/winrt-audio.mjs`**：Node 行协议封装（绝对路径 System32 PowerShell 5.1、握手 8s / 请求 6s 超时、退出时在途请求全失败）。
- **`lib/web-backend.mjs`**：
  - `play_daily` 提到 `ensure()` 之前：取数/取音频 URL/出声全走 Node 侧 + WinRT 引擎，彻底去掉「点日推报找不到 ego 浏览器」的 CDP 依赖。
  - 引擎在播时 `state()` 优先读 WinRT（`positionSource:'winrt'`），播放控制 play/pause/toggle/next/prev/seek/volume 全走引擎；`play` 用 resume（已有 Source 续播，不是换歌）；like 走绿色通道收藏队列当前曲，不碰 SMTC/CDP。
  - `stop()` 关掉引擎子进程。
- `index.js`：`describe()` 新增 `winrt` → 「日推后台播放」进度来源文案。
- `test/web-backend.test.mjs`：新增 3 例（ego 关着日推仍起播、引擎在播时全控制走 WinRT、like 收藏队列当前曲不碰 SMTC）。

## [0.7.13] - 2026-11-22

修复网页版（SMTC 数据源）「喜欢」红心丢失 / like-no-song / 连点状态漂移。

### Fixed

- **`lib/web-backend.mjs`**：
  - `_songIdBySearch` 增加 Node 侧明文 fetch 兜底：原先只靠 ego 浏览器 CDP 页面内 fetch 搜歌，浏览器一关（browser.json 消失）就搜不到 songId → 红心空、like 报「播放中才能喜欢」。现在 CDP 搜不到自动退到 Node 侧 `/api/search/get` + 客户端/手填 cookie，ego 没开也能搜到。
  - 新增 `_smtcLike`：SMTC 场景的「喜欢」改为全程零 CDP 的独立路径——显式读一次 SMTC 会话按当前歌名搜 songId → LikeService 收藏，不再依赖 `probe.positionSource`/`dataSource` 快照。修掉连点 like 时 state 把 dataSource 改写成 cdp、快照漂移导致冒出 `web-browser-unavailable` / `like-no-song` 的 bug；回包直接带更新后的 liked，红心立即刷新。
- `test/web-backend.test.mjs`：新增 3 例（Node 兜底搜歌 + 60min 缓存、零 CDP 收藏回填红心、连续切换遇 dataSource 漂移仍成功）。

## [0.7.12] - 2026-11-22

修复网页版（SMTC 数据源）歌词不同步。LRC 本身能完整取到，问题在播放状态/进度数据源：Windows SMTC 上报滞后。

### Fixed

- **`lib/smtc-browser.mjs`**：
  - `control(play/pause/toggle/...)` 按动作语义推断目标 `status`，不再盲信滞后的 probe 回读（刚点 play probe 仍报 Paused → 前端 `playing=false` → 200ms 歌词高亮节拍不起）。
  - 进度锚点 `_posAnchor`：SMTC Position 常卡在旧值不动，改为记录播放起点靠墙上时钟单调推进，probe 旧值不得回退（此前进度 32↔33.3 横跳，高亮行来回跳）；换歌（title 变化）自动重建锚点，暂停时清锚点。
- **`test/smtc-browser.test.mjs`** 新增 2 例（play 后 status 推断、pos 单调+换歌重建）。全量 199 项通过。

## [0.7.11] - 2026-11-22

优化网页版/SMTC 通道的操作延迟。实测 `smtc-probe.ps1` 每次冷启 PowerShell 要 ~280ms，而前端每 2 秒轮询一次 `state()`、单个播放 action 内部还会 probe→control→after 连调三次，一次点击光 PowerShell 冷启就 ~840ms。

### Changed / Perf

- **`lib/smtc-browser.mjs`**：`readState()` 加 2.5s TTL 缓存（略大于前端 2s 轮询间隔）+ 并发合并，播放中命中缓存按经过时间推进 `pos`；`control()` 会失效缓存并在成功后回填 probe 回读的状态；新增 `invalidate()`。
- **`lib/smtc-probe.ps1`**：控制动作（play/pause/toggle/next/prev/seek）在**同一个 PowerShell 进程**里顺带回读完整 state（标题/歌手/进度/controls），供调用方直接当 after 状态，省掉一次冷启。
- **`lib/web-backend.mjs`**：SMTC action 复用最近一次 state 快照判断数据源，跳过 action 开头的 probe spawn；control 回读的快照直接当 after（含 songId/liked，都走缓存）；`_readSystemVolume()` 去掉 `fresh`，复用 native 400ms 缓存省一次 helper 往返。
- 效果（mock 量化）：3 次轮询 spawn 从 3 → 1；一次 next action spawn 从 3 → 1，冷启耗时 ~840ms → ~280ms。

### Tests

- `test/smtc-browser.test.mjs` 新增 3 例：TTL 缓存、并发合并、control 后失效。全量 197 项通过。

## [0.7.10] - 2026-11-22

修复网页版「调整播放顺序点了没同步」：0.7.9 已让 Host 正确回显 `now.mode`，但当 `state()` 读不到歌（个人 Edge 无会话 / CDP 页没开）时，`set_mode` 会回 `now:null`，前端 `run()` 见 `now!==undefined` 就整体替换，把图标清空回退成默认「顺序」。

### Fixed

- **`lib/web-backend.mjs`** `set_mode`：无论如何都回一个带新 `mode` 的 `now`——读不到歌时先用 `smtcState` 重建，再退到兜底空壳（channel:'web'、对应 positionSource），杜绝 `now:null`。
- **`index.js`** `describe()`：status 增加「播放顺序 顺序/列表循环/单曲循环/随机」一行，便于确认运行时 mode。
- 前端零改动：`client.js` 本就按 `now.mode` 切图标，后端稳定回 `now` 即生效（前端已开页面需刷新一次让 client.js 重新加载，`dev:web` 未运行时不自动热更）。

### Tests

- `test/web-backend.test.mjs` 新增「state 读不到歌时 set_mode 仍回带新 mode 的 now」用例。全量 194 项通过。
- 真机验证：重载后 `set_mode(random/order)` → status 显示「播放顺序 随机/顺序」。

## [0.7.9] - 2026-11-22

适配「调整播放顺序」到网页版通道。之前网页通道的 `set_mode` 只是记一个本地变量，`state()` 两处写死 `mode:'playOrder'`，前端图标永远不变，next/prev 也不看模式——按钮形同虚设。

### Added / Fixed

- **`lib/web-backend.mjs`**：新增短值↔内部枚举映射（`order/cycle/single/random` ↔ `playOrder/playCycle/playOneCycle/playRandom`），`set_mode` 校验白名单并写入 `this.mode`、`state()` 两条分支的 `now.mode` 回显它（前端 `MODE_ORDER` 才认、图标才跟着切）；`set_mode` 提到登录/CDP 检查之前，纯本地状态、个人 Edge 的 SMTC 场景也能切。
- 队列切歌按模式生效：新增 `_advanceIndex(delta)`——order 到头停在边界、cycle 回环、single 原地、random 换一首不同的；`next`/`prev` 改用它，到边界不再硬停在第 0/最后一首。
- 前端零改动：`client.js` 本来就按 `now.mode` 切图标、按 `nextMode()` 发短值，后端接上映射即生效。

### Tests

- `test/web-backend.test.mjs` 新增 4 例：set_mode 四种短值映射+回显、非法值 bad-mode 不改动、`_advanceIndex` 四种模式行为、`state().now.mode` 在 CDP/SMTC 两分支都回显。全量 193 项通过。
- 真机验证：网页通道 `set_mode(random/single/order)` 均返回「播放顺序已切到 …」。

## [0.7.8] - 2026-11-22

修「SYS 音量未能同步系统，也未与系统同步」。根因：网页版通道的 `state()` 把 `systemVolume` 恒写成 `null`、`volume(scope:'system')` 只操作插件自己那个几乎不存在的 `<audio>`，完全没接 Windows 系统音量端点。系统音量是端点级、与播放通道无关，native helper（常驻 PowerShell）在客户端没开时也能独立读写。

### Fixed

- **`index.js`**：`web.systemVolumeService = native`，把 native 的音量读写能力注入网页版后端（helper 不依赖客户端进程，独立实测可读）。
- **`lib/web-backend.mjs`**：新增 `_hasSystemVolume` / `_readSystemVolume`；注入 service 时自动把 `capabilities.systemVolume` 打开；`state()` 两条分支的 `systemVolume` 都改成从 native helper 读真实系统音量（不再是 null）；`volume(scope:'system')` 直接走 native helper，不依赖 CDP 也能调；APP 音量在网页无 `<audio>`（个人 Edge 才是真正出声源）时落到系统音量，保证拖动有反应。
- 前端零改动：`client.js` 本来就按 `st.systemVolume` 显示 SYS 一路、按 scope 发 `/volume`，后端补上读数与写入后即生效。

### Tests

- `test/web-backend.test.mjs` 新增 3 例：注入 service 后 `capabilities.systemVolume` 打开、`volume(scope:'system')` 走 native 且不连 CDP、`state().systemVolume` 跟随 native 读数。全量 189 项通过。
- 真机验证：网页通道 `status` 显示「音量 80%（网易云）（系统 25%）」；`volume(level:0.6,scope:system)`→系统 60%；`mute(scope:system)`→「系统 60% 静音」；外部改系统音量到 33% 后 `status` 立刻显示「系统 33%」——调 / 静音 / 跟随全通。

## [0.7.7] - 2026-11-22

修「点喜欢提示请先在网易云客户端登录」。根因：网易云服务端用 `code=401` 同时表达「需要登录」和「下架歌曲无法收藏」，`like.mjs` 只按 code 判成 `like-needs-login`，前端 `LIKE_TEXT` 再硬映射成「请先在网易云客户端登录」——网页版根本不需要客户端登录，文案完全误导。

### Fixed

- **`lib/like.mjs`**：新增 `classifyLikeError(code, serverMsg)`——`301/401` 且服务端文案含「下架/下线/版权/无法收藏/已删除/unavailable/copyright」等→ 新错误码 `like-unavailable-song`；真「需要登录」才保留 `like-needs-login`；非 301/401 → `like-failed`。`isLiked` / `setLiked` 的业务码分支都改用它分流。
- **文案通道无关**：`like.mjs` 三处写死的「请先在网易云客户端登录后再试」改为「请先在网易云登录后再试（客户端或网页版）」；`client.js` 的 `likeNeedsLogin` 文案同步改通道无关，并新增 `likeUnavailableSong`（中/英）与 `LIKE_TEXT['like-unavailable-song']` 映射。
- **`lib/web-backend.mjs`**：`_webLike` 成功后强制重读 liked（清 `likedCheckedAt` + 重新 `state()`），不再拿操作前的 probe 回填——修掉「取消喜欢后红心还亮着 ♥」的状态滞留。

### Tests

- `test/like.test.mjs` 新增 `classifyLikeError` 纯函数测试（下架/版权/英文/真登录/非登录码全覆盖）+ `setLiked`/`isLiked` 下架歌 401 → `like-unavailable-song`、真登录 401 → `like-needs-login`。全量 186 项测试通过。
- 真机验证：网页版通道 `like(true)`→「已收藏…♥ 已喜欢」、`like(false)`→「已取消喜欢」且红心消失。

## [0.7.6] - 2026-11-22

**网页版通道补齐「喜欢」红心**。此前 web 通道 `state()` 的 `now` 没有 `liked` 字段，前端红心永远空心；SMTC 场景队列为空时 `like` 还会报 `like-no-song`。这一版用带浏览器 cookie 的 `LikeService` 读/写红心，并给 SMTC 会话按歌名补出 songId。

### Added

- **`lib/web-backend.mjs`**：constructor 注入独立 `likeWeb = new LikeService({cookieLoader})`——cookie 优先取浏览器已登录会话（`_browserCookies()`，含 httpOnly 的 `MUSIC_U`），再退到手填/客户端解出的 cookie，网页版不依赖客户端 CEF cookie。
- `_likeSyncMs()` / `_likedFor(songId)` / `_attachLiked(now, songId)`：带节流的 liked 查询（切歌必查、否则 `likeSyncMs` 一次、失败 15s 退避），把 `now.liked` 挂到 CDP 与 SMTC 两条 state 分支上。
- `_songIdBySearch(title, artist)`：SMTC 会话没有 songId 时，页面内同源 `/api/search/get` 按歌名+歌手搜一首（60 分钟缓存），拿到 id 后红心就能读/能点。
- `index.js` 的 `describe()`：`now.liked===true` 时在标题后显示 `♥ 已喜欢`。

### Fixed

- `action('like')`：songId 来源扩成「插件队列 → 手动点播记住的 → state.now.songId（SMTC 搜出来的）」；SMTC 场景的 like 不再走 `smtc.control`（SMTC 无喜欢语义），改走 `likeWeb`；统一出口透传 `liked` 给上层文案。
- **`lib/like.mjs`**：401/301 等业务码优先透传网易云服务端 `message`（如「下架歌曲无法收藏」），不再一律显示「请先在网易云客户端登录后再试」——网页版下架歌也返回 401，旧文案误导。原生通道同样受益。

### Tests

- `test/web-backend.test.mjs` 新增 4 条：CDP 分支挂 liked、SMTC 分支搜歌+liked、SMTC like 走 likeWeb 且透传 liked、无歌返回 like-no-song。全量 184 项测试通过。
- 真机验证：29753673 / 188978 / 254132 收藏→取消全成功（净效果为零）；当前晴天(186016)是网易云标记的**下架歌曲**，服务端返回「下架歌曲无法收藏」——内容限制，任何客户端都一样。

## [0.7.5] - 2026-11-22

**SMTC 回退不再误接管 B 站 / YouTube 视频**。0.7.4 用 `PlaybackType==1`(Music) 判音乐，但 B 站视频页也上报 `playbackType=1`，且它 `artist` 为空、标题带 `_bilibili` —— 当视频会话排在网易云前头或网易云会话不在时，插件会显示成 B 站视频标题。

### Fixed

- **`lib/smtc-probe.ps1`**：会话筛选从「第一个命中就 break」改为**评分择优**——标题含 `bilibili`/`youtube`/`youtu.be`/`acfun`/`nicovideo` 站点标记直接硬排除（PS1 必须保持纯 ASCII，PowerShell 5.1 按 GBK 读中文注释会解析失败）；`artist` 非空且 Playing→3 分、非空非 Playing→2 分、无 artist→1 分，取最高分。真机验证：B 站视频 + 网易云音乐两会话同时在播，probe 稳定返回「会呼吸的痛 - 梁静茹」；只留视频无音乐时返回 `no-browser-music-session`。「绝不因只有一个会话就兜底」的底线保持不变。
- **`lib/web-backend.mjs`**：Node 层加 `_isVideoTitle()` 兜底——即便 probe 因会话顺序漏判，标题带视频站标记且 `artist` 为空的会话也不会被包装成 `smtc-web` 状态（双重保险）。

### Tests

- 新增单测：`state` 收到视频站标题+无歌手时不走 `smtc-web`；会话筛选评分逻辑由 probe 真机验证 + probe 语法解析检查覆盖。全量 180 项测试通过。

## [0.7.4] - 2026-11-21

**网页版通道：识别你在个人浏览器（DSH Web GUI 那个 Edge）里放的歌**。此前插件只连 ego-lite 的浏览器（无头 agent 浏览器），而用户真正在放歌的是另一个没有 CDP 调试端口的 Edge——`getPlaying()` 在 ego 页里只是残留态，插件一直显示「晴天」或「无标题」，识别不到用户刚点的歌。这一版用 Windows 系统媒体会话（SMTC）作为回退数据源与控制通道。

### Fixed

- **根因**：系统里有两个 Edge —— ego-lite 那个（CDP port 由 `browser.json` 给出，插件 web 通道唯一数据源）里网易云是「打开客户端播放」占位，`getPlaying().track` 停在残留的 `186016`（晴天）；用户实际放歌的是个人 Edge（DSH Web GUI 所在，无 CDP 端口），CDP 完全读不到。前几轮改的 `createTarget`/ENOENT/数字形态补元数据都不是这一层根因。
- **`lib/smtc-probe.ps1`（新增）**：PowerShell 5.1 + WinRT `GlobalSystemMediaTransportControlsSessionManager`，严格筛选「浏览器 AUMID + 标题非空 + `PlaybackType==1`(Music) 或 artist 非空」的音乐会话，输出一行 UTF-8 JSON（歌名/歌手/专辑/状态/pos/end 秒/can* 能力位）；控制动作 `play/pause/toggle/next/prev/seek` 走对应 `Try*Async`（seek 毫秒×10000 = 100ns tick）。**绝不因「只有一个会话」兜底接管**——helper.ps1 的历史事故（误接管 B 站视频）不会再犯。全程 try/catch 输出 JSON 不抛。
  - 关键坑：AsTask 泛型反射须用双引号 `"IAsyncOperation``1"`（`` 解析成一个字面反引号，匹配运行时 `IAsyncOperation\`1`），单引号版本给两个反引号会匹配不上；stdout 须 `[Console]::OutputEncoding = UTF8`，否则中文标题在 Node 侧变乱码。
- **`lib/smtc-browser.mjs`（新增）**：用绝对路径 `$SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe` spawn probe（宿主 PATH 里没有裸名 `powershell.exe`，会 ENOENT），解析 stdout 首个 JSON 行，超时/失败统一返回 `{ok:false,error,detail}` 不抛。可注入 `spawnFactory` 做单测；配置 `smtcEnabled`（默认开）/`smtcBrowserAumid`（浏览器 AUMID 白名单正则）。
- **`lib/web-backend.mjs`**：`state()` 在 CDP 没有「真实在播的 `<audio>`」时，回退读 SMTC 会话填 `now`（歌名/歌手/进度/能力位，`channel:'web'`、`positionSource:'smtc-web'`）；插件自己 audio 在播时不被 SMTC 顶掉，避免「在放 A、显示 B」。`action()` 的 `play/pause/toggle/next/prev/seek` 在 SMTC 数据源下走 `smtc.control`，`like/play_daily/set_mode` 仍走原 CDP+API。`deepHealth()` 增 `smtc` 段（enabled/available/title/artist/error）；CDP 没连上但 SMTC 读到歌也算通道可用。constructor 可注入 `smtc` 做单测。
- **`index.js`**：Config/DEFAULTS/`getConfig()` 加 `smtcEnabled`/`smtcBrowserAumid`；`describe()` 的 `positionSource==='smtc-web'` 文案「系统媒体（浏览器）」。`cordis.patch.yml` 同步两个字段。上层 action 接口与前端 `client.js` 零改动。

### Tests

- 新增 `test/smtc-browser.test.mjs` 6 条（JSON 解析/中文/秒单位、seek 毫秒透传、失败降级不抛、smtcEnabled 开关、AUMID 白名单透传、默认白名单）；`test/web-backend.test.mjs` 增 3 条（CDP 无真实 audio 回退 SMTC、SMTC 数据源 action 走 smtc.control、插件 audio 在播时不回退），并给既有 fakeWeb 注入 mock smtc 保证隔离。全套 **179 条**全过。

### Notes

- 真机验证（个人 Edge 放「会呼吸的痛-梁静茹」）：`status`=「已暂停 · 会呼吸的痛 - 梁静茹 / 进度 0:01 / 4:32（来自系统媒体（浏览器），可 seek）」；`play`→播放中、`pause`→已暂停、进度 0:01→0:07 推进；`seek(60000)`→落点 1:00；`toggle`→播放中。SMTC 读取与控制整条链路真实生效。
- 「来自系统媒体（浏览器）」的进度由浏览器上报，seek 后能推进；若某网页不暴露时间轴，进度可能停在端点，属浏览器 SMTC 上报限制，不影响识别与控制。

## [0.7.3] - 2026-11-21

**网页版通道：接管你在网页里手动点的那首**。上一版只认「插件自己播的歌」，用户在 music.163.com 上手点一首，插件显示「未识别 / 无标题」、点播放返回 `web-no-song`、时间轴不动。这一版把手动点播的歌接管过来。

### Fixed

- **`lib/web-backend.mjs`：网页播放器已不能出声**。实测 `music.163.com` 页面里既没有 `<audio>` 也没有 `<video>`（top 与 `#g_iframe` 都没有），`window.player` 只剩 `addTo / tipPlay / getPlaying / pause` 四个方法，`addTo([id])` 返回 undefined 且空转，播放栏是「00:00 / 00:00」加一个「去客户端播放」按钮 —— 网易云把网页播放器阉割成占位了。所以**不能再指望页面自己出声**：插件用 `getPlaying().track` 拿到用户点的那首的裸 `songId`，走 Host 侧 cookie 取真实音频 URL，在同一个页面注入 `<audio>` 播放。这才是「手动点的歌能被控制」的唯一可行路径。
- **新增 `_playManual()`**：队列为空时 `play` 走它。先读页面状态取 `songId`（并记进 `this.manualSongId`）；已经在放这首就直接返回 `{reused:true}` 不重新 `load`（否则进度被打回 0）；有 audio 但是暂停态就 resume；都没有才 `_songUrl` + `_playUrl`。
- **新增 `_pauseAny()`**：`pause` 先走插件自己的 `<audio>`；页面里压根没有 audio（从没让插件播过）时退到 `window.player.pause()`，返回 `via:'page-player'`，让手动点的歌也能停。
- **`_controlAudio` 的 `pause`** 不再无条件返回 `true`——没有 audio 时返回 `false`，上层才有机会降级或报错（之前这里永远「成功」，是「点暂停没反应但也不报错」的来源）。
- **`action('play' | 'toggle')`**：队列里有歌但 audio 没建（插件重启过、页面刷新过）时，按队列重放当前那首，而不是对着空气 `play`。
- **`action('seek')`**：没有 audio 时返回 `web-no-audio-url` +「这首还没被插件接管，先点一次播放再拖进度」，不再静默成功。
- **`state()`**：队列空但页面在放歌时记下 `manualSongId`；`canSeek` 对手动点播的歌也为真（点一次播放就能建出时间轴）。
- **`deepHealth()`** 增 `manualSongId` 字段，排障时能看出插件认的是哪首。
- **`_playUrl(url, { songId })`**：注入时把 songId 写进 `a.dataset.songId`；`READ_STATE_EXPR` 多报一个 `audioSongId`。**这是真机上抓到的错位 bug**：接管后 audio 在放 A 曲，而 `getPlaying().track` 仍指着用户手动点的那首 B 曲，`state()` 拿 B 的歌名和时长去配 A 的音频，面板上就是「在放《情非得已》、显示《晴天》」。现在 `state()` 以 `audioSongId` 优先决定当前曲目与队列元数据，`_playManual` 也先比对 `dataset.songId` 再决定复用还是重载——用户在页面换了歌，audio 会跟着换，不会停在上一首假装在放。

### Tests

- `test/web-backend.test.mjs` 新增 4 条：按 songId 接管手动点播、已在播时复用不重载、`_pauseAny` 退到页面播放器、`seek` 无 audio 时报 `web-no-audio-url`。全套 **170 条**全过。

### Notes

- 手动点播的歌**第一次**要从插件点一次播放，插件才能注入 `<audio>`；在那之前拖进度会提示「先点一次播放」。这是网页播放器被阉割的直接后果，不是插件偷懒。
- 无版权 / 需 VIP 的曲子拿不到 URL（`code:404, url:null`，例如「晴天」），返回 `web-no-audio-url`。这与客户端里的表现一致。
- 真机验证记录（Edge + ego 浏览器，页面 `music.163.com` 停在一首无版权的「晴天」上）：`play` 正确报 `web-no-audio-url` 而不是假装成功；换成有版权的 `33894312` 注入后 `<audio>` 报 `paused:false / readyState:4 / duration:267.233`，时间轴真的在走（2.9 s），`pause` 返回 `via:'audio'`、状态转 Paused，`seek(30000)` 落点 30 s —— 接管链路整条通。

## [0.7.2] - 2026-11-21

**网页版通道：浏览器重启后续连 + 点重试不再弹新窗口**。修掉浏览器重启后 `health` 挂陈旧 ENOENT 错误、以及点重试按钮弹出新浏览器窗口两个问题。

### Fixed

- **`lib/web-backend.mjs` `ensure()`**：去掉 `Target.createTarget`——找不到已打开的 `music.163.com` 页面时返回可读错误 `web-page-not-found`（「请先在浏览器里打开 music.163.com」），绝不替用户新建窗口/标签，这就是"点重试弹新窗口"的根因。
- **`lib/web-backend.mjs`**：给 `CdpClient` 加 `isAlive()`，`ensure()` 开头校验旧连接存活，浏览器重启后旧 ws 会重建而不是被一直复用；`readEgoConfig` 失败重试 4 次（间隔 200ms），应对 Edge 重启瞬间重写 `browser.json` 的偶发 ENOENT；连上后清空 `lastError`，`health` 不再挂陈旧错误。
- **测试**：新增 `test/web-backend.test.mjs` 2 条，断言"找不到页面时返回 web-page-not-found 且不调用 Target.createTarget"、以及"已有存活连接时直接复用并清错误"。全套 166 条。

## [0.7.1] - 2026-11-21

**网页版通道：识别用户手动放歌**。用户在浏览器里自己点播时，之前 `status` 显示「已暂停 · (无标题) · 原生车道」。本版修好识别与通道选择。

### Fixed

- **`lib/web-backend.mjs` READ_STATE_EXPR**：当前曲目改用 `window.player.getPlaying().track` 识别——对象形态取 `name/id/artists/duration`（`duration` 毫秒、`position` 秒），裸数字形态（如 `{"track":186016,"playing":true}`）取 `String(trackId)` 作 songId；`playing===true` 纳入播放态判断。进度优先自检 `<audio>`，手动放歌无 audio 时退到 `track.position`。
- **`lib/web-backend.mjs` `_songMeta` + `state()`**：数字形态 track 只有 songId 没歌名时，页面内同源 fetch `/api/song/detail?ids=[id]` 补 name/artist/durationMs（60 分钟缓存），不再显示「网易云音乐」占位；时长单位统一为秒。
- **`lib/web-backend.mjs` `ensure()`**：已登录或已读到正在播的歌时跳过注入 cookie 与 `Page.reload`，避免打断用户当前播放。
- **`lib/channel.mjs`**：`pick()` 改按「哪条通道正在播放」选路（`channelPlaying`，1.5 秒缓存），而不是只看客户端进程；`detectClientRunning` 的 tasklist 探测失败改为返回 false 并用绝对路径，修掉在 DSH 宿主里裸命令 ENOENT 导致的假在线、卡在 native 的问题。
- **`index.js`** describe：`positionSource:'web'` 文案改「网页版」。

## [0.7.0] - 2026-11-21

**网易云网页版通道**。客户端没装 / 没开时，插件自动切到浏览器里的网易云网页版执行同一套动作，`client.js` 面板零改动。

### Added

- **`lib/web-backend.mjs`：WebBackend**。通过 ego 浏览器的 CDP（Node 内置 WebSocket，无新增依赖）驱动 `music.163.com` 页面。登录态复用：优先手填 cookie，其次用 `lib/cookies.mjs` 从客户端 profile 解出的 cookie 注入浏览器（httpOnly 的 `MUSIC_U` 走 `Storage.getCookies` 读取）。播放走明文 `POST /api/song/enhance/player/url/v1` + 登录 cookie 拿真实音频 URL（实测无需 weapi/eapi 加密），注入页面 `<audio>` 播放，url 缓存 30 分钟；无版权歌曲 url=null 降级 `web-no-audio-url`。`state/action/volume/deepHealth` 返回形状与原生一致，`channel:'web'`，动作支持 play/pause/toggle/next/prev/seek/set_mode/like/play_daily。
- **`lib/channel.mjs`：ChannelRouter + detectClientRunning**。四种通道模式：`client-first`（默认，客户端在线走 native、掉线切 web）/ `web-first` / `client-only` / `web-only`。「客户端在线」用 tasklist 查进程存在，3 秒缓存；探测失败保守按在线处理，避免 client-first 误切。`deepHealth` 同时报两条通道状态。
- **配置**（`index.js` / `cordis.patch.yml`）：`channelMode` / `webBrowserJson` / `webLoginCookie` / `webAutoInjectCookie` / `webSongUrlLevel`。设置页可切换通道策略与歌词音质档位。
- **测试**：`test/channel.test.mjs` 5 条覆盖四模式选择 / 未知回退 / 动作路由 / 通道属性 / 进程探测。全套 164 条。

### Notes

- 网页版通道依赖本机 ego 浏览器（Edge/Chrome CDP）在跑；`webLoginCookie` 留空且客户端也没装时，需在 ego 浏览器里登录一次网易云网页版。
- 自动播放受浏览器策略限制，WebBackend 用 `userGesture` 触发播放；音频加载的 Referer 防盗链已验证通过。
- 「一键播日推」在网页版通道同样生效：`play_daily` 复用 `DailyService` 拉推荐歌单灌队列从第一首播。

## [0.6.0] - 2026-11-21

**"喜欢"红心**。展开态控制行"下一首"按钮右边多了一个红心：点一下把当前歌收藏进「我喜欢的音乐」（或取消），已喜欢时填实心红。全程走 Web API + 客户端 cookie，**不投 orpheus、不唤起客户端窗口**。

### Added

- **`lib/like.mjs`：LikeService**。注入式服务（`getConfig` / `log` / `cookieLoader` / `fetchJson` / `now`），复用 `lib/cookies.mjs` 的登录态与 `lib/daily.mjs` 的 `postForm` 范式。`isLiked(songId)` 打 `POST /song/like/get`，`setLiked(songId, liked)` 打 `POST /song/like`（`like:'true'|'false'` + `csrf_token` 取 `__csrf`）。按 songId 缓存 60 秒、查询/写入各自 inflight 去重；错误码 `like-no-song` / `like-no-cookie` / `like-unavailable` / `like-needs-login` / `like-network` / `like-failed`。`apiBase` 优先 `likeApiBase`，留空跟随 `dailyApiBase`，再兜 `https://music.163.com/api`。
- **`like` 动作**（`lib/player.mjs` / `index.js`）。`action('like',{like?:boolean})`：显式布尔即目标态，省略则按当前 liked 取反；songId 取自 elog 的 `track.songId`；成功后回填 `now.liked`。`state()` 给 `now` 附加 `liked` 字段（按 songId 变化才重查，同一首读 LikeService 缓存，失败 15 秒内不重试）。模型工具 `action` enum 加 `like` + 布尔参数 `like`。配置加 `likeApiBase`（默认空，跟随 `dailyApiBase`）。
- **面板红心**（`client.js`）。`nc-ctrl` 行 next 之后插 `nc-like-btn`：空心/实心 `HeartIcon` 两态，已喜欢填 `#e6495b`；`title` / `aria-pressed` 跟着 liked 变，正在收藏显示"收藏中…"；`!songId` 时禁用。它正好顶替原来右侧的对称占位块，主播放键仍然居中；收起态 return 在更上面，天然不出现。`like-*` 错误映射成人话。
- **文案**（`client.js` 内嵌 LOCALES + `locale/zh.json` / `en.json`）。新增 like/unlike/liking/likeNoSong/likeNeedsLogin/likeUnavailable/likeFailed。
- **大卡片显示所属专辑 / 歌曲来源**（`lib/elog.mjs` / `lib/player.mjs` / `client.js`）。副标题在歌手后接「专辑：X · 来源：Y」，与客户端「歌曲信息」一致。`extractSource(text)` 从 elog 播放事件顶层（`"localTrack"` 之前）取 `scene`/`href`/`text` 作 last-known——这是客户端「来源：xxx」显示的那串字；text 为空则前端显示「未知」。关键防错：`firstString` 取首个匹配，必须先在 `"localTrack"` 处截断，否则会误抓 track 内部的同名字段。`#mergeElog` 把 `es.source` 透传给 `now.source`，前端只在有值时显示；副标题整体加 `title` 全文防 ellipsis 截断。`nativePlay` / 无来源的 track 事件不清除 last-known。
- **测试**。`test/like.test.mjs` 38 条（csrfOf / normalizeLiked 多形状、60s 缓存与 force、in-flight 合并、form 字段、错误码映射、PlayerService 分支、state 红心同步状态机、native 热键同步与回退、elog source 透传）；`test/elog.test.mjs` 42 条（extractSource 纯函数、Watcher last-known、track 事件来源抽取与保留）。`npm test` 共 **159 条**。

### Fixed

- **喜欢状态不同步**：`isLiked` 改用 `POST /api/song/like/check` + `{trackIds:[id]}`（原 `/song/like/get` 会忽略传入 ids、恒返回全量已喜欢列表，单曲判定永远读不出来）。`normalizeLiked` 现认得 check 返回的「命中 id 数组」：命中→实心，不在列表→空心。id 全程按字符串传递，避免大 id 的 Number 精度丢失。
- **点红心报"操作失败，请重试"**：`setLiked` 写入参数由 `songid` 改为 `trackId`（实测 `songid` 返回 `code:400 请求参数错误`，`trackId` 返回 `code:200`）；`userid` 省略，`like` 仍为字符串 `'true'/'false'`。
- **喜欢状态不与客户端同步（客户端→插件）**：客户端 elog 全量无 like/收藏事件（11.78 MB 日志零命中），事件驱动不可行。`state()` 改为轮询近似实时：切歌立即回源，同一首歌每 `likeSyncMs`（默认 8 秒）用 `force:true` 强制打 `/song/like/check`（绕过 LikeService 的 60s 本地缓存），节流窗口内只读缓存零网络开销，失败 15 秒退避。`toggleLike` 成功后刷新节流时间戳，避免紧接着又回源。
- **在 DSH 里点红心不同步客户端本地 UI（插件→客户端）**：客户端没有 like 的 webcmd、onWebMessage 命令表也无 like、本地 20017 是未破解私有协议、native.ntpk 加密——外部直连全部排除。改用客户端自己的全局 love 热键（`async:hostResource/setLikeCurPlayingTrack`，默认 `Ctrl+Alt+L`、`activateGlobal:true`）：`#toggleLike` 先 force 查服务端作客户端状态代理，与目标一致则幂等不按（热键是 toggle，按了会翻回去），不一致则经 helper 模拟热键让客户端自己 toggle 红心并写服务端，再 force 回填面板。helper 新 `setLike` case 用 `Hotkey()`（keybd_event 按下+逆序释放）、**不 Activate、不投 webcmd，全程不弹窗**。native 不可用 / 失败 / 无会话一律回退 LikeService Web API 写服务端（值对、客户端 UI 待其自刷新）。新增配置 `hotkeyLike`（默认 `Ctrl+Alt+L`，改过客户端快捷键时对应修改）。用户可用配置 `likeSyncMs`（2000–60000）调节及时性。
- **「来源」不显示**：原只在 `trackmeta` case 从 `refreshCurPlaying` 抽来源，但它在真实日志里极稀疏（最近一次距回放切点约 2.5 万行），`#preload()` 从切点往后回放直接跳过 → `source` 恒 null。改为在每次切歌必发的 `playOneTrackInPlayingList` 事件里抽顶层 `scene`/`href`/`text`（形状与 curPlaying 一致，实测 `text` 就是客户端显示值），`refreshCurPlaying` 保留作兜底。用 `if(src)` 保护：同次起播连发的无来源 `checkPlayPrivilege` 不清空已抽到的来源（last-known）。

### Known limitations

- **喜欢状态靠轮询 Web API**：客户端日志没有红心事件，用户在网易云客户端点红心后，插件最多 `likeSyncMs`（默认 8 秒）才会跟随——不是事件级实时。只有当首歌的 id 能从 elog 拿到时才显示准确的红心态；拿不到 id 时按钮禁用。接口偶发失败时红心保持上次的本地态，15 秒后才重试。

## [0.5.0] - 2026-11-15

**播放顺序切换**。展开态控制行最左多了个模式按钮（上一首左边）：点一下在 顺序 → 列表循环 → 单曲循环 → 随机 里循环，图标和 tooltip 跟着当前态变，和客户端自己的循环顺序一致。

### Added

- **`set_mode` 动作**（`lib/player.mjs` / `index.js` / `client.js`）。`value` 取 `cycle`（列表循环）/ `single`（单曲循环）/ `random`（随机）/ `order`（顺序），非法值回 `bad-mode`；成功返回 `{ok, value, mode, now, volume}`，`now.mode` 是 elog 读回的客户端枚举（`playOrder` / `playCycle` / `playOneCycle` / `playRandom`）。
- **`setMode` 助手命令**（`lib/helper.ps1` 的 `Invoke-NativeMode`）。投 `{"cmd":"mode","value":...}` webcmd（客户端 73.chunk 的 `case"mode"` → `playing/switchPlayingMode`），窗口压制与 seek 同一套。
- **`elog` 的 mode 解析**（`lib/elog.mjs`）。客户端切模式会写一条 `【playing】,"播放模式切换","旧播放模式::","x","新播放模式::","y"` 日志，`classifyLine` 归为 `mode` 事件，`#apply` 用 `/新播放模式::","(\w+)"/` 取新值，`getState()` 返回 `mode`。注意客户端枚举与 webcmd 短值是两套词：`playOneCycle` ↔ `single`。
- **面板按钮**（`client.js`）。`nc-ctrl` 行 prev 键之前插了 `nc-mode-btn`：四个 SVG 图标（顺序横线箭头 / 双循环 / 单曲循环带 1 / 交叉随机）按 `now.mode` 查表显示，`title` 拼当前文案，点击发 `set_mode` + 下一个值。`mode-no-client` / `mode-failed` 错误在底部 `nc-err` 显示人话。收起态 return 在更上面，天然不出现。
- **测试**。elog 2 条（classifyLine 识别 + Watcher 提取 mode）、daily.test 5 条（bad-mode / 成功回填 / no-client / 透传 / 抛错）。`npm test` 现为 **112 条**。

### Known limitations

- **模式读数来自客户端日志**：客户端从启动到第一次切模式之间不写任何模式日志，`now.mode` 是空串，面板按「顺序」兜底显示——此时图标可能和客户端实际状态不一致，点一下就同步了。
- **SMTC 读不到模式**：网易云 3.1.43 不注册 SMTC 会话，`configCenter` 等本地缓存也不持久化播放模式，所以 elog 是唯一可靠的读数来源。

## [0.4.0] - 2026-11-15

**一键播放日推**。展开态多了一个「今日推荐」小按钮：点一下就把客户端队列换成今天的每日推荐、从第一首开始播。数据不是猜的，是插件用客户端自己的登录态去拉的。

### Added

- **`play_daily` 动作**（`lib/player.mjs` / `index.js` / `client.js`）。展开态 `.nc-ctrl` 与 `.nc-vol` 之间多一行 `.nc-daily`，里面是一个 17 px 高的小胶囊按钮（`♪ 今日推荐`）；收起态走的是另一个 return 分支，所以天然不出现。返回值沿用其它动作的形状（`ok` / `message` / `now` / `volume`），另外带 `songCount` / `firstSong` / `day` / `cached`。
- **`lib/cookies.mjs`：读客户端的 CEF cookie**。日推接口要登录态，而插件自己没有登录流程——所以直接借客户端已有的：`%LOCALAPPDATA%\NetEase\CloudMusic\webapp*\Cookies`（SQLite）里 `MUSIC_U` 等 21 个 cookie 全是 `v10` 前缀的 OSCrypt 密文，密钥在 `LocalPrefs.json` 的 `os_crypt.encrypted_key`（base64 → 去 5 字节 `DPAPI` 头 → `CryptUnprotectData` 得 32 字节 AES key），再用 AES-256-GCM 解（`v10` + 12 B nonce + 密文 + 16 B tag）。两个坑：① 客户端运行时 `Cookies` 被独占锁，必须先 `fs.copyFileSync` 到临时目录再打开；② PowerShell 5.1 没有 `[Convert]::FromHexString`，二进制只能走 base64 传递（`-EncodedCommand` + `[Convert]::FromBase64String`）。
- **`lib/daily.mjs`：拉日推列表**。`GET /api/v1/discovery/recommend/songs?limit=50`，带上面拼好的 cookie 串与客户端 UA。`normalizeSongs()` 同时兼容 `recommend[]` / `data.dailySongs[]` / `data.recommend[]` / `songs[]` 四种形状，丢掉 id 为空 / `'0'` / `'NaN'` 的项。按天缓存（同一天重复点不重复请求），并发请求合并成一个 inflight。
- **`playDaily` 助手命令**（`lib/helper.ps1` 的 `Invoke-PlayDaily`）。先投 `{"cmd":"play","type":"song","id":<第一首>}`，等 420 ms 让客户端把队列换完，再投 `{"cmd":"playingList","type":"addToNext","value":[其余 id]}` 把剩下的塞进队列。窗口压制直接复用 `SendOrpheusCommand` 那一套（Blind / Ghost / MuteShadows / Guard）。
- **`test/daily.test.mjs`：28 条**。`normalizeSongs` 四种形状、按天缓存 / 跨天失效 / `force`、并发合并、`limit` 夹取、`apiBase` 尾斜杠、空列表判为未登录、cookie 解不开、401 / 403 / 500 / 网络异常、失败不落缓存，以及 `play_daily` 的 unavailable / 成功 / 空列表 / 透传 / 抛错 / `no-client` / 连点去重。`npm test` 现为 **105 条**（elog 31 + lyrics 25 + transport 21 + daily 28）。

### Fixed

- **`started` 事件会把歌名张冠李戴**（`lib/elog.mjs`）。webcmd 起播这条路客户端只发 `started`（`native播放资源load完成，开始播放`）和 `native播放state`，**不发** `playOneTrackInPlayingList` / `nativePlay` 那两条带完整曲目 JSON 的事件；而旧代码在 `started` 里写的是 `this.track = this.track || {...}` 再改 `songId`，于是「`songId` 是新的、歌名还是上一首」。现在整体替换成只带 `songId` 的空壳，让前端老实地退回窗口标题兜底。
- **连点两次不重复起播**。`#playDaily()` 用一个 `dailyInflight` 挂住进行中的 promise，第二次点击直接 `await` 第一份结果并标 `deduped: true`，不会投第二遍 webcmd。
- **客户端窗口顶部那条白边**（`lib/helper.ps1` 的 `SendOrpheusCommand`）。白边的真身是客户端那 4 个 `OrpheusShadow` 边框窗（永远画纯白的自绘弹窗），正常时被压在主窗下面只露出一圈柔化阴影。原来的压制条件是「窗口从最小化 / 托盘恢复时才弄哑」，前提是「窗口正常摆在屏幕上时客户端不会走 restore」。**实测否掉了这条前提**：客户端开着、首页完整摊在屏幕上，发一条 webcmd 它照样会自己走一遍 restore，4 个边框窗被重排到主窗内侧上方，屏幕顶部留下一条 80 px 的纯白带（截图采样 x=1500：y=69..148 全是 `255,255,255`），而且不会自己消失。现在改成**只要发 orpheus 消息就先 `MuteShadows`**，与窗口当前是什么状态无关。代价仍是窗口外沿那圈 32 px 柔化阴影没了（`MuteShadows` 不恢复），比顶部一条 80 px 白带划算。

### Known limitations

- **未登录时接口不报 401，而是回 200 + `{"code":200,"recommend":[]}`**（已实测）。所以「需要登录」只能靠空数组判定，`daily-needs-login` 的 `detail` 会区分 `no cookie` 与 `empty recommend list`。
- **cookie 会随客户端刷新而失效**。失效时表现是空列表（同上），点按钮会提示「请先在网易云客户端登录」，重新登录客户端即可。
- **日推起播瞬间歌名可能短暂显示窗口标题**。`started` 事件里没有歌名，要等客户端的后续事件或窗口标题更新（见上）。
- 一次 `play_daily` 要发两条 webcmd，窗口压制跟 `seek` 同一套：托盘 / 最小化态一帧不露，窗口**正摆在屏幕上且部分可见**时仍会跳前约 1.3 秒（与 seek 同一个残留）。

## [0.3.0] - 2026-11-14

**拖进度条跳转**。`native` 车道原来 `canSeek` 恒为 false，进度条只能看；现在能拖、能按方向键、真的跳。

### Added

- **进度条可拖动**（`client.js`）。展开态把 `.nc-bar` 从 3 px 的展示条改成可交互滑块：命中区撑到 14 px（原来 `overflow: hidden` 会把滑块裁掉），`onPointerDown` 里 `stopPropagation` 免得拖着拖着把整张卡片拖走，拖动期间用本地值渲染、松手才 `commitSeek()` 发一次命令——不是每动一像素发一条。键盘：`←` / `→` ±5 s（`Shift` ±10 s）、`Home` / `End` 到头尾。`role="slider"` + `aria-valuemin/valuemax/valuenow` 补齐。
- **orpheus 协议通道**（`lib/helper.ps1` 的 `SendOrpheusCommand` / `Invoke-NativeSeek`）。客户端把 `HKLM\SOFTWARE\Classes\orpheus` 注册成 `cloudmusic.exe --webcmd="%1"`，投递 `orpheus://<base64(JSON {cmd,value})>` 后第二条进程转交主进程、前端 `onWebMessage` 的 `case "seek"` → `playing/setPlayingPosition` → 原生 `DoSeek pos:N`。踩过的坑：`ShellExecuteW` 的返回值只代表「投递成功」，转交是异步的，实测 show 最晚落在 7.3 秒。
- **`elog.noteSeek()` + `pendingSeek`**（`lib/elog.mjs`）。日志落盘比命令本身慢 60–150 ms，这段时间前端会看到「位置还在原处」并把滑块拽回去。现在 seek 成功后立刻按目标位置推算（`PENDING_SEEK_MS = 2500`、`PENDING_SEEK_TOLERANCE_MS = 1500`），`setPlayingPosition` 一到就撤销，日志接管后正常前进。
- **`test/elog.test.mjs` 新增 5 条**：`noteSeek` 生效 / 到点撤销 / 日志接管后不再外推 / 容差外的事件不撤销 / 负数与超长钳制。`npm test` 现为 **77 条**（elog 31 + lyrics 25 + transport 21）。

### Fixed

- **`native` 车道不能 seek**：`canSeek` 恒为 false，进度条只展示。现在走 orpheus 协议，`#mergeElog` 的 `canSeek` 改 true，`/action {action:'seek'}` 真跳。
- **跳进度时客户端窗口蹦到眼前**。客户端收到任何 orpheus 消息都会 `showWindow`（`app.chunk` 的 `activeWindow` effect 末尾是无条件的 `"webmsg" === t && (yield o({ type: "showWindow" }))`，`actionId` 白名单管不到这一行），所以这条路必须配宿主机侧的压制：投递前最小化/托盘态用空 region + layered `alpha=0`（**不改窗口尺寸**），可见态把 z 序插回原位；投递后起后台守卫，3 ms 高频盯到 4.2 秒、然后 40 ms 盯到 8 秒，把客户端迟到的 show 按回去、把焦点还给原窗口。三态实测：托盘态一帧不露、最小化态只在屏外动、可见态位置不动且不抢焦点。
- **跳完进度后顶部一条 61～62 行的白带永远不消**。真身是客户端那 4 个 `WS_POPUP + WS_EX_TRANSPARENT` 的 `OrpheusShadow` 边框窗（顶边那个 1239×64，覆盖窗口顶部 32 逻辑像素）：正常状态它们压在主窗口下面只露出一圈柔化阴影，客户端从最小化 restore 时会把它们排到主窗口**上面**，于是一片纯白。z 序压底当场有效但下次 restore 会复位；`RGN_DIFF` 只能降到 13 行；nudge / invalidate / 缩放 / 显隐 / 最大化再还原全部无效或极不稳定。唯一持久的是把它们的 visible region 清空——代价是窗口外沿那圈阴影没了，用户拖进度时察觉不到。`MuteShadows()` 在投递前调用，且不恢复。
- **1×1 park 是白带的另一半来源，已整体删除**。早期为了不让客户端 restore 到屏幕中央，把 `rcNormalPosition` 改成 `(0,0,1,1)`；CEF 会照着这份 geometry 重新 layout，等拉回 1175×940 时自绘标题栏层和那 8 个阴影窗不跟着重排。另外 `SetWindowPlacement` 在隐藏态会把窗口「写活」（`vis` 从 false 变 true，屏幕上多出一个 1×1 的小点）。现在只用 region + alpha。
- **「用户自己点任务栏打开窗口」被按回最小化**。原来的判据一个都不成立：`GetLastInputInfo` 的 idle 会被客户端自己 show 打回 0–30 ms；「前台是 shell」在窗口被按回最小化后恒为真（静置 2 秒就误判）；「从最小化变普通窗口」客户端自己 show 也造成它。现在只认一条证据：**光标在外壳上 + 左键按着**（`CursorOnShell()` + `GetAsyncKeyState(0x01)`）。外壳判定还得回退到「光标落在 `Shell_TrayWnd` 矩形内」——本机任务栏上盖着微信的 `Qt51514QWindowIcon`，`WindowFromPoint` 命中它会让类名判定失手。
- **守卫退出后窗口停在「可见、非最小化、挂在屏外」的透明空壳**。旧的「整个守卫只按回一次」让 `PressBacks = 1` 之后再也不管，客户端把窗口放在 `-25600, 159×27` 的占位几何上却报 `ico=False`。改成每拍都按（上限 40 次），按够次数就交给收尾去摆正；收尾改成「查到 `IsIconic` 为真为止」重试（8 次 × 40 ms）。
- **`rcNormalPosition` 被写成最小化的假几何**。客户端某一拨 show 会顺手把 `rcNormalPosition` 写成 `-25600, 159×27`，不补的话用户下次还原出来是个 159×27 的小条、所有按钮都点不到。收尾在确认真的按回去之后，检查 `rcNormalPosition` 是否退化成 `< 200 px` 或 `<= -20000`，是就用 `SetNormalRect` 写回原矩形（最小化态下 `SetWindowPlacement` 只改 `rcNorm`、不动 `showCmd`，实测持久）。
- **守卫收敛太早**：`QUIET_MS = 1500` 在几拨 show 之间长达 4 秒的空档里就收工，漏掉 7.3 秒那拨。改成 `elapsed >= LATE_MS(8200) && quiet >= 1500`。
- **z 序纠正反而把窗口顶到最前**：`SetWindowPos` 的 `hWndInsertAfter = NULL` 等于 `HWND_TOP`，而 `GetWindow(hwnd, GW_HWNDNEXT)` 在窗口已经是最上层时返回 NULL。新增 `ZInsert`（NULL 时改用 `HWND_BOTTOM`）。
- **豁免期把遮罩一起关掉**：`userGrace` 原本同时关掉 blind / ghost / MuteShadows / `needGuard`，于是「刚被用户点开过」的 8 秒里再 seek 就完全裸奔。改成只关「按回」，遮罩与 z 纠正照做（`Guard.NoPressBack`）。
- **`needGuard` 含 `!wasFront` 导致前台时不守**：窗口正好在前台时反而不起守卫，那几拨 show 无人处理。去掉这个条件。
- **helper 起不来时整个插件像坏了**：`lib/backend.mjs` 原来裸名 `spawn('powershell.exe')`，而某些宿主进程的 `PATH` 里没有 `C:\Windows\System32`（实测 DSH 后端 PATH 只有 Python / npm / Ollama / PortableGit），于是 `ENOENT`。现在按 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 解析绝对路径；用户显式配了带路径的 `powershellPath` 就照用。
- **`seek-unsupported` 的措辞**改为「车道既没有时间轴也没有 orpheus 协议通道」——它不再等价于「native 车道」。

### Known limitations

- 跳进度会起一个短命的 `cloudmusic.exe`：协议命令要走客户端自己的 `--webcmd` 入口，第二条进程把消息转交主进程后约 1 秒内自行退出（日志 `orpheus_runner.cpp(535)] Another client is exist.`）。松手才发一次，不是连续发。
- 跳进度时会短暂压制客户端窗口（客户端收到消息必弹窗，见上）。托盘态一帧不露，最小化态只在屏外动。
- 清空 `OrpheusShadow` 的 region 之后，窗口外沿那圈柔化阴影**不再恢复**——恢复即刻白边就回来。用户拖进度时察觉不到。

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
