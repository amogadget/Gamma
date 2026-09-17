param([Parameter(Mandatory = $true)][string]$ServerUrl)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw 'Install the Codex CLI first: https://learn.chatgpt.com/docs/cli'
}
$gammaUri = [Uri]$ServerUrl
if (-not $gammaUri.IsAbsoluteUri -or $gammaUri.UserInfo -or $gammaUri.Query -or $gammaUri.Fragment -or
    $gammaUri.AbsolutePath -ne '/mcp' -or
    ($gammaUri.Scheme -ne 'https' -and -not ($gammaUri.Scheme -eq 'http' -and $gammaUri.IsLoopback))) {
    throw 'Use the Gamma MCP URL from External assistants (HTTPS, or HTTP localhost).'
}

# Release packaging pins both the version and the archive digest into this file.
$gammaDownload = '__GAMMA_ARCHIVE_URL__'
$gammaDigest = '__GAMMA_ARCHIVE_SHA256__'
$gammaRoot = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Gamma/codex-plugin' } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.local/share/gamma/codex-plugin' }
New-Item -ItemType Directory -Path $gammaRoot -Force | Out-Null
$gammaRoot = (Resolve-Path -LiteralPath $gammaRoot).Path
$gammaInstall = Join-Path $gammaRoot ([Guid]::NewGuid().ToString('N'))
$gammaMarketplace = Join-Path $gammaRoot 'gamma-marketplace'
$gammaPrevious = Join-Path $gammaInstall 'previous'
$gammaStaged = Join-Path $gammaInstall 'gamma-marketplace'
# Validate absolute operation targets before moving or recursively removing them.
$gammaPrefix = $gammaRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
foreach ($gammaPath in @($gammaInstall, $gammaMarketplace, $gammaPrevious, $gammaStaged)) {
    if (-not [IO.Path]::GetFullPath($gammaPath).StartsWith($gammaPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The plugin installation path must stay inside the Gamma plugin directory.'
    }
}
New-Item -ItemType Directory -Path $gammaInstall | Out-Null
try {
    $gammaArchive = Join-Path $gammaInstall 'gamma-marketplace.zip'
    Write-Host 'Downloading the Gamma PDF plugin...'
    Invoke-WebRequest -UseBasicParsing -Uri $gammaDownload -OutFile $gammaArchive
    if ((Get-FileHash -LiteralPath $gammaArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $gammaDigest) {
        throw 'The Gamma plugin download is incomplete or changed. Run setup again.'
    }
    Expand-Archive -LiteralPath $gammaArchive -DestinationPath $gammaInstall
    if (-not (Test-Path -LiteralPath (Join-Path $gammaStaged '.agents/plugins/marketplace.json'))) {
        throw 'The Gamma plugin package is missing its marketplace catalog.'
    }
    # Replace the whole package so removed skills cannot survive an upgrade.
    # Keep the old source until the new directory has been moved into place.
    if (Test-Path -LiteralPath $gammaMarketplace) {
        Move-Item -LiteralPath $gammaMarketplace -Destination $gammaPrevious
    }
    Move-Item -LiteralPath $gammaStaged -Destination $gammaMarketplace
} finally {
    if ((Test-Path -LiteralPath $gammaPrevious) -and -not (Test-Path -LiteralPath $gammaMarketplace)) {
        # If restoration fails, stop here and retain the backup for recovery.
        Move-Item -LiteralPath $gammaPrevious -Destination $gammaMarketplace
    }
    Remove-Item -LiteralPath $gammaInstall -Recurse -Force
}
& codex plugin marketplace add $gammaMarketplace
if ($LASTEXITCODE -ne 0) { throw 'Could not register the Gamma marketplace. See the Codex error above. If gamma-local uses another source, remove that registration in Codex before switching to this installer.' }
& codex plugin add gamma@gamma-local
if ($LASTEXITCODE -ne 0) { throw 'Could not install Gamma PDF. Update your Codex CLI and retry.' }
Write-Host 'Connecting Gamma. Approve the workspace in your browser.'
# mcp add performs OAuth login itself. Do not immediately start a second login.
& codex mcp add gamma --url $ServerUrl
if ($LASTEXITCODE -ne 0) { throw 'Gamma PDF is installed, but connection failed. Retry with: codex mcp login gamma' }
Write-Host 'Gamma PDF is installed. Start a new chat and mention @Gamma PDF.'
