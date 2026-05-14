param(
    [string]$EnvFile = ".env",
    [int]$Port = 443,
    [switch]$VerboseChecks
)

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Write-Check {
    param(
        [ValidateSet("PASS", "WARN", "FAIL", "INFO")][string]$Level,
        [string]$Message
    )

    $prefix = "[$Level]"
    switch ($Level) {
        "PASS" { Write-Host "$prefix $Message" -ForegroundColor Green }
        "WARN" { Write-Host "$prefix $Message" -ForegroundColor Yellow }
        "FAIL" { Write-Host "$prefix $Message" -ForegroundColor Red }
        default { Write-Host "$prefix $Message" -ForegroundColor Cyan }
    }
}

function Parse-EnvFile {
    param([string]$Path)

    $result = @{}
    if (-not (Test-Path $Path)) {
        return $result
    }

    foreach ($line in Get-Content -Path $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }
        $parts = $trimmed -split "=", 2
        if ($parts.Count -ne 2) {
            continue
        }
        $key = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"')
        $result[$key] = $value
    }

    return $result
}

function Split-Names {
    param([string]$Value)

    if (-not $Value) {
        return @()
    }

    return ($Value -split "[\s,;]+" | Where-Object { $_ -and $_.Trim() })
}

function Get-RemoteCertificate {
    param(
        [string]$HostName,
        [int]$TlsPort
    )

    $tcpClient = [System.Net.Sockets.TcpClient]::new()
    $tcpClient.Connect($HostName, $TlsPort)

    $callback = {
        param($sender, $cert, $chain, $sslPolicyErrors)
        return $true
    }

    $sslStream = [System.Net.Security.SslStream]::new($tcpClient.GetStream(), $false, $callback)
    $sslStream.AuthenticateAsClient($HostName)

    $remoteCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($sslStream.RemoteCertificate)

    $sslStream.Close()
    $tcpClient.Close()

    return $remoteCert
}

function Get-SanText {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)

    foreach ($extension in $Certificate.Extensions) {
        if ($extension.Oid.Value -eq "2.5.29.17") {
            return $extension.Format($false)
        }
    }
    return ""
}

function Test-WindowsTrust {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)

    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $ok = $chain.Build($Certificate)

    return [PSCustomObject]@{
        Trusted = $ok
        Status  = ($chain.ChainStatus | ForEach-Object { $_.Status.ToString() }) -join ", "
    }
}

function Test-FirefoxEnterpriseRootsEnabled {
    $policyPaths = @(
        "$env:ProgramFiles\Mozilla Firefox\distribution\policies.json",
        "$env:ProgramFiles(x86)\Mozilla Firefox\distribution\policies.json"
    )

    foreach ($policyPath in $policyPaths) {
        if (Test-Path $policyPath) {
            try {
                $policyRaw = Get-Content -Path $policyPath -Raw
                if ($policyRaw -match '"ImportEnterpriseRoots"\s*:\s*true') {
                    return $true
                }
            }
            catch {
            }
        }
    }

    $profilesRoot = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
    if (-not (Test-Path $profilesRoot)) {
        return $null
    }

    $prefsFiles = Get-ChildItem -Path $profilesRoot -Filter "prefs.js" -Recurse -ErrorAction SilentlyContinue
    foreach ($prefsFile in $prefsFiles) {
        try {
            $prefsRaw = Get-Content -Path $prefsFile.FullName -Raw
            if ($prefsRaw -match 'security.enterprise_roots.enabled",\s*true') {
                return $true
            }
        }
        catch {
        }
    }

    return $false
}

$failures = 0
$warnings = 0

Write-Check INFO "Reading configuration from $EnvFile"
$config = Parse-EnvFile -Path $EnvFile

$dnsBack = @(Split-Names -Value ($config["DNS_BACK_NAMES"]))
$dnsFront = @(Split-Names -Value ($config["DNS_FRONT_NAMES"]))
$domains = @($dnsBack + $dnsFront | Select-Object -Unique)

if ($domains.Count -eq 0) {
    Write-Check FAIL "No domains found in DNS_BACK_NAMES / DNS_FRONT_NAMES."
    exit 2
}

Write-Check INFO "Domains to check: $($domains -join ', ')"

$hostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
if (-not (Test-Path $hostsPath)) {
    Write-Check FAIL "Hosts file not found at $hostsPath"
    exit 2
}

$hostsContent = Get-Content -Path $hostsPath -Raw
foreach ($domain in $domains) {
    if ($hostsContent -match "(?m)^\s*(127\.0\.0\.1|::1)\s+.*\b$([Regex]::Escape($domain))\b") {
        Write-Check PASS "Hosts mapping exists for $domain"
    }
    else {
        Write-Check FAIL "Missing hosts mapping for $domain (expected 127.0.0.1 or ::1)"
        $failures++
    }
}

$composeRunning = cmd /c "docker compose ps progeo-nginx --status running --quiet 2>nul"
if ($LASTEXITCODE -eq 0 -and $composeRunning) {
    Write-Check PASS "Container progeo-nginx is running"
}
else {
    Write-Check FAIL "Container progeo-nginx is not running (or docker compose unavailable)"
    $failures++
}

foreach ($domain in $domains) {
    Write-Check INFO "Checking TLS for https://${domain}:$Port"

    try {
        $cert = Get-RemoteCertificate -HostName $domain -TlsPort $Port
        Write-Check PASS "TLS handshake works for $domain"

        $now = Get-Date
        if ($cert.NotAfter -lt $now) {
            Write-Check FAIL "Certificate is expired for $domain (NotAfter=$($cert.NotAfter))"
            $failures++
        }
        else {
            Write-Check PASS "Certificate expiry OK for $domain (NotAfter=$($cert.NotAfter))"
        }

        $sanText = Get-SanText -Certificate $cert
        if ($sanText -and $sanText -match [Regex]::Escape($domain)) {
            Write-Check PASS "SAN contains $domain"
        }
        else {
            Write-Check FAIL "SAN does not contain $domain"
            if ($VerboseChecks) {
                Write-Check INFO "SAN raw: $sanText"
            }
            $failures++
        }

        $trust = Test-WindowsTrust -Certificate $cert
        if ($trust.Trusted) {
            Write-Check PASS "Windows trust chain is valid for $domain"
        }
        else {
            Write-Check FAIL "Windows trust chain invalid for $domain ($($trust.Status))"
            $failures++
        }
    }
    catch {
        Write-Check FAIL "HTTPS/TLS check failed for ${domain}: $($_.Exception.Message)"
        $failures++
    }
}

$ffEnterpriseRoots = Test-FirefoxEnterpriseRootsEnabled
if ($ffEnterpriseRoots -eq $true) {
    Write-Check PASS "Firefox enterprise roots are enabled (should trust mkcert if Windows trusts it)."
}
elseif ($ffEnterpriseRoots -eq $false) {
    Write-Check WARN "Firefox enterprise roots are not enabled. Firefox may reject mkcert certs."
    Write-Check INFO "Fix: set security.enterprise_roots.enabled=true in about:config, or add Firefox policy ImportEnterpriseRoots=true."
    $warnings++
}
else {
    Write-Check WARN "Could not determine Firefox profile/policy state."
    $warnings++
}

Write-Host ""
if ($failures -gt 0) {
    Write-Check FAIL "HTTPS check finished with $failures failure(s) and $warnings warning(s)."
    exit 1
}

if ($warnings -gt 0) {
    Write-Check WARN "HTTPS check finished with 0 failures and $warnings warning(s)."
    exit 0
}

Write-Check PASS "HTTPS check finished with no failures/warnings."
exit 0
