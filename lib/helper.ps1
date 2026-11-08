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

        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int cmd);

        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

        const uint KEYUP = 2u;

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

  $spec = ''
  switch ($action) {
    'play'   { $spec = $HotkeyPlayPause }
    'pause'  { $spec = $HotkeyPlayPause }
    'toggle' { $spec = $HotkeyPlayPause }
    'next'   { $spec = $HotkeyNext }
    'prev'   { $spec = $HotkeyPrev }
    'seek'   { return @{ ok = $false; channel = 'native'; error = 'seek-unsupported' } }
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
