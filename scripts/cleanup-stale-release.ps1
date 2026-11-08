# 清理被 WorkBuddy 句柄锁住的旧构建残留目录
# 用法：重启 WorkBuddy 后，右键"使用 PowerShell 运行"本脚本，或让我再执行一次清理。
# 目标（共约 467MB）：release2 / release3 / release-split-0
# 注意：release/ 目录是当前 3.9.2 正式产物（Setup + Portable + promo.mp4），不会动。

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName Microsoft.VisualBasic
$root = Split-Path -Parent $PSScriptRoot
$targets = @('release2', 'release3', 'release-split-0')

foreach ($t in $targets) {
    $p = Join-Path $root $t
    if (Test-Path $p) {
        try {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
                $p, 'OnlyErrorDialogs', 'SendToRecycleBin')
            Write-Host "OK   已删除: $t"
        } catch {
            Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $p) { Write-Host "FAIL 仍被占用: $t （请重启 WorkBuddy 后再试）" }
            else { Write-Host "OK   已删除: $t" }
        }
    } else {
        Write-Host "SKIP 不存在: $t"
    }
}

# 顺带清理构建缓存里的临时目录
Get-ChildItem $root -Directory -Filter '.tmp-cdp-*' -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "OK   已删除: $($_.Name)" }

Write-Host "`n完成。release/ 下的正式安装包未受影响。"
