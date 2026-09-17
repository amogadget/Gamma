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
# Keep marketplace sources in a persistent directory, never the temp directory.
$gammaInstall = Join-Path $gammaRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $gammaInstall -Force | Out-Null
$gammaArchive = Join-Path $gammaInstall 'gamma-marketplace.zip'
Write-Host 'Downloading the Gamma PDF plugin...'
Invoke-WebRequest -UseBasicParsing -Uri $gammaDownload -OutFile $gammaArchive
if ((Get-FileHash -LiteralPath $gammaArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $gammaDigest) {
    throw 'The Gamma plugin download is incomplete or changed. Run setup again.'
}
Expand-Archive -LiteralPath $gammaArchive -DestinationPath $gammaInstall
$gammaMarketplace = Join-Path $gammaInstall 'gamma-marketplace'
if (-not (Test-Path -LiteralPath (Join-Path $gammaMarketplace '.agents/plugins/marketplace.json'))) {
    throw 'The Gamma plugin package is missing its marketplace catalog.'
}
# A stable source path lets subsequent runs update the same marketplace.
Copy-Item -LiteralPath $gammaMarketplace -Destination $gammaRoot -Recurse -Force
$gammaMarketplace = Join-Path $gammaRoot 'gamma-marketplace'
& codex plugin marketplace add $gammaMarketplace
if ($LASTEXITCODE -ne 0) { throw 'Could not register the Gamma marketplace. See the Codex error above. If gamma-local uses another source, remove that registration in Codex before switching to this installer.' }
& codex plugin add gamma@gamma-local
if ($LASTEXITCODE -ne 0) { throw 'Could not install Gamma PDF. Update your Codex CLI and retry.' }
Write-Host 'Connecting Gamma. Approve the workspace in your browser.'
# mcp add performs OAuth login itself. Do not immediately start a second login.
& codex mcp add gamma --url $ServerUrl
if ($LASTEXITCODE -ne 0) { throw 'Gamma PDF is installed, but connection failed. Retry with: codex mcp login gamma' }
Write-Host 'Gamma PDF is installed. Start a new chat and mention @Gamma PDF.'
