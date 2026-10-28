<#
.SYNOPSIS
  Start the Pixel Agents office as a standalone server reachable from the phone over Tailscale only.

.DESCRIPTION
  Runs this fork's CLI (dist/cli.js) bound to the machine's Tailscale IPv4 address (never 0.0.0.0,
  never the LAN), on a fixed port, with the embedded terminal on, from the game folder (so
  "+ Agent" starts the boss there). Writes the tokened URL to ~/.pixel-agents/office_url.txt,
  readable by the current user only, and prints it.

  The token in the URL is the key: whoever has it (and can reach the tailnet) can run commands as
  you through the office's terminal. Rotate it with -RotateToken (stop the office first).

  If the office already runs on that port, the script only rewrites the URL file.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\office\start_office.ps1
  powershell -ExecutionPolicy Bypass -File tools\office\start_office.ps1 -Stop
  powershell -ExecutionPolicy Bypass -File tools\office\start_office.ps1 -Stop; powershell -File tools\office\start_office.ps1 -RotateToken
#>
param(
  [int]$Port = 47231,
  [string]$ProjectDir = 'C:\Users\hight\Documents\Unreal Projects\Underlives',
  [switch]$RotateToken,
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cli = Join-Path $repo 'dist\cli.js'
$stateDir = Join-Path $env:USERPROFILE '.pixel-agents'
$urlFile = Join-Path $stateDir 'office_url.txt'
$logDir = Join-Path $stateDir 'office'
$log = Join-Path $logDir 'office.log'
$pidFile = Join-Path $logDir 'office.pid'

function Get-OfficeProcess {
  if (-not (Test-Path $pidFile)) { return $null }
  $officePid = [int](Get-Content $pidFile -Raw)
  $p = Get-Process -Id $officePid -ErrorAction SilentlyContinue
  if ($p -and ($p.ProcessName -eq 'cmd' -or $p.ProcessName -eq 'node')) { return $p }
  return $null
}

if ($Stop) {
  $p = Get-OfficeProcess
  if ($p) { taskkill /PID $p.Id /T /F | Out-Null; Write-Output "Office stopped (pid $($p.Id))." }
  else { Write-Output 'Office not running.' }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  return
}

if (-not (Test-Path $cli)) { throw "No build at $cli : run 'npm install' then 'npm run package' in $repo first." }

# Tailscale only: the address the phone reaches through the tailnet, nothing else.
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }
if (-not (Test-Path $ts)) {
  throw 'Tailscale is not installed: this office is only ever served on the Tailscale address. Install Tailscale (https://tailscale.com/download) and sign in, then run this again.'
}
$ip = ((& $ts ip -4) | Select-Object -First 1)
if ($ip) { $ip = $ip.Trim() }
if ($ip -notmatch '^100\.\d+\.\d+\.\d+$') { throw "No Tailscale IPv4 address ('$ip'): is Tailscale connected?" }
$dnsName = $null
try { $dnsName = ((& $ts status --json) | Out-String | ConvertFrom-Json).Self.DNSName.TrimEnd('.') } catch { }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-UrlFile([string]$token) {
  $lines = @("http://${ip}:${Port}/?token=$token")
  if ($dnsName) { $lines += "http://${dnsName}:${Port}/?token=$token" }
  Set-Content -Path $urlFile -Value $lines -Encoding utf8
  # Private: the token is a key to a shell.
  icacls $urlFile /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
  Write-Output "Office: $($lines[0])"
  if ($dnsName) { Write-Output "        $($lines[1])" }
  Write-Output "(saved in $urlFile, readable by $env:USERNAME only)"
}

$running = Get-OfficeProcess
if ($running) {
  if ($RotateToken) { throw "The office is running (pid $($running.Id)): stop it first with -Stop, then -RotateToken." }
  $token = (Get-Content (Join-Path $stateDir 'standalone-token') -Raw).Trim()
  Write-UrlFile $token
  return
}

$cliArgs = "--host $ip --port $Port"
if ($dnsName) { $cliArgs += " --allowed-host $dnsName" }
if ($RotateToken) { $cliArgs += ' --rotate-token' }
Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue

# Detached through WMI: the office must not inherit this console's handles (a caller waiting on
# this script's output would otherwise wait for the office to exit), and runs without a window.
$cmdLine = "cmd.exe /d /c node `"$cli`" $cliArgs > `"$log`" 2> `"$log.err`""
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $cmdLine; CurrentDirectory = $ProjectDir; ProcessStartupInformation = $startup
}
if ($r.ReturnValue -ne 0) { throw "Could not start the office (Win32_Process.Create returned $($r.ReturnValue))." }
$p = Get-Process -Id $r.ProcessId
Set-Content -Path $pidFile -Value $p.Id

# The CLI prints "Pixel Agents server running at http://<host>:<port>/?token=<token>".
$deadline = (Get-Date).AddSeconds(30)
$token = $null
while ((Get-Date) -lt $deadline -and -not $token) {
  Start-Sleep -Milliseconds 500
  if ($p.HasExited) { break }
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'running at http://\S+\?token=([0-9a-fA-F-]+)' | Select-Object -Last 1
    if ($m) { $token = $m.Matches[0].Groups[1].Value }
  }
}
if (-not $token) {
  Write-Output (Get-Content $log, "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 30)
  throw "The office did not start (log: $log)."
}
Write-UrlFile $token
Write-Output "Office running (pid $($p.Id)); log: $log. Stop: start_office.ps1 -Stop"
