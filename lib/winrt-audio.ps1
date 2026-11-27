param()

# winrt-audio.ps1 - resident background audio engine for cloudmusic-player web channel.
# Reads one JSON command per line from stdin, writes one JSON response per line to stdout.
# Uses WinRT MediaPlayer (no window, no browser page, no CDP, not registered in SMTC).
# IMPORTANT: this file must stay pure ASCII. PowerShell 5.1 decodes script text with the
# system ANSI codepage (GBK on zh-CN); non-ASCII comments become mojibake / ParserError.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

function Out-Json([hashtable]$obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  [Windows.Media.Playback.MediaPlayer,Windows.Media.Playback,ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Core.MediaSource,Windows.Media.Core,ContentType=WindowsRuntime] | Out-Null
} catch {
  Out-Json @{ seq=0; ok=$false; ready=$false; error='winrt-unavailable'; detail=($_.Exception.Message) }
  exit 0
}

$mp = $null
$curSongId = ''
$curTitle = ''
$curArtist = ''
$curUrl = ''

function Get-Session {
  if ($null -eq $mp) { return $null }
  try { return $mp.PlaybackSession } catch { return $null }
}

function Get-StateObj([int]$seq) {
  $st = Get-Session
  if ($null -eq $st) {
    return @{ seq=$seq; ok=$true; active=$false; status='Paused'; pos=[double]0; end=[double]0; songId=$curSongId; title=$curTitle; artist=$curArtist; volume=[double]1; muted=$false }
  }
  $state = [string]$st.PlaybackState
  $pos = [double]0
  $end = [double]0
  try { $pos = [double]$st.Position.TotalSeconds } catch {}
  try { $end = [double]$st.NaturalDuration.TotalSeconds } catch {}
  $vol = [double]1
  $mut = $false
  try { $vol = [double]$mp.Volume } catch {}
  try { $mut = [bool]$mp.IsMuted } catch {}
  return @{ seq=$seq; ok=$true; active=$true; status=$state; pos=$pos; end=$end; songId=$curSongId; title=$curTitle; artist=$curArtist; url=$curUrl; volume=$vol; muted=$mut }
}

Out-Json @{ seq=0; ok=$true; ready=$true; engine='winrt-mediaplayer' }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch {
    Out-Json @{ seq=0; ok=$false; error='bad-json'; detail=$_.Exception.Message }
    continue
  }
  $seq = 0
  try { $seq = [int]$req.seq } catch {}
  $cmd = [string]$req.cmd
  try {
    switch ($cmd) {
      'play' {
        $url = [string]$req.url
        if ([string]::IsNullOrEmpty($url)) { Out-Json @{ seq=$seq; ok=$false; error='no-url' }; break }
        if ($null -eq $mp) {
          $mp = New-Object Windows.Media.Playback.MediaPlayer
          $mp.IsLoopingEnabled = $false
        }
        # Source must be a MediaSource, not a raw System.Uri.
        $src = [Windows.Media.Core.MediaSource]::CreateFromUri([System.Uri]$url)
        $mp.Source = $src
        $curUrl = $url
        $curSongId = [string]$req.songId
        $curTitle = [string]$req.title
        $curArtist = [string]$req.artist
        if ($null -ne $req.level) { try { $mp.Volume = [double]$req.level } catch {} }
        if ($null -ne $req.muted) { try { $mp.IsMuted = [bool]$req.muted } catch {} }
        $st = Get-Session
        if ($null -ne $st) {
          if ($null -ne $req.positionMs -and [double]$req.positionMs -gt 0) {
            try { $st.Position = [TimeSpan]::FromMilliseconds([double]$req.positionMs) } catch {}
          }
          try { $st.PlaybackRate = 1.0 } catch {}
        }
        $mp.Play()
        $r = Get-StateObj $seq
        $r.cmd = 'play'
        Out-Json $r
      }
      'pause' {
        if ($null -ne $mp) { try { $mp.Pause() } catch {} }
        $r = Get-StateObj $seq; $r.cmd = 'pause'; Out-Json $r
      }
      'resume' {
        if ($null -ne $mp) {
          $st = Get-Session
          if ($null -ne $st) { try { $st.PlaybackRate = 1.0 } catch {} }
          try { $mp.Play() } catch {}
        }
        $r = Get-StateObj $seq; $r.cmd = 'resume'; Out-Json $r
      }
      'toggle' {
        if ($null -ne $mp) {
          $st = Get-Session
          $state = if ($null -ne $st) { [string]$st.PlaybackState } else { 'Paused' }
          if ($state -eq 'Playing') {
            try { $mp.Pause() } catch {}
          } else {
            if ($null -ne $st) { try { $st.PlaybackRate = 1.0 } catch {} }
            try { $mp.Play() } catch {}
          }
        }
        $r = Get-StateObj $seq; $r.cmd = 'toggle'; Out-Json $r
      }
      'seek' {
        $ms = [double]0
        try { $ms = [double]$req.positionMs } catch {}
        if ($ms -lt 0) { $ms = 0 }
        $st = Get-Session
        if ($null -ne $st) { try { $st.Position = [TimeSpan]::FromMilliseconds($ms) } catch {} }
        $r = Get-StateObj $seq; $r.cmd = 'seek'; Out-Json $r
      }
      'volume' {
        if ($null -ne $mp) {
          if ($null -ne $req.level) { try { $mp.Volume = [double]$req.level } catch {} }
          if ($null -ne $req.muted) { try { $mp.IsMuted = [bool]$req.muted } catch {} }
        }
        $r = Get-StateObj $seq; $r.cmd = 'volume'; Out-Json $r
      }
      'state' {
        $r = Get-StateObj $seq; $r.cmd = 'state'; Out-Json $r
      }
      'stop' {
        if ($null -ne $mp) {
          try { $mp.Pause() } catch {}
          try { $mp.Dispose() } catch {}
          $mp = $null
        }
        $curSongId = ''; $curTitle = ''; $curArtist = ''; $curUrl = ''
        Out-Json @{ seq=$seq; ok=$true; active=$false; status='Paused'; pos=[double]0; end=[double]0; songId=''; title=''; artist=''; cmd='stop' }
      }
      'quit' {
        if ($null -ne $mp) { try { $mp.Dispose() } catch {}; $mp = $null }
        Out-Json @{ seq=$seq; ok=$true; cmd='quit' }
        break
      }
      default {
        Out-Json @{ seq=$seq; ok=$false; error='bad-cmd'; detail=("unknown cmd: " + $cmd) }
      }
    }
  } catch {
    Out-Json @{ seq=$seq; ok=$false; error='cmd-failed'; detail=($_.Exception.Message) }
  }
}
