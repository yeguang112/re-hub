# 直连推送到 GitHub（绕过失效的代理，带重试）
#
# 背景：本机 Clash(127.0.0.1:7890) 对 GitHub 的 TLS 握手不可用
#       （schannel: failed to receive handshake），而 GitHub 直连会被
#       reset / 挂起，只能靠重试。OpenSSL 后端 + 无代理 实测可通。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\push-direct.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\push-direct.ps1 -Branch main -Retries 6
param(
  [string]$Remote = 'origin',
  [string]$Branch = 'main',
  [int]$Retries = 6,
  [int]$TimeoutSec = 45
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Clear-ProxyEnv {
  $env:HTTPS_PROXY = ''; $env:HTTP_PROXY = ''; $env:ALL_PROXY = ''
  $env:NO_PROXY = '*'
  $env:GIT_TERMINAL_PROMPT = '0'
}

for ($i = 1; $i -le $Retries; $i++) {
  Write-Host "== 直连推送尝试 $i/$Retries ==" -ForegroundColor Cyan
  $job = Start-Job -ScriptBlock {
    param($repo, $Remote, $Branch)
    Set-Location $repo
    $env:HTTPS_PROXY = ''; $env:HTTP_PROXY = ''; $env:ALL_PROXY = ''
    $env:NO_PROXY = '*'; $env:GIT_TERMINAL_PROMPT = '0'
    $o = git -c http.sslBackend=openssl -c http.proxy= -c https.proxy= push $Remote $Branch 2>&1
    [pscustomobject]@{ code = $LASTEXITCODE; out = (($o | Out-String).Trim()) }
  } -ArgumentList $repo, $Remote, $Branch

  if (Wait-Job $job -Timeout $TimeoutSec) {
    $res = Receive-Job $job
    Remove-Job $job -Force
    if ($res -and $res.out) { Write-Host $res.out }
    if ($res -and $res.code -eq 0) {
      Write-Host "OK 推送成功（$Remote/$Branch）" -ForegroundColor Green
      exit 0
    }
    Write-Host "  失败 exit=$($res.code)" -ForegroundColor Yellow
  } else {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force
    Write-Host "  超时 ${TimeoutSec}s（直连被挂起）" -ForegroundColor Yellow
  }

  if ($i -lt $Retries) { Start-Sleep -Seconds 3 }
}

Write-Host "FAIL 直连推送失败：GitHub 直连被 reset/挂起。" -ForegroundColor Red
Write-Host "  可选：修好代理节点后用 git push；或改用 SSH（ssh.github.com:443）。"
exit 1
