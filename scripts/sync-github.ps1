<#
.SYNOPSIS
    把本地改动同步到 GitHub：补 remote → add → commit → push。

.DESCRIPTION
    这个仓库的本地目录可能被搬走（甚至 .git 都可能没跟着走）。所以脚本第一件事
    不是 add，而是确认「这是不是一个 git 仓库」「origin 还在不在」——缺了就补回来，
    这样换机器、换目录之后仍然一条命令能推。

    没有改动时直接退出 0（不算失败），方便放进习惯动作里反复跑。

.PARAMETER Message
    自定义提交信息。不给就用 "chore: sync yyyy-MM-dd HH:mm"。

.PARAMETER Remote
    origin 缺失时补的地址。默认读 package.json 的 repository.url。

.EXAMPLE
    npm run sync

.EXAMPLE
    pwsh -NoProfile -File scripts/sync-github.ps1 -Message "fix: 歌词对齐"
#>
[CmdletBinding()]
param(
    [string]$Message,
    [string]$Remote
)

$ErrorActionPreference = 'Continue'
# 说明：这里刻意用 Continue 而不是 Stop。git 在「预期内的失败」上会写 stderr
# （比如 remote 不存在时的 `error: No such remote 'origin'`），Stop 会把它当成
# 异常抛出去、脚本直接崩在第一次探测上。所有 git 调用都显式检查 $LASTEXITCODE。

function Say([string]$text, [string]$color = 'Gray') {
    Write-Host $text -ForegroundColor $color
}

function Fail([string]$text) {
    Write-Host $text -ForegroundColor Red
    exit 1
}

# ── 0. 定位仓库根（scripts/ 的上一级） ───────────────────────────────────
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    # ── 1. 是不是 git 仓库 ──────────────────────────────────────────────
    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) {
        Fail @'
这里不是 git 仓库（.git 丢了？）。
换机器/换目录后的恢复办法：
  git clone https://github.com/jx70/dsh-cloudmusic-player.git <新目录>
然后把你的改动覆盖进去，再跑一次 npm run sync。
（注意：clone 时本地 node_modules 会被跳过，需要时跑一次 npm install。）
'@
    }

    # ── 2. origin 在不在（这是「换了位置也能推」的关键兜底） ────────────
    $origin = ''
    try { $origin = (git remote get-url origin 2>$null) } catch { $origin = '' }
    if (-not $origin) {
        if (-not $Remote) {
            $pkgPath = Join-Path $root 'package.json'
            if (Test-Path $pkgPath) {
                $pkg = Get-Content -Raw -Encoding utf8 $pkgPath | ConvertFrom-Json
                $url = $pkg.repository.url
                if ($url) {
                    # git+https://github.com/x/y.git → https://github.com/x/y.git
                    $Remote = $url -replace '^git\+', ''
                }
            }
        }
        if (-not $Remote) {
            Fail 'origin 不存在，而且 package.json 里也读不到 repository.url。请用 -Remote <url> 指定。'
        }
        git remote add origin $Remote
        if ($LASTEXITCODE -ne 0) { Fail "补 origin 失败：$Remote" }
        Say "已补回 origin：$Remote" 'Yellow'
    }
    else {
        Say "origin：$origin"
    }

    # ── 3. 有没有改动 ──────────────────────────────────────────────────
    git add -A
    if ($LASTEXITCODE -ne 0) { Fail 'git add 失败（看上面的报错）。' }

    git diff --cached --quiet
    $hasChange = ($LASTEXITCODE -ne 0)
    if (-not $hasChange) {
        Say '没有改动要推。' 'Green'
        exit 0
    }

    # ── 4. 看一眼将要提交什么（沉住气：node_modules 一定不该出现） ──────
    $staged = git diff --cached --name-only
    $suspicious = $staged | Where-Object { $_ -match '(^|/)node_modules/' -or $_ -match '\.env(b|\.local)?$' }
    if ($suspicious) {
        Fail "拒绝提交：暂存区里有不该入库的路径`n$($suspicious -join "`n")`n先修 .gitignore，再 git reset。"
    }
    Say ("将提交 {0} 个文件" -f ($staged | Measure-Object).Count)

    # ── 5. 提交 ────────────────────────────────────────────────────────
    if (-not $Message) {
        $Message = 'chore: sync ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
    }
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { Fail 'git commit 失败（看上面的报错）。' }

    # ── 6. 推送 ────────────────────────────────────────────────────────
    git push -u origin HEAD
    if ($LASTEXITCODE -ne 0) {
        Fail @'
git push 失败。常见两种：
  · 凭据没配：gh auth setup-git 之后再跑一次
  · 远端有新提交：git pull --rebase origin main 之后再跑一次
（本地 commit 已经留下了，重试不会丢东西。）
'@
    }

    Say '已推送。' 'Green'
}
finally {
    Pop-Location
}
