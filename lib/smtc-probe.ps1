param(
  [Parameter(Mandatory=$true)][string]$Action,
  [int]$SeekMs = 0,
  [string]$AumidPattern = 'msedge\.exe|chrome\.exe|firefox\.exe|MSWebView2|msedgewebview2'
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 writes console output in the system ANSI codepage (GBK on zh-CN);
# force UTF-8 so Node (which decodes stdout as UTF-8) reads CJK titles correctly.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Json([hashtable]$obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
} catch {
  Out-Json @{ ok=$false; error='smtc-unavailable'; detail=('add-type failed: ' + $_.Exception.Message) }
  exit 0
}

# Must use DOUBLE quotes: "IAsyncOperation``1" -> one literal backtick -> matches runtime IAsyncOperation`1
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
})[0]

function Await($winRtTask, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($winRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null

  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  if ($null -eq $mgr) { Out-Json @{ ok=$false; error='smtc-unavailable'; detail='no session manager' }; exit 0 }

  $sessions = @($mgr.GetSessions())
  if ($sessions.Count -eq 0) { Out-Json @{ ok=$false; error='no-browser-music-session' }; exit 0 }

  # Strict filter: browser AUMID + non-empty title. Never fall back to "only one session".
  # PlaybackType==1 (Music) is NOT enough: video pages (Bilibili/YouTube) also report 1.
  # Real differentiators measured on this machine:
  #   - a music track has a non-empty Artist (the singer); a video page leaves it blank;
  #   - a video title carries a site marker e.g. "_bilibili" / "youtube" (ASCII only here:
  #     this .ps1 must stay pure ASCII, PowerShell 5.1 reads it as ANSI/GBK otherwise).
  # Score candidates and pick the best instead of "first match wins".
  $videoMarkers = @('bilibili','youtube','youtu.be','acfun','nicovideo')
  $target = $null
  $targetProps = $null
  $bestScore = -1
  # Chromium reports only ONE SMTC session per browser. If a video page steals the
  # focus, the music track's session disappears from SMTC even though its audio is
  # still playing. For CONTROL actions (play/pause/toggle/...), the only channel that
  # can still reach the browser's actual media is that single session, so keep the
  # first browser session as a fallback even when its metadata looks like a video.
  # STATE actions keep the strict music-only rule (Node side has sticky fallback).
  $controlTarget = $null
  $controlProps = $null
  foreach ($s in $sessions) {
    $aumid = [string]$s.SourceAppUserModelId
    if ($aumid -notmatch $AumidPattern) { continue }
    $props = $null
    try { $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) } catch { }
    if ($null -eq $props) { continue }
    $title = [string]$props.Title
    if ([string]::IsNullOrWhiteSpace($title)) { continue }
    $pt = 0
    try { $pt = [int]$props.PlaybackType } catch { $pt = 0 }
    $artist = [string]$props.Artist

    # Record the loose candidate for control fallback (video titles included).
    if ($null -eq $controlTarget) {
      $controlTarget = $s
      $controlProps = @{ props=$props; pt=$pt; title=$title; artist=$artist }
    }

    # Hard reject obvious video-site titles (ASCII markers only) for STATE.
    $lower = $title.ToLowerInvariant()
    $isVideo = $false
    foreach ($m in $videoMarkers) { if ($lower.Contains($m)) { $isVideo = $true; break } }
    if ($isVideo) { continue }

    # A non-empty artist is the strong "this is music" signal.
    # No artist + clean title is only a weak candidate (used when nothing better exists).
    $pb = $s.GetPlaybackInfo()
    $isPlaying = ($null -ne $pb -and [string]$pb.PlaybackStatus -eq 'Playing')
    if (-not [string]::IsNullOrWhiteSpace($artist)) {
      $score = $(if ($isPlaying) { 3 } else { 2 })
    } else {
      $score = 1
    }
    if ($score -gt $bestScore) {
      $bestScore = $score
      $target = $s
      $targetProps = @{ props=$props; pt=$pt; title=$title; artist=$artist }
    }
  }

  if ($null -eq $target) {
    # No music session. For control actions, fall back to the loose browser session
    # so pause/play still reach the browser's real media (the music audio may still
    # be playing under a video session's metadata). STATE keeps strict behavior.
    if ($Action -ne 'state' -and $null -ne $controlTarget) {
      $target = $controlTarget
      $targetProps = $controlProps
    } else {
      Out-Json @{ ok=$false; error='no-browser-music-session' }; exit 0
    }
  }

  if ($Action -eq 'state') {
    $pb = $target.GetPlaybackInfo()
    $tl = $target.GetTimelineProperties()
    $pos = 0.0; $end = 0.0
    try { $pos = [double]$tl.Position.TotalSeconds } catch { }
    try { $end = [double]$tl.EndTime.TotalSeconds } catch { }
    $ctl = $pb.Controls
    Out-Json @{
      ok=$true
      title=$targetProps.title
      artist=$targetProps.artist
      album=([string]$targetProps.props.AlbumTitle)
      status=([string]$pb.PlaybackStatus)
      pos=$pos
      end=$end
      aumid=([string]$target.SourceAppUserModelId)
      playbackType=$targetProps.pt
      canPlay=[bool]$ctl.IsPlayEnabled
      canPause=[bool]$ctl.IsPauseEnabled
      canNext=[bool]$ctl.IsNextEnabled
      canPrev=[bool]$ctl.IsPreviousEnabled
      canSeek=[bool]$ctl.IsPlaybackPositionEnabled
    }
    exit 0
  }

  $done = $false
  switch ($Action) {
    'play'  { $done = [bool](Await ($target.TryPlayAsync()) ([bool])) }
    'pause' { $done = [bool](Await ($target.TryPauseAsync()) ([bool])) }
    'toggle'{ $done = [bool](Await ($target.TryTogglePlayPauseAsync()) ([bool])) }
    'next'  { $done = [bool](Await ($target.TrySkipNextAsync()) ([bool])) }
    'prev'  { $done = [bool](Await ($target.TrySkipPreviousAsync()) ([bool])) }
    'seek'  {
      $ticks = [long]$SeekMs * 10000
      $done = [bool](Await ($target.TryChangePlaybackPositionAsync($ticks)) ([bool]))
    }
    default { Out-Json @{ ok=$false; error='unknown-action'; detail=$Action }; exit 0 }
  }
  if ($done) {
    # Control and read back state in the SAME process: the caller uses this
    # snapshot as the post-action state, avoiding a second ~280ms PowerShell
    # cold start for the follow-up state() call.
    $pb = $target.GetPlaybackInfo()
    $tl = $target.GetTimelineProperties()
    $pos = 0.0; $end = 0.0
    try { $pos = [double]$tl.Position.TotalSeconds } catch { }
    try { $end = [double]$tl.EndTime.TotalSeconds } catch { }
    $ctl = $pb.Controls
    Out-Json @{
      ok=$true
      action=$Action
      title=$targetProps.title
      artist=$targetProps.artist
      album=([string]$targetProps.props.AlbumTitle)
      status=([string]$pb.PlaybackStatus)
      pos=$pos
      end=$end
      aumid=([string]$target.SourceAppUserModelId)
      playbackType=$targetProps.pt
      canPlay=[bool]$ctl.IsPlayEnabled
      canPause=[bool]$ctl.IsPauseEnabled
      canNext=[bool]$ctl.IsNextEnabled
      canPrev=[bool]$ctl.IsPreviousEnabled
      canSeek=[bool]$ctl.IsPlaybackPositionEnabled
    }
  }
  else { Out-Json @{ ok=$false; error='smtc-control-failed'; detail=$Action } }
  exit 0
} catch {
  Out-Json @{ ok=$false; error='smtc-error'; detail=$_.Exception.Message }
  exit 0
}
