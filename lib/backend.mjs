/**
 * lib/backend.mjs —— 媒体后端抽象
 * ============================================================================
 * 上层（player.mjs / index.js / client.js）只认这里的接口，不认平台。
 * 现在只有 Windows 一条真实实现；macOS / Linux 留占位，二期补：
 *   - macOS：`media-control` CLI 或 osascript（AppleScript）+ `osascript -e 'set volume'`
 *   - Linux：`playerctl` + `pactl`
 * 补的时候只加一个对象，不用动 player.mjs。
 *
 * 为什么 Windows 只走 PowerShell 5.1：
 *   SMTC 的 WinRT 投影靠 .NET Framework 的 System.Runtime.WindowsRuntime，
 *   PowerShell 7 跑在 .NET Core 上，`Type.GetType(..., ContentType=WindowsRuntime)`
 *   不支持，取类型会直接失败。所以 `powershellPath` 默认写死 5.1，
 *   并在 UI 里说明「别填 pwsh.exe」。
 * ============================================================================
 */
import { fileURLToPath } from 'node:url'

/** 包内助手脚本的绝对路径（不依赖 cwd，装到 node_modules 也找得到） */
export function helperScriptPath() {
  return fileURLToPath(new URL('./helper.ps1', import.meta.url))
}

/**
 * @typedef {object} MediaBackend
 * @property {string} id
 * @property {string} platform
 * @property {{ playback: boolean, sessionVolume: boolean, systemVolume: boolean, lyrics: boolean }} capabilities
 * @property {string} [reason]          不支持时的原因（给 UI 显示）
 * @property {(cfg: object) => { shell: string, args: string[] }} command
 */

/** @typedef {{ processName: string, aumidPattern: string, powershellPath: string, helperPath: string, hotkeyPlayPause?: string, hotkeyNext?: string, hotkeyPrev?: string }} HelperConfig */

/** Windows：常驻 powershell.exe + lib/helper.ps1 */
export const windowsBackend = {
  id: 'windows-powershell',
  platform: 'win32',
  capabilities: { playback: true, sessionVolume: true, systemVolume: true, lyrics: true },

  /**
   * 组装 spawn 参数。`helperPath` 配置优先于包内脚本，
   * 方便高阶用户把脚本拷出去改（但默认不需要）。
   *
   * 三个热键参数是给 native 车道用的：客户端注册 SMTC 失败时，
   * 只能靠它自己的全局快捷键来控制播放，所以组合键必须和客户端里一致。
   * @param {HelperConfig} cfg
   */
  command(cfg) {
    const script = cfg.helperPath && String(cfg.helperPath).trim() ? String(cfg.helperPath).trim() : helperScriptPath()
    const args = [
      '-NoProfile',
      '-NoLogo',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-ProcessName',
      cfg.processName || 'cloudmusic',
      '-AumidPattern',
      cfg.aumidPattern || 'cloudmusic|netease|wangyi',
    ]
    if (cfg.hotkeyPlayPause) args.push('-HotkeyPlayPause', String(cfg.hotkeyPlayPause))
    if (cfg.hotkeyNext) args.push('-HotkeyNext', String(cfg.hotkeyNext))
    if (cfg.hotkeyPrev) args.push('-HotkeyPrev', String(cfg.hotkeyPrev))
    return { shell: cfg.powershellPath || 'powershell.exe', args }
  },
}

/**
 * 非 Windows 占位：UI 与歌词照常，播放控制 / 音量不可用。
 * @param {string} platform
 * @returns {MediaBackend}
 */
export function unsupportedBackend(platform) {
  return {
    id: `unsupported-${platform}`,
    platform,
    capabilities: { playback: false, sessionVolume: false, systemVolume: false, lyrics: true },
    reason: `media backend for ${platform} is not implemented yet`,
    command() {
      return { shell: '', args: [] }
    },
  }
}

/**
 * 选当前平台的后端。
 * @param {string} [platform] 默认 process.platform（测试时可传）
 * @returns {MediaBackend}
 */
export function selectBackend(platform = process.platform) {
  if (platform === 'win32') return windowsBackend
  return unsupportedBackend(platform)
}
