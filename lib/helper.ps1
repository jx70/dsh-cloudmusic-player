# ============================================================================
# helper.ps1 — dsh-cloudmusic-player 的常驻后台助手
# ============================================================================
# 由 Host 半端（lib/player.mjs）用 node:child_process.spawn 起一次，
# 之后所有请求都走 stdin/stdout 的 JSONL（一行一条请求、一行一条回复），
# 避免每次操作重新加载 WinRT + 编译 C#（那样单次要 300ms 以上）。
#
# 启动后第一行固定输出：
#   {"type":"ready","winrt":true|false,"pid":<pid>,"ps":"5.1.x","version":"0.1.0"}
# winrt=false 表示本机拿不到系统媒体控制（例如用了 PowerShell 7），
# 此时播放控制不可用，但音量仍然可用 —— 上层据此降级，不报错。
#
# 请求：{"seq":1,"cmd":"state"}
# 回复：{"type":"reply","seq":1,"ok":true,"cmd":"state","now":{...},"volume":{...}}
#
# 命令：ping state refresh play pause toggle next prev seek volume mute procs deep quit
#
# 注意：本文件必须存为 UTF-8 **带 BOM**，否则 PowerShell 5.1 会按 ANSI
#       解码，中文注释可能被截断成非法字节。
# ============================================================================

param(
  [string]$ProcessName = 'cloudmusic',
  [string]$AumidPattern = 'cloudmusic|netease|wangyi',
  # 客户端自己的全局热键。SMTC 拿不到会话时靠它控制播放。
  [string]$HotkeyPlayPause = 'Ctrl+Alt+P',
  [string]$HotkeyNext = 'Ctrl+Alt+Right',
  [string]$HotkeyPrev = 'Ctrl+Alt+Left'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VERSION = '0.1.0'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# ---------------------------------------------------------------------------
# 1. Core Audio（音量）：一次编译，进程内常驻
# ---------------------------------------------------------------------------
# vtable 顺序必须与 Windows SDK 完全一致 —— 少一项或错一项都会直接
# 触发 AccessViolationException（访问冲突直接崩进程，不会给你异常栈）。
$core = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace NcmCore
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow flow, int mask, out IntPtr col);
        int GetDefaultAudioEndpoint(EDataFlow flow, ERole role, out IMMDevice dev);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl
    {
        int GetState(out int s);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(string name, ref Guid g);
        int GetIconPath(out IntPtr path);
        int SetIconPath(string path, ref Guid g);
        int GetGroupingParam(out Guid g);
        int SetGroupingParam(ref Guid g, ref Guid ctx);
        int RegisterAudioSessionNotification(IntPtr n);
        int UnregisterAudioSessionNotification(IntPtr n);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl2
    {
        int GetState(out int s);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(string name, ref Guid g);
        int GetIconPath(out IntPtr path);
        int SetIconPath(string path, ref Guid g);
        int GetGroupingParam(out Guid g);
        int SetGroupingParam(ref Guid g, ref Guid ctx);
        int RegisterAudioSessionNotification(IntPtr n);
        int UnregisterAudioSessionNotification(IntPtr n);
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out int pid);
        int IsSystemSoundsSession();
        int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl session);
    }

    // 前两项必须是 GetAudioSessionControl / GetSimpleAudioVolume，插占位会让
    // GetSessionEnumerator 崩在错误的 vtable 槽上。
    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        int GetAudioSessionControl(ref Guid g, int flags, out IntPtr c);
        int GetSimpleAudioVolume(ref Guid g, int flags, out ISimpleAudioVolume v);
        int GetSessionEnumerator(out IAudioSessionEnumerator e);
        int RegisterSessionNotification(IntPtr n);
        int UnregisterSessionNotification(IntPtr n);
        int RegisterDuckNotification(string id, IntPtr n);
        int UnregisterDuckNotification(IntPtr n);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid g);
        int GetMasterVolume(out float level);
        // 这两个 bool 必须显式按 4 字节 BOOL 封送：COM 默认是 VARIANT_BOOL（2 字节），
        // 槽位错位后 ref Guid 会被当成垃圾指针读，真正的 SetMute 失败还被 catch 吞掉。
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid g);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // 13 项顺序固定；把 GetMasterVolumeLevel 提前会返回
    // "Value does not fall within the expected range."
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr p);
        int UnregisterControlChangeNotify(IntPtr p);
        int GetChannelCount(out int n);
        int SetMasterVolumeLevel(float f, ref Guid g);
        int SetMasterVolumeLevelScalar(float f, ref Guid g);
        int GetMasterVolumeLevel(out float f);
        int GetMasterVolumeLevelScalar(out float f);
        int SetChannelVolumeLevel(int ch, float f, ref Guid g);
        int SetChannelVolumeLevelScalar(int ch, float f, ref Guid g);
        int GetChannelVolumeLevel(int ch, out float f);
        int GetChannelVolumeLevelScalar(int ch, out float f);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool b, ref Guid g);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool b);
    }

    // 峰值表：暂停但会话仍 Active 时 GetState 不变，只有峰值会归零，
    // 所以「是否在出声」只能靠 GetPeakValue。
    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioMeterInformation
    {
        int GetPeakValue(out float peak);
        int GetMeteringChannelCount(out int n);
        int GetChannelsPeakValues(int n, [Out] float[] peaks);
        int QueryHardwareSupport(out int mask);
    }

    public static class Api
    {
        // 缓存 COM 对象：state 每 2 秒被调一次，反复 Activate 会平白多出几十毫秒。
        // 设备被切换（插拔耳机）后调用 Reset() 让它们重建。
        static IAudioSessionManager2 _sm;
        static IAudioEndpointVolume _ep;

        public static void Reset()
        {
            _sm = null;
            _ep = null;
        }

        static IAudioSessionManager2 Manager()
        {
            if (_sm != null) return _sm;
            var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            en.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out dev);
            Guid iid = typeof(IAudioSessionManager2).GUID;
            object o;
            dev.Activate(ref iid, 23, IntPtr.Zero, out o);
            _sm = (IAudioSessionManager2)o;
            return _sm;
        }

        static IAudioEndpointVolume Endpoint()
        {
            if (_ep != null) return _ep;
            var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            en.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out dev);
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object o;
            dev.Activate(ref iid, 23, IntPtr.Zero, out o);
            _ep = (IAudioEndpointVolume)o;
            return _ep;
        }

        public static string NameOf(int pid)
        {
            if (pid == 0) return "system";
            try { return Process.GetProcessById(pid).ProcessName; } catch { return ""; }
        }

        public static int[] Pids(string processName)
        {
            List<int> pids = new List<int>();
            try
            {
                foreach (Process p in Process.GetProcessesByName(processName)) pids.Add(p.Id);
            }
            catch { }
            pids.Sort();
            return pids.ToArray();
        }

        // 关键：IAudioSessionManager2::GetSimpleAudioVolume 的第二个参数是
        // 音频会话 ID（DWORD dwSessionId），不是进程 ID。传 pid 只会拿到默认
        // 会话（实测会让所有行读出同一个值，并且改到 helper 自己的会话）。
        // 正确做法是枚举会话，把每个 IAudioSessionControl 用 QueryInterface
        // 转成 ISimpleAudioVolume —— 同一个 COM 对象本来就实现了该接口。
        static ISimpleAudioVolume FindVolume(int pid)
        {
            IAudioSessionControl c = FindControl(pid);
            if (c == null) return null;
            return c as ISimpleAudioVolume;
        }

        // 找到某个进程的音频会话控制对象（一个进程可能有多条会话，取第一条）
        static IAudioSessionControl FindControl(int pid)
        {
            IAudioSessionEnumerator e;
            if (Manager().GetSessionEnumerator(out e) != 0 || e == null) return null;
            int n;
            if (e.GetCount(out n) != 0) return null;
            for (int i = 0; i < n; i++)
            {
                IAudioSessionControl c;
                if (e.GetSession(i, out c) != 0 || c == null) continue;
                var c2 = c as IAudioSessionControl2;
                if (c2 == null) continue;
                int p;
                if (c2.GetProcessId(out p) != 0) continue;
                if (p == pid) return c;
            }
            return null;
        }

        // 该进程此刻的音频峰值（0..1）。暂停后会在 1~2 秒内归零，
        // 是判断「到底在不在放」唯一可靠的信号（GetState 一直是 Active）。
        public static float Peak(int pid)
        {
            try
            {
                IAudioSessionControl c = FindControl(pid);
                if (c == null) return -1f;
                var m = c as IAudioMeterInformation;
                if (m == null) return -1f;
                float peak;
                if (m.GetPeakValue(out peak) != 0) return -1f;
                return peak;
            }
            catch { Reset(); return -1f; }
        }

        // 进程里有没有至少一条音频会话（客户端开着但没放歌也算有）
        public static bool HasSession(int pid)
        {
            try { return FindControl(pid) != null; }
            catch { Reset(); return false; }
        }

        // 每条 "<pid>|<name>|<level>|<muted>"，name 拿不到时为空串
        public static string[] Sessions()
        {
            List<string> rows = new List<string>();
            IAudioSessionEnumerator e;
            if (Manager().GetSessionEnumerator(out e) != 0 || e == null) return rows.ToArray();
            int n;
            if (e.GetCount(out n) != 0) return rows.ToArray();
            for (int i = 0; i < n; i++)
            {
                IAudioSessionControl c;
                if (e.GetSession(i, out c) != 0 || c == null) continue;
                var c2 = c as IAudioSessionControl2;
                if (c2 == null) continue;
                int pid;
                if (c2.GetProcessId(out pid) != 0) continue;
                float level;
                bool muted;
                var v = c as ISimpleAudioVolume;
                string volText = "";
                if (v != null && v.GetMasterVolume(out level) == 0 && v.GetMute(out muted) == 0)
                {
                    volText = level.ToString("R", CultureInfo.InvariantCulture) + "|" + (muted ? "1" : "0");
                }
                rows.Add(pid + "|" + NameOf(pid) + "|" + volText);
            }
            return rows.ToArray();
        }

        public static float GetProcVol(int pid, out bool found, out bool muted)
        {
            found = false;
            muted = false;
            try
            {
                var v = FindVolume(pid);
                if (v == null) return -1f;
                float level;
                if (v.GetMasterVolume(out level) != 0) return -1f;
                bool m;
                v.GetMute(out m);
                found = true;
                muted = m;
                return level;
            }
            catch { Reset(); return -1f; }
        }

        public static bool SetProcVol(int pid, float level)
        {
            try
            {
                var v = FindVolume(pid);
                if (v == null) return false;
                Guid g = Guid.Empty;
                return v.SetMasterVolume(level, ref g) == 0;
            }
            catch { Reset(); return false; }
        }

        public static bool SetProcMute(int pid, bool mute)
        {
            try
            {
                var v = FindVolume(pid);
                if (v == null) return false;
                Guid g = Guid.Empty;
                return v.SetMute(mute, ref g) == 0;
            }
            catch { Reset(); return false; }
        }

        public static float GetSysVol(out bool muted)
        {
            muted = false;
            try
            {
                IAudioEndpointVolume e = Endpoint();
                float v;
                if (e.GetMasterVolumeLevelScalar(out v) != 0) return -1f;
                bool m;
                e.GetMute(out m);
                muted = m;
                return v;
            }
            catch { Reset(); return -1f; }
        }

        public static bool SetSysVol(float level)
        {
            try
            {
                IAudioEndpointVolume e = Endpoint();
                Guid g = Guid.Empty;
                return e.SetMasterVolumeLevelScalar(level, ref g) == 0;
            }
            catch { Reset(); return false; }
        }

        public static bool SetSysMute(bool mute)
        {
            try
            {
                IAudioEndpointVolume e = Endpoint();
                Guid g = Guid.Empty;
                return e.SetMute(mute, ref g) == 0;
            }
            catch { Reset(); return false; }
        }
    }
}
'@

$coreOk = $false
$coreError = ''
try {
  Add-Type -TypeDefinition $core -Language CSharp | Out-Null
  $coreOk = $true
} catch {
  # 类型已在当前 PowerShell 会话里注册过时也会走到这里，视为可用
  if ([bool]([type]::GetType('NcmCore.Api'))) { $coreOk = $true } else { $coreError = $_.Exception.Message }
}

# ---------------------------------------------------------------------------
# 1b. Win32 辅助（窗口标题 + 热键注入）
# ---------------------------------------------------------------------------
# 网易云的 Cef 外壳没有可用的 UI Automation 节点，但主窗口标题就是
# 「歌名 - 歌手」，这是唯一能稳定拿到的元数据来源。
$shell = @'
using System;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;

namespace NcmWin
{
    public static class Win
    {
        delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool EnumWindows(EnumProc cb, IntPtr p);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetWindowTextLengthW(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int cmd);

        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

        [DllImport("user32.dll")]
        static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr ShellExecuteW(IntPtr hwnd, string op, string file, string param, string dir, int show);

        [DllImport("user32.dll")]
        static extern bool IsZoomed(IntPtr hWnd);

        // SetWindowPos 关键：能跨进程，而且会顺带把 rcNormalPosition 一起改掉。
        // 这正好是要的效果 —— 客户端 restore 时用的就是那份记录。
        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, ref RECT r);

        // 客户端那次 show 除了抢焦点，还会把窗口提到最前 —— 位置一点没变，
        // 但它盖住了用户的浏览器/编辑器，这就是「弹窗」的实际观感。
        // 要压住它就得会读 z 序：从桌面最顶层往下走，看谁在前面。
        [DllImport("user32.dll")]
        static extern IntPtr GetTopWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

        const uint GW_HWNDNEXT = 2;
        const uint GW_HWNDPREV = 3;

        const uint SWP_NOSIZE = 0x0001;
        const uint SWP_NOMOVE = 0x0002;
        const uint SWP_NOZORDER = 0x0004;
        const uint SWP_NOACTIVATE = 0x0010;
        const uint SWP_FRAMECHANGED = 0x0020;

        // SetWindowPos 的 hWndInsertAfter 有两个特殊值：NULL 等于 HWND_TOP（0），
        // 也就是「放到最顶上」。想把窗口压到最底要用 HWND_BOTTOM（1）。
        // 这里必须显式写出来：早先用 GetWindow(hwnd, GW_HWNDNEXT) 的结果直接当
        // hWndInsertAfter 传，那个函数在「窗口已经在最底层」时返回 NULL，于是
        // 「纠正 z 序」这一步反而把它顶到了最前 —— 正是要修的那个毛病。
        const int HWND_BOTTOM = 1;

        /// <summary>a 是不是排在 b 前面（更靠近用户）。任一无效都算否。</summary>
        static bool IsAbove(IntPtr a, IntPtr b)
        {
            if (a == IntPtr.Zero || b == IntPtr.Zero) return false;
            IntPtr h = GetTopWindow(IntPtr.Zero);
            int guard = 0;
            while (h != IntPtr.Zero && guard++ < 8000)
            {
                if (h == a) return true;
                if (h == b) return false;
                h = GetWindow(h, GW_HWNDNEXT);
            }
            return false;
        }

        // ── 这次窗口变可见，是客户端弄的还是人手弄的 ────────────────────────
        //
        // 客户端收到 orpheus:// 之后会连着好几拨自己 show 窗口（实测投递后
        // 1.3s / 4.1s / 7.1s 各一拨），守卫的职责就是把这几拨按回去。但用户
        // 想打开播放器时窗口状态和那些 show 长得一模一样（都是 vis && !ico），
        // 只按状态判会把人也一起按回去——「跳转进度后一点客户端就又被最小化」
        // 就是这么来的。
        //
        // 区别只能从输入侧看：那些 show 发生时用户早就松手了，而用户点任务栏
        // 或托盘的那一刻键盘鼠标刚动过。GetLastInputInfo 给的就是这个时间。
        [StructLayout(LayoutKind.Sequential)]
        struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }

        [DllImport("user32.dll")]
        static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

        [DllImport("user32.dll")]
        static extern bool GetCursorPos(ref POINT p);

        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vKey);

        /// <summary>距上一次用户键鼠输入过去了多少毫秒（读不到返回 -1）。</summary>
        static int IdleMs()
        {
            LASTINPUTINFO li = new LASTINPUTINFO();
            li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!GetLastInputInfo(ref li)) return -1;
            // dwTime 是 32 位 tick，TickCount 是有符号 int，回绕后靠掩码掰正
            return unchecked(Environment.TickCount - (int)li.dwTime) & 0x7FFFFFFF;
        }

        /// <summary>
        /// 光标此刻是不是停在外壳上（任务栏 / 托盘 / 桌面）。
        ///
        /// 用户要打开播放器只有两条路：点任务栏按钮，或者点托盘图标 —— 两者
        /// 那一刻光标一定落在外壳窗口上。客户端自己 show 的时候，光标还停在
        /// 用户原来干活的地方（多半是浏览器里），不可能在外壳上。
        /// 这比「前台是不是 shell」更可靠：点任务栏按钮时前台可能被 explorer
        /// 直接切给播放器，中间那一帧 shell 前台不一定采得到。
        /// </summary>
        /// <summary>
        /// 光标坐标是否落在任务栏矩形内（用 Shell_TrayWnd / Shell_SecondaryTrayWnd
        /// 的 GetWindowRect 做几何判定，而不是 WindowFromPoint 命中谁）。
        ///
        /// 实测（.tmp_clickprobe.ps1）：本机任务栏上盖着微信的 Qt51514QWindowIcon
        /// 窗口，WindowFromPoint 在任务栏坐标上命中的是它（进程 Weixin，不是
        /// explorer），IsShellWindow 判 false —— 于是「用户点任务栏」永远测不到。
        /// 直接按任务栏自己的矩形判坐标最稳，不依赖上面盖了什么。
        /// </summary>
        static bool CursorInTrayRect(POINT p)
        {
            foreach (string cls in new string[] { "Shell_TrayWnd", "Shell_SecondaryTrayWnd" })
            {
                IntPtr tray = FindWindowW(cls, null);
                if (tray == IntPtr.Zero) continue;
                RECT r = new RECT();
                if (!GetWindowRect(tray, ref r)) continue;
                if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) continue;
                if (p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom) return true;
            }
            return false;
        }

        static bool CursorOnShell()
        {
            POINT p = new POINT();
            if (!GetCursorPos(ref p)) return false;
            IntPtr hit = WindowFromPoint(p);
            if (hit != IntPtr.Zero)
            {
                IntPtr top = GetAncestor(hit, GA_ROOT);
                if (IsShellWindow(top == IntPtr.Zero ? hit : top)) return true;
            }
            // WindowFromPoint 没命中 shell（可能是微信的 Qt 任务栏缩略图盖在上面），
            // 退回几何判定：光标确实落在任务栏矩形内也算。
            return CursorInTrayRect(p);
        }

        /// <summary>
        /// 用户此刻正按着左键、而且按在外壳上 —— 这就是「点任务栏按钮」那一刻。
        ///
        /// 光看「光标在外壳上」不够：用户可能只是把鼠标停在任务栏上没动，
        /// 那时客户端自己 show 也会满足条件，会被误判成人在开窗口。加上「左键
        /// 按着」就只会在真正点下去的那几十毫秒里成立。
        /// </summary>
        static bool ClickOnShell()
        {
            if (!CursorOnShell()) return false;
            return (GetAsyncKeyState(0x01) & 0x8000) != 0;   // VK_LBUTTON
        }

        /// <summary>
        /// 这个窗口是不是 Windows 自己的外壳（任务栏 / 桌面 / 托盘溢出窗 /
        /// Alt-Tab 与任务视图那层壳）。
        ///
        /// 用来判断「用户是不是刚点了任务栏」：客户端只会把自己提到前台，
        /// 造不出 shell 前台，所以看到它就是人在操作。
        /// </summary>
        static bool IsShellWindow(IntPtr h)
        {
            if (h == IntPtr.Zero) return true;
            StringBuilder sb = new StringBuilder(256);
            if (GetClassNameW(h, sb, sb.Capacity) <= 0) return false;
            string c = sb.ToString();
            if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd"
                || c == "Progman" || c == "WorkerW"
                || c == "NotifyIconOverflowWindow"
                || c == "TopLevelWindowForOverflowXamlIsland"
                // 任务视图 / Win+Tab 那一层壳
                || c == "MultitaskingViewFrame"
                || c == "XamlExplorerHostIslandWindow")
            {
                return true;
            }
            // 类名没命中时再看进程：explorer.exe 的窗口一律算 shell。
            // 任务栏的某些形态（尤其是 Win11 的 XAML 岛）类名会变，但进程不变。
            // 注意不要按类名认 Windows.UI.Core.CoreWindow —— 很多 UWP 应用都有，
            // 客户端自己切前台时也可能短暂出现，会把「用户点任务栏」判成常态。
            try
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid == 0) return false;
                System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById((int)pid);
                string name = p.ProcessName;
                return string.Equals(name, "explorer", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "StartMenuExperienceHost", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "ShellExperienceHost", StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        // ── 让窗口在像素层面消失 ────────────────────────────────────────────
        //
        // 可见态下客户端那次 show 不改位置，只把它提到最前。压 z 序最快也要等到
        // 下一次采样（3ms，但合成周期 16ms）——实测能留下 1 帧闪动，就是用户说的
        // 「弹窗」。把窗口的可见区域设成空 region 就没有这一帧：z 序怎么跳都没有
        // 像素可画。实测可见态设置后客户端不会重置它（只有最小化态 restore 时才会
        // 被清成 COMPLEXREGION），守卫里再兜底复查一次。
        [DllImport("gdi32.dll")]
        static extern IntPtr CreateRectRgn(int l, int t, int r, int b);

        [DllImport("user32.dll")]
        static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

        [DllImport("user32.dll")]
        static extern int GetWindowRgn(IntPtr hWnd, IntPtr hRgn);

        [DllImport("gdi32.dll")]
        static extern bool DeleteObject(IntPtr h);

        const int NULLREGION = 1;

        /// <summary>
        /// 把窗口可见区域清空：仍然「显示」着（不进任务栏变化、不影响坐标），
        /// 但一个像素都不画。SetWindowRgn 成功后 region 归系统所有，这里不释放。
        /// </summary>
        static bool Blind(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            IntPtr rgn = IntPtr.Zero;
            try
            {
                rgn = CreateRectRgn(0, 0, 0, 0);
                if (rgn == IntPtr.Zero) return false;
                if (SetWindowRgn(hwnd, rgn, true) == 0)
                {
                    try { DeleteObject(rgn); } catch { }
                    return false;
                }
                return true;
            }
            catch { return false; }
        }

        static bool IsBlind(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            IntPtr tmp = IntPtr.Zero;
            try
            {
                tmp = CreateRectRgn(0, 0, 1, 1);
                if (tmp == IntPtr.Zero) return false;
                return GetWindowRgn(hwnd, tmp) == NULLREGION;
            }
            catch { return false; }
            finally { if (tmp != IntPtr.Zero) { try { DeleteObject(tmp); } catch { } } }
        }

        // ---- 整窗透明（WS_EX_LAYERED + alpha=0）--------------------------------
        //
        // 为什么除了 region 还要这一层：region 是「窗口的形状」，客户端在 restore 时会
        // 把它重置成 COMPLEXREGION（实测 region kind 1 → 3），中间那条缝足够合成一帧；
        // 而且 region 只挡住主窗口的像素，跟着一起冒出来的 OrpheusShadow 边框残影挡不住。
        // layered + alpha=0 是在 DWM 合成之前就把整窗抹掉，客户端自己 show/restore 也不会
        // 重置它（实测 exstyle 保持 0x000C0110、alpha 保持 0），所以这一层才能真正消灭那一下闪。
        //
        // 只在「最小化 / 托盘隐藏」态启用：正常可见态整窗抹掉几秒比闪一下更糟。

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
        static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
        static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll")]
        static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint crKey, byte bAlpha, uint dwFlags);

        [DllImport("user32.dll")]
        static extern bool GetLayeredWindowAttributes(IntPtr hWnd, out uint crKey, out byte bAlpha, out uint dwFlags);

        const int GWL_EXSTYLE = -20;
        const int WS_EX_LAYERED = 0x00080000;
        const uint LWA_ALPHA = 0x00000002u;
        const uint GHOST_SWP = SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED;

        static bool Ghost(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            try
            {
                if (!IsWindow(hwnd)) return false;
                long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
                if ((ex & WS_EX_LAYERED) == 0)
                {
                    SetWindowLongPtr(hwnd, GWL_EXSTYLE, (IntPtr)(ex | WS_EX_LAYERED));
                }
                if (!SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA))
                {
                    // 设不上就退回原状，别留个半透明的窗口在屏幕上
                    if ((ex & WS_EX_LAYERED) == 0) { SetWindowLongPtr(hwnd, GWL_EXSTYLE, (IntPtr)ex); }
                    return false;
                }
                SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, GHOST_SWP);
                return true;
            }
            catch { return false; }
        }

        static bool IsGhost(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return false;
            try
            {
                if (!IsWindow(hwnd)) return false;
                long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
                if ((ex & WS_EX_LAYERED) == 0) return false;
                uint key; byte alpha; uint flags;
                if (!GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags)) return false;
                return alpha == 0;
            }
            catch { return false; }
        }

        static void Unghost(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            try
            {
                if (!IsWindow(hwnd)) return;
                long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
                if ((ex & WS_EX_LAYERED) == 0) return;
                SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
                SetWindowLongPtr(hwnd, GWL_EXSTYLE, (IntPtr)(ex & ~(long)WS_EX_LAYERED));
                SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, GHOST_SWP);
            }
            catch { }
        }

        /// <summary>枚举某进程的顶层窗口；cls 为空表示不过滤类名。</summary>
        static IntPtr[] ProcessWindows(uint pid, string cls)
        {
            System.Collections.Generic.List<IntPtr> list = new System.Collections.Generic.List<IntPtr>();
            if (pid == 0) return list.ToArray();
            try
            {
                EnumWindows(delegate(IntPtr h, IntPtr p)
                {
                    uint id;
                    GetWindowThreadProcessId(h, out id);
                    if (id != pid) return true;
                    if (!string.IsNullOrEmpty(cls))
                    {
                        System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
                        GetClassNameW(h, sb, sb.Capacity);
                        if (sb.ToString() != cls) return true;
                    }
                    list.Add(h);
                    return true;
                }, IntPtr.Zero);
            }
            catch { }
            return list.ToArray();
        }

        /// <summary>主窗口 + 所有 OrpheusShadow 一起抹掉。返回成功的窗口数。</summary>
        static int GhostAll(IntPtr main, uint pid)
        {
            int n = 0;
            if (Ghost(main)) { n++; }
            foreach (IntPtr sh in ProcessWindows(pid, "OrpheusShadow"))
            {
                if (Ghost(sh)) { n++; }
            }
            return n;
        }

        static void UnghostAll(IntPtr main, uint pid)
        {
            try { Unghost(main); } catch { }
            foreach (IntPtr sh in ProcessWindows(pid, "OrpheusShadow"))
            {
                try { Unghost(sh); } catch { }
            }
        }

        /// <summary>
        /// 放开整窗透明。只在 needGhostDrop 为真时才做，且只清理本代守卫占用的 owner。
        /// 抽成方法是因为放开透明被推迟到「几何落定 + 内容重合成」之后（见 FinishUserTook），
        /// 观察循环里有多个出口（窗口消失 / 超时 / 正常结束），每个出口都要记得放开，
        /// 否则窗口会停在 alpha=0 的透明态。
        /// </summary>
        static void DropGhost(IntPtr hw, uint pid, int gen, bool needGhostDrop)
        {
            if (!needGhostDrop) return;
            try { UnghostAll(hw, pid); } catch { }
            if (_ghostOwner == gen) { _ghostOwner = 0; }
        }

        // ---- 屏蔽 OrpheusShadow 边框窗 ----------------------------------------
        //
        // 白边的真身不是 CEF，是客户端那四个 OrpheusShadow 边框窗：它们是
        // WS_POPUP + WS_EX_TRANSPARENT 的自绘窗口，永远画纯白，正常运行时就叠在
        // 主窗口矩形外面（窗口往内缩 32px 那一圈），所以平时看不见。
        //
        // 一旦客户端从最小化 restore，这几个边框窗会先按「真实窗口矩形」重排到窗口
        // 内侧上方，而 CEF 内容还没合成 —— 于是顶部露出 61~62 行纯白，正是用户在
        // 「跳转完进度后」看到的白边。实测（class ZB/ZC/ZE/ZI 的对照实验）：
        //   · 把它 SetWindowPos(HWND_BOTTOM)   → 当场归零，但下一次 restore 又回到最前
        //   · 按主窗口矩形做 RGN_DIFF 裁剪      → 61 → 13，剩下 13 行还是白
        //   · 把它的 visible region 清空        → 归零，且此后连续的 minimize/restore、
        //                                        改尺寸、再 restore 全部保持 0
        // 所以这里给它们设空 region：窗口照旧存在、坐标照旧、客户端也不会重置
        // （实测 4 个 shadow 的 region kind 一直稳定在 1 = NULLREGION），
        // 只是不再绘制。视觉上丢掉的是窗口外沿那一圈 32px 阴影 —— 用户拖进度时
        // 根本注意不到，比顶部一条白带好得多。

        /// <summary>把该进程所有 OrpheusShadow 的绘制区域清空（不再画白边）。</summary>
        static int MuteShadows(uint pid)
        {
            int n = 0;
            try
            {
                foreach (IntPtr sh in ProcessWindows(pid, "OrpheusShadow"))
                {
                    RECT r = new RECT();
                    if (!GetWindowRect(sh, ref r)) continue;
                    if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) continue;
                    if (Blind(sh)) { n++; }
                }
            }
            catch { }
            return n;
        }

        /// <summary>恢复 OrpheusShadow 的绘制区域（窗口边框阴影回来）。</summary>
        /// <remarks>
        /// 不在任何流程里自动调用：实测恢复 region 之后白带立刻回来（band 0 → 60），
        /// 所以一旦弄哑就让它一直哑着。留着这个方法是给排查/手工恢复用的。
        /// </remarks>
        static void UnmuteShadows(uint pid)
        {
            try
            {
                foreach (IntPtr sh in ProcessWindows(pid, "OrpheusShadow"))
                {
                    try { if (IsWindow(sh)) { SetWindowRgn(sh, IntPtr.Zero, true); } } catch { }
                }
            }
            catch { }
        }

        [DllImport("user32.dll")]
        static extern IntPtr WindowFromPoint(POINT p);

        [DllImport("user32.dll")]
        static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

        const uint GA_ROOT = 2;

        /// <summary>
        /// 窗口虽然正常显示，但整个矩形都被别的窗口压住了 —— 用户根本看不见它。
        /// 这种状态下给窗口上 ghost 是零感知的：它本来就没画在屏幕上，
        /// 而客户端那几拨 show/raise 落在一个 alpha=0 的窗口上，一个像素都不会漏。
        /// 做法是 3x3 网格取样：九个点做 WindowFromPoint + GetAncestor(GA_ROOT)，
        /// 只要有一个点打到自己就说明露着，返回 false。
        /// </summary>
        static bool IsCovered(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return true;
            try
            {
                if (!IsWindow(hwnd)) return true;
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
                RECT r = new RECT();
                if (!GetWindowRect(hwnd, ref r)) return true;
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w < 40 || h < 40) return true;   // 小到没法判断，按「看不见」处理
                for (int gy = 0; gy < 3; gy++)
                {
                    for (int gx = 0; gx < 3; gx++)
                    {
                        POINT p = new POINT();
                        p.X = r.Left + w * (2 * gx + 1) / 6;
                        p.Y = r.Top + h * (2 * gy + 1) / 6;
                        IntPtr hit = WindowFromPoint(p);
                        IntPtr top = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, GA_ROOT);
                        if (top == hwnd) return false;
                    }
                }
                return true;
            }
            catch { return false; }
        }

        /// <summary>恢复窗口的完整可见区域。</summary>
        static void Unblind(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            try { if (IsWindow(hwnd)) { SetWindowRgn(hwnd, IntPtr.Zero, true); } } catch { }
        }

        // ── 强制重绘 ────────────────────────────────────────────────────────
        //
        // 客户端从最小化还原时，CEF 的 renderer 表面与 D3D 交换链不会立刻重画，
        // 窗口顶层露出的是 Win32 背景刷 —— 纯白。实测还原后顶部整行 1175 px 全是
        // (255,255,255)，厚 60 px 以上，而且不会自己消失（2 秒内一动不动）。
        // 用户看到的就是「跳转完进度后客户端出现白边」。
        //
        // 对照实测（同一窗口、同样先最小化再还原）：
        //   什么都不做            → 白边全程在（采样 62,62,62,... 不归零）
        //   RDW_ERASE 一起带上    → 归零，但擦背景本身也是刷白，容易把白边固化
        //   只 INVALIDATE|ALLCHILDREN|UPDATENOW → 360ms 归零，且不碰背景刷
        //   SetWindowPos 高度抖 1px → 540ms 归零，副作用是重排布局
        // 所以这里只用 invalidate 那一路：让窗口把自己的内容重画一遍，
        // 不去擦背景（擦背景等于自己再刷一层白）。
        [DllImport("user32.dll")]
        static extern bool RedrawWindow(IntPtr hWnd, IntPtr lprcUpdate, IntPtr hrgnUpdate, uint flags);

        const uint RDW_INVALIDATE = 0x0001;
        const uint RDW_ALLCHILDREN = 0x0080;
        const uint RDW_UPDATENOW = 0x0100;

        /// <summary>让窗口连同子窗口立刻重画一遍，消掉还原时露出的白色底。</summary>
        static void Repaint(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            try
            {
                if (!IsWindow(hwnd)) return;
                RedrawWindow(hwnd, IntPtr.Zero, IntPtr.Zero,
                             RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
            }
            catch { }
        }

        /// <summary>
        /// 把窗口宽度抖一下（-1 再 +1），逼 CEF 重新合成整个表面。
        ///
        /// RedrawWindow 只给宿主窗口发 WM_PAINT，但网易云的渲染走 D3D 交换链，
        /// 它不在 WM_PAINT 里重画 —— 所以 invalidate 清不掉还原时的白底。
        /// 实测改一次尺寸就能在 ~100ms 内把白边清干净（对照 invalidate 的 360ms
        /// 还未必可靠）。SWP_NOMOVE 让 x/y 保持不动，只有宽度变 1px，用户看不到。
        /// </summary>
        static void NudgeResize(IntPtr hwnd, int w, int h)
        {
            if (hwnd == IntPtr.Zero) return;
            try
            {
                if (!IsWindow(hwnd)) return;
                SetWindowPos(hwnd, IntPtr.Zero, 0, 0, w - 1, h,
                             SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
                SetWindowPos(hwnd, IntPtr.Zero, 0, 0, w, h,
                             SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
            catch { }
        }

        /// <summary>
        /// 改写窗口「正常位置」记录（WINDOWPLACEMENT.rcNormalPosition）。
        /// 最小化的窗口只有这一个入口能改几何 —— SetWindowPos 一律无效。
        /// </summary>
        static bool SetNormalRect(IntPtr hwnd, int x, int y, int w, int h)
        {
            if (hwnd == IntPtr.Zero) return false;
            WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
            wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
            if (!GetWindowPlacement(hwnd, ref wp)) return false;
            // 只改 rcNormalPosition，showCmd 一律原样保留。
            //
            // 这条路是实测出来的：三种状态（正常 / 最小化 / 隐藏）下都能真正落地，
            // 而且不改变窗口的可见性与最小化状态（全程 vis/ico 不变），所以 park
            // 和还原都不会让窗口闪一下。
            //
            // 走过的弯路（别再回头）：
            //   · showCmd 传 2（SW_SHOWMINIMIZED）时系统会**静默丢弃** rcNormalPosition
            //     的修改 —— SetWindowPlacement 返回 True，读回来还是旧值。当初就是
            //     踩了这个坑：park 写 (0,0,1,1) 生效了、收尾想写回真实矩形没生效，
            //     于是窗口的「正常位置」被永久留在 1×1，用户还原客户端只剩一个像素。
            //   · 补救方案试过「showCmd 改成 4 → SetWindowPos → ShowWindow(6)」三步，
            //     虽然能写进去，但每调一次就把窗口亮出来一帧；park 本身不该产生任何
            //     可见动作，所以弃用。
            //
            // 唯一的例外是隐藏态：隐藏窗口的 showCmd 往往是 1（SW_SHOWNORMAL），
            // 原样回写等于自己把它唤出来，必须显式写 0（SW_HIDE）。
            if (!IsWindowVisible(hwnd)) { wp.showCmd = 0; }
            wp.rcNormalPosition.Left = x;
            wp.rcNormalPosition.Top = y;
            wp.rcNormalPosition.Right = x + w;
            wp.rcNormalPosition.Bottom = y + h;
            return SetWindowPlacement(hwnd, ref wp);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        struct WINDOWPLACEMENT
        {
            public int length;
            public int flags;
            public int showCmd;
            public POINT ptMinPosition;
            public POINT ptMaxPosition;
            public RECT rcNormalPosition;
        }

        [DllImport("user32.dll")]
        static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);

        [DllImport("user32.dll")]
        static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);

        /// <summary>
        /// 窗口「正常」时的矩形（还原后落在哪、多大）。
        ///
        /// 为什么不能直接用 GetWindowRect：最小化的窗口它返回的是 -25600 那个
        /// 占位坐标，尺寸也只有 159×153（不是真实窗口大小）。拿这个去 park，
        /// 改出来的 rcNormalPosition 就是个 159×153 的小框，客户端还原时
        /// 会当成无效几何丢掉，退回它自己记的位置 —— 于是照旧弹在屏幕中间。
        /// </summary>
        static bool NormalRect(IntPtr hwnd, out RECT r)
        {
            r = new RECT();
            if (hwnd == IntPtr.Zero) return false;
            WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
            wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
            if (!GetWindowPlacement(hwnd, ref wp)) return false;
            RECT n = wp.rcNormalPosition;
            if (n.Right - n.Left <= 0 || n.Bottom - n.Top <= 0) return false;
            // 还是同一个陷阱的另一面：最小化的窗口 rcNormalPosition 也可能是系统
            // 占位值 (-25600,-25600)-(-25441,-25573)（159×153）。这个值尺寸不为零，
            // 只按尺寸判会当它是「真的正常位置」，于是下次 park/还原都拿它当目标 ——
            // 一传十十传百，窗口就永远回不到原位了。屏外坐标一律当无效。
            if (n.Left <= -20000 || n.Top <= -20000) return false;
            r = n;
            return true;
        }

        // 记住一份「好用的」正常矩形。
        //
        // 为什么需要记：窗口的 rcNormalPosition 有可能被外部写坏（历史版本里
        // 会把窗口 park 到 (0,0,1,1)，只要还原那一次没跑完就会永久停在一个点上），
        // 那时 NormalRect 读到的就是 1×1。拿它当还原目标，窗口就被永久缩成一个
        // 像素点。所以每次读到像样的矩形就记下来，读到退化的就退回上次那份。
        static int _goodX, _goodY, _goodW, _goodH;

        static void RememberRect(RECT r)
        {
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w > 8 && h > 8) { _goodX = r.Left; _goodY = r.Top; _goodW = w; _goodH = h; }
        }

        static bool GoodRect(out RECT r)
        {
            r = new RECT();
            if (_goodW <= 8 || _goodH <= 8) return false;
            r.Left = _goodX;
            r.Top = _goodY;
            r.Right = _goodX + _goodW;
            r.Bottom = _goodY + _goodH;
            return true;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct SRECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")]
        static extern bool SystemParametersInfo(uint act, uint p1, ref SRECT r, uint p3);

        const uint SPI_GETWORKAREA = 0x0030;

        /// <summary>
        /// 几何自愈：窗口的 rcNormalPosition 退化成 1×1 或跑到屏幕外时把它修回来。
        ///
        /// 为什么必须有这道保险：窗口的 rcNormalPosition 有可能被写坏（历史版本里
        /// 会把窗口 park 到 1×1，只要还原那一次没跑完就永久停在那个点上；用户手动
        /// 改过窗口位置也可能留下异常值）。用户下次点开播放器只剩一个像素、所有
        /// 按钮都点不到 —— 表现就是「插件好多功能都不能用了」，而且从日志上完全
        /// 看不出异常。所以每次 helper 起来、每次发 seek 之前，都先做一次自愈。
        ///
        /// 修的顺序：先用上次记下的好矩形，没有就落在工作区正中（1174×940，
        /// 客户端默认尺寸）。只在窗口确实退化时才动，正常窗口一概不碰。
        /// </summary>
        public static bool HealRect(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
            RECT cur;
            bool have = NormalRect(hwnd, out cur);
            int cw = have ? cur.Right - cur.Left : 0;
            int ch = have ? cur.Bottom - cur.Top : 0;
            // 阈值放 200：正常的播放器最小也有几百像素，比它小的只可能是退化残值
            bool bad = !have || cw < 200 || ch < 200;
            if (!bad) { RememberRect(cur); return false; }

            int x, y, w, h;
            RECT good;
            if (GoodRect(out good))
            {
                x = good.Left; y = good.Top;
                w = good.Right - good.Left; h = good.Bottom - good.Top;
            }
            else
            {
                SRECT wa = new SRECT();
                if (!SystemParametersInfo(SPI_GETWORKAREA, 0, ref wa, 0)) return false;
                int aw = wa.Right - wa.Left;
                int ah = wa.Bottom - wa.Top;
                w = Math.Min(1174, Math.Max(480, aw - 120));
                h = Math.Min(940, Math.Max(360, ah - 120));
                x = wa.Left + (aw - w) / 2;
                y = wa.Top + (ah - h) / 2;
            }
            // 可见且非最小化时 SetWindowPlacement 写不进 rcNormalPosition（实测返回 True
            // 但值不变），只有 SetWindowPos 带尺寸才会同步改这份记录。反过来，最小化态
            // 只能走 SetWindowPlacement —— SetWindowPos 对最小化窗口无效。
            try
            {
                if (IsWindowVisible(hwnd) && !IsIconic(hwnd))
                {
                    SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
                }
                return SetNormalRect(hwnd, x, y, w, h);
            }
            catch { return false; }
        }

        /// <summary>给 PowerShell 侧调用：按 pid 找主窗口再做自愈。</summary>
        public static bool Heal(int pid)
        {
            if (pid <= 0) return false;
            string t = Title(pid);
            if (t == null) t = "";
            bool fixedRect = HealRect(_lastHwnd);
            // 顺手清一遍整窗透明：守卫要是被上层直接收掉（后端重启、会话结束），
            // alpha=0 的 layered 位会留在窗口上 —— 窗口在那儿却一个像素都不画，
            // 用户只会觉得「客户端坏了」。这一步是那种遗留状态的唯一自愈点。
            try
            {
                foreach (IntPtr w in ProcessWindows((uint)pid, null))
                {
                    if (IsGhost(w)) { Unghost(w); }
                }
            }
            catch { }
            return fixedRect;
        }

        const uint KEYUP = 2u;

        // 守卫要按毫秒级盯窗口状态。默认 Sleep(3) 实际睡 15.6ms（系统时钟精度），
        // 那就是说「客户端 show 落地」到「我们压回去」之间必然留 15～45ms 的暴露。
        // timeBeginPeriod(1) 把时钟精度提到 1ms，Sleep(3) 才是真的 3ms。
        [DllImport("winmm.dll", EntryPoint = "timeBeginPeriod")]
        static extern uint TimeBeginPeriod(uint ms);

        [DllImport("winmm.dll", EntryPoint = "timeEndPeriod")]
        static extern uint TimeEndPeriod(uint ms);

        // 焦点归还：SetForegroundWindow 有个"前台锁"，后台进程调用经常被静默忽略
        // （返回值不可靠，窗口也不动）。绕法是把自己的线程输入挂到当前前台线程上，
        // 挂上之后再 SetForegroundWindow 就等同于前台进程自己调用。
        [DllImport("user32.dll")]
        static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);

        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool IsWindow(IntPtr hWnd);

        static int _lastPid;
        static string _lastTitle;
        static IntPtr _lastHwnd;
        static long _lastAt;
        const int CACHE_MS = 400;

        /// <summary>
        /// 该进程里「最像 歌名 - 歌手」的那条窗口文本。
        ///
        /// 不能只取最长的一条：切歌瞬间网易云会冒出 `GDI+ Window (cloudmusic.exe)`
        /// 这种比歌名更长的内部窗口，一取就把曲目名冲掉了。所以按特征打分：
        ///   · 形如 `X - Y`（有分隔符）最可信
        ///   · 可见窗口 > 隐藏窗口
        ///   · 类名是 OrpheusBrowserHost / Chrome_WidgetWin* 的更可信（Cef 主界面）
        ///   · 含 .exe / GDI+ / Window ( 这类内部窗体直接淘汰
        /// </summary>
        public static string Title(int pid)
        {
            int bestScore = int.MinValue;
            string best = "";
            IntPtr bestHwnd = IntPtr.Zero;
            EnumWindows((h, l) =>
            {
                uint p;
                GetWindowThreadProcessId(h, out p);
                if (p != (uint)pid) return true;
                int len = GetWindowTextLengthW(h);
                if (len <= 0) return true;
                var sb = new StringBuilder(len + 2);
                GetWindowTextW(h, sb, sb.Capacity);
                string t = sb.ToString();
                if (t.Length == 0) return true;
                if (t == "桌面歌词" || t == "迷你播放器" || t == "CloudMusic") return true;
                // 内部窗体：名字里带 exe / 是 GDI+ 之类的调试窗口
                if (t.IndexOf(".exe", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (t.StartsWith("GDI+", StringComparison.OrdinalIgnoreCase)) return true;
                if (t.StartsWith("Window (", StringComparison.OrdinalIgnoreCase)) return true;
                if (t.StartsWith("Default IME", StringComparison.OrdinalIgnoreCase)) return true;
                if (t.StartsWith("MSCTFIME", StringComparison.OrdinalIgnoreCase)) return true;

                int score = t.Length;
                if (t.IndexOf(" - ", StringComparison.Ordinal) > 0) score += 1000;
                if (IsWindowVisible(h)) score += 200;
                var cls = new StringBuilder(256);
                GetClassNameW(h, cls, cls.Capacity);
                string cn = cls.ToString();
                if (cn.StartsWith("Orpheus", StringComparison.OrdinalIgnoreCase)) score += 400;
                if (cn.StartsWith("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase)) score += 300;

                if (score > bestScore) { bestScore = score; best = t; bestHwnd = h; }
                return true;
            }, IntPtr.Zero);
            _lastPid = pid;
            _lastTitle = best;
            _lastHwnd = bestHwnd;
            _lastAt = Environment.TickCount;
            return best;
        }

        /// <summary>
        /// 缓存版：400ms 内重复取同一进程不重扫窗口。
        ///
        /// 不能无限期缓存 —— 切歌不会通知我们，只有窗口文本变了才知道曲目换了。
        /// </summary>
        public static string TitleCached(int pid)
        {
            if (pid == _lastPid && _lastTitle != null && (Environment.TickCount - _lastAt) < CACHE_MS) return _lastTitle;
            return Title(pid);
        }

        public static void Invalidate() { _lastPid = 0; _lastTitle = null; _lastHwnd = IntPtr.Zero; _lastAt = 0; }

        static byte Vk(string name)
        {
            switch (name.Trim().ToLowerInvariant())
            {
                case "ctrl": case "control": return 0x11;
                case "alt": return 0x12;
                case "shift": return 0x10;
                case "win": return 0x5B;
                case "left": return 0x25;
                case "up": return 0x26;
                case "right": return 0x27;
                case "down": return 0x28;
                case "space": return 0x20;
                case "enter": return 0x0D;
                case "esc": case "escape": return 0x1B;
                case "tab": return 0x09;
                default:
                    if (name.Length == 1)
                    {
                        char c = char.ToUpperInvariant(name[0]);
                        if (c >= 'A' && c <= 'Z') return (byte)c;
                        if (c >= '0' && c <= '9') return (byte)c;
                    }
                    throw new ArgumentException("unsupported key: " + name);
            }
        }

        /// <summary>发送组合键，例如 "Ctrl+Alt+P" / "Ctrl+Alt+Right"</summary>
        public static bool Hotkey(string spec)
        {
            if (string.IsNullOrWhiteSpace(spec)) return false;
            string[] parts = spec.Split('+');
            byte[] vks = new byte[parts.Length];
            for (int i = 0; i < parts.Length; i++) vks[i] = Vk(parts[i]);
            for (int i = 0; i < vks.Length; i++) { keybd_event(vks[i], 0, 0u, UIntPtr.Zero); System.Threading.Thread.Sleep(20); }
            for (int i = vks.Length - 1; i >= 0; i--) { keybd_event(vks[i], 0, KEYUP, UIntPtr.Zero); System.Threading.Thread.Sleep(20); }
            Invalidate();
            return true;
        }

        /// <summary>
        /// 用 orpheus:// 协议把一条 webcmd 投给正在运行的客户端。
        ///
        /// 客户端注册的协议处理器是 `cloudmusic.exe --webcmd="%1"`，第二次启动的进程
        /// 会检测到已有实例，把 webcmd 转交给主进程后立刻退出 —— 这正是我们要的
        /// 「不额外起进程、直接喂命令」通道。
        ///
        /// webcmd 的编码（前端 module 32 的 decode 函数）：
        ///   orpheus://&lt;base64(JSON)&gt;
        /// 解码后得到 { cmd, value }，再由前端 onWebMessage 分发。
        ///
        /// 副作用（实测，反编译 app.chunk 确认）：**任何** webcmd 都会被客户端当成
        /// 「用户从外部唤起」，走 ipcMessage → app/activeWindow，最后无条件执行
        ///   "webmsg" === t &amp;&amp; (yield o({type:"showWindow"}))
        /// 也就是说窗口会被 show 出来并抢焦点 —— 跟命令内容无关，跳进度还是别的都一样。
        ///
        /// 所以这里做的是「投递前先把它挪走 + 后台守卫 2.2 秒」：
        ///   · 隐藏（收托盘）/ 最小化 → 先在屏外停一下，守卫结束后按原状态摆回去
        ///   · 正常显示               → 不动窗口，只在焦点被抢走时还回去
        ///
        /// 守卫必须跨越 ~1.4 秒：客户端那次 show 不是收到消息立刻发的，
        /// 而是 orpheus_runner 起新进程转发之后才发（实测 t+1357ms）。
        /// </summary>
        public static string SendOrpheusCommand(string json)
        {
            if (string.IsNullOrEmpty(json)) return "empty";
            string b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
            // 先确保 _lastHwnd 有效：没扫过窗口就先扫一次，否则判断不了最小化/前台
            if (_lastHwnd == IntPtr.Zero) { try { EnumAnyWindow(); } catch { } }
            IntPtr hwnd = _lastHwnd;
            bool iconic = hwnd != IntPtr.Zero && IsIconic(hwnd);
            bool zoomed = hwnd != IntPtr.Zero && !iconic && IsZoomed(hwnd);
            bool wasVisible = hwnd != IntPtr.Zero && IsWindowVisible(hwnd);
            bool wasHidden = hwnd != IntPtr.Zero && !wasVisible && !iconic;
            IntPtr fgAtCall = GetForegroundWindow();
            bool wasFront = hwnd != IntPtr.Zero && fgAtCall == hwnd;

            RECT rect = new RECT();
            bool haveRect = NormalRect(hwnd, out rect);
            // 历史版本会把窗口 park 到 1×1，那时 rcNormalPosition 读到的就是这个
            // 退化值；不能拿它当「调用前的几何」。退回上次记下的那份好矩形。
            if (haveRect && (rect.Right - rect.Left) <= 8)
            {
                RECT good;
                if (GoodRect(out good)) { rect = good; }
            }
            else if (haveRect) { RememberRect(rect); }
            if (!haveRect)
            {
                // 读不到正常矩形（窗口句柄失效/刚创建）时也试一下缓存
                RECT good;
                if (GoodRect(out good)) { rect = good; haveRect = true; }
            }

            // z 序也要记一份。窗口可见时它「弹出来」的实际观感不是移动，而是
            // 盖到用户正在看的窗口上面（实测：位置一动不动，z 序从浏览器后面
            // 跳到浏览器前面，持续约 1.3 秒）。位置没变所以拦不住，只能靠压 z 序。
            // 记住此刻排在它下面（更靠后）的那个窗口，事后插回同一层即可。
            IntPtr zAnchor = hwnd != IntPtr.Zero ? GetWindow(hwnd, GW_HWNDNEXT) : IntPtr.Zero;
            // GetWindow 返回 NULL 有两种可能：句柄无效，或者它当时就排在最底层。
            // 后者的情况下直接把 NULL 传给 SetWindowPos 会被当成 HWND_TOP ——
            // 「纠正 z 序」反而把窗口顶到最前面，正是要修的那个毛病。所以这里
            // 显式换成 HWND_BOTTOM：它本来就在最底，压回最底才是不动。
            IntPtr zInsert = zAnchor != IntPtr.Zero ? zAnchor : (IntPtr)HWND_BOTTOM;
            bool coveredBefore = hwnd != IntPtr.Zero && fgAtCall != IntPtr.Zero
                                 && IsAbove(hwnd, fgAtCall);

            // 用户刚自己把播放器打开过。这段时间里**不按回、不隐藏、不改几何** ——
            // 他要正常用这个窗口，我们不该跟人抢。
            //
            // 但遮罩和 z 序纠正照做：早先这里是「grace 期间一切不做」，结果
            // 用户刚点开过客户端，八秒内再拖一次进度条，那次 seek 就完全裸奔 ——
            // 客户端自己 show 的那几拨没人管，窗口直接弹到用户眼前。
            // 「别跟人抢窗口」和「别让客户端弹窗」是两件事，不能共用一个开关。
            bool userGrace = unchecked(Environment.TickCount - _userGraceUntil) < 0;

            // 以前这里会把 rcNormalPosition 改成 (0,0,1,1) 把窗口「停」在屏幕外。
            // 2026-11-14 实测把它彻底否掉了，原因有两条：
            //
            //   1. CEF 会照着这份 geometry 真的重新 layout —— 1 像素宽渲染出来的
            //      是一套完全错位的界面。等用户点还原、我们把窗口拉回 1175x940，
            //      客户端的标题栏层和那 8 个 OrpheusShadow 阴影窗不会跟着重排，
            //      于是在窗口顶部留下一块永久白带（实测 61~62 行，任何 nudge /
            //      invalidate / 缩放 / 显隐都清不掉）。
            //   2. SetWindowPlacement 在隐藏态会把窗口「写活」——实测 vis 从
            //      False 直接变成 True，屏幕上多出一个 (0,0) 处的 1x1 小点。
            //
            // 压制改由 Blind（空 region）+ Ghost（layered alpha=0）+ MuteShadows
            // 三条视觉手段接管：它们都不改窗口尺寸，CEF 不需要重排，也就没有白边。

            // 先领一个代号：遮 region 的时候要记「这份是我遮的」，
            // 被后面的 seek 顶掉时才敢放开（否则会把新一代刚遮好的露出来）。
            int gen = System.Threading.Interlocked.Increment(ref _guardGen);

            // 把可见区域清空 —— 只对「本来就没在屏幕上」的窗口做。
            //
            // 守卫只能事后把窗口按回去，而按回去要等下一次采样，实测每次都会留下
            // 1 帧（16ms）真实位置的暴露（`.tmp_t5.ps1` 采样：3953ms、7172ms 两个
            // vis=True 采样点）。用户看到的就是「弹了一下」。清空 region 之后窗口
            // 就算被 show 出来也是全透明的，那一帧彻底消失。
            //
            // 窗口本来就摆在屏幕上时不遮：遮了它会在那儿留一块空白（守卫要跑几秒），
            // 比 16ms 的一帧更显眼。那种情况交给 z 序纠正处理。
            //
            // 不受豁免期影响：这里只处理「本来就不在屏幕上」的窗口，用户自己的
            // 窗口一直开着，这一段根本不会命中。
            bool blinded = false;
            if (hwnd != IntPtr.Zero && (iconic || wasHidden))
            {
                try { blinded = Blind(hwnd); } catch { blinded = false; }
                if (blinded) { _blindOwner = gen; }
            }

            // region 是「窗口的形状」，客户端 restore 时会把它重置掉（实测 kind 1→3），
            // 跟着一起冒出来的 OrpheusShadow 边框残影也挡不住。再叠一层整窗透明：
            // 它在 DWM 合成之前生效，客户端自己 minimize/restore 也不会冲掉，
            // 才是真的一个像素都不画。仍然只对「本来就没在屏幕上」的窗口做。
            uint ghostPid = _lastPid > 0 ? (uint)_lastPid : 0;
            if (ghostPid == 0 && hwnd != IntPtr.Zero)
            {
                uint owner;
                try { GetWindowThreadProcessId(hwnd, out owner); ghostPid = owner; } catch { ghostPid = 0; }
            }
            bool ghosted = false;
            // 除了「最小化 / 托盘隐藏」，还有一种情况也值得上 ghost：窗口摆在那里，
            // 但整个矩形被别的窗口（通常是全屏的浏览器）压住了 —— 用户看不见它。
            // 这时 ghost 是零感知的，却能吃掉客户端 show 那一帧（z 序插回是事后纠正，
            // 人眼在 16ms 里已经看见了）。只对「完全被遮住」启用：部分可见时上 ghost
            // 会让露出来的那块突然消失，比闪一下更难看。
            bool covered = hwnd != IntPtr.Zero && !iconic && !wasHidden && IsCovered(hwnd);
            if (hwnd != IntPtr.Zero && (iconic || wasHidden || covered))
            {
                try { ghosted = GhostAll(hwnd, ghostPid) > 0; } catch { ghosted = false; }
                if (ghosted) { _ghostOwner = gen; }
            }
            // 把 OrpheusShadow 边框窗的绘制区域清空。
            //
            // 这是「白边」的根治手段：那四个 WS_POPUP 边框窗永远画纯白，正常状态下
            // 它们被压在主窗口下面、露在外面的只有一圈柔化过度的阴影；一旦客户端
            // 从最小化 restore，它们会跑到主窗口上面，顶部 32px 那截就变成一条纯白。
            // 实测（`.tmp_zk.ps1` / `.tmp_zl.ps1`）：
            //   · 把它们 SetWindowPos 压到主窗口下面 → 当场有效，但客户端下一次
            //     show/restore 会重新排到最前，下一轮又白
            //   · 把 visible region 清空            → 归零，且此后连续 minimize/restore
            //                                        全部保持 0（region kind 稳定在 1）
            // 所以这里直接清 region，而且**不恢复**：恢复即刻白边就回来（实测
            // Unmute 后 band 从 0 直接跳回 60）。代价是窗口外沿那圈阴影没了 ——
            // 用户拖进度时察觉不到，比顶部一条白带宽得多。
            // 放在投递前：restore 是客户端收到消息之后才做的，先把 shadow 弄哑，
            // 它 restore 时就没有白像素可画。
            //
            // 只对「本来就不在屏幕上」的窗口做：窗口正常摆在屏幕上时客户端不会
            // 走 restore 那条路径，边框窗也不会被挪到窗口内侧，白边根本不会出现 ——
            // 那种情况下去动用户的窗口外观是多余的（这层阴影是客户端自己画的，
            // 弄哑之后窗口外沿那圈柔化阴影就没了）。
            if (hwnd != IntPtr.Zero && ghostPid != 0 && (iconic || wasHidden))
            {
                try { MuteShadows(ghostPid); } catch { }
            }

            IntPtr r = ShellExecuteW(IntPtr.Zero, "open", "orpheus://" + b64, null, null, 0);
            if ((long)r <= 32)
            {
                // 投递失败就把窗口放回去，别把用户的窗口留在遮着的状态
                if (blinded) { try { Unblind(hwnd); } catch { } if (_blindOwner == gen) { _blindOwner = 0; } }
                if (ghosted) { try { UnghostAll(hwnd, ghostPid); } catch { } if (_ghostOwner == gen) { _ghostOwner = 0; } }
                return "shell-error:" + ((long)r).ToString();
            }

            // 守卫放后台线程：seek 本身几十毫秒就返回，界面不卡；
            // 但窗口会被盯住最多 8 秒多，正好盖住客户端那几拨迟到的 show。
            //
            // 豁免期里也要起：那次 seek 照样会让客户端连着 show 几拨，只是我们
            // 不按回、不隐藏（交给 g.NoPressBack）。早先这里是 `!userGrace &&`，
            // 结果用户刚点开过客户端、几秒内再拖一次进度条，那次就完全没人管。
            bool needGuard = hwnd != IntPtr.Zero
                             && (blinded || ghosted || !wasFront || wasHidden || iconic || !coveredBefore);
            if (needGuard)
            {
                Guard g = new Guard();
                g.Hwnd = hwnd;
                g.IconicBefore = iconic;
                g.HiddenBefore = wasHidden;
                g.FrontBefore = wasFront;
                g.FgAtCall = fgAtCall;
                g.Blinded = blinded;
                g.Ghosted = ghosted;
                g.GhostCovered = covered;
                g.Pid = ghostPid;
                g.Rect = rect;
                g.ZAnchor = zAnchor;
                g.ZInsert = zInsert;
                g.WatchFront = !coveredBefore && fgAtCall != IntPtr.Zero;
                g.NoPressBack = userGrace;
                g.Gen = gen;
                System.Threading.Thread t = new System.Threading.Thread(() => GuardWindow(g));
                t.IsBackground = true;
                t.Start();
            }

            return string.Format(
                CultureInfo.InvariantCulture,
                "sent|{0}|{1}|{2}|{3}|1",
                iconic ? "1" : "0",
                wasFront ? "1" : "0",
                zoomed ? "1" : "0",
                wasHidden ? "1" : "0");
        }

        /// <summary>一次守卫的上下文。</summary>
        class Guard
        {
            public IntPtr Hwnd;
            public bool IconicBefore;
            public bool HiddenBefore;
            public bool FrontBefore;
            public IntPtr FgAtCall;
            /// <summary>这一轮把窗口的可见区域清空了吗（结束时必须 Unblind）。</summary>
            public bool Blinded;
            /// <summary>这一轮给主窗口和阴影窗加了整窗透明吗（结束时必须 UnghostAll）。</summary>
            public bool Ghosted;
            /// <summary>
            /// 这一轮的 ghost 是因为「窗口被完全遮住」才加的（而不是最小化/托盘）。
            /// 这种 ghost 必须在窗口重新露出来或到前台时立刻撤掉，否则用户会看到一块透明洞。
            /// </summary>
            public bool GhostCovered;
            /// <summary>ghost 作用在哪个进程的窗口上（主窗口 + OrpheusShadow）。</summary>
            public uint Pid;
            public RECT Rect;
            public IntPtr ZAnchor;
            /// <summary>
            /// 纠正 z 序时真正传给 SetWindowPos 的 hWndInsertAfter。
            /// 正常情况下等于 ZAnchor；窗口当时就在最底层时 ZAnchor 是 NULL，
            /// 而 NULL 在 SetWindowPos 里意味着 HWND_TOP —— 直接传会把窗口顶到
            /// 最前面，所以那种情况改用 HWND_BOTTOM。
            /// </summary>
            public IntPtr ZInsert;
            public bool WatchFront;
            public int Gen;
            /// <summary>
            /// 这次 seek 落在用户刚动过窗口的豁免期里：不按回、不隐藏、不改几何，
            /// 但遮罩和 z 序纠正照做 —— 「别跟人抢窗口」不等于「任由客户端把它弹出来」。
            /// </summary>
            public bool NoPressBack;
            /// <summary>
            /// 用户自己把窗口打开了（不是客户端 show 的）—— 立刻收手，别按回去。
            /// 一次 seek 之后的十几秒里窗口会连着被 show 几拨，但「不许用户打开
            /// 播放器」从来不是这个功能的意图。
            /// </summary>
            public bool UserTook;
            /// <summary>
            /// 这一轮已经按回去多少次。客户端的 show 实测最多三拨，所以只按回
            /// 第一次就够了 —— 之后靠 ghost 挡像素，不再跟人对着拉。
            /// </summary>
            public int PressBacks;
            /// <summary>
            /// 最后一次「看到前台是任务栏/桌面」的时刻（Environment.TickCount）。
            /// 收尾段要用同一个判据，所以挂在 Guard 上而不是局部变量。
            /// </summary>
            public int ShellSeenAt;
            /// <summary>
            /// 最后一次「用户点在外壳上」的时刻（Environment.TickCount）。
            /// 点任务栏按钮那一刻窗口还是最小化的，等它真的还原时左键早就松了，
            /// 所以证据必须在按下的那一拍就记下来。
            /// </summary>
            public int ShellClickAt;
        }

        // 连续快速拖动时只让最后一次守卫收尾，避免几个线程互相把窗口摆来摆去
        static int _guardGen;

        // 当前这份「空 region」是谁遮的（guard 代号）。被顶掉的守卫只有在
        // 自己还是 owner 时才放开 —— 否则会把新一代刚遮好的又露出来。
        static int _blindOwner;

        // 同理：整窗透明是哪一代守卫加的。被顶掉 / 收尾时只在 owner 是自己时才撤。
        static int _ghostOwner;

        // 用户刚动过播放器（自己把它打开了）之后的一段时间里，不再 park / ghost /
        // 不再起守卫 —— 那段时间他要正常用这个窗口。判定与设置都在守卫线程里。
        static int _userGraceUntil;

        /// <summary>「按回最小化/隐藏」最多试几次，见 GuardWindow 里的用法。</summary>
        const int PRESS_MAX = 40;

        /// <summary>
        /// 后台守卫：把窗口按在屏外，直到客户端那次迟到的 show 落地并被抵消。
        ///
        /// 实测时间线（`.tmp_test3.ps1`，最小化 + park）：
        ///   seek 返回          663ms
        ///   客户端 show 落地  2406ms  ← 窗口被拉到 (438,86) 并抢焦点
        /// 所以固定时长的压制一定会漏：show 到底什么时候来，取决于
        /// orpheus_runner 起新进程转发的耗时，实测波动在 1.3～2.4 秒。
        /// 这里改成「盯着状态等它安静」：只要窗口还是可见的正常窗口（说明
        /// 那次 show 已经发生），就立刻压回去；连续安静 500ms 才收工。
        /// </summary>
        static void GuardWindow(Guard g)
        {
            // 原来 25ms 一采样，实测露出 46ms 的一帧。最小化的窗口没法提前挪走
            // （SetWindowPos 对隐藏/最小化的窗口不改 rect，系统硬把坐标钉在 -25600），
            // 所以唯一的办法是「它一出来就按回去」，而这就取决于采样够不够密。
            // 3ms + timeBeginPeriod(1)（否则 Sleep(3) 实际睡 15.6ms）。
            //
            // 只有「窗口原本藏起来了」才值得这么拼。窗口本来就摆在屏幕上时，
            // 客户端那次 show 什么也改变不了外观，唯一要处理的是焦点被抢 ——
            // 20ms 一采样足够，也不必把全系统的时钟精度提到 1ms（那会增加耗电）。
            //
            // 实测纠正：可见窗口那次 show 也看得见 —— 位置一点没动，但它会被
            // 提到最前，盖住用户正在看的浏览器，持续约 1.3 秒。所以只要还在
            // 盯 z 序，同样得上高频采样。
            // 窗口还在屏幕上就一律高频：可见窗口被客户端提到最前，一帧就够了，
            // 40ms 的采样间隔足以让用户在那一帧里看见它。这里不看是否被遮挡 ——
            // 部分遮挡时 IsCovered 返回 false、不会上 ghost 兜底，只能靠 z 序纠正，
            // 那就更不能慢。
            bool onScreen = !g.HiddenBefore && !g.IconicBefore;
            bool needsFast = g.Blinded || g.HiddenBefore || g.IconicBefore || g.WatchFront || onScreen;
            const int MAX_MS = 12000;    // 上限：再晚就放弃，别把窗口永久霸占
            // 见到 show 之后，连续这么久没再被 show 才算过去。
            // 实测一次 seek 会引来好几拨 show（2.3s、3.4s、7.3s……），
            // 中间可能有长达 4 秒的空档，所以安静窗口不能太短。
            const int QUIET_MS = 1500;
            // 高频（3ms）守到这么久，之后降到低频。3ms 采样要 timeBeginPeriod(1)
            // 把系统时钟精度拉满，长时间开着会增加耗电，所以只在前段用。
            const int FAST_MS = 4200;
            // 低频阶段的采样间隔。实测最晚一次 show 出现在 7.3 秒，
            // 50ms 的偏差用户看不出，但足以抓住它。
            const int SLOW_STEP_MS = 40;
            // 最晚那一拨 show 落在 7.3 秒，所以遮罩无论如何要撑到它之后。
            //
            // 之前只靠 QUIET_MS 收敛：最后一拨 show 之前的空档可以长达 4 秒，
            // 只要在 4 秒空档里安静满 1.5 秒，守卫就收工、把 ghost 和空 region
            // 一起放开 —— 紧接着 7.3 秒那一拨 show 就没人在管，窗口当着用户的
            // 面弹出来。这就是「有时候」：看这次客户端发了几拨、间隔多长。
            const int LATE_MS = 8200;
            // 窗口原本藏起来（收托盘 / 最小化）时才需要把那次 show 按回去。
            // 摆在屏幕上的窗口，show 本身什么也改变不了外观，要处理的只有焦点。
            bool needHide = g.HiddenBefore || g.IconicBefore;
            // 一次事件都没见到的情形同样要守到最晚那拨之后：客户端有时只在
            // 7 秒左右发一拨，早退等于完全没保护。
            int noEventMs = needHide ? 8300 : 8900;
            // 判成「人弄的」之后，这么长一段时间里不再 park / ghost / 起守卫。
            const int USER_GRACE_MS = 8000;
            // 判定「人在动这个窗口」只看一条证据：**光标在外壳上、左键正按着**。
            //
            // 原来用过三种判据，都不可靠：
            //   1. GetLastInputInfo 的 idle —— 客户端自己 show 时会调 SetForegroundWindow
            //      一类 API，把 LastInputInfo 一并刷新（实测全程无键鼠输入，idle 仍被
            //      打成 93 → 16 → 0 → 15 → 0……），「idle < 600」恒为真。
            //   2. 「前台是 shell」—— 窗口被按回最小化之后前台就常驻任务栏/桌面，
            //      这条同样恒为真（实测 min 态静置 2.1 秒就误判成用户接管）。
            //   3. 「窗口从最小化变成普通窗口」—— 客户端自己那几拨 show 也会造成它。
            //
            // 现在只留一条：**光标落在外壳上、而且左键正按着**。客户端自己 show 时
            // 这两个条件一个都不成立（它不会去移动光标、也不会按下左键），所以这条
            // 判据只可能在人点任务栏/托盘的那一刻成立。
            const int CLICK_SEEN_MS = 1500;
            g.ShellSeenAt = 0;
            g.ShellClickAt = 0;
            int elapsed = 0;
            int quiet = 0;
            bool sawEvent = false;
            // 用初始状态打底：本来就在屏幕上的窗口不该被当成「刚被打开」
            bool wasRevealed = g.Hwnd != IntPtr.Zero
                               && IsWindowVisible(g.Hwnd) && !IsIconic(g.Hwnd);
            // 被新 seek 顶掉时不是收尾，不能跑 FinishGuard
            bool superseded = false;
            // 把系统时钟精度提到 1ms，否则 Sleep(3) 会被调度成 15.6ms
            bool fine = needsFast;
            if (fine) { try { fine = TimeBeginPeriod(1) == 0; } catch { fine = false; } }
            try
            {
                while (elapsed < MAX_MS)
                {
                    // 前段高频盯，后段降到 40ms：既能把迟到的那次 show 也抓住，
                    // 又不会让 timeBeginPeriod(1) 一直挂着。
                    bool fast = elapsed < FAST_MS;
                    int stepMs = (!fast || !needsFast) ? SLOW_STEP_MS : 3;
                    System.Threading.Thread.Sleep(stepMs);
                    elapsed += stepMs;
                    if (g.Gen != _guardGen)
                    {
                        // 被新的 seek 顶掉了，收尾交给它。可见区域如果还是我们遮的
                        // 那份，得自己放开；新一代已经重新遮过就别动（owner 判定）。
                        if (g.Blinded && _blindOwner == g.Gen) { try { Unblind(g.Hwnd); } catch { } }
                        if (g.Ghosted && _ghostOwner == g.Gen) { try { UnghostAll(g.Hwnd, g.Pid); } catch { } _ghostOwner = 0; }
                        superseded = true;
                        break;
                    }
                    IntPtr hwnd = g.Hwnd;
                    if (hwnd == IntPtr.Zero) break;

                    // 每一拍先记「用户刚刚是不是点了任务栏/托盘」。
                    // 必须每拍都记、不能等到窗口真的被打开再判：用户点下去的那一刻
                    // 窗口还是最小化的，等它还原时左键早就松了，那一瞬间的证据已经没了。
                    if (ClickOnShell()) { g.ShellClickAt = Environment.TickCount; }
                    bool vis = IsWindowVisible(hwnd);
                    bool ico = IsIconic(hwnd);
                    // 客户端的 show 到了？藏起来的窗口变成「可见的普通窗口」就是到了
                    bool revealed = vis && !ico;
                    // 用户自己把窗口打开了 —— 立刻收手。
                    //
                    // 这个守卫只负责盖住客户端收到 orpheus:// 之后自己 show 的那几拨，
                    // 绝不等于「seek 之后十几秒内不许用户打开播放器」。但两者在状态上
                    // 长得一模一样（都是 vis && !ico），唯一区别是「这次转换是不是手弄的」。
                    // 判据：转换那一刻距上次键鼠输入的间隔。人点任务栏就是几十毫秒前，
                    // 客户端那几拨 show 落地时人早就松手了。
                    // 用户自己打开了窗口？判据是「刚刚点了任务栏/托盘」或者
                    // 「刚刚前台是外壳」。命中就立刻收手 —— 一次 seek 之后窗口会
                    // 连着被 show 好几拨，但「不许用户打开播放器」从来不是意图。
                    //
                    // 注意这段必须**先于**「只按回一次」那一段：先判人、再决定要不要
                    // 按回去，否则用户点开的那一下会被按回去，之后才轮到人接管判定，
                    // 观感就是「打开了又缩回去」。
                    //
                    // 点击证据不带任何「投递后 N 毫秒才认」的门槛：那种门槛是给
                    // idle 判据准备的（刚投递那几百毫秒里用户可能还在松手，idle
                    // 读数不可信）。「光标在外壳上 + 左键按着」这件事客户端造不出来，
                    // 什么时候成立都说明是人点的。实测用户点任务栏后窗口 130ms 内
                    // 就还原了，加 600ms 门槛会把这一下直接漏掉，然后按回去 ——
                    // 正是用户抱怨的「点开又缩回去」。
                    int sinceClick = g.ShellClickAt == 0 ? int.MaxValue
                                     : unchecked(Environment.TickCount - g.ShellClickAt);
                    bool clickedRecently = sinceClick <= CLICK_SEEN_MS;
                    // 只看点击，不看「前台是不是 shell」：窗口被按回最小化之后，
                    // 前台常常就落在任务栏/桌面上（用户什么都没做），那条判据会
                    // 恒为真，实测 min 态静置 2.1 秒就误判成「用户接管」。
                    bool userOpening = revealed && clickedRecently;
                    if (userOpening)
                    {
                        g.UserTook = true;
                        // 接下来的几秒别再跟他抢窗口：一次 seek 的压制最长十几秒，
                        // 用户在这段时间里反复点都白点，那才是最糟的体验。
                        _userGraceUntil = unchecked(Environment.TickCount + USER_GRACE_MS);
                        break;
                    }
                    wasRevealed = revealed;
                    // 窗口已经开着的时候还要持续看：客户端那几拨 show 之后窗口常常
                    // 就一直停在「可见但被 ghost 罩着」的状态（按回不一定真能把它变回
                    // 最小化），用户这时点任务栏把它叫出来，状态并没有发生任何转换。
                    // 要求已经按回过一次，避免把「用户在别的程序上顺手点了任务栏」
                    // 当成要打开播放器。
                    if (revealed && g.PressBacks > 0 && clickedRecently)
                    {
                        g.UserTook = true;
                        _userGraceUntil = unchecked(Environment.TickCount + USER_GRACE_MS);
                        break;
                    }
                    bool stoleFocus = !g.FrontBefore && g.FgAtCall != IntPtr.Zero
                                      && GetForegroundWindow() == hwnd;
                    // 窗口被提到用户正在看的那个窗口前面了 —— 这就是「弹出来」
                    bool raised = g.WatchFront && revealed && g.FgAtCall != IntPtr.Zero
                                  && IsAbove(hwnd, g.FgAtCall);
                    bool acted = false;
                    if (needHide && revealed)
                    {
                        // 每一拍都按回，直到它真的变回最小化。
                        //
                        // 曾经写成「整个守卫只按一次」，目的是别跟用户对着拉（用户
                        // 点任务栏 → 下一拍就被按回去，观感是「打开又缩回去」）。但那个
                        // 问题现在有更准的判据 —— 上面那段点击证据命中时已经 break 走了，
                        // 根本走不到这里；点过任务栏之后的几秒还有 NoPressBack 兜着。
                        //
                        // 只按一次的代价实测很实在：客户端某一拨 show 只是把窗口拉到
                        // 屏外占位几何（-25600、159×27）却仍然 ico=False，一次按回用掉
                        // 之后窗口就永久停在「可见、非最小化、挂在屏外」的状态 —— 用户
                        // 下次点任务栏拿到的是一个透明空壳。
                        if (!g.NoPressBack && g.PressBacks < PRESS_MAX)
                        {
                            if (g.HiddenBefore) { ShowWindow(hwnd, 0); }    // SW_HIDE
                            else { ShowWindow(hwnd, 6); }                   // SW_MINIMIZE
                            g.PressBacks++;
                            acted = true;
                        }
                        // 按够次数还没按回去，就说明这个窗口已经不是 ShowWindow
                        // 能按回去的状态了（客户端把它当成「没显示」挂在屏外）。
                        // 再按下去只会让 acted 每拍为真、quiet 永不累积，守卫白
                        // 跑满 MAX_MS；交给下面的收尾段去摆正。
                        // 不置 acted：这一拍没有真的改变任何东西，不该刷新安静计时。
                    }
                    if (raised)
                    {
                        // 插回它原来的那一层：ZInsert 是调用前紧挨在它下面的窗口，
                        // 把它重新排到它之后，它就又回到用户窗口后面了。
                        // 位置/尺寸都不动，只有叠放次序变 —— 用户看到的是「没弹」。
                        //
                        // 用 ZInsert 而不是 ZAnchor：后者在「窗口当时就在最底层」时是
                        // NULL，而 SetWindowPos 把 NULL 当成 HWND_TOP —— 那会把窗口顶到
                        // 最前面，正好和这一步的目的相反。
                        SetWindowPos(hwnd, g.ZInsert, 0, 0, 0, 0,
                                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                        acted = true;
                    }
                    // 客户端 restore 的时候会顺手把可见区域重置掉（实测会变回
                    // COMPLEXREGION，且和「窗口搬回真实位置」是同一拍）。判定条件里
                    // 不能带 revealed —— 重置发生在可见之前，中间那条窄缝足够合成一帧。
                    // 「因为被遮住才 ghost」的那一种必须随时能撤：用户把窗口叫到前台，
                    // 或者别的窗口让开了、播放器重新露出来，就立刻恢复不透明 ——
                    // 否则他会看到一块透明洞。
                    // 前台检查每拍都做（一次 GetForegroundWindow，可以忽略），
                    // 「还遮着吗」要 9 次 WindowFromPoint，降到每 100ms 一次。
                    // 这一步必须排在补 ghost 之前，不然刚撤掉的下一行又给补回去了。
                    if (g.Ghosted && g.GhostCovered && _ghostOwner == g.Gen)
                    {
                        bool fgNow = GetForegroundWindow() == hwnd;
                        bool uncovered = !fgNow && elapsed % 100 < stepMs && !IsCovered(hwnd);
                        if (fgNow || uncovered)
                        {
                            try { UnghostAll(hwnd, g.Pid); } catch { }
                            if (_ghostOwner == g.Gen) { _ghostOwner = 0; }
                            g.Ghosted = false;
                        }
                    }
                    // 透明层复查：客户端偶发会重设 exstyle。主窗口每拍查（一次
                    // GetWindowLongPtr 可以忽略），阴影窗每 100ms 枚举一次 —— 它们的
                    // 数量和存在性都会变，不能只在开场抓一遍。
                    if (g.Ghosted && !IsGhost(hwnd)) { Ghost(hwnd); acted = true; }
                    if (g.Ghosted && elapsed % 100 < stepMs)
                    {
                        foreach (IntPtr sh in ProcessWindows(g.Pid, "OrpheusShadow"))
                        {
                            if (!IsGhost(sh)) { Ghost(sh); }
                        }
                    }
                    if (g.Blinded && elapsed % 30 < stepMs && !IsBlind(hwnd))
                    {
                        Blind(hwnd);
                        acted = true;
                    }
                    // 隐形车道上（最小化 / 托盘 / 整窗透明）窗口一个像素都没有，
                    // 还焦点没有任何意义 —— 而 StealForeground 内部那套
                    // SetForegroundWindow + BringWindowToTop + TOPMOST 抖动会把
                    // GetLastInputInfo 清零。下面「这次变可见是不是人弄的」判据
                    // 靠的就是它，自己把它打乱等于判据随机化：实测同一份代码、
                    // 同一个动作，三次里两次把用户刚还原的窗口按回最小化。
                    if (stoleFocus && !needHide && !g.Ghosted)
                    {
                        StealForeground(g.FgAtCall);
                        acted = true;
                    }
                    if (acted) { sawEvent = true; quiet = 0; }
                    else { quiet += stepMs; }
                    // 两个条件缺一不可：安静够久（这一拨 show 已经落完），而且
                    // 已经越过最晚那一拨的时点（后面不会再冒新的）。
                    if (elapsed >= LATE_MS && sawEvent && quiet >= QUIET_MS) break;
                    if (!sawEvent && elapsed >= noEventMs) break;
                }
            }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine("cloudmusic-player guard: " + ex.GetType().Name + ": " + ex.Message); }
            if (fine) { try { TimeEndPeriod(1); } catch { } }            // 顶替我们的是新一代守卫，收尾归它；用户抢先打开窗口则只把窗口
            // 还给他（几何 + 像素），绝不按回去。
            if (!superseded)
            {
                if (g.UserTook) { try { FinishUserTook(g); } catch (Exception ex) { System.Diagnostics.Debug.WriteLine("cloudmusic-player finish user: " + ex.Message); } }
                else { try { FinishGuard(g); } catch (Exception ex) { System.Diagnostics.Debug.WriteLine("cloudmusic-player finish guard: " + ex.GetType().Name + ": " + ex.Message); } }
            }
        }

        /// <summary>
        /// 用户抢先打开了窗口：把几何和像素还给他，其它一概不动。
        ///
        /// 不能按回最小化、不能还焦点 —— 用户就是要看这个窗口。但必须做两件事：
        ///   · 放开 region，否则窗口在那儿却是全透明的（用户以为又坏了）
        ///   · 把几何从 1×1 拨回真实尺寸：用户还原走的是 rcNormalPosition，
        ///     那份还是 park 写进去的 (0,0,1,1)，不补的话他打开的是 1 像素的窗口
        /// </summary>
        static void FinishUserTook(Guard g)
        {
            IntPtr hw = g.Hwnd;
            if (hw == IntPtr.Zero || !IsWindow(hw)) return;

            // region 先恢复：窗口要有形状，CEF 才能合成到它上面。
            // 整窗透明（layered alpha=0）**故意留着**：它在这里的意义从「压制客户端
            // show」变成「盖住 restore 那一刻 DWM 的默认白色表面」。
            //
            // 白边的物理来源是 DWM 在 CEF 重新合成之前用默认白色表面兜底（Chrome/Edge
            // 2025 年就是用 DWMWA_CLOAK 解决同类问题）。之前这里是「先 UnghostAll 再
            // NudgeResize」，等于先把像素放开、白边就在 nudge 生效前漏出来了（实测
            // 1.2~1.8 秒）。正确顺序反过来：保持 alpha=0 遮住白边，等几何落定、nudge
            // 把内容逼着重合成好，再放开透明 —— 用户看到的第一个可见帧就是深色内容。
            bool needGhostDrop = g.Ghosted || _ghostOwner == g.Gen;
            if (g.Blinded || _blindOwner == g.Gen) { try { Unblind(hw); } catch { } }
            if (_blindOwner == g.Gen) { _blindOwner = 0; }

            int x = g.Rect.Left;
            int y = g.Rect.Top;
            int w = g.Rect.Right - g.Rect.Left;
            int h = g.Rect.Bottom - g.Rect.Top;
            if (w <= 8 || h <= 8 || x <= -20000 || y <= -20000)
            {
                RECT good;
                if (GoodRect(out good))
                {
                    x = good.Left; y = good.Top;
                    w = good.Right - good.Left; h = good.Bottom - good.Top;
                }
            }
            if (w <= 8 || h <= 8) { DropGhost(hw, g.Pid, g.Gen, needGhostDrop); return; }

            // 先写 rcNormalPosition：用户点的那一下 restore 是照着这份记录落地的，
            // 而它此刻还是 park 写进去的 (0,0,1,1)。晚一步写，系统就会按 1 像素
            // 把窗口摆出来 —— 实测「窗口打开了但只有 1 个点」就是这么来的。
            // 可见且非最小化时 SetWindowPlacement 写不进 rcNormalPosition（实测返回
            // True 但值不变），得用 SetWindowPos 带尺寸才会同步改这份记录。
            try
            {
                if (IsWindowVisible(hw) && !IsIconic(hw))
                {
                    SetWindowPos(hw, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
                }
                SetNormalRect(hw, x, y, w, h);
            }
            catch { }

            // 此时窗口仍是 alpha=0（透明），白边无论怎么露都画不出来。趁这个窗口期
            // 先发一次 WM_PAINT；尺寸抖动留到几何落定、放开透明之后再做（还 ghost 着
            // 的时候 nudge 只会逼 CEF 画进 layered 合成路径，切回直接交换链后白边还在）。
            Repaint(hw);

            // 光写记录不够：那次 restore 可能已经在飞了，落地时用的还是旧值。
            // 这里盯一小会儿，只要它还缩着/漂在屏外就再摆正一次。绝不最小化、
            // 绝不抢焦点 —— 窗口是用户要看的。全程保持透明，等几何落定再放开。
            for (int t = 0; t < 3000; t += 40)
            {
                System.Threading.Thread.Sleep(40);
                if (!IsWindow(hw)) { DropGhost(hw, g.Pid, g.Gen, needGhostDrop); return; }
                if (!IsWindowVisible(hw) || IsIconic(hw))
                {
                    // 用户点下去到窗口几何真正到位实测要 300~600ms（DWM 动画 +
                    // 客户端重排）。240ms 就放弃会把整段重绘漏掉 —— 白边正是这样
                    // 一直留到客户端自己重画才消失的。这里多等一会儿：超过 2 秒
                    // 还没还原才算「用户又把它收了」，不再插手。
                    if (t >= 2000) { DropGhost(hw, g.Pid, g.Gen, needGhostDrop); return; }
                    continue;
                }
                RECT cur = new RECT();
                bool okRect = GetWindowRect(hw, ref cur);
                int cw = okRect ? cur.Right - cur.Left : 0;
                int ch = okRect ? cur.Bottom - cur.Top : 0;
                if (okRect && (cw < w - 8 || ch < h - 8 || cur.Left <= -20000 || cur.Top <= -20000))
                {
                    try
                    {
                        SetWindowPos(hw, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
                    }
                    catch { }
                    try { SetNormalRect(hw, x, y, w, h); } catch { }
                    continue;            // 几何还没落定，这一拍不放像素
                }
                // 几何落定之后，用「空 region 接管隐藏 → 切回直接交换链 → 逼 CEF 交帧
                // → 等帧到 → 放开」的顺序，让用户看到的第一个可见帧就是内容。
                //
                // 决定性实验（.tmp_decisive.ps1）：
                //   min → ghost → restore → blind → unghost → nudge → wait → unblind
                //   wait=0   : unblind 后 band=62，白边 300ms 才消
                //   wait=700 : unblind 后 band=0，一帧不白
                // 为什么不能只用 ghost(alpha=0)：ghost 态下 nudge 只逼 CEF 画进 layered
                // 合成路径，unghost 切回直接交换链后那张交换链还是旧的/白的。所以必须
                // 在 unghost 之前先用空 region（Blind）接管「不可见」，unghost 之后 region
                // 仍空、窗口看不见，此时 nudge 逼 CEF 在直接交换链上重出帧，等帧到了
                // 才 Unblind 放开 —— 白边永远没机会露出来。
                if (okRect && cw >= w - 8 && ch >= h - 8)
                {
                    Blind(hw);
                    DropGhost(hw, g.Pid, g.Gen, needGhostDrop);
                    Repaint(hw);
                    NudgeResize(hw, w, h);
                    System.Threading.Thread.Sleep(700);
                    Unblind(hw);
                    // 后面几拍如果它又自己重排、白底又回来，就再 nudge 一次兜底。
                    Repaint(hw);
                    NudgeResize(hw, w, h);
                    break;
                }
            }
            // 循环正常走完（3000ms）也没落定的，这里兜底放开。
            DropGhost(hw, g.Pid, g.Gen, needGhostDrop);
            Unblind(hw);
        }

        /// <summary>守卫结束：把窗口摆回调用前的状态。</summary>
        static void FinishGuard(Guard g)
        {
            IntPtr hwnd = g.Hwnd;
            if (hwnd == IntPtr.Zero) return;

            // 主守卫阶段就已经判定「用户自己打开了」，直接还给他。
            if (g.UserTook) { FinishUserTook(g); return; }

            // 收尾还得分两段，顺序很关键。
            //
            // 第一段：窗口此刻**还遮着**（region 空 + 整窗透明），把迟到的 show
            //   全部熬过去。实测客户端最后一拨 show 晚到投递后 7.3~7.9 秒（主守卫
            //   早在 6 秒就因为「安静 1.5 秒」收工了）。这一段里它怎么 show 都没有
            //   像素 —— 前提是**先别放开遮罩**。
            // 第二段：确认静下来了，才还原可见性 / 焦点 / 叠放次序，最后放开像素。
            //   反过来（先放开像素再盯）就会出现「窗口已经回来、客户端又来一次
            //   show」的 16ms 暴露 —— 那正是用户看到的抖动。
            bool tail = g.HiddenBefore || g.IconicBefore;
            bool blindNow = g.Blinded;
            if (tail && !blindNow)
            {
                try { blindNow = Blind(hwnd); } catch { blindNow = false; }
                if (blindNow && _blindOwner == 0) { _blindOwner = g.Gen; }
            }

            if (tail && g.Gen == _guardGen)
            {
                // 为什么是「固定跑满一段」而不是「安静就收工」：
                //   客户端那拨迟到的 show 实测落在投递后 3.9～4.6 秒，主守卫的
                //   「安静 1.5 秒 + 最少 3.6 秒」刚好卡在它前面收工，所以收尾这一段
                //   必须再撑一会儿。这段里窗口 region 为空、整窗透明，怎么
                //   show 都不可见，多守几秒的代价只是几次 P/Invoke。
                //   但也不能太长：helper 是随会话走的，拖过十几秒有被上层收掉的风险。
                const int SETTLE_MAX = 3200;
                const int SETTLE_MIN = 2000;
                const int SETTLE_QUIET = 900;
                const int SETTLE_STEP = 40;
                // 主守卫里同样的判据：这一段里用户照样可能点开播放器。
                // 阈值必须和主守卫一致 —— 两段用不同的数字，就等于同一件事
                // 在主守卫里算「人弄的」、在收尾里算「客户端 show」，行为随机。
                const int CLICK_MS = 1500;
                // 和主守卫那份保持一致：判成「人弄的」之后同样进入豁免期。
                const int GRACE_MS = 8000;
                int quiet = 0;
                bool wasShown = IsWindowVisible(hwnd) && !IsIconic(hwnd);
                for (int t = 0; t < SETTLE_MAX; t += SETTLE_STEP)
                {
                    System.Threading.Thread.Sleep(SETTLE_STEP);
                    if (g.Gen != _guardGen) break;
                    if (!IsWindow(hwnd)) break;
                    if (ClickOnShell()) { g.ShellClickAt = Environment.TickCount; }
                    bool vis = IsWindowVisible(hwnd);
                    bool ico = IsIconic(hwnd);
                    // 用户打开了窗口就立刻停 —— 这一段存在的意义只是盖住客户端的
                    // 那几拨 show，不包括「不许人打开自己的播放器」。
                    // 判据同主守卫：只看「刚刚点了外壳」，不看 idle（会被客户端自己
                    // 刷新）、也不看「前台是 shell」（窗口被按回最小化后它恒为真）。
                    bool shown = vis && !ico;
                    if (shown)
                    {
                        int sinceClick = g.ShellClickAt == 0 ? int.MaxValue
                                         : unchecked(Environment.TickCount - g.ShellClickAt);
                        if (sinceClick <= CLICK_MS)
                        {
                            g.UserTook = true;
                            _userGraceUntil = unchecked(Environment.TickCount + GRACE_MS);
                            break;
                        }
                    }
                    wasShown = shown;
                    // 「因为被遮住才 ghost」的那一种同样要随时能撤：收尾这几秒里
                    // 用户可能把播放器叫到前台，或者挡住它的窗口让开了。
                    if (g.Ghosted && g.GhostCovered && _ghostOwner == g.Gen)
                    {
                        bool fgNow = GetForegroundWindow() == hwnd;
                        bool uncovered = !fgNow && t % 100 == 0 && !IsCovered(hwnd);
                        if (fgNow || uncovered)
                        {
                            try { UnghostAll(hwnd, g.Pid); } catch { }
                            if (_ghostOwner == g.Gen) { _ghostOwner = 0; }
                            g.Ghosted = false;
                        }
                    }
                    bool acted = false;
                    if (vis && !ico)
                    {
                        // 它一边 show 一边被我们按回去，这一段的可见性不进用户眼睛 ——
                        // 没有像素。等静下来之后第二段再统一摆回隐藏/最小化的样子。
                        // 同主守卫：只按回一次，之后靠 ghost 挡像素，不再跟人对着拉；
                        // 豁免期里（g.NoPressBack）一次都不按。
                        // 同主守卫：不再「只按一次」。客户端把窗口拉到屏外占位几何
                        // 后仍然 ico=False，一次按回之后它就永久停在那个空壳状态，
                        // 用户下次点任务栏拿到的是透明空窗口。
                        if (!g.NoPressBack && g.PressBacks < PRESS_MAX)
                        {
                            if (g.HiddenBefore) { ShowWindow(hwnd, 0); }
                            else if (g.IconicBefore) { ShowWindow(hwnd, 6); }
                            g.PressBacks++;
                            acted = true;
                        }
                        // 同主守卫：按够次数还按不回去就停手，别让 acted 恒为真
                        // 把 quiet 卡在 0、把这一段也拖满。
                    }
                    if (!g.FrontBefore && g.FgAtCall != IntPtr.Zero && !g.Ghosted && GetForegroundWindow() == hwnd)
                    {
                        // 同主守卫：隐形车道上还焦点只会把 idle 清零，把判据搅乱
                        StealForeground(g.FgAtCall);
                        acted = true;
                    }
                    // 客户端 restore 时会把可见区域重置掉（实测变回 COMPLEXREGION，
                    // 和「窗口搬回真实位置」是同一拍），无条件补，别等它可见。
                    // 注意这里不重置 quiet：重新遮一下不是「用户看得见的事件」，
                    // 让它参与 quiet 会让这段永远不收敛、跑满 SETTLE_MAX。
                    if (blindNow && !IsBlind(hwnd)) { Blind(hwnd); }
                    if (acted) { quiet = 0; }
                    else { quiet += SETTLE_STEP; }
                    // 「静下来了」的判据必须带上 `IsIconic`：最小化的窗口
                    // IsWindowVisible 依然是 true，只按 !IsWindowVisible 判会永远
                    // 不成立。另外必须熬过 SETTLE_MIN，否则漏掉那拨 13 秒的 restore。
                    bool calm = !IsWindowVisible(hwnd) || IsIconic(hwnd);
                    if (t >= SETTLE_MIN && quiet >= SETTLE_QUIET && calm) break;
                }
            }

            // 这一段里判出「用户自己打开了」，就别再往下走了 —— 下面全是把窗口
            // 按回隐藏/最小化、把几何写回旧值，每一条都与用户的意图相反。
            //
            // 补一道收尾前的复查：主守卫判定完到这一行之间还有几毫秒，而守卫本身
            // 也可能是在「用户点下去、窗口还没还原」的那一拍退出的 —— 那种情况下
            // 主循环里 `revealed` 还是 false，userOpening 判不出来，于是走到这里
            // 就会把用户刚打开的窗口按回最小化。实测 RevealAt=1200 就撞上了这一下。
            if (!g.UserTook && (g.HiddenBefore || g.IconicBefore))
            {
                const int FINAL_CLICK_MS = 1500;
                int sinceClickFinal = g.ShellClickAt == 0 ? int.MaxValue
                                      : unchecked(Environment.TickCount - g.ShellClickAt);
                if (sinceClickFinal <= FINAL_CLICK_MS
                    && IsWindowVisible(hwnd) && !IsIconic(hwnd))
                {
                    g.UserTook = true;
                }
            }
            if (g.UserTook) { FinishUserTook(g); return; }

            // 第二段：可见性还原 + 几何修补。
            //
            // 为什么要「反复按」，而不是按一次就算：
            // ShowWindow 对别的进程的窗口是异步的（内部投消息），客户端也可能
            // 在同一拍里又把它顶回来。实测只按一次会输在最后那一下，窗口停在
            // 「可见、非最小化、挂在屏外」的透明空壳上，用户下次点任务栏拿到
            // 的是一扇空窗口。所以这里按「查到状态对了为止」重试，最多 8 次 ×40ms。
            //
            // 为什么还要补 rcNormalPosition：
            // 客户端某一拨 show 会自己把窗口 SetWindowPos 到最小化的占位几何
            // （实测 -25600, 159×27）却仍然 showCmd=1 / ico=False —— 它认为那是
            // 「没显示」，Windows 认为那是一扇挂在屏幕外的正常窗口。这一下顺手
            // 把 rcNormalPosition 也写成了那个假几何，等于毁掉用户的窗口位置：
            // 下次还原出来的是个 159×27 的小条，所有按钮都点不到。
            // 最小化态下 SetWindowPlacement 只改 rcNorm、不动 showCmd，实测持久，
            // 之后的 minimize/restore 循环都正常，所以修在这里最稳。
            {
                RECT want = new RECT();
                bool haveWant = false;
                if (g.Rect.Right - g.Rect.Left > 200 && g.Rect.Bottom - g.Rect.Top > 200)
                {
                    want = g.Rect;
                    haveWant = true;
                }
                else if (GoodRect(out want))
                {
                    haveWant = true;
                }

                bool restored = false;
                if (g.HiddenBefore)
                {
                    for (int i = 0; i < 8; i++)
                    {
                        if (!IsWindowVisible(hwnd)) { restored = true; break; }
                        ShowWindow(hwnd, 0);                                    // SW_HIDE
                        System.Threading.Thread.Sleep(40);
                    }
                }
                else if (g.IconicBefore)
                {
                    for (int i = 0; i < 8; i++)
                    {
                        if (IsIconic(hwnd)) { restored = true; break; }
                        ShowWindow(hwnd, 6);                                    // SW_MINIMIZE
                        System.Threading.Thread.Sleep(40);
                    }
                }

                // 只有真被按回去了才补几何。窗口还开着的时候用户要看的就是它，
                // 这时候去动 rcNormalPosition 等于在偷偷改他的窗口位置。
                if (haveWant && restored)
                {
                    RECT cur = new RECT();
                    bool haveCur = NormalRect(hwnd, out cur);
                    int cw = haveCur ? cur.Right - cur.Left : 0;
                    int ch = haveCur ? cur.Bottom - cur.Top : 0;
                    if (!haveCur || cw < 200 || ch < 200
                        || cur.Left <= -20000 || cur.Top <= -20000)
                    {
                        try
                        {
                            SetNormalRect(hwnd, want.Left, want.Top,
                                          want.Right - want.Left, want.Bottom - want.Top);
                        }
                        catch { }
                    }
                }
            }

            // 不再有「几何还原」这一步：park 已经彻底删掉（见 SendOrpheusCommand
            // 里那段说明），守卫全程没动过窗口尺寸和位置，用户窗口一直是原样。
            // 还焦点。后台进程直接 SetForegroundWindow 会被前台锁挡掉，
            // 所以挂到当前前台线程上再调。
            // 隐形车道上不还：那里窗口没有像素，还焦点唯一的效果是把
            // GetLastInputInfo 清零，让「用户自己打开」的判据失效。
            if (!g.FrontBefore && g.FgAtCall != IntPtr.Zero && !g.Ghosted
                && GetForegroundWindow() != g.FgAtCall)
            {
                StealForeground(g.FgAtCall);
            }
            // 最后再确认一次叠放次序：守卫收尾时客户端可能又提了一手 z 序。
            // 放在还焦点之后做，避免 SetWindowPos 把它顶回前台。
            if (g.WatchFront && g.FgAtCall != IntPtr.Zero
                && IsWindowVisible(hwnd) && !IsIconic(hwnd) && IsAbove(hwnd, g.FgAtCall))
            {
                // 同主守卫：用 ZInsert（NULL 会变成 HWND_TOP，反而顶到最前）
                SetWindowPos(hwnd, g.ZInsert, 0, 0, 0, 0,
                             SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }

            // 像素最后再放回来：先把窗口摆回原位、藏好、压回原来的层，
            // 最后才恢复可见区域 —— 反过来的话中间那些动作都会被用户看到。
            // 透明层和 region 一样是「最后才放开」的：先把窗口摆回原位、藏好、
            // 压回原来的层，最后才让像素回来。反过来的话，alpha=255 那一刻窗口
            // 可能还停在 (0,0,1,1) 上 —— 用户会看到一个小点闪一下，正是要修的东西。
            if (g.Ghosted && _ghostOwner == g.Gen)
            {
                try { UnghostAll(hwnd, g.Pid); } catch { }
                _ghostOwner = 0;
            }
            if (blindNow && _blindOwner == g.Gen)
            {
                Unblind(hwnd);
                _blindOwner = 0;
            }

            // 可见态的收尾：窗口一直在用户眼前，客户端那几拨 show 没有触发重画，
            // 内容区可能停在半旧的一帧上。补一次强制重绘，代价只有一次 WM_PAINT。
            // 隐藏 / 最小化态不用管 —— 那时候没有像素，等用户还原时走
            // FinishUserTook，那里会重绘。
            if (IsWindowVisible(hwnd) && !IsIconic(hwnd)) { Repaint(hwnd); NudgeResize(hwnd, g.Rect.Right - g.Rect.Left, g.Rect.Bottom - g.Rect.Top); }
        }

        /// <summary>
        /// 把焦点还给 target。SetForegroundWindow 对后台进程有两道闸：
        /// 前台锁（AttachThreadInput 可绕）+ 系统"刚刚有窗口被激活"的抑制期。
        /// 后者用 SetWindowPos 置顶 + BringWindowToTop 补一下。
        /// </summary>
        public static bool StealForeground(IntPtr target)
        {
            if (target == IntPtr.Zero || !IsWindow(target)) return false;
            uint mine = GetCurrentThreadId();
            uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            bool attached = false;
            try
            {
                if (fgThread != 0 && fgThread != mine) attached = AttachThreadInput(mine, fgThread, true);
                SetForegroundWindow(target);
                BringWindowToTop(target);
                SetWindowPos(target, (IntPtr)(-1), 0, 0, 0, 0,   // HWND_TOPMOST
                             SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                SetWindowPos(target, (IntPtr)(-2), 0, 0, 0, 0,   // HWND_NOTOPMOST
                             SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            catch { }
            finally
            {
                if (attached) { try { AttachThreadInput(mine, fgThread, false); } catch { } }
            }
            return GetForegroundWindow() == target;
        }

        /// <summary>最近一次 Title() 命中的窗口句柄（即客户端主窗口）</summary>
        public static IntPtr LastHwnd { get { return _lastHwnd; } }
        public static bool LastIconic { get { return _lastHwnd != IntPtr.Zero && IsIconic(_lastHwnd); } }

        /// <summary>
        /// 扫一遍所有顶层窗口，把「非本进程且可见」的第一个窗口记成锚点。
        /// 只在没有已知主窗口时用一次：目的不是找网易云，而是拿到任意一个
        /// 句柄，好让 IsIconic/GetForegroundWindow 的比较有基准。
        /// </summary>
        public static void EnumAnyWindow()
        {
            if (_lastHwnd != IntPtr.Zero) return;
            uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            EnumWindows((h, l) =>
            {
                uint p;
                GetWindowThreadProcessId(h, out p);
                if (p == self) return true;
                if (!IsWindowVisible(h)) return true;
                if (GetWindowTextLengthW(h) <= 0) return true;
                _lastHwnd = h;
                return false;
            }, IntPtr.Zero);
        }

        /// <summary>把目标窗口拉到前台再发键，避免热键被其它窗口吃掉</summary>
        public static void Activate(int pid)
        {
            string t = Title(pid);
            if (_lastHwnd == IntPtr.Zero) return;
            try
            {
                ShowWindow(_lastHwnd, 9); // SW_RESTORE
                SetForegroundWindow(_lastHwnd);
                System.Threading.Thread.Sleep(60);
            }
            catch { }
        }
    }
}
'@

$winOk = $false
$winError = ''
try {
  Add-Type -TypeDefinition $shell -Language CSharp | Out-Null
  $winOk = $true
} catch {
  if ([bool]([type]::GetType('NcmWin.Win'))) { $winOk = $true } else { $winError = $_.Exception.Message }
}

# 窗口层编译不出来（多半是 helper.ps1 正被编辑到一半）就直接退出，不要带着
# window=false 硬撑着报 ready —— 那样后端会认定「助手正常」，然后整局挂着：
# Get-NativeTarget 见 winOk 为假一律返回 $null，热键/切歌/seek 全部报 no-session，
# 用户看到的就是「好多功能都不能用了」。退出会让后端按 restartLimit 退避重启，
# 文件改好了就自动恢复；一直坏着就进 degraded，界面上会给出「重试」。
if (-not $winOk) {
  [Console]::Error.WriteLine("window layer failed to compile: $winError")
  exit 1
}

# 启动时先把窗口几何自愈一次。
#
# 为什么放在启动：park/还原是一对，只要有一次「park 写进去了、还原没写进去」
# （helper 被上层收掉、宿主重启、进程被杀），窗口的 rcNormalPosition 就永久停在
# (0,0,1,1)。用户下次点开播放器只剩一个像素，所有按钮都点不到，日志上却完全
# 看不出异常 —— 表现就是「插件好多功能都不能用了」。这里每次 helper 起来都先
# 扫一遍，发现退化就修回工作区正中。只在退化时动手，正常窗口一概不碰。
# 这里不能用 Get-NativePids —— 它在文件后半段才定义，PowerShell 是自上而下执行
# 的，这时候调用只会报 CommandNotFound（还被 catch 吞掉，等于没自愈）。所以就地
# 枚举一遍。
try {
  $healPids = @()
  if ($ProcessName) {
    try { $healPids = @((Get-Process -Name $ProcessName -ErrorAction SilentlyContinue) | ForEach-Object { $_.Id }) } catch { }
  }
  foreach ($hp in $healPids) {
    try { [void][NcmWin.Win]::Heal($hp) } catch { }
  }
} catch { }

# ---------------------------------------------------------------------------
# 2. WinRT / SMTC（播放控制）：拿不到就降级，不阻断启动
# ---------------------------------------------------------------------------
$winrt = $false
$winrtError = ''
$asTaskGeneric = $null
$mgrType = $null
$propsType = $null
$manager = $null

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  if ($asTaskGeneric -eq $null) { throw 'AsTask(IAsyncOperation<T>) bridge not found' }

  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
  $winrt = $true
} catch {
  $winrt = $false
  $winrtError = $_.Exception.Message
}

function Await($operation, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function Get-Manager() {
  if (-not $winrt) { return $null }
  try { return (Await ($mgrType::RequestAsync()) $mgrType) } catch { return $null }
}

function Get-AllSessions($manager) {
  if ($manager -eq $null) { return @() }
  try { return @($manager.GetSessions()) } catch { return @() }
}

# 目标会话的挑选顺序：
#   1) SourceAppUserModelId 命中 -AumidPattern
#   2) SourceAppUserModelId 里含进程名（例如 cloudmusic.exe）
#   命不中就是 null —— 绝不接管别的应用。曾经有过「只有一个会话就接管」的
#   兜底，结果把正在放 B 站视频的 Edge 当成了播放器，用户按暂停暂停的是视频。
function Get-TargetSession($manager) {
  $sessions = Get-AllSessions $manager
  if ($sessions.Count -eq 0) { return $null }
  foreach ($s in $sessions) {
    if ([string]$s.SourceAppUserModelId -match $AumidPattern) { return $s }
  }
  if ($ProcessName) {
    foreach ($s in $sessions) {
      if ([string]$s.SourceAppUserModelId -match [regex]::Escape($ProcessName)) { return $s }
    }
  }
  return $null
}

# ---------------------------------------------------------------------------
# 2b. 原生通道：窗口标题 + 音频峰值 + 全局热键
# ---------------------------------------------------------------------------
# 很多网易云版本（本机 2.10.x 就是）压根不向系统注册 SMTC 会话
# （cloudmusic.dll 里有 "[SMTCWrapper] Failed to set play status ret="），
# 这时 SMTC 完全拿不到它。退路是它自己的全局热键 + 可观测的两件事：
# 音频峰值（在不在出声）和窗口标题（歌名 - 歌手）。

$script:nativePids = @()
$script:nativePidAt = 0

function Get-NativePids() {
  $now = [Environment]::TickCount
  if ($script:nativePids.Count -gt 0 -and ($now - $script:nativePidAt) -lt 1000) { return $script:nativePids }
  $list = @()
  if ($ProcessName) {
    try {
      $list = @((Get-Process -Name $ProcessName -ErrorAction SilentlyContinue) |
        Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id })
    } catch { $list = @() }
    if ($list.Count -eq 0) {
      try { $list = @((Get-Process -Name $ProcessName -ErrorAction SilentlyContinue) | ForEach-Object { $_.Id }) } catch { }
    }
  }
  $script:nativePids = $list
  $script:nativePidAt = $now
  return $list
}

# 挑那个真正在出声的实例；都不出声就挑第一个有窗口的
function Get-NativeTarget() {
  if (-not $winOk -or -not $coreOk) { return $null }
  $pids = Get-NativePids
  if ($pids.Count -eq 0) { return $null }
  $best = $null
  foreach ($p in $pids) {
    $peak = -1.0
    $has = $false
    try { $peak = [NcmCore.Api]::Peak($p); $has = [NcmCore.Api]::HasSession($p) } catch { }
    $title = ''
    try { $title = [NcmWin.Win]::TitleCached($p) } catch { }
    $row = [ordered]@{ pid = $p; title = $title; peak = $peak; hasSession = $has }
    if ($best -eq $null) { $best = $row; continue }
    if ($peak -gt $best.peak) { $best = $row }
  }
  return $best
}

# 把窗口标题 "歌名 - 歌手" 拆开；拆不开就整条当歌名
function Split-Title([string]$raw) {
  $t = ([string]$raw).Trim()
  if ($t -eq '') { return @('', '') }
  $sep = ' - '
  $i = $t.LastIndexOf($sep)
  if ($i -gt 0) { return @($t.Substring(0, $i).Trim(), $t.Substring($i + $sep.Length).Trim()) }
  return @($t, '')
}

# 判定「在出声」的峰值阈值：实测播放时 0.10~0.30，暂停后稳定 0.0000；
# 0.002 既能滤掉底噪，又不会漏掉很轻的段落。
$PEAK_PLAYING = 0.002

# 刚按过热键之后的「意图」缓存。
# 实测：按下暂停后客户端有 ~900ms 的淡出（0.16 → 0.10 → 0.03 → 0），
# 这期间的峰值仍然像在播放；只靠峰值判状态会让 UI 来回跳，也会让
# 「再按一次暂停」误判成「还在播」于是又按一次 —— 结果是恢复播放。
# 所以按下后在 INTENT_MS 内以意图为准。
$INTENT_MS = 2600
$script:lastIntent = $null

function Set-Intent([int]$targetPid, [bool]$playing) {
  $script:lastIntent = @{ pid = $targetPid; playing = $playing; at = [Environment]::TickCount }
}

function Get-IntentPlaying([int]$targetPid, [ref]$known) {
  $i = $script:lastIntent
  if ($i -eq $null) { return $false }
  if ($i.pid -ne $targetPid) { return $false }
  if (([Environment]::TickCount - $i.at) -gt $INTENT_MS) { return $false }
  $known.Value = $true
  return [bool]$i.playing
}

# 刚投递过 seek 的那一小段时间里，峰值不能拿来当判据。
#
# 为什么需要它：跳转时客户端会切一段新的音频流，`audio_player.cpp` 走
# Enter buffering → Leave buffering，中间峰值降到 0 一百多毫秒。Read-Native
# 拿这个 0 判出「暂停」，界面就在跳转那一刻闪一下播放/暂停按钮，用户以为是
# 自己点错了。这里记一个截止时间，窗口内改用「跳转前的播放态」。
$QUIET_MS = 900
$script:quietFrom = 0
$script:quietUntil = 0
$script:quietPlaying = $false

function Set-Quiet([int]$ms, [bool]$playing) {
  $now = [Environment]::TickCount
  $script:quietFrom = $now
  $script:quietUntil = $now + $ms
  $script:quietPlaying = $playing
}

function Get-QuietPlaying([ref]$known) {
  $u = $script:quietUntil
  if ($u -le 0) { return $false }
  if (([Environment]::TickCount - $u) -gt 0) { return $false }
  $known.Value = $true
  return [bool]$script:quietPlaying
}

# 安静窗口走到哪一步了：0 = 没开始，1 = 还没结束，2 = 刚结束。
# 「刚结束」那一档要补一次确定性判定（客户端缓冲完了峰值会重新起来），
# 否则窗口一过、峰值还没回来，又会被判成暂停。
function Get-QuietPhase() {
  $u = $script:quietUntil
  if ($u -le 0) { return 0 }
  $now = [Environment]::TickCount
  if (($u - $now) -gt 0) { return 1 }
  if (($now - $u) -lt 200) { return 2 }
  return 0
}

# 峰值判定：一次采样会在两句话之间掉到 0，取一小段时间内的最大值
function Get-PeakMax([int]$targetPid, [int]$samples = 4, [int]$gapMs = 60) {
  $max = -1.0
  for ($i = 0; $i -lt $samples; $i++) {
    try {
      $v = [NcmCore.Api]::Peak($targetPid)
      if ($v -gt $max) { $max = $v }
    } catch { }
    if ($i -lt ($samples - 1)) { Start-Sleep -Milliseconds $gapMs }
  }
  return $max
}

function Read-Native() {
  $t = Get-NativeTarget
  if ($t -eq $null) { return $null }
  $parts = Split-Title $t.title
  # 3×45ms：够跨过句子间隙，又不至于让每 2 秒一次的状态轮询变成 300ms
  $peak = Get-PeakMax $t.pid 3 45
  $playing = ($peak -gt $PEAK_PLAYING)
  # 刚按过热键的那 2.6 秒里，意图优先于峰值（淡出 / 淡入都要时间）
  $known = $false
  $intent = Get-IntentPlaying $t.pid ([ref]$known)
  if ($known) { $playing = $intent }
  # seek 之后的缓冲期同理：峰值归零不代表用户按了暂停
  $qk = $false
  $qPhase = Get-QuietPhase
  $qPlaying = Get-QuietPlaying ([ref]$qk)
  if ($qk) {
    $playing = $qPlaying
  } elseif ($qPlaying -and $qPhase -eq 2) {
    # 窗口刚结束、峰值还没回来：补一轮稍长的采样再下结论，别让按钮抖一下
    $p2 = Get-PeakMax $t.pid 4 45
    if ($p2 -gt $peak) { $peak = $p2; $playing = ($peak -gt $PEAK_PLAYING) }
    else { $playing = $qPlaying }
  }
  return [ordered]@{
    aumid    = 'native:' + [string]$ProcessName
    title    = $parts[0]
    artist   = $parts[1]
    album    = ''
    status   = if ($playing) { 'Playing' } else { 'Paused' }
    pos      = 0.0
    end      = 0.0
    start    = 0.0
    canPlay  = $true
    canPause = $true
    canNext  = $true
    canPrev  = $true
    canSeek  = $false
    peak     = [Math]::Round($peak, 4)
    pid      = $t.pid
    channel  = 'native'
  }
}


function Read-Session($session) {
  if ($session -eq $null) { return $null }
  try {
    $pb = $session.GetPlaybackInfo()
    $tl = $session.GetTimelineProperties()
    $props = $null
    try { $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType } catch { }

    $ctl = $pb.Controls
    $pos = 0.0; $end = 0.0; $start = 0.0
    try { $pos = [double]$tl.Position.TotalSeconds } catch { }
    try { $end = [double]$tl.EndTime.TotalSeconds } catch { }
    try { $start = [double]$tl.StartTime.TotalSeconds } catch { }

    return [ordered]@{
      aumid    = [string]$session.SourceAppUserModelId
      title    = if ($props -ne $null) { [string]$props.Title } else { '' }
      artist   = if ($props -ne $null) { [string]$props.Artist } else { '' }
      album    = if ($props -ne $null) { [string]$props.AlbumTitle } else { '' }
      status   = [string]$pb.PlaybackStatus
      pos      = $pos
      end      = $end
      start    = $start
      canPlay  = [bool]$ctl.IsPlayEnabled
      canPause = [bool]$ctl.IsPauseEnabled
      canNext  = [bool]$ctl.IsNextEnabled
      canPrev  = [bool]$ctl.IsPreviousEnabled
      canSeek  = [bool]$ctl.IsPlaybackPositionEnabled
    }
  } catch {
    return $null
  }
}

# 原生车道的 seek：走 orpheus:// 协议把 webcmd 喂给客户端。
#
# 为什么不用热键：网易云没有「快进 N 秒」的全局热键。
# 为什么不用 SMTC：客户端启动参数里把 MediaSessionService /
# HardwareMediaKeyHandling 关了，本机根本没有可用的 SMTC 会话。
# 为什么协议能用：客户端注册了 `cloudmusic.exe --webcmd="%1"`，第二次启动的
# 进程发现已有实例后会把 webcmd 转交给主进程再退出，前端 onWebMessage 的
# `case "seek"` 直接 setPlayingPosition → 原生 DoSeek。
#
# 已知副作用：客户端把所有外部 webcmd 都当成「唤起」，会 show 窗口并抢焦点
# （app.chunk 的 activeWindow effect 末尾无条件 showWindow）。SendOrpheusCommand
# 内部已做三态复原，这里只把「原来是什么状态、复原成功没有」回报给上层。
function Invoke-NativeSeek($target, [int]$seekMs) {
  $sec = [math]::Round([double]$seekMs / 1000.0, 3)
  if ($sec -lt 0) { $sec = 0 }
  # 用 invariant 格式，避免某些区域设置把小数点写成逗号
  $json = '{"cmd":"seek","value":' + $sec.ToString([System.Globalization.CultureInfo]::InvariantCulture) + '}'
  try {
    # 先扫一次窗口，保证 _lastHwnd 是最新的（决定图标/前台判断是否可信）
    [void][NcmWin.Win]::Title($target.pid)
    # 自愈：窗口的「正常位置」要是退化成 1×1（上一次 park 写进去了、还原没写成，
    # 例如 helper 被上层收掉），用户点开播放器只会看到一个像素，什么都点不到。
    # 每次 seek 前顺手修一次，代价是两三次 P/Invoke。
    try { [void][NcmWin.Win]::Heal($target.pid) } catch { }
    # 跳转前记下播放态：缓冲期峰值会归零，这段时间得靠它回答「在不在播」
    $peakBefore = Get-PeakMax $target.pid 3 45
    $playingBefore = ($peakBefore -gt $PEAK_PLAYING)
    $kb = $false
    $intentBefore = Get-IntentPlaying $target.pid ([ref]$kb)
    if ($kb) { $playingBefore = $intentBefore }
    $r = [NcmWin.Win]::SendOrpheusCommand($json)
    if ($r -ne $null -and $r.StartsWith('sent')) {
      $parts = $r.Split('|')
      $iconic = ($parts.Length -gt 1 -and $parts[1] -eq '1')
      $wasFront = ($parts.Length -gt 2 -and $parts[2] -eq '1')
      $wasHidden = ($parts.Length -gt 4 -and $parts[4] -eq '1')
      # 给前端解码 + 原生 DoSeek 留出时间，紧接着的 state 才读得到新进度
      Start-Sleep -Milliseconds 120
      [NcmWin.Win]::Invalidate()
      $out = @{ ok = $true; channel = 'native'; error = ''; seek = [ordered]@{ ms = $seekMs; pos = $sec } }
      # 窗口原本不可见（托盘/最小化）→ 后台守卫会负责摆回去
      if ($iconic -or $wasHidden) { $out.restored = $true }
      # 刚投递完的这段时间里峰值不可信（客户端在跳转/缓冲，会静音一百多毫秒），
      # 别拿它去判「用户按了暂停」。
      Set-Quiet $QUIET_MS $playingBefore
      $out.quietMs = $QUIET_MS
      if ($wasHidden) { $out.wasHidden = $true }
      if (-not $wasFront) { $out.detached = $true }
      return $out
    }
    return @{ ok = $false; channel = 'native'; error = 'seek-failed'; detail = [string]$r }
  } catch {
    return @{ ok = $false; channel = 'native'; error = 'seek-failed'; detail = $_.Exception.Message }
  }
}

# 系统端点音量。原来这段内联在 Get-Volume 的退路里；现在两路读数各要一份，
# 抽出来单独调用（每次几十微秒，比重新枚举会话便宜得多）。
function Get-SystemVolume() {
  $sm = $false
  $sv = -1.0
  try {
    $sv = [NcmCore.Api]::GetSysVol([ref]$sm)
  } catch { }
  if ($sv -lt 0) { $sv = 0 }
  return [ordered]@{ scope = 'system'; pid = 0; level = $sv; muted = [bool]$sm }
}

# 网易云自己的音频会话音量；客户端没开（没有会话）时返回 $null。
function Get-ProcessVolume($procName) {
  $level = -1.0
  $muted = $false
  $found = $false
  $usePid = 0
  try {
    foreach ($p in [NcmCore.Api]::Pids($procName)) {
      $f = $false; $m = $false
      $v = [NcmCore.Api]::GetProcVol($p, [ref]$f, [ref]$m)
      if ($f) { $level = $v; $muted = $m; $found = $true; $usePid = $p; break }
    }
  } catch { }
  if (-not $found) { return $null }
  return [ordered]@{ scope = 'process'; pid = $usePid; level = $level; muted = $muted }
}

# 音量：优先网易云自己的会话（不动系统总音量），拿不到才退系统端点
function Get-Volume($procName) {
  $pv = Get-ProcessVolume $procName
  if ($pv -ne $null) { return $pv }
  return Get-SystemVolume
}

# 回读「实际写入的那一路」。SYS 车道写完却回 APP 读数，界面就会看着像弹回原值。
function Get-VolumeAt([string]$scope) {
  if ($scope -eq 'process') {
    $pv = Get-ProcessVolume $ProcessName
    if ($pv -ne $null) { return $pv }
    return $null
  }
  if ($scope -eq 'system') { return Get-SystemVolume }
  return $null
}

function Set-Volume($level, $scope) {
  if ($level -lt 0) { $level = 0 }
  if ($level -gt 1) { $level = 1 }
  if ($scope -eq 'process' -and $ProcessName) {
    try {
      foreach ($p in [NcmCore.Api]::Pids($ProcessName)) {
        if ([NcmCore.Api]::SetProcVol($p, $level)) { return 'process' }
      }
    } catch { }
    # 客户端没开（没有音频会话）→ 退系统音量，并如实回报 scope
    if ([NcmCore.Api]::SetSysVol($level)) { return 'system' }
    return ''
  }
  if ([NcmCore.Api]::SetSysVol($level)) { return 'system' }
  return ''
}

function Set-Mute($mute, $scope) {
  if ($scope -eq 'process' -and $ProcessName) {
    try {
      foreach ($p in [NcmCore.Api]::Pids($ProcessName)) {
        if ([NcmCore.Api]::SetProcMute($p, $mute)) { return 'process' }
      }
    } catch { }
    if ([NcmCore.Api]::SetSysMute($mute)) { return 'system' }
    return ''
  }
  if ([NcmCore.Api]::SetSysMute($mute)) { return 'system' }
  return ''
}

# ---------------------------------------------------------------------------
# 3. 播放控制：SMTC 优先，拿不到就走客户端自己的全局热键
# ---------------------------------------------------------------------------
# 返回 @{ ok=bool; channel='smtc'|'native'|''; error='' }
function Invoke-Playback([string]$action, $manager, [int]$seekMs = 0) {
  $s = Get-TargetSession $manager
  if ($s -ne $null) {
    try {
      $done = $false
      switch ($action) {
        'play'   { $done = [bool](Await ($s.TryPlayAsync()) ([bool])) }
        'pause'  { $done = [bool](Await ($s.TryPauseAsync()) ([bool])) }
        'toggle' { $done = [bool](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
        'next'   { $done = [bool](Await ($s.TrySkipNextAsync()) ([bool])) }
        'prev'   { $done = [bool](Await ($s.TrySkipPreviousAsync()) ([bool])) }
        'seek' {
          # SMTC 的时间轴单位是 100ns tick
          $ticks = [long]$seekMs * 10000
          $done = [bool](Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool]))
        }
      }
      if ($done) { return @{ ok = $true; channel = 'smtc'; error = '' } }
    } catch { }
  }

  # 热键通道：只在确认目标进程存在时才发键，绝不能乱按到别的窗口
  if (-not $winOk) { return @{ ok = $false; channel = ''; error = 'no-session' } }
  $t = Get-NativeTarget
  if ($t -eq $null) { return @{ ok = $false; channel = ''; error = 'no-session' } }

  # seek 走 orpheus:// 协议通道：客户端自己解码 webcmd 后执行 setPlayingPosition，
  # 是一次真正的跳转（日志里能看到 DoSeek pos:N），不依赖 SMTC。
  # 热键做不到这件事 —— 网易云没有「快进 N 秒」的全局热键。
  if ($action -eq 'seek') { return Invoke-NativeSeek $t $seekMs }

  $spec = ''
  switch ($action) {
    'play'   { $spec = $HotkeyPlayPause }
    'pause'  { $spec = $HotkeyPlayPause }
    'toggle' { $spec = $HotkeyPlayPause }
    'next'   { $spec = $HotkeyNext }
    'prev'   { $spec = $HotkeyPrev }
  }
  if ([string]::IsNullOrWhiteSpace($spec)) { return @{ ok = $false; channel = ''; error = 'no-session' } }

  # play/pause 是无状态切换键：目标状态已经达成时不必再按，
  # 否则会「按暂停反而开始播」。判当前状态时，刚按过的意图优先于峰值
  # （暂停后客户端还有约 900ms 淡出，这段时间峰值仍非零）。
  if ($action -eq 'play' -or $action -eq 'pause' -or $action -eq 'toggle') {
    $known = $false
    $isPlaying = Get-IntentPlaying $t.pid ([ref]$known)
    if (-not $known) {
      $peak = Get-PeakMax $t.pid 4 60
      $isPlaying = ($peak -gt $PEAK_PLAYING)
    }
    if ($action -eq 'play' -and $isPlaying) { return @{ ok = $true; channel = 'native'; error = ''; skipped = 'already-playing' } }
    if ($action -eq 'pause' -and -not $isPlaying) { return @{ ok = $true; channel = 'native'; error = ''; skipped = 'already-paused' } }
    # 按完之后的目标状态：play→true，pause→false，toggle→当前取反
    Set-Intent $t.pid $(if ($action -eq 'toggle') { -not $isPlaying } else { $action -eq 'play' })
  }

  # 切歌之后一定是「在播放」，顺手把意图纠正过来，免得沿用上一次的暂停态
  if ($action -eq 'next' -or $action -eq 'prev') { Set-Intent $t.pid $true }

  try {
    # 不调用 Activate：全局热键不需要前台焦点，抢焦点反而会打断用户正在做的事
    # （实测直接发键即可，网易云能收到）。
    [void][NcmWin.Win]::Hotkey($spec)
    # 给客户端一点时间响应，后面的 state 才读得到新歌名
    Start-Sleep -Milliseconds 240
    [NcmWin.Win]::Invalidate()
    return @{ ok = $true; channel = 'native'; error = '' }
  } catch {
    return @{ ok = $false; channel = 'native'; error = $_.Exception.Message }
  }
}

# ---------------------------------------------------------------------------
# 4. 启动 + JSONL 主循环
# ---------------------------------------------------------------------------
$manager = Get-Manager

$ready = [ordered]@{
  type    = 'ready'
  version = $VERSION
  pid     = $PID
  winrt   = $winrt
  audio   = $coreOk
  window  = $winOk
  hotkeys = [ordered]@{ playPause = $HotkeyPlayPause; next = $HotkeyNext; prev = $HotkeyPrev }
  ps      = $PSVersionTable.PSVersion.ToString()
}
if (-not $winrt -and $winrtError) { $ready.winrtError = $winrtError }
if (-not $coreOk -and $coreError) { $ready.audioError = $coreError }
if (-not $winOk -and $winError) { $ready.windowError = $winError }
[Console]::Out.WriteLine(($ready | ConvertTo-Json -Compress -Depth 5))
[Console]::Out.Flush()

$running = $true
while ($running) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }

  $reply = [ordered]@{ type = 'reply'; seq = 0; ok = $false; cmd = '' }
  try {
    $req = $line | ConvertFrom-Json
    if ($null -ne $req.seq) { $reply.seq = [int]$req.seq }
    $cmd = [string]$req.cmd
    $reply.cmd = $cmd

    switch ($cmd) {
      'ping' { $reply.ok = $true }

      'state' {
        $reply.ok = $true
        $now = Read-Session (Get-TargetSession $manager)
        if ($now -eq $null) { $now = Read-Native }
        $reply.now = $now
        # volume：沿用原来的语义（APP 优先），老客户端/老调用方不受影响。
        # systemVolume：系统端点那一路，单独给前端切到 SYS 时用 —— 少了它，
        # SYS 车道拖完只能回落到 APP 读数，看起来就像「弹回原值」。
        $reply.volume = Get-Volume $ProcessName
        $reply.systemVolume = Get-SystemVolume
        $reply.sessions = @(Get-AllSessions $manager | ForEach-Object { [string]$_.SourceAppUserModelId })
        $reply.winrt = $winrt
      }

      'refresh' {
        [NcmCore.Api]::Reset()
        if ($winOk) { [NcmWin.Win]::Invalidate() }
        $script:nativePids = @()
        $manager = Get-Manager
        $reply.ok = $true
      }

      'play' {
        $r = Invoke-Playback 'play' $manager
        $reply.ok = $r.ok
        $reply.channel = $r.channel
        if ($r.skipped) { $reply.skipped = $r.skipped }
        if (-not $r.ok) { $reply.error = $r.error }
      }
      'pause' {
        $r = Invoke-Playback 'pause' $manager
        $reply.ok = $r.ok
        $reply.channel = $r.channel
        if ($r.skipped) { $reply.skipped = $r.skipped }
        if (-not $r.ok) { $reply.error = $r.error }
      }
      'toggle' {
        $r = Invoke-Playback 'toggle' $manager
        $reply.ok = $r.ok
        $reply.channel = $r.channel
        if ($r.skipped) { $reply.skipped = $r.skipped }
        if (-not $r.ok) { $reply.error = $r.error }
      }
      'next' {
        $r = Invoke-Playback 'next' $manager
        $reply.ok = $r.ok
        $reply.channel = $r.channel
        if (-not $r.ok) { $reply.error = $r.error }
      }
      'prev' {
        $r = Invoke-Playback 'prev' $manager
        $reply.ok = $r.ok
        $reply.channel = $r.channel
        if (-not $r.ok) { $reply.error = $r.error }
      }
      'seek' {
        $ms = [int]$req.ms
        if ($ms -lt 0) { $ms = 0 }
        $r = Invoke-Playback 'seek' $manager $ms
        $reply.ok = $r.ok
        $reply.channel = $r.channel
        if (-not $r.ok) { $reply.error = $r.error }
        if ($r.detail) { $reply.detail = [string]$r.detail }
        if ($r.seek) { $reply.seek = $r.seek }
        if ($r.restored) { $reply.restored = $true }
        if ($r.detached) { $reply.detached = $true }
        # windowLeaked：客户端把窗口 show 出来了、按不回去。必须回报，否则 UI
        # 只能靠用户肉眼发现「窗户飞了」。
        if ($r.windowLeaked) { $reply.windowLeaked = $true }
        if ($r.quietMs) { $reply.quietMs = [int]$r.quietMs }
        # 跳转后立刻回报一次最新状态，前端好马上把滑块挪到新位置
        if ($r.ok) {
          $now2 = $null
          if ($manager -ne $null) {
            try { $now2 = Read-Session (Get-TargetSession $manager) } catch { }
          }
          if ($now2 -eq $null) { $now2 = Read-Native }
          $reply.now = $now2
        }
      }

      'volume' {
        $scope = [string]$req.scope
        if ([string]::IsNullOrEmpty($scope)) { $scope = 'process' }
        $applied = Set-Volume ([double]$req.level) $scope
        $reply.ok = ($applied -ne '')
        $reply.scope = $applied
        # 回读实际写入的那一路：写的是系统端点就回系统读数。
        # 以前这里恒回 Get-Volume（APP 优先），SYS 车道拖完就显示 APP 的旧值。
        $at = $null
        if ($applied -ne '') { $at = Get-VolumeAt $applied }
        if ($at -eq $null) { $at = Get-Volume $ProcessName }
        $reply.volume = $at
        $reply.systemVolume = Get-SystemVolume
      }
      'mute' {
        $scope = [string]$req.scope
        if ([string]::IsNullOrEmpty($scope)) { $scope = 'process' }
        $applied = Set-Mute ([bool]$req.muted) $scope
        $reply.ok = ($applied -ne '')
        $reply.scope = $applied
        $at = $null
        if ($applied -ne '') { $at = Get-VolumeAt $applied }
        if ($at -eq $null) { $at = Get-Volume $ProcessName }
        $reply.volume = $at
        $reply.systemVolume = Get-SystemVolume
      }

      # intent：宿主从客户端日志读到了权威的播放态，提前灌给这里。
      # native 车道的 play/pause 是同一个切换键，只能靠峰值猜；而客户端暂停时
      # 有约 900ms 淡出，猜错方向就会「按暂停反而开始播」。
      'intent' {
        $targetPid = [int]$req.pid
        if ($targetPid -le 0) {
          $t = Get-NativeTarget
          if ($t -ne $null) { $targetPid = $t.pid }
        }
        if ($targetPid -gt 0) {
          Set-Intent $targetPid ([bool]$req.playing)
          $reply.ok = $true
          $reply.pid = $targetPid
          $reply.playing = [bool]$req.playing
        } else {
          $reply.ok = $false
          $reply.error = 'no-session'
        }
      }

      'procs' {
        $reply.ok = $true
        $reply.pids = @([NcmCore.Api]::Pids($ProcessName))
        $reply.sessions = @([NcmCore.Api]::Sessions())
      }

      # deep：换机器时的自检口子 —— 列出系统里全部 SMTC 会话与全部音频会话，
      # 用户照着挑自己的 AUMID / 进程名填进配置即可。
      'deep' {
        $reply.ok = $true
        $reply.winrt = $winrt
        if ($winrtError) { $reply.winrtError = $winrtError }
        $reply.window = $winOk
        if ($winError) { $reply.windowError = $winError }
        $reply.hotkeys = [ordered]@{ playPause = $HotkeyPlayPause; next = $HotkeyNext; prev = $HotkeyPrev }
        $reply.ps = $PSVersionTable.PSVersion.ToString()
        $reply.pids = @()
        if ($coreOk) {
          try { $reply.pids = @([NcmCore.Api]::Pids($ProcessName)) } catch { }
          try { $reply.sessions = @([NcmCore.Api]::Sessions()) } catch { }
        }
        $target = Get-TargetSession $manager
        $reply.target = if ($target -ne $null) { [string]$target.SourceAppUserModelId } else { '' }
        $reply.media = @()
        foreach ($s in (Get-AllSessions $manager)) {
          $row = [ordered]@{ aumid = [string]$s.SourceAppUserModelId }
          try {
            $pb = $s.GetPlaybackInfo()
            $row.status = [string]$pb.PlaybackStatus
          } catch { $row.status = '' }
          try {
            $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
            $row.title = [string]$p.Title
            $row.artist = [string]$p.Artist
          } catch { $row.title = ''; $row.artist = '' }
          $reply.media += $row
        }
        # 原生通道现状：每个 cloudmusic 进程的 pid / 窗口标题 / 峰值
        $reply.native = @()
        if ($winOk -or $coreOk) {
          foreach ($p in (Get-NativePids)) {
            $row = [ordered]@{ pid = $p; title = ''; peak = -1.0 }
            try { $row.title = [NcmWin.Win]::Title($p) } catch { }
            try { $row.peak = [Math]::Round([NcmCore.Api]::Peak($p), 4) } catch { }
            $reply.native += $row
          }
        }
      }

      'quit' { $reply.ok = $true; $running = $false }

      default { $reply.error = "unknown command: $cmd" }
    }
  } catch {
    $reply.ok = $false
    $reply.error = $_.Exception.Message
  }

  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
