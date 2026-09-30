# Stable launcher for a DSEmployee terminal node on Windows.
#
# Lives in scripts/ (not bin/ -- that one is gitignored by the Gitee template).
# This is the Windows twin of run-node.sh: the thing that never changes, whose only job
# is "ask which release should run, run it, and bring it back if it dies". Which code
# actually runs is decided by the pointer file:
#
#     <releases>/current.json                { release, previous, ... }
#     <releases>/<code-fingerprint>/         one frozen export per version
#
# The DECISION (run / rollback / run-anyway) is not implemented here: it lives in
# src/node/release.ts and is asked for via `dse release start-plan`. Two implementations
# of "when to roll back" would drift, and drift shows up as "rollback works on one
# machine but not the other" -- the worst kind of thing to debug at night.
#
# Why this loops instead of handing restarts to the scheduled task's RestartOnFailure:
# the node asks for a restart by exiting with EXIT_RESTART (75) after it has swapped the
# pointer. The task would bring it back, but only after its restart interval (PT1M on
# this machine), i.e. a one-minute outage on every upgrade. Looping brings it back in
# seconds and keeps this file behaviourally identical to run-node.sh; the task's
# RestartOnFailure stays as the backstop for the case where the launcher itself dies.
#
# Exit-code convention (must match src/node/* and run-node.sh):
#   0            clean shutdown -- the loop stops
#   75           "restart me, this is intentional" -- NOT counted as a crash
#   anything else, and it died within the grace window -- counted as a crash, and the
#                next iteration may decide to roll back
#
# Usage:
#   foreground:  .\scripts\start-node.ps1
#   background:  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden `
#                  -File <repo>\scripts\start-node.ps1 -Background
#
# This file is deliberately ASCII-only, and the node name is built from code points:
# Windows PowerShell 5.1 reads BOM-less scripts as ANSI, so literal CJK text here would
# risk mojibake. Every path is derived from $PSScriptRoot for the same reason (this
# workspace path itself contains CJK characters).

param([switch]$Background)

$ErrorActionPreference = 'Stop'

# --- console encoding, FIRST ----------------------------------------------
# PowerShell 5.1 decodes native-command output with [Console]::OutputEncoding, which
# defaults to the OEM code page (936 on a zh-CN box). The `release start-plan` JSON
# carries an absolute path, and on this machine that path contains CJK characters:
# decoded as GBK it turns into mojibake, the Test-Path below fails, and every start
# silently degrades to "release dir unusable". Real incident (2026-09-24): the upgrade
# button kept reporting success while the node kept running the old tree, because the
# pointer was read but its directory could not be verified.
# So this must be set BEFORE the first node invocation, not merely before the log
# pipeline that writes the child's output.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$ScriptDir = $PSScriptRoot
$Repo = Split-Path $ScriptDir -Parent          # <repo>: this scripts/ directory's parent
$Root = Split-Path $Repo -Parent               # <workspace root>: holds state + releases
$DseHome = Join-Path $Root '.dsemployee'
$NodeName = [string]([char]0x5149 + [char]0x5F71 + [char]0x7CBE + [char]0x7075)

# --- which hub -------------------------------------------------------------
# Deliberately NOT a literal. This file ships in a public repository: a hardcoded address
# publishes one operator's endpoint to everyone who clones it, while a placeholder would
# strand machines already deployed (this file is re-read only when the launcher process
# itself restarts, so the break would show up days later, at a reboot).
#
# The address therefore comes from the machine:
#   1. $env:DSE_HUB
#   2. <workspace root>/.dsemployee/hub-url -- one line, written by the node itself on
#      every start (HUB_URL_FILE in src/node/agent.ts). The node is the side that actually
#      knows the address (it arrives as --hub), so it is the side that records it; this
#      script only reads it back.
#
# A URL is not a credential -- this is hygiene, not secrecy. If neither source exists we
# refuse to start instead of guessing: silently connecting to the wrong hub is worse than
# a launcher that names exactly what is missing.
$Hub = $env:DSE_HUB
if ($Hub) { $Hub = $Hub.Trim() }
$hubFile = Join-Path $DseHome 'hub-url'
if (-not $Hub -and (Test-Path $hubFile)) {
  $line = Get-Content $hubFile -ErrorAction SilentlyContinue |
          Where-Object { $_ -and $_.Trim() } | Select-Object -First 1
  if ($line) { $Hub = $line.Trim() }
}
if (-not $Hub) {
  throw "hub URL not configured: set `$env:DSE_HUB, or write one line to $hubFile (e.g. wss://your-hub.example.com/ws)"
}

# How long a freshly started node has to prove itself. If it exits inside this window
# with a non-zero, non-75 code, that is a failed start (counted toward rollback).
$StartGraceSec = 90
# Backoff between iterations (avoid a hot loop if something fails instantly).
$RetrySec = 5

if (-not (Test-Path $Repo)) { throw "repo not found: $Repo" }

$logDir = Join-Path $Root '.node-logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir 'node.log'
# Where the launcher's own lines go when the main log cannot be opened (see below).
$launcherLog = Join-Path $logDir 'node.launcher.log'

# Append one launcher line. Uses .NET rather than Out-File: the node's own output reaches
# this file as raw bytes (through cmd's `>>`, see below), and PowerShell 5.1's
# -Encoding utf8 would inject a BOM into that stream. Same bytes in, same bytes appended.
#
# A failure here must NOT be silent. Real incident (2026-09-25): leftovers from the
# previous run still held the log open, so every line the launcher wrote was swallowed
# right here -- while the launcher was in fact working correctly (it recorded a crash and
# rolled back on its own). The empty log made it look like a hung launcher and sent the
# investigation down the wrong path for half an hour.
function Write-LauncherLog([string]$text) {
  if (-not $Background) {
    Write-Host $text
    return
  }
  $line = "$text`n"
  $utf8 = New-Object System.Text.UTF8Encoding $false
  try {
    [System.IO.File]::AppendAllText($log, $line, $utf8)
    return
  } catch { }
  try { [System.IO.File]::AppendAllText($launcherLog, $line, $utf8) } catch { }
}

# --- single-instance guard -------------------------------------------------
# Two processes sharing one node identity displace each other (the hub keeps one live
# session per device), so refuse to start a second one.
$lockFile = Join-Path $logDir 'node.pid'
if (Test-Path $lockFile) {
  $oldPid = (Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $old = $null
  if ($oldPid) { $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue }
  # The ProcessName check keeps a recycled PID from blocking startup forever.
  if ($old -and $old.ProcessName -eq 'powershell') {
    Write-Warning "node already running (PID $oldPid); refusing to start a second instance."
    exit 1
  }
}

# --- environment -----------------------------------------------------------
# A scheduled task starts with a minimal environment: make sure node.exe and the npm
# global bin dir (which holds dsh.cmd) are on PATH.
$nodeExe = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd -ne $null) { $nodeExe = $cmd.Source }
if (-not $nodeExe) {
  $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $candidate) {
    $nodeExe = $candidate
    $env:PATH = (Split-Path $candidate) + ';' + $env:PATH
  }
}
if (-not $nodeExe) { throw 'node.exe not found on PATH' }

$npmBin = Join-Path $env:APPDATA 'npm'
if (Test-Path $npmBin) { $env:PATH = $npmBin + ';' + $env:PATH }

# The same directory the hub-url lookup above read from, so both sides agree by construction.
$env:DSE_HOME = $DseHome
# The node must know where the git clone is: after an upgrade it runs from a release
# directory (a frozen export with no .git), where `dse release update` cannot fetch.
# run-node.sh exports the same variable; the pointer also records the clone as a fallback.
$env:DSE_REPO = $Repo
# Releases live next to the repo (see src/node/release.ts for why not inside it).
if (-not $env:DSE_RELEASES) { $env:DSE_RELEASES = Join-Path $Root 'dse-releases' }

$nodeArgs = @(
  'bin/dse.mjs', 'node',
  '--hub', $Hub,
  '--name', $NodeName,
  '--employee-root', (Join-Path $Repo 'employees'),
  '--dsh-home', (Join-Path $Root '.dsh-home'),
  # No --dsh-port: let the node pick a free port on every start.
  #
  # This machine used to pin 52850. The pin existed because a fixed port makes the node
  # spawn dsh with stdio=inherit instead of pipes, and pipes are refused inside the DSH
  # file sandbox -- a workaround for how the node happened to be launched back then. The
  # launcher runs under the scheduled task now, outside any sandbox, so the workaround is
  # not needed -- and it actively hurts: with a pinned port, a leftover dsh from the
  # previous run (see the exit-75 handling below) blocks the NEXT run from binding, so the
  # node would come back without its dsh, i.e. online but unable to run anything.
  # With an auto port the new run simply takes another free one, and dsh is still spawned
  # with stdio=inherit (the node resolves the port first and passes it explicitly).
  '--verbose'
)

# To let employees actually run tasks (otherwise every run fails with
# MISSING_CREDENTIAL), either append this to $nodeArgs:
#   '--dsh-env', 'DEEPSEEK_API_KEY=sk-xxx'
# or drop your existing ~/.dsh/.credentials.yaml into (Join-Path $Root '.dsh-home').

Set-Content -Path $lockFile -Value $PID

try {
  while ($true) {
    # --- which release should run? ------------------------------------------
    $codeDir = $Repo
    $release = '__source__'
    $action = 'run'
    $reason = ''

    # The repo's own copy of the CLI is asked, and it always exists and always starts:
    # the release being judged may be exactly the thing that cannot start.
    $plan = $null
    $planJson = & $nodeExe "$Repo\bin\dse.mjs" release start-plan --repo $Repo 2>$null
    if ($LASTEXITCODE -eq 0 -and $planJson) {
      try { $plan = $planJson | ConvertFrom-Json } catch { $plan = $null }
    }
    if ($plan -eq $null) {
      Write-LauncherLog '[start-node] release start-plan failed; falling back to the repo working tree'
      $reason = 'start-plan failed'
    } else {
      $release = [string]$plan.release
      $action = [string]$plan.action
      $reason = [string]$plan.reason
      if ($plan.codeDir) { $codeDir = [string]$plan.codeDir }
    }

    # Fallbacks, in order of preference: the plan, then the repo working tree.
    # A plan that cannot start is worse than no plan at all.
    if (-not $codeDir -or -not (Test-Path (Join-Path $codeDir 'bin\dse.mjs'))) {
      Write-LauncherLog "[start-node] plan unusable (dir='$codeDir'); falling back to the repo working tree"
      $codeDir = $Repo
      $release = '__source__'
      $action = 'run'
      $reason = 'plan unusable'
    }

    # A rollback is a decision about the pointer, not just about this one start:
    # write it down, otherwise every future start re-decides the same way forever.
    if ($action -eq 'rollback') {
      Write-LauncherLog "[start-node] ROLLBACK: $reason"
      & $nodeExe "$Repo\bin\dse.mjs" release switch --to $release --by launcher-rollback --repo $Repo 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        # Could not record the rollback (target missing?). Do not pretend: say so and run
        # the repo working tree, which is the one thing we know exists.
        Write-LauncherLog '[start-node] rollback could not be recorded; falling back to the repo working tree'
        $codeDir = $Repo
        $release = '__source__'
        $reason = 'rollback target unusable'
      }
    }

    $banner = "[start-node] release=$release action=$action dir=$codeDir reason=$reason"
    $startedAt = Get-Date

    if ($Background) {
      # Rotate per iteration, not once per launcher process: the launcher now lives for
      # as long as the node does, which can be weeks. Never fatal: the previous run's
      # dsh can still hold the file open for a moment.
      try {
        if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) {
          Move-Item -Force $log (Join-Path $logDir 'node.log.1')
        }
      } catch { }

      Write-LauncherLog $banner
      Set-Location $codeDir
      # Probe the log we are about to hand to cmd. `>>` has to OPEN the file, so if a
      # leftover process from the previous run still holds it, cmd fails and the node
      # never starts at all -- a silent, total outage from a logging detail. Fall back to
      # the side log instead; the child's output is then at least somewhere.
      $logTarget = $log
      try { [System.IO.File]::AppendAllText($log, '', (New-Object System.Text.UTF8Encoding $false)) }
      catch { $logTarget = $launcherLog }
      # Redirection goes through cmd.exe, NOT through a PowerShell pipeline.
      #
      # Why (real incident, 2026-09-25): `& $nodeExe @nodeArgs 2>&1 | Out-File $log` gives
      # the child a PIPE. The node spawns dsh, and dsh spawns the MCP servers; those
      # grandchildren inherit the pipe. When the node exits -- which is exactly what it
      # does for an upgrade, `exit 75` -- the grandchildren are still alive, so the pipe
      # stays open, so Out-File never sees EOF and the launcher blocks forever. The
      # restart it was asked to perform never happens, and the scheduled task's
      # RestartOnFailure cannot rescue it either (that only fires once this process
      # exits). Result on this machine: the node stayed offline for 23 minutes; the
      # moment the orphans were killed by hand the pipeline returned and the launcher
      # logged the exit-75 it had been sitting on all along.
      #
      # `cmd.exe`'s `>>` hands the child a real file handle instead: no pipe, so we get
      # control back as soon as the DIRECT child exits, and the bytes land in the log
      # verbatim (raw UTF-8, no PowerShell re-encoding step).
      $quotedArgs = ($nodeArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
      $cmdLine = '"' + $nodeExe + '" ' + $quotedArgs + ' >> "' + $logTarget + '" 2>&1'
      & cmd.exe /d /s /c $cmdLine
      $exitCode = $LASTEXITCODE
    } else {
      Write-Host $banner
      Set-Location $codeDir
      & $nodeExe @nodeArgs
      $exitCode = $LASTEXITCODE
    }

    # Parentheses matter: [int](...).TotalSeconds would cast the TimeSpan first.
    $ranSec = [int](((Get-Date) - $startedAt).TotalSeconds)

    if ($exitCode -eq 0) {
      Write-LauncherLog '[start-node] node exited cleanly; stopping'
      exit 0
    }
    if ($exitCode -eq 75) {
      # Intentional restart (the node swapped the pointer and asked to be brought back).
      # NOT a crash: counting it would corrupt the counter that drives rollback, and a
      # normal upgrade would push a healthy release toward being rolled back.
      Write-LauncherLog "[start-node] restart requested by the node (exit 75) after ${ranSec}s"
      Start-Sleep -Seconds 2
      continue
    }
    if ($ranSec -lt $StartGraceSec) {
      # Failed start: it died quickly. Count it so the NEXT start can roll back.
      # (A short-lived CLI with no grandchildren of its own, so capturing it is safe.)
      Write-LauncherLog "[start-node] child exited code=$exitCode after ${ranSec}s (< ${StartGraceSec}s grace) -- noting a crash"
      $note = & $nodeExe "$Repo\bin\dse.mjs" release note-crash --repo $Repo 2>$null
      if ($note) { Write-LauncherLog ([string]$note) }
    }
    Start-Sleep -Seconds $RetrySec
  }
}
finally {
  Remove-Item -Force $lockFile -ErrorAction SilentlyContinue
}
