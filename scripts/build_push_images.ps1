<#
.SYNOPSIS
    Build, tag, sign and push all progeo images to Docker Hub (Windows / PowerShell).

.DESCRIPTION
    Equivalent of scripts/build_push_images.sh for Windows. Builds the local
    images, tags them as progeomonitoring/detection-docker-setup:<service>-<VERSION>
    (database, backend, frontend, nginx, optionally cad_factory), signs them
    via Docker Content Trust (DCT) and pushes them.

    Usage:
      $env:VERSION = '1.0.0'; .\scripts\build_push_images.ps1   # explicit version
      .\scripts\build_push_images.ps1                            # version = date (yyyy.MM.dd)
      $env:INCLUDE_CAD_FACTORY = '1'; .\scripts\build_push_images.ps1

    Signing (Docker Content Trust):
      DCT is enabled for every push. Provide the key passphrases via the
      environment (never stored or printed here):
        DOCKER_CONTENT_TRUST_ROOT_PASSPHRASE
        DOCKER_CONTENT_TRUST_REPOSITORY_PASSPHRASE
        DOCKER_CONTENT_TRUST_TAGGING_PASSPHRASE
      On the first push DCT creates the keys using those passphrases (or
      prompts interactively when they are not set).

    Credentials:
      docker login is performed securely - the password is piped via
      --password-stdin and never appears on the command line or in the output.
      Set DOCKER_USERNAME (and DOCKER_PASSWORD, e.g. from a secret manager) to
      log in non-interactively; otherwise you are prompted securely. If you
      are already logged in, your session is reused and left untouched.

      NOTE: if your Docker Hub account has 2FA enabled, the account password
      will NOT work for docker login - use a personal access token
      (hub.docker.com -> Account Settings -> Personal access tokens) as the
      password instead.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
# Native commands (docker) legitimately write warnings to stderr (e.g.
# "No blkio throttle.read_bps_device support"). In PowerShell 7.3+ those
# would become terminating errors with $ErrorActionPreference='Stop'. Keep the
# classic behavior (warnings are displayed but non-fatal) and check real
# failures via $LASTEXITCODE after each docker call instead.
$PSNativeCommandUseErrorActionPreference = $false

function Say { param([string]$Message) Write-Host "[build-push] $Message" -ForegroundColor Cyan }
function Fail { param([string]$Message) Write-Error "[build-push] ERROR: $Message"; exit 1 }

# ---------------------------------------------------------------------------
# Config (env overrides, same names as the bash script)
# ---------------------------------------------------------------------------
if (-not $env:REPO) { $env:REPO = 'progeomonitoring/detection-docker-setup' }
if (-not $env:REGISTRY) { $env:REGISTRY = 'docker.io' }
if (-not $env:VERSION) { $env:VERSION = Get-Date -Format 'yyyy.MM.dd' }
if (-not $env:LOCAL_PREFIX) { $env:LOCAL_PREFIX = 'detection-docker-setup-progeo' }

# Services built from this repo (redis uses a public image and is not built).
$SERVICES = @('database', 'backend', 'frontend', 'nginx')
if ($env:INCLUDE_CAD_FACTORY -eq '1') { $SERVICES += 'cad_factory' }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker is required' }

# ---------------------------------------------------------------------------
# 1) Login (only when needed) - credentials never on the command line
# ---------------------------------------------------------------------------
$script:LoggedInHere = $false

function Login-Docker {
    param([string]$Username)

    $Username = $Username.Trim()
    $password = if ($env:DOCKER_PASSWORD) { $env:DOCKER_PASSWORD.Trim() } else { $null }
    if (-not $password) {
        if ([Console]::IsInputRedirected) {
            Fail 'no password available and stdin is not a terminal - set DOCKER_USERNAME and DOCKER_PASSWORD (e.g. from a secret manager) or run this script interactively'
        }
        $secure = Read-Host -AsSecureString "Docker Hub password for $Username (use an access token when 2FA is enabled)"
        if (-not $secure) { Fail 'empty password - docker login aborted' }
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            $secure.Dispose()
        }
    }
    $password = $password.Trim()
    if (-not $password) { Fail 'empty password - docker login aborted' }

    $output = $password | docker login $env:REGISTRY -u $Username --password-stdin 2>&1
    $code = $LASTEXITCODE
    $password = $null   # drop the plaintext immediately
    Remove-Item Env:DOCKER_PASSWORD -ErrorAction SilentlyContinue
    if ($code -ne 0) { Fail "docker login failed for user '$Username': $output" }
    $script:LoggedInHere = $true
}

if ($env:DOCKER_USERNAME) {
    # Explicit credentials: always perform a fresh login - never reuse a
    # possibly stale/malformed credential from ~/.docker/config.json.
    Login-Docker -Username $env:DOCKER_USERNAME
}
else {
    # Interactive: reuse an existing session when present, otherwise log in.
    $loggedIn = docker info 2>$null | Select-String -Quiet 'username:'
    if ($loggedIn) {
        Say "Already logged in to $($env:REGISTRY) - reusing session."
    }
    else {
        $env:DOCKER_USERNAME = Read-Host 'Docker Hub username'
        Login-Docker -Username $env:DOCKER_USERNAME
    }
}


# ---------------------------------------------------------------------------
# 2) Build (cad_factory only when requested, via its compose profile)
# ---------------------------------------------------------------------------
Say "Building images (version $($env:VERSION))..."
if ($env:INCLUDE_CAD_FACTORY -eq '1') {
    $env:COMPOSE_PROFILES = 'cad_factory'
}
docker compose build
if ($LASTEXITCODE -ne 0) { Fail 'docker compose build failed' }

# ---------------------------------------------------------------------------
# 3) Tag, sign and push every image
# ---------------------------------------------------------------------------
$env:DOCKER_CONTENT_TRUST = '1'
if (-not $env:DOCKER_CONTENT_TRUST_SERVER) { $env:DOCKER_CONTENT_TRUST_SERVER = 'https://notary.docker.io' }

foreach ($service in $SERVICES) {
    $localImage = "$($env:LOCAL_PREFIX)-${service}:latest"
    $remoteImage = "$($env:REPO):$service-$($env:VERSION)"

    Say "Tagging $localImage -> $remoteImage"
    docker tag $localImage $remoteImage
    if ($LASTEXITCODE -ne 0) { Fail "docker tag failed for $localImage" }

    Say "Signing + pushing $remoteImage (DCT enabled)"
    $pushOutput = docker push $remoteImage 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($pushOutput -match 'authentication|malformed|unauthorized|denied') {
            Fail "docker push failed for $remoteImage - auth problem. Run 'docker logout' once, then re-run this script (fresh login): $pushOutput"
        }
        Fail "docker push failed for ${remoteImage}: $pushOutput"
    }
}

Say "Done: signed images pushed to $($env:REPO) with tag suffix -$($env:VERSION)"
Say "Deploy with: IMAGE_VERSION=$($env:VERSION) docker compose -f docker-compose.prod.yml up -d"

if ($script:LoggedInHere) {
    docker logout $env:REGISTRY 2>$null | Out-Null
}
