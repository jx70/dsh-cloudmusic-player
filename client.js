/**
 * client.js —— 浏览器半端：右下角那个悬浮小播放器
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是**自注册脚本**：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<package.json 的 name>',
 *       factory: (require) => { ...; return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 *   三条硬约束（踩过才写的）：
 *     1. 所有副作用（注入 <style>、定时器、事件监听）必须写在 factory 闭包里，
 *        因为 factory 是**首次 require 时才执行**并 memoize —— 写在顶层会在
 *        模块还没被加载时就去摸 document，运气不好直接静默失败。
 *     2. 只 require('react')。DSH 的 @deepseek-ai/dsh-client-* 包是宿主内部的，
 *        第三方 bundle 不该依赖它们的内部结构。
 *     3. 不用 JSX（这里是 .js 不是 .jsx，没有编译步骤），全部 React.createElement。
 *
 * 挂在哪：`shell.overlay` 是 layout 声明的 list 槽（scope: 'root'），
 *   渲染在 AppFrame 的 grid 之外、不走滚动容器，所以 `position: fixed` 的
 *   悬浮框天然就浮在最上层，不需要 portal，也不会被主区的 overflow 裁掉。
 *
 * 数据从哪来：宿主半端开的 6 条同源路由（/api/cloudmusic-player/*）。
 *   浏览器和服务同源、带 cookie，connection 的信任栅栏才放行 —— 这也是
 *   为什么不能用 WebSocket / 自定义端口，那会被栅栏挡在外面。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloudmusic-player',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** locale 命名空间：和宿主 export const name 一致 */
    const NS = 'cloudmusic-player'
    /** 路由前缀：和 index.js 的 NS 一致 */
    const API = '/api/cloudmusic-player'
    /** localStorage 键：和 v3 计划的命名一致 */
    const STORE_KEY = 'dsh-cloudmusic-player'

    /** 轮询间隔（毫秒）。2 秒够跟手，又不至于把宿主刷爆 */
    const POLL_MS = 2000
    /** 页面在后台时间隔拉长到 5 秒 —— 看不见的时候没必要勤快 */
    const POLL_HIDDEN_MS = 5000
    /** 进度条/歌词高亮的刷新率（约 5 Hz，比 60fps 省得多，肉眼看不出区别） */
    const TICK_MS = 200

    // ── 文案 ────────────────────────────────────────────────────────────────
    const LOCALES = {
      zh: {
        play: '播放',
        pause: '暂停',
        next: '下一首',
        prev: '上一首',
        mute: '静音',
        unmute: '取消静音',
        volume: '音量',
        lyrics: '歌词',
        collapse: '收起',
        expand: '展开',
        refresh: '刷新',
        retry: '重试',
        idle: '没在放歌',
        idleHint: '打开网易云播一首，这里就动起来了',
        noClient: '没找到播放器',
        noClientHint: '确认网易云客户端在运行',
        unsupported: '这台机器不支持控制',
        unsupportedHint: '目前只有 Windows 能接管系统媒体会话',
        helperDown: '后台没响应',
        helperDownHint: '点重试会把助手进程重新拉起来',
        noLyrics: '暂无歌词',
        noLyricsHint: '',
        lyricsOff: '歌词已关闭',
        lyricsOffHint: '可在插件设置里打开',
        scopeProcess: '只调网易云',
        scopeSystem: '调系统音量',
        noTimeline: '客户端不共享进度 · 点歌词行对齐',
        alignHint: '点这一句可以按它校准歌词',
        settings: '设置',
      },
      en: {
        play: 'Play',
        pause: 'Pause',
        next: 'Next',
        prev: 'Previous',
        mute: 'Mute',
        unmute: 'Unmute',
        volume: 'Volume',
        lyrics: 'Lyrics',
        collapse: 'Collapse',
        expand: 'Expand',
        refresh: 'Refresh',
        retry: 'Retry',
        idle: 'Nothing playing',
        idleHint: 'Open NetEase Cloud Music and hit play',
        noClient: 'No player found',
        noClientHint: 'Make sure the NetEase client is running',
        unsupported: 'Not supported on this machine',
        unsupportedHint: 'Only Windows can drive the system media session today',
        helperDown: 'Backend not responding',
        helperDownHint: 'Retry restarts the helper process',
        noLyrics: 'No lyrics',
        noLyricsHint: '',
        lyricsOff: 'Lyrics disabled',
        lyricsOffHint: 'Enable it in the plugin settings',
        scopeProcess: 'App only',
        scopeSystem: 'System',
        noTimeline: 'no shared timeline · click a line to sync',
        alignHint: 'Click a line to sync the lyrics to it',
        settings: 'Settings',
      },
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────

    /** 统一的 JSON 请求：400/500 也要能读出正文里的 error，不能只看 .json() */
    async function call(path, init) {
      const res = await fetch(API + path, {
        credentials: 'same-origin',
        ...init,
        headers: init && init.body ? { 'content-type': 'application/json', ...(init.headers || {}) } : init?.headers,
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        data = null
      }
      if (!res.ok) {
        const why = res.status === 401 ? '401（没登录/没权限）' : res.status === 403 ? '403（被宿主拦了）' : `HTTP ${res.status}`
        throw new Error((data && (data.detail || data.error)) || why)
      }
      return data || {}
    }

    const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body || {}) })

    /** 秒 → m:ss */
    function clock(sec) {
      const s = Math.max(0, Math.floor(Number(sec) || 0))
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }

    /** 二分：找最后一个 t <= ms 的行下标 */
    function findLine(lines, ms) {
      let lo = 0
      let hi = lines.length - 1
      let ans = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (lines[mid].t <= ms) {
          ans = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return ans
    }

    /**
     * LRC 里「作词 : 许嵩」这类署名行。
     *
     * 流行歌前面十几二十秒往往只有作词/作曲/编曲/制作人四行（每行 1 秒），
     * 第一句真歌词要等到 20 多秒才出现。如果让它们参与高亮，这段时间高亮
     * 会死钉在「制作人」上，观感就是「歌词不动」。所以署名行照常显示，
     * 但不参与高亮定位。
     */
    const CREDIT_RE =
      /^(作词|作曲|编曲|制作人|制作|监制|混音|母带|录音|和声|吉他|贝斯|鼓|键盘|弦乐|出品|发行|企划|统筹|词|曲|原唱|翻唱|OP|SP)\s*[:：]/

    /** 点歌词校准的锚点有效期：超过就作废，免得明天重放这首歌还按上次的位置起算 */
    const ANCHOR_TTL_MS = 30 * 60 * 1000

    /** 读本地 UI 偏好；坏了就当没存过 */
    function loadUi() {
      const base = { collapsed: false, x: null, y: null, scope: '', anchor: null }
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (!raw) return base
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return base
        // anchor：用户点歌词行手动对齐过的时间锚点，按歌曲 key 记
        let anchor = null
        if (
          parsed.anchor &&
          typeof parsed.anchor.key === 'string' &&
          Number.isFinite(parsed.anchor.t) &&
          Number.isFinite(parsed.anchor.at) &&
          Date.now() - parsed.anchor.at < ANCHOR_TTL_MS
        ) {
          anchor = { key: parsed.anchor.key, t: Number(parsed.anchor.t), at: Number(parsed.anchor.at) }
        }
        return {
          collapsed: parsed.collapsed === true,
          x: Number.isFinite(parsed.x) ? parsed.x : null,
          y: Number.isFinite(parsed.y) ? parsed.y : null,
          scope: parsed.scope === 'system' || parsed.scope === 'process' ? parsed.scope : '',
          anchor,
        }
      } catch {
        return base
      }
    }

    function saveUi(patch) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(patch))
      } catch {
        /* 隐私模式/配额满：只是记不住位置，不影响功能 */
      }
    }

    // ── 图标（内联 SVG，跟着 currentColor 走，深色浅色都好看） ─────────────
    function Svg({ children, size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        children,
      )
    }

    const PlayIcon = () => h(Svg, null, h('path', { d: 'M8 5.5v13l10.5-6.5z', fill: 'currentColor', stroke: 'none' }))
    const PauseIcon = () =>
      h(
        Svg,
        null,
        h('rect', { x: 7.5, y: 5.5, width: 3.4, height: 13, rx: 1.2, fill: 'currentColor', stroke: 'none' }),
        h('rect', { x: 13.1, y: 5.5, width: 3.4, height: 13, rx: 1.2, fill: 'currentColor', stroke: 'none' }),
      )
    const NextIcon = () =>
      h(
        Svg,
        null,
        h('path', { d: 'M6.5 5.6v12.8L16 12z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M18 5.5v13' }),
      )
    const PrevIcon = () =>
      h(
        Svg,
        null,
        h('path', { d: 'M17.5 5.6v12.8L8 12z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M6 5.5v13' }),
      )
    const VolIcon = ({ muted }) =>
      h(
        Svg,
        null,
        h('path', { d: 'M4 9.2v5.6h3.6L13 19V5L7.6 9.2z' }),
        muted
          ? h('path', { d: 'M17 9.5l4 5M21 9.5l-4 5' })
          : h('path', { d: 'M16.4 9a4.2 4.2 0 010 6M19 6.6a7.6 7.6 0 010 10.8' }),
      )
    const ChevronIcon = ({ up }) => h(Svg, null, h('path', { d: up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6' }))
    const RefreshIcon = () => h(Svg, null, h('path', { d: 'M20 12a8 8 0 11-2.4-5.7M20 4.5V10h-5.5' }))
    const NoteIcon = ({ size = 16 }) =>
      h(
        Svg,
        { size },
        h('path', { d: 'M9 18V6.5l10-2v11' }),
        h('circle', { cx: 6.5, cy: 18, r: 2.6 }),
        h('circle', { cx: 16.5, cy: 15.5, r: 2.6 }),
      )

    // ── 组件 ────────────────────────────────────────────────────────────────

    /**
     * 悬浮播放器。shell.overlay 不给 props（layout 里是 renderSlot('shell.overlay', {})），
     * 所以一切数据自己取。
     */
    function MiniPlayer() {
      const t = React.useContext(LocaleCtx)

      // ── 远端状态 ──
      const [st, setSt] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [lyr, setLyr] = React.useState(null)
      const [lyrState, setLyrState] = React.useState('idle') // idle|loading|ok|off|none|error

      // ── 本地 UI ──
      const [ui, setUi] = React.useState(loadUi)
      const [busy, setBusy] = React.useState('')
      const [dragLevel, setDragLevel] = React.useState(null)
      const [slide, setSlide] = React.useState(0) // 拖动时的临时坐标
      const [, forceTick] = React.useState(0)

      const rootRef = React.useRef(null)
      const volTimer = React.useRef(0)
      const volLast = React.useRef(0)

      const patchUi = React.useCallback((patch) => {
        setUi((prev) => {
          const next = { ...prev, ...patch }
          saveUi(next)
          return next
        })
      }, [])

      // ── 轮询 ──────────────────────────────────────────────────────────────
      React.useEffect(() => {
        let alive = true
        let timer = 0
        const tick = async () => {
          if (!alive) return
          if (!document.hidden) {
            try {
              const data = await call('/state')
              if (!alive) return
              setSt(data)
              setErr('')
            } catch (e) {
              if (!alive) return
              setErr(String((e && e.message) || e))
            }
          }
          if (alive) timer = window.setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS)
        }
        tick()
        const onVisible = () => {
          if (document.hidden) return
          window.clearTimeout(timer)
          tick()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      // ── 进度/歌词高亮的本地节拍 ────────────────────────────────────────────
      const playing = !!(st && st.now && st.now.status === 'Playing')
      React.useEffect(() => {
        if (!playing) return undefined
        const id = window.setInterval(() => forceTick((n) => (n + 1) % 1000), TICK_MS)
        return () => window.clearInterval(id)
      }, [playing])

      // ── 歌曲变化 → 取歌词 ─────────────────────────────────────────────────
      // songId 优先：日志车道（elog）给的是网易云自己的 id，按 id 取词不会
      // 撞上「搜同名的翻唱/伴奏」。拿不到 id 时才退回「标题 + 歌手 + 时长」。
      const songKey =
        st && st.now
          ? `${st.now.title}||${st.now.artist}||${st.now.songId || 0}||${Math.round(Number(st.now.end) || 0)}`
          : ''
      React.useEffect(() => {
        if (!songKey) {
          setLyr(null)
          setLyrState('idle')
          return undefined
        }
        const node = st.now
        const ctrl = new AbortController()
        let alive = true
        setLyrState('loading')
        const q = new URLSearchParams({
          title: node.title || '',
          artist: node.artist || '',
          durationMs: String(Math.round((Number(node.end) || 0) * 1000)),
        })
        if (node.songId) q.set('songId', String(node.songId))
        fetch(`${API}/lyrics?${q.toString()}`, { credentials: 'same-origin', signal: ctrl.signal })
          .then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => null) }))
          .then(({ ok, data }) => {
            if (!alive) return
            if (!ok || !data || data.ok !== true || !Array.isArray(data.lines) || data.lines.length === 0) {
              const reason = data && data.reason
              setLyr(null)
              setLyrState(reason === 'lyrics-disabled' ? 'off' : 'none')
              return
            }
            setLyr(data)
            setLyrState('ok')
          })
          .catch(() => {
            if (!alive) return
            setLyr(null)
            setLyrState('error')
          })
        return () => {
          alive = false
          ctrl.abort()
        }
        // 只用 songKey 作为依赖：st 每 2 秒换一个对象，别跟着瞎重建
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [songKey])

      // ── 位置插值 ──────────────────────────────────────────────────────────
      //
      // 两种通道的位置来源不同：
      //  · smtc   —— 系统给了 pos / end，按 serverTime 外推到「现在」。
      //  · native —— 客户端不注册 SMTC，拿不到时间轴（pos/end 恒 0），
      //              只能本地累计。起点只有两个来源：
      //                1. 用户点过某一行歌词 → 以那一行的时间戳为锚（按歌记住）
      //                2. 都没有 → 从 0 开始（等于「这首歌现在刚开始」）
      //
      // 为什么第 2 条不从「第一句真歌词」起算：LRC 里歌前常有十几二十秒的
      // 「作词/作曲/编曲/制作人」，看着像该跳过，但把起点挪到第一句歌词会让
      // 整首歌词提前一个前奏的长度 —— 比滞后更糟。那股空档期的正确做法是
      // 「不高亮任何行」（见下面 activeIdx 的回退扫描），而不是挪起点。
      //
      // 这里刻意不 memo：forceTick 每 200ms 触发一次渲染，就是要让这个表达式
      // 重新读一次 Date.now()，memo 反而会让时钟卡住不动。
      const nativeClock = React.useRef({ key: '', ms: 0, at: 0 })

      const posNow = (() => {
        if (!st || !st.now) return 0
        const end = Number(st.now.end) || 0
        const isPlaying = st.now.status === 'Playing'
        const serverAt = Number(st.serverTime) || Date.now()

        if (end > 0) {
          const base = Number(st.now.pos) || 0
          const drift = isPlaying ? Math.max(0, (Date.now() - serverAt) / 1000) : 0
          return Math.min(end, base + drift)
        }

        const c = nativeClock.current
        if (c.key !== songKey) {
          // 有锚点就用锚点起算，否则从 0 开始（= 这首歌现在刚开始放）
          const a = ui.anchor
          const start = a && a.key === songKey ? Math.max(0, Number(a.t) || 0) : 0
          nativeClock.current = { key: songKey, ms: start, at: Date.now() }
          return start / 1000
        }
        return (c.ms + (isPlaying ? Date.now() - c.at : 0)) / 1000
      })()

      // 把本地累计值写回 ref，下次渲染从新起点继续
      React.useEffect(() => {
        if (!st || !st.now || Number(st.now.end) > 0) return
        const c = nativeClock.current
        if (c.key !== songKey) return
        const nowMs = Date.now()
        if (st.now.status === 'Playing') {
          nativeClock.current = { key: songKey, ms: c.ms + Math.max(0, nowMs - c.at), at: nowMs }
        } else if (nowMs - c.at > 400) {
          nativeClock.current = { key: songKey, ms: c.ms, at: nowMs }
        }
      })

      /** 点歌词某一行 → 以它为锚点校准时钟（native 车道唯一能拿到真实位置的途径） */
      const alignTo = (line) => {
        if (!line || !songKey) return
        const t = Math.max(0, Number(line.t) || 0)
        nativeClock.current = { key: songKey, ms: t, at: Date.now() }
        patchUi({ anchor: { key: songKey, t, at: Date.now() } })
        forceTick((n) => (n + 1) % 1000)
      }

      // ── 动作 ──────────────────────────────────────────────────────────────
      const run = React.useCallback(
        async (name, fn) => {
          setBusy(name)
          try {
            const res = await fn()
            if (res && res.ok === false) setErr(String(res.error || 'failed'))
            else setErr('')
            if (res && res.now !== undefined) {
              setSt((prev) =>
                prev
                  ? {
                      ...prev,
                      now: res.now,
                      volume: res.volume ?? prev.volume,
                      systemVolume: res.systemVolume ?? prev.systemVolume,
                      serverTime: Date.now(),
                    }
                  : prev,
              )
            }
            return res
          } catch (e) {
            setErr(String((e && e.message) || e))
            return null
          } finally {
            setBusy('')
          }
        },
        [],
      )

      const act = (name, extra) => run(name, () => post('/action', { action: name, ...(extra || {}) }))

      const pushVolume = (level) => {
        volLast.current = level
        if (volTimer.current) return
        volTimer.current = window.setTimeout(async () => {
          volTimer.current = 0
          const v = volLast.current
          const res = await run('volume', () => post('/volume', { level: v, scope: scopeNow }))
          setDragLevel(null)
          if (res && res.ok !== false) {
            setSt((prev) => (prev ? { ...prev, volume: res.volume ?? prev.volume, systemVolume: res.systemVolume ?? prev.systemVolume } : prev))
          }
        }, 110)
      }

      const toggleMute = () => {
        const muted = activeMuted
        run('mute', () => post('/volume', { muted: !muted, scope: scopeNow })).then((res) => {
          if (res && res.ok !== false) {
            setSt((prev) => (prev ? { ...prev, volume: res.volume ?? prev.volume, systemVolume: res.systemVolume ?? prev.systemVolume } : prev))
          }
        })
      }

      const retry = () => run('restart', () => post('/restart', {}))

      // ── 拖动 ──────────────────────────────────────────────────────────────
      const onPointerDown = (e) => {
        if (e.button !== 0) return
        const el = rootRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const offX = e.clientX - rect.left
        const offY = e.clientY - rect.top
        const move = (ev) => {
          const maxX = Math.max(4, window.innerWidth - rect.width - 8)
          const maxY = Math.max(4, window.innerHeight - rect.height - 8)
          setSlide({
            x: Math.min(maxX, Math.max(8, ev.clientX - offX)),
            y: Math.min(maxY, Math.max(8, ev.clientY - offY)),
          })
        }
        const up = (ev) => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          const maxX = Math.max(4, window.innerWidth - rect.width - 8)
          const maxY = Math.max(4, window.innerHeight - rect.height - 8)
          patchUi({
            x: Math.min(maxX, Math.max(8, ev.clientX - offX)),
            y: Math.min(maxY, Math.max(8, ev.clientY - offY)),
          })
          setSlide(null)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        e.preventDefault()
      }

      // 位置：优先用拖过的绝对坐标，否则贴右下角
      const placed = slide || (ui.x !== null && ui.y !== null ? { x: ui.x, y: ui.y } : null)
      const rootStyle = placed
        ? { left: `${placed.x}px`, top: `${placed.y}px` }
        : { right: '22px', bottom: '22px' }

      // 窗口变小后旧坐标可能把卡片挤到屏幕外，顺手夹回来
      React.useEffect(() => {
        const onResize = () => {
          if (ui.x === null || ui.y === null || !rootRef.current) return
          const rect = rootRef.current.getBoundingClientRect()
          const x = Math.min(Math.max(8, ui.x), Math.max(8, window.innerWidth - rect.width - 8))
          const y = Math.min(Math.max(8, ui.y), Math.max(8, window.innerHeight - rect.height - 8))
          if (x !== ui.x || y !== ui.y) patchUi({ x, y })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [ui.x, ui.y, patchUi])

      // ── 状态判定 ──────────────────────────────────────────────────────────
      const caps = (st && st.helper && st.helper.capabilities) || null
      const degraded = !!(st && st.helper && st.helper.degraded)
      const helperDead = !!(st && st.ok === false) || !!err
      const unsupported = !!(caps && !caps.playback && !caps.sessionVolume)
      const now = st && st.now ? st.now : null
      const vol = st && st.volume ? st.volume : null
      // APP 与 SYS 是两套独立读数（进程音频会话 / 系统端点），一路写一路读错就会
      // 出现「拖到 70% 立刻弹回 49%」。scopeNow 决定界面上所有音量控件看哪一路。
      const sysVol = st && st.systemVolume ? st.systemVolume : null
      const scopeNow = ui.scope || (vol && vol.scope) || 'process'
      const activeVol = scopeNow === 'system' && sysVol ? sysVol : vol
      const activeMuted = !!(activeVol && activeVol.muted)
      const shownLevel = dragLevel !== null ? dragLevel : activeVol ? Number(activeVol.level) || 0 : 0

      // 收起态：只留一个胶囊
      if (ui.collapsed) {
        return h(
          'div',
          {
            ref: rootRef,
            className: 'nc-root nc-mini',
            style: rootStyle,
            onPointerDown,
            title: now ? `${now.title || ''}${now.artist ? ` · ${now.artist}` : ''}` : t('idle'),
          },
          h('div', { className: 'nc-mini-body' },
            h('span', { className: 'nc-note' }, h(NoteIcon, { size: 15 })),
            h('span', { className: 'nc-mini-text' }, now ? now.title || t('idle') : t('idle')),
            now
              ? h('button', {
                  className: 'nc-iconbtn nc-mini-btn',
                  disabled: busy !== '' || unsupported,
                  title: playing ? t('pause') : t('play'),
                  onClick: (e) => {
                    e.stopPropagation()
                    act('toggle')
                  },
                }, playing ? h(PauseIcon) : h(PlayIcon))
              : null,
          ),
          h('button', {
            className: 'nc-iconbtn nc-mini-expand',
            title: t('expand'),
            onClick: (e) => {
              e.stopPropagation()
              patchUi({ collapsed: false })
            },
          }, h(ChevronIcon, { up: true })),
        )
      }

      // ── 展开态 ────────────────────────────────────────────────────────────
      const progress = now && Number(now.end) > 0 ? Math.min(1, Math.max(0, posNow / Number(now.end))) : 0
      // 高亮只在真歌词行之间走：署名行（作词/作曲/编曲/制作人）不参与定位，
      // 否则歌前那 20 秒高亮会钉在「制作人 : 光良」上一动不动。
      // 但滚动位置仍跟着署名行走，免得整块歌词条突然跳回顶部。
      const rawIdx = lyr && lyrState === 'ok' && Array.isArray(lyr.lines) ? findLine(lyr.lines, posNow * 1000) : -1
      const activeIdx = (() => {
        if (rawIdx < 0) return -1
        for (let i = rawIdx; i >= 0; i -= 1) {
          const text = String(lyr.lines[i].text || '').trim()
          if (text && !CREDIT_RE.test(text)) return i
        }
        return -1
      })()
      const scrollIdx = activeIdx >= 0 ? activeIdx : rawIdx

      // 行高不是常量：带译文的那一行要塞两行字（原文 + 小字译文），所以更高。
      // 滚动位移必须按**真实累计高度**算，否则有译文之后高亮行会偏离中线。
      // 这里刻意不用 useMemo：歌词最多几十行，5Hz 重算的代价远小于 memo 依赖写错的风险。
      const LINE_H = 22
      const LINE_H_TR = 34
      const boxH = LINE_H * 5
      const rows = lyr && lyrState === 'ok' && Array.isArray(lyr.lines) ? lyr.lines : []
      const offsets = []
      let acc = 0
      for (let i = 0; i < rows.length; i += 1) {
        offsets.push(acc)
        acc += typeof rows[i].tr === 'string' && rows[i].tr ? LINE_H_TR : LINE_H
      }
      const rowH = (i) => (typeof rows[i]?.tr === 'string' && rows[i].tr ? LINE_H_TR : LINE_H)
      const shift =
        scrollIdx >= 0 && offsets[scrollIdx] !== undefined
          ? boxH / 2 - rowH(scrollIdx) / 2 - offsets[scrollIdx]
          : boxH / 2 - LINE_H / 2

      // 网易云客户端不给系统时间轴时，进度条和时长都没有意义 —— 别画一条永远 0% 的假进度
      const hasTimeline = !!(now && Number(now.end) > 0)

      const subtitle = (() => {
        if (err) return t('helperDownHint')
        if (unsupported) return t('unsupportedHint')
        if (degraded) return t('helperDownHint')
        if (!now) return t('idleHint')
        // 只显示歌手（没有歌手就退到专辑名）。通道名（native / smtc）不再往这儿拼 ——
        // 那行字会挤掉歌名的宽度，而通道信息真要看的时候 health?deep=1 里有。
        return now.artist || now.album || ''
      })()

      return h(
        'div',
        { ref: rootRef, className: 'nc-root nc-card', style: rootStyle },
        // 顶部：拖拽把手 + 标题 + 收起
        h('div', { className: 'nc-head', onPointerDown },
          h('div', { className: 'nc-head-main' },
            h('div', { className: 'nc-title', title: now ? now.title : '' }, now ? now.title || '—' : t('idle')),
            subtitle ? h('div', { className: 'nc-sub' }, subtitle) : null,
          ),
          h('button', {
            className: 'nc-iconbtn',
            title: t('collapse'),
            onPointerDown: (e) => e.stopPropagation(),
            onClick: () => patchUi({ collapsed: true }),
          }, h(ChevronIcon, { up: false })),
        ),

        // 歌词区
        h('div', { className: 'nc-lyr', style: { height: `${boxH}px` } },
          lyrState === 'ok'
            ? h('div', { className: 'nc-lyr-inner', style: { transform: `translateY(${shift}px)` } },
                lyr.lines.map((line, i) =>
                  h('div', {
                    key: `${line.t}-${i}`,
                    className:
                      'nc-lyr-line' +
                      (i === activeIdx ? ' nc-on' : '') +
                      (CREDIT_RE.test(String(line.text || '').trim()) ? ' nc-credit' : '') +
                      (typeof line.tr === 'string' && line.tr ? ' nc-tr' : '') +
                      (hasTimeline ? '' : ' nc-clickable')
                    ,
                    style: { height: `${rowH(i)}px` },
                    title: hasTimeline ? undefined : t('alignHint'),
                    onClick: hasTimeline ? undefined : () => alignTo(line),
                  },
                    h('span', { className: 'nc-lyr-text' }, line.text || '·'),
                    typeof line.tr === 'string' && line.tr
                      ? h('span', { className: 'nc-lyr-tr' }, line.tr)
                      : null,
                  ),
                ))
            : h('div', { className: 'nc-lyr-empty' },
                lyrState === 'off' ? t('lyricsOff')
                  : lyrState === 'loading' ? '…'
                  : lyrState === 'none' || lyrState === 'error' ? t('noLyrics')
                  : t('noLyrics')),
        ),

        // 进度条（客户端不给时间轴时整行都不画）
        hasTimeline
          ? h('div', { className: 'nc-bar' },
              h('div', { className: 'nc-bar-fill', style: { width: `${progress * 100}%` } }),
            )
          : null,
        hasTimeline
          ? h('div', { className: 'nc-time' },
              h('span', null, clock(posNow)),
              h('span', null, clock(now ? now.end : 0)),
            )
          : h('div', { className: 'nc-time nc-time-min' },
              h('span', null, clock(posNow)),
              h('span', null, '—'),
              h('span', { className: 'nc-time-hint' }, t('noTimeline')),
            ),

        // 控制行
        h('div', { className: 'nc-ctrl' },
          h('button', {
            className: 'nc-iconbtn',
            title: t('prev'),
            disabled: busy !== '' || !now || now.canPrev === false,
            onClick: () => act('prev'),
          }, h(PrevIcon)),
          h('button', {
            className: 'nc-iconbtn nc-main-btn',
            title: playing ? t('pause') : t('play'),
            disabled: busy !== '' || unsupported,
            onClick: () => act('toggle'),
          }, playing ? h(PauseIcon) : h(PlayIcon)),
          h('button', {
            className: 'nc-iconbtn',
            title: t('next'),
            disabled: busy !== '' || !now || now.canNext === false,
            onClick: () => act('next'),
          }, h(NextIcon)),
          err || degraded
            ? h('button', { className: 'nc-iconbtn nc-retry', title: t('retry'), disabled: busy !== '', onClick: retry }, h(RefreshIcon))
            : null,
        ),

        // 音量行
        h('div', { className: 'nc-vol' },
          h('button', {
            className: 'nc-iconbtn',
            title: activeMuted ? t('unmute') : t('mute'),
            disabled: busy !== '' || unsupported,
            onClick: toggleMute,
          }, h(VolIcon, { muted: activeMuted })),
          h('input', {
            className: 'nc-slider',
            type: 'range',
            min: 0,
            max: 1,
            step: 0.01,
            value: shownLevel,
            disabled: unsupported,
            title: t('volume'),
            onChange: (e) => {
              const v = Number(e.target.value)
              setDragLevel(v)
              pushVolume(v)
            },
            onPointerUp: () => setDragLevel(null),
          }),
          h('span', { className: 'nc-pct' }, `${Math.round(shownLevel * 100)}%`),
          h('button', {
            className: 'nc-scope',
            title: scopeNow === 'system' ? t('scopeSystem') : t('scopeProcess'),
            disabled: unsupported,
            onClick: () => patchUi({ scope: scopeNow === 'system' ? 'process' : 'system' }),
          }, scopeNow === 'system' ? 'SYS' : 'APP'),
        ),

        // 底部状态（只在出问题时出现，平时不占高度）
        err || degraded
          ? h('div', { className: 'nc-err' }, err || t('helperDown'))
          : null,
        unsupported ? h('div', { className: 'nc-err' }, t('unsupported')) : null,
      )
    }

    // ── locale：自己做一份 context，省掉对宿主 i18n 钩子的依赖 ───────────────
    const LocaleCtx = React.createContext((key) => key)

    /** 宿主 locale 的初值：浏览器语言优先，中文语境下默认中文。 */
    function guessLang() {
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : null
        const raw = (nav && (nav.language || (nav.languages && nav.languages[0]))) || 'zh'
        return String(raw).toLowerCase().startsWith('en') ? 'en' : 'zh'
      } catch {
        return 'zh'
      }
    }

    /**
     * 手搓的 t()：从宿主 locale 拿当前语言，拿不到就按 navigator.language 猜。
     * 用 context 传下去，组件里一句 useContext 就够，不用处处传 props。
     *
     * 宿主的 locale.getSnapshot() 形状是 { active, locales, revision }，
     * active 才是当前语言的 BCP 47 tag —— 不是 id，也不是 locale。
     */
    function LocaleProvider({ locale, children }) {
      const [lang, setLang] = React.useState(() => guessLang())
      React.useEffect(() => {
        if (!locale) return undefined
        const read = () => {
          try {
            const snap = locale.getSnapshot ? locale.getSnapshot() : null
            const id = (snap && (snap.active || snap.id || snap.locale)) || ''
            if (id) setLang(String(id).toLowerCase().startsWith('en') ? 'en' : 'zh')
          } catch {
            /* 读不到就保持默认 */
          }
        }
        read()
        if (typeof locale.subscribe === 'function') {
          const off = locale.subscribe(read)
          return () => { try { off() } catch { /* ignore */ } }
        }
        return undefined
      }, [locale])

      const dict = LOCALES[lang] || LOCALES.zh
      const t = React.useCallback((key, fallback) => dict[key] ?? fallback ?? key, [dict])
      return h(LocaleCtx.Provider, { value: t }, children)
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    const CSS = `
.nc-root{
  position:fixed;
  z-index:70;
  box-sizing:border-box;
  color:var(--dsw-alias-label-primary,#1f1f1f);
  font:500 12px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  -webkit-user-select:none;user-select:none;

  /* 本插件自己的强调色。
     注意：不要用 --dsw-alias-brand-primary —— 那个 token 是「前景墨色」，
     浅色主题 #0f1115、深色主题 #f9fafb。拿它当按钮底色，深色下就是
     白底 + 白图标，整个主按钮糊成一个白块。
     这里显式给一套按主题切的红，并保证图标色永远与之对比。 */
  --nc-accent:#d9383f;
  --nc-accent-ink:#ffffff;
  --nc-accent-soft:rgba(217,56,63,.16);
  --nc-accent-glow:rgba(217,56,63,.45);
  --nc-surface:rgba(252,253,254,.88);
  --nc-surface-shadow:0 10px 30px -12px rgba(0,0,0,.28),0 2px 8px -4px rgba(0,0,0,.18);
  --nc-thumb-ring:#ffffff;
}
/* 深色主题：红提亮一档，保证在 #151517 上够跳；面层换成深色半透明 */
body[data-ds-dark-theme] .nc-root{
  --nc-accent:#ff5a60;
  --nc-accent-ink:#1a0506;
  --nc-accent-soft:rgba(255,90,96,.20);
  --nc-accent-glow:rgba(255,90,96,.40);
  --nc-surface:#2b2c31b8;
  --nc-surface-shadow:0 12px 34px -14px rgba(0,0,0,.72),0 2px 8px -4px rgba(0,0,0,.5);
  --nc-thumb-ring:#2b2c31;
}
.nc-root *{box-sizing:border-box;}

/* ── 展开态 ── */
.nc-card{
  width:288px;
  padding:10px 10px 8px;
  border-radius:14px;
  background:var(--nc-surface);
  backdrop-filter:blur(14px) saturate(1.4);
  -webkit-backdrop-filter:blur(14px) saturate(1.4);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  box-shadow:var(--nc-surface-shadow);
}

.nc-head{display:flex;align-items:flex-start;gap:6px;cursor:grab;padding:0 2px 6px;}
.nc-head:active{cursor:grabbing;}
.nc-head-main{min-width:0;flex:1;}
.nc-title{
  font-size:13px;font-weight:650;line-height:1.35;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--dsw-alias-label-primary,#1f1f1f);
}
.nc-sub{
  margin-top:1px;font-size:11px;line-height:1.4;
  color:var(--dsw-alias-label-tertiary,#9a9a9a);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}

/* ── 歌词 ── */
.nc-lyr{
  position:relative;overflow:hidden;margin:2px 0 6px;border-radius:9px;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  -webkit-mask-image:linear-gradient(180deg,transparent,#000 26%,#000 74%,transparent);
  mask-image:linear-gradient(180deg,transparent,#000 26%,#000 74%,transparent);
}
.nc-lyr-inner{transition:transform .34s cubic-bezier(.22,.61,.36,1);will-change:transform;}
.nc-lyr-line{
  display:flex;align-items:center;justify-content:center;
  padding:0 8px;font-size:12px;line-height:1.1;
  color:var(--dsw-alias-label-tertiary,#b0b0b0);
  transition:color .25s ease,opacity .25s ease;
  opacity:.72;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.nc-lyr-line.nc-on{
  color:var(--nc-accent);
  font-weight:700;font-size:13px;opacity:1;
  text-shadow:0 0 12px var(--nc-accent-soft);
}
/* 作词/作曲/编曲/制作人这类署名行：照常显示，但更淡，也不参与高亮定位 */
.nc-lyr-line.nc-credit{opacity:.5;font-size:11px;letter-spacing:.02em;}
/* 外语歌：原文 + 网易云自带译文两行。行高由 JS 按行算（22 / 34），这里只管排版 */
.nc-lyr-line.nc-tr{flex-direction:column;gap:1px;}
.nc-lyr-text,.nc-lyr-tr{
  width:100%;max-width:100%;text-align:center;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.nc-lyr-tr{
  font-size:10px;line-height:1.15;font-weight:400;
  opacity:.66;letter-spacing:.01em;
}
.nc-lyr-line.nc-on .nc-lyr-tr{opacity:.9;font-weight:400;font-size:10.5px;text-shadow:none;}
/* native 车道没有时间轴：点某一行就按它校准，所以给个手型 */
.nc-lyr-line.nc-clickable{cursor:pointer;}
.nc-lyr-line.nc-clickable:hover{color:var(--dsw-alias-label-secondary,#6b6b6b);}
.nc-lyr-empty{
  display:flex;align-items:center;justify-content:center;height:100%;
  color:var(--dsw-alias-label-tertiary,#b0b0b0);font-size:11px;
}

/* ── 进度 ── */
.nc-bar{height:3px;border-radius:2px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.1));overflow:hidden;}
.nc-bar-fill{height:100%;border-radius:2px;background:var(--nc-accent);transition:width .2s linear;}
.nc-time{
  display:flex;justify-content:space-between;margin-top:3px;
  font-size:10px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary,#a8a8a8);
}
/* 没有时间轴时：只有一个不停走的本地计时，右端用 — 表示「总长未知」 */
.nc-time-min{margin-top:5px;justify-content:flex-start;gap:6px;opacity:.85;}
.nc-time-hint{margin-left:auto;font-size:9px;opacity:.75;}

/* ── 控制 ── */
.nc-ctrl{display:flex;align-items:center;justify-content:center;gap:10px;margin:4px 0 2px;}
.nc-iconbtn{
  display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;border:0;border-radius:9px;
  background:transparent;color:var(--dsw-alias-label-secondary,#4b4b4b);cursor:pointer;padding:0;
  transition:background .16s ease,color .16s ease,opacity .16s ease,transform .12s ease;
}
.nc-iconbtn:hover:not(:disabled){
  background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));
  color:var(--dsw-alias-label-primary,#1f1f1f);
}
.nc-iconbtn:active:not(:disabled){transform:scale(.94);}
.nc-iconbtn:disabled{opacity:.32;cursor:default;}

/* 主按钮：实心强调色 + 与之对比的图标色。
   两个颜色都来自本插件变量，不引用 brand-primary（那个在深色下是白色）。 */
.nc-main-btn{
  width:36px;height:36px;border-radius:50%;
  background:var(--nc-accent);color:var(--nc-accent-ink);
  box-shadow:0 4px 12px -4px var(--nc-accent-glow);
}
.nc-main-btn:hover:not(:disabled){background:var(--nc-accent);color:var(--nc-accent-ink);filter:brightness(1.08);}
.nc-main-btn:active:not(:disabled){transform:scale(.92);}
.nc-main-btn svg{color:inherit;}
.nc-retry{color:var(--dsw-alias-state-warn-label,#d97706);}

/* ── 音量 ── */
.nc-vol{display:flex;align-items:center;gap:5px;margin-top:2px;padding:0 2px;}
.nc-slider{
  -webkit-appearance:none;appearance:none;flex:1;height:3px;border-radius:2px;
  background:var(--dsw-alias-border-l2,rgba(0,0,0,.16));outline:none;cursor:pointer;
}
.nc-slider::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;width:11px;height:11px;border-radius:50%;
  background:var(--nc-accent);border:2px solid var(--nc-thumb-ring);
  box-shadow:0 1px 3px rgba(0,0,0,.28);cursor:pointer;
}
.nc-slider::-moz-range-thumb{
  width:11px;height:11px;border-radius:50%;border:2px solid var(--nc-thumb-ring);
  background:var(--nc-accent);cursor:pointer;
}
.nc-slider:disabled{opacity:.4;cursor:default;}
.nc-pct{
  width:30px;text-align:right;font-size:10px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary,#a8a8a8);
}
.nc-scope{
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  background:transparent;color:var(--dsw-alias-label-tertiary,#9a9a9a);
  font:600 9px/1 system-ui,sans-serif;letter-spacing:.4px;
  padding:3px 4px;border-radius:5px;cursor:pointer;
}
.nc-scope:hover:not(:disabled){color:var(--dsw-alias-label-secondary,#666);}
.nc-scope:disabled{opacity:.4;cursor:default;}

.nc-err{
  margin-top:5px;padding:3px 6px;border-radius:6px;
  font-size:10px;line-height:1.4;
  color:var(--dsw-alias-state-error-primary,#d33);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 10%,transparent);
  word-break:break-word;
}

/* ── 收起态 ── */
.nc-mini{
  display:flex;align-items:center;gap:4px;
  max-width:210px;height:34px;padding:0 4px 0 8px;
  border-radius:17px;cursor:grab;
  background:var(--nc-surface);
  backdrop-filter:blur(14px) saturate(1.4);
  -webkit-backdrop-filter:blur(14px) saturate(1.4);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  box-shadow:var(--nc-surface-shadow);
}
.nc-mini:active{cursor:grabbing;}
.nc-mini-body{display:flex;align-items:center;gap:5px;min-width:0;flex:1;}
.nc-note{display:inline-flex;color:var(--nc-accent);flex:0 0 auto;}
.nc-mini-text{
  min-width:0;flex:1;font-size:11px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--dsw-alias-label-secondary,#4b4b4b);
}
.nc-mini-btn{width:24px;height:24px;flex:0 0 auto;}
/* 收起态里的播放/暂停也要有实心底色，否则深色下只剩一个浅灰图标 */
.nc-mini-btn{
  width:24px;height:24px;flex:0 0 auto;border-radius:50%;
  background:var(--nc-accent);color:var(--nc-accent-ink);
}
.nc-mini-btn:hover:not(:disabled){background:var(--nc-accent);filter:brightness(1.08);}
.nc-mini-expand{width:22px;height:22px;flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#9a9a9a);}

@media (prefers-reduced-motion: reduce){
  .nc-lyr-inner,.nc-bar-fill,.nc-lyr-line{transition:none;}
}
`

    function installStyle() {
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', 'dsh-cloudmusic-player')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    // ── 插件入口 ────────────────────────────────────────────────────────────
    const inject = ['slots', 'locale']

    function apply(ctx) {
      // 1) 样式：effect 里返回清理函数，插件卸了 <style> 跟着走
      ctx.effect(() => installStyle(), 'dsh-cloudmusic-player: 悬浮框样式')

      // 2) 文案：注册一份本命名空间的字典。宿主自己的 i18n 用得上；
      //    组件内部再走一个自建 context，两套互不干扰（拿不到就用内联那份）。
      try {
        ctx.locale.register(NS, LOCALES)
      } catch {
        /* 没有 locale 服务也不影响显示 */
      }

      // 3) 挂到 shell.overlay
      const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
      if (!slots || typeof slots.inject !== 'function') {
        console.warn('[cloudmusic-player] 没有 slots 服务，悬浮框挂不上')
        return
      }

      const locale = (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) || ctx.locale || null

      slots.inject('shell.overlay', () =>
        slots.register(
          {
            name: 'shell.overlay',
            id: 'cloudmusic-player',
            order: 70,
            locale: NS,
          },
          () => h(LocaleProvider, { locale }, h(MiniPlayer)),
        ),
      )
    }

    return { inject, apply }
  },
})
