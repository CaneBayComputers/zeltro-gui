# Set up zeltro-gui on a fresh Windows box, and open SSH so it can be driven
# remotely afterwards.
#
# Windows is REMOTE-ONLY for Zeltro: there is no local CLI to install, because
# Zeltro is Docker plus bash scripts. The GUI here talks to Zeltro on other
# machines over SSH. So this installs the GUI and nothing else Zeltro-related -
# projects live on the Linux and Mac hosts you add under Settings.
#
# Every step is idempotent. Re-running is the supported way to update.
#
# Normally invoked by install-windows.bat, which handles elevation.

# Remote access is OPT-IN and takes the key from whoever runs it. Nothing here
# authorises anybody by default, and no key is baked into this file.
#
# An installer that shipped a hardcoded public key would silently grant its
# author SSH access to every machine it ran on. That is a backdoor regardless of
# intent, and a public key being safe to publish does not make it safe to
# INSTALL on someone else's computer.
param(
    # Skip the remote-access question and set it up. For unattended runs; an
    # ordinary run just asks.
    [switch]$EnableSsh,

    # Never ask, never set it up. For unattended runs on a normal install.
    [switch]$NoSsh,

    # A public key to authorise, in authorized_keys format. Prompted for if
    # remote access is wanted and this was not supplied.
    [string]$PublicKey = ''
)

$ErrorActionPreference = 'Stop'

# Without this, an unhandled error closes the window instantly and the reason
# goes with it - which is exactly what happened on the first real install: red
# text flashed and the terminal vanished, leaving no way to know what failed.
trap {
    Write-Host ""
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  at: $($_.InvocationInfo.PositionMessage)" -ForegroundColor DarkGray
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

$REPO_URL  = 'https://github.com/CaneBayComputers/zeltro-gui.git'
$BRANCH    = 'dev'
$REPO_DIR  = 'C:\zeltro-gui'
$NODE_VER  = '20.19.3'

function Say  ($m) { Write-Host "  $m" }
function Step ($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host ""; Write-Host "FAILED: $m" -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
# Only the SSH server needs elevation; installing the GUI does not. The
# question is asked either way, and declined with an explanation if this is not
# an elevated session, rather than failing after the user has already said yes.
if ($EnableSsh -and -not $isAdmin) {
    Die "-EnableSsh needs Administrator rights (it installs a Windows feature and a firewall rule)."
}

Write-Host ""
Write-Host "Zeltro GUI - Windows setup" -ForegroundColor Green
Say "user: $($id.Name)"
Say "windows: $((Get-CimInstance Win32_OperatingSystem).Caption)"

# --- SSH server (opt-in) ---------------------------------------------------
# Only for machines you intend to drive remotely - a test box, or your own
# workstation. Skipped entirely unless asked for.
Step "Remote access"
Say "Optional. Installs an OpenSSH server so this machine can be reached from"
Say "another computer - useful for a test box, unnecessary for ordinary use."

$wantSsh = $false
if ($EnableSsh)      { $wantSsh = $true;  Say "enabled by -EnableSsh" }
elseif ($NoSsh)      { $wantSsh = $false; Say "skipped by -NoSsh" }
elseif (-not $isAdmin) {
    # Asking would be dishonest: saying yes could not be acted on.
    Say "not offered - this is not an elevated session, and installing a"
    Say "Windows feature needs one. Re-run as administrator if you want it."
} else {
    Write-Host ""
    # Defaults to no. Opening a listening service is not something to arrive at
    # by pressing Enter without reading.
    $answer = Read-Host "  Set up remote SSH access? [y/N]"
    $wantSsh = $answer -match '^(y|yes)$'
    if (-not $wantSsh) { Say "skipped" }
}

if ($wantSsh) {
    if (-not $PublicKey) {
        Write-Host ""
        Say "Paste the PUBLIC key to authorise (the contents of a .pub file)."
        Say "It grants whoever holds the matching private key SSH access to this"
        Say "machine, so only paste a key you control."
        Write-Host ""
        $PublicKey = (Read-Host "  public key").Trim()
    }
    if ($PublicKey -notmatch '^(ssh-rsa|ssh-ed25519|ecdsa-sha2-\S+)\s+\S+') {
        Die "That does not look like a public key. Expected a line starting ssh-rsa, ssh-ed25519 or ecdsa-sha2-*."
    }
    # A private key pasted by mistake would be published into authorized_keys
    # and, worse, the user would think it was the right thing to do.
    if ($PublicKey -match 'PRIVATE KEY') { Die "That is a PRIVATE key. Paste the .pub file instead." }

    Step "OpenSSH Server"
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    if ($cap.State -ne 'Installed') {
        Say "installing (this takes a minute)..."
        Add-WindowsCapability -Online -Name $cap.Name | Out-Null
        Say "installed"
    } else { Say "already installed" }

    Set-Service -Name sshd -StartupType Automatic
    if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd; Say "service started" }
    else { Say "service already running" }

    if (-not (Get-NetFirewallRule -Name 'sshd-zeltro' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'sshd-zeltro' -DisplayName 'OpenSSH Server (Zeltro)' `
            -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
        Say "firewall rule added for port 22"
    } else { Say "firewall rule already present" }

    # The gotcha that silently breaks key auth on Windows: for any account in
    # the Administrators group, sshd ignores ~/.ssh/authorized_keys entirely and
    # reads C:\ProgramData\ssh\administrators_authorized_keys instead - and it
    # REFUSES that file unless its ACL grants only SYSTEM and Administrators.
    # Get either wrong and sshd falls back to asking for a password with no
    # error explaining why.
    Step "Authorised key"
    $inAdmins = ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($inAdmins) {
        $keyFile = "$env:ProgramData\ssh\administrators_authorized_keys"
        Say "account is an administrator -> $keyFile"
    } else {
        $keyFile = "$env:USERPROFILE\.ssh\authorized_keys"
        New-Item -ItemType Directory -Force -Path (Split-Path $keyFile) | Out-Null
        Say "standard account -> $keyFile"
    }

    $existing = if (Test-Path $keyFile) { Get-Content $keyFile -Raw } else { '' }
    if ($existing -notmatch [regex]::Escape($PublicKey.Split(' ')[1])) {
        # ASCII deliberately. PowerShell 5.1's -Encoding UTF8 writes a BOM, and
        # sshd treats a BOM as part of the first key, so it never matches.
        $lines = @()
        if ($existing.Trim()) { $lines += $existing.Trim() }
        $lines += $PublicKey
        Set-Content -Path $keyFile -Value ($lines -join "`r`n") -Encoding ASCII
        Say "key added: $($PublicKey.Split(' ')[-1])"
    } else { Say "key already present" }

    if ($inAdmins) {
        icacls $keyFile /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
        Say "permissions locked to SYSTEM + Administrators"
    }

    # PowerShell rather than cmd, because everything worth running remotely here
    # is PowerShell. Without this, `ssh host "command"` lands in cmd.exe.
    $sshReg = 'HKLM:\SOFTWARE\OpenSSH'
    if (-not (Test-Path $sshReg)) { New-Item -Path $sshReg -Force | Out-Null }
    Set-ItemProperty -Path $sshReg -Name DefaultShell `
        -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    Say "default shell set to PowerShell"

    Restart-Service sshd
    Say "sshd restarted to pick up the key and shell"
}

# --- Git and Node ----------------------------------------------------------
Step "Git and Node.js"

function Have ($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
}

$haveWinget = Have winget

if (-not (Have git)) {
    if ($haveWinget) {
        Say "installing Git via winget..."
        winget install --id Git.Git -e --source winget --silent `
            --accept-source-agreements --accept-package-agreements | Out-Null
    } else {
        # winget ships with App Installer, which is absent on some Windows 10
        # builds. Fall back to the release the Git project publishes.
        Say "winget not available; downloading Git installer..."
        $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest'
        $url = ($rel.assets | Where-Object { $_.name -like '*64-bit.exe' } | Select-Object -First 1).browser_download_url
        if (-not $url) { Die "Could not find a Git installer to download." }
        $exe = "$env:TEMP\git-installer.exe"
        Invoke-WebRequest $url -OutFile $exe
        Start-Process $exe -ArgumentList '/VERYSILENT','/NORESTART' -Wait
    }
    RefreshPath
    if (Have git) { Say "git installed: $(git --version)" } else { Warn "git still not on PATH - a reboot may be needed" }
} else { Say "git already installed: $(git --version)" }

if (-not (Have node)) {
    if ($haveWinget) {
        Say "installing Node.js LTS via winget..."
        winget install --id OpenJS.NodeJS.LTS -e --source winget --silent `
            --accept-source-agreements --accept-package-agreements | Out-Null
    } else {
        Say "winget not available; downloading Node $NODE_VER..."
        $msi = "$env:TEMP\node-install.msi"
        Invoke-WebRequest "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-x64.msi" -OutFile $msi
        Start-Process msiexec.exe -ArgumentList '/i',"`"$msi`"",'/qn','/norestart' -Wait
    }
    RefreshPath
    if (Have node) { Say "node installed: $(node --version)" } else { Warn "node still not on PATH - a reboot may be needed" }
} else { Say "node already installed: $(node --version)" }

if (-not (Have git) -or -not (Have node)) {
    Die "git and node must both be on PATH. Reboot and re-run this script."
}

# --- The GUI itself --------------------------------------------------------
# From source rather than a packaged installer: there is no Windows build
# target configured, an unsigned .exe trips SmartScreen, and a checkout updates
# with `git pull` instead of a rebuild-and-reinstall cycle.
Step "Zeltro GUI"
if (Test-Path "$REPO_DIR\.git") {
    Say "updating existing checkout at $REPO_DIR"
    git -C $REPO_DIR fetch -q origin
    git -C $REPO_DIR checkout -q $BRANCH
    git -C $REPO_DIR reset -q --hard "origin/$BRANCH"
} else {
    Say "cloning into $REPO_DIR ..."
    git clone -q --branch $BRANCH $REPO_URL $REPO_DIR
}
Say "at $(git -C $REPO_DIR rev-parse --short HEAD) on $BRANCH"

Push-Location $REPO_DIR
try {
    # Native commands are run with ErrorActionPreference relaxed. npm writes
    # warnings to stderr, and under 'Stop' PowerShell turns any stderr line from
    # a native command into a terminating error - so a routine npm warning killed
    # the first real run partway through, leaving node_modules without its .bin
    # shims and no tsc.
    #
    # npm.cmd rather than npm: bare `npm` resolves to npm.ps1, which the default
    # execution policy refuses to load.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Say "installing dependencies (several minutes on a first run)..."
        & npm.cmd install --no-audit --no-fund 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Warn "npm install reported errors - retrying once"
            & npm.cmd install --no-audit --no-fund 2>&1 | Out-Null
        }
        # The shim directory is the thing that actually has to exist; a partial
        # install leaves the packages but not the executables.
        if (-not (Test-Path "$REPO_DIR\node_modules\.bin")) {
            Die "npm install did not complete - node_modules\.bin is missing. Run 'npm install' in $REPO_DIR."
        }
        Say "dependencies installed"

        Say "building..."
        & npm.cmd run build-ts 2>&1 | Out-Null
        if (-not (Test-Path "$REPO_DIR\dist\main.js")) {
            Die "TypeScript build failed. Run 'npm run build-ts' in $REPO_DIR to see why."
        }
        Say "built"
    } finally { $ErrorActionPreference = $prev }
} finally { Pop-Location }

# A launcher, so starting it is not a command to remember.
$launcher = "$REPO_DIR\zeltro-gui.bat"
Set-Content -Path $launcher -Encoding ASCII -Value @"
@echo off
cd /d "$REPO_DIR"
call npm run build-ts >nul 2>&1
start "" npx electron dist\main.js
"@
# Shortcuts on the Desktop AND in the Start Menu.
#
# The Start Menu one is what most people actually use — it is what typing
# "zeltro" into the search box finds, and a desktop icon is easy to lose under
# windows or delete while tidying up.
#
# Both get an explicit .ico. Without one a shortcut to a .bat shows the generic
# batch-file icon, which is what this did before.
$shell = New-Object -ComObject WScript.Shell
$icon  = Join-Path $REPO_DIR 'assets\icon.ico'

function New-ZeltroShortcut($path) {
    $sc = $shell.CreateShortcut($path)
    $sc.TargetPath = $launcher
    $sc.WorkingDirectory = $REPO_DIR
    $sc.Description = 'Zeltro — local development environments'
    # A .bat launcher always opens a console window; minimised keeps it out of
    # the way rather than flashing a black box over whatever is on screen.
    $sc.WindowStyle = 7
    if (Test-Path $icon) { $sc.IconLocation = $icon }
    $sc.Save()
}

New-ZeltroShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Zeltro.lnk')
Say "desktop shortcut created"

# Per-user rather than all-users: the checkout lives under one account and the
# launcher builds into it, so a shortcut offered to every user would point at a
# directory they may not be able to write.
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Zeltro.lnk'
New-ZeltroShortcut $startMenu
Say "start menu entry created"

# --- Summary ---------------------------------------------------------------
$ips = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Say "repo:     $REPO_DIR"
Say "launch:   the 'Zeltro GUI' desktop shortcut"
if ($wantSsh) {
    Say "ssh:      ssh $($id.Name.Split('\')[-1])@$($ips -join ' or ')"
}
Write-Host ""
Say "Zeltro projects live on the hosts you add under Settings > SSH Hosts."
Say "Windows has no local Zeltro - that is by design, not a missing step."
if ($wantSsh) {
    Write-Host ""
    # The one change here that could make SSH awkward if PowerShell misbehaves
    # on a given machine, so the undo is printed rather than looked up later.
    Say "SSH sessions open in PowerShell. To switch back to cmd.exe:"
    Say "  Remove-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell"
    Write-Host ""
    Say "To revoke access later, remove the key from:"
    Say "  $keyFile"
}
Write-Host ""
Read-Host "Press Enter to close"
