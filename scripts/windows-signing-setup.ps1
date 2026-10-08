# windows-signing-setup.ps1: point `tauri build` at Azure Artifact Signing.
#
# Runs in release.yml's Windows lane, and only when scripts/signing-config.sh
# found all six Azure secrets. Without them this script is never called and the
# installers are built unsigned, as before.
#
# What it sets up is Microsoft's own documented route, with no third party
# tool in between (learn.microsoft.com/azure/artifact-signing/
# how-to-signing-integrations, read 2026-10-08): SignTool from the Windows SDK
# loads the Artifact Signing dlib, and the dlib asks the service to sign. The
# certificate never leaves Azure, so there is no .pfx and nothing to import.
#
#   1. Fetch the dlib package from nuget.org, pinned by version and sha256.
#   2. Find a SignTool the dlib supports.
#   3. Write metadata.json (endpoint, account, certificate profile).
#   4. Write a Tauri config overlay that sets bundle.windows.signCommand, and
#      hand its path to the build step as an extra --config argument.
#
# With a signCommand in place the bundler signs, read at tauri-cli 2.10.1: the
# main binary, every externalBin (lu-llama-server.exe), every binary among the
# bundle resources that is not signed yet (the ggml and llama DLLs), the NSIS
# plugins and uninstaller, the NSIS installer, and the MSI. The updater
# signature (.sig) is taken from the signed installer.
#
# Authentication happens inside SignTool, at signing time, through the
# AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET variables of the
# build step. This script does not read them.

$ErrorActionPreference = 'Stop'

function Require-Env([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is not set" }
  return $value
}

$endpoint = Require-Env 'ARTIFACT_SIGNING_ENDPOINT'
$account = Require-Env 'ARTIFACT_SIGNING_ACCOUNT'
$certificateProfile = Require-Env 'ARTIFACT_SIGNING_PROFILE'
$clientVersion = Require-Env 'ARTIFACT_SIGNING_CLIENT_VERSION'
$clientSha256 = Require-Env 'ARTIFACT_SIGNING_CLIENT_SHA256'
$runnerTemp = Require-Env 'RUNNER_TEMP'
$workspace = Require-Env 'GITHUB_WORKSPACE'

if ($endpoint -notmatch '^https://[a-z0-9]+\.codesigning\.azure\.net/?$') {
  throw "ARTIFACT_SIGNING_ENDPOINT must be the region endpoint of the account, for example https://weu.codesigning.azure.net"
}

# ── 1. The dlib ────────────────────────────────────────────────────────────
$toolsDir = Join-Path $runnerTemp 'artifact-signing'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$package = Join-Path $toolsDir 'client.zip'
$packageUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/$clientVersion/microsoft.artifactsigning.client.$clientVersion.nupkg"
curl.exe -fsSL --retry 3 --max-time 180 -o $package $packageUrl
if ($LASTEXITCODE -ne 0) { throw "download of the Artifact Signing client $clientVersion failed" }
$actual = (Get-FileHash -Path $package -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $clientSha256.ToLower()) {
  throw "the Artifact Signing client did not match the pinned sha256 (expected $clientSha256, got $actual)"
}
$clientDir = Join-Path $toolsDir 'client'
Expand-Archive -Path $package -DestinationPath $clientDir -Force
$dlib = Join-Path $clientDir 'bin\x64\Azure.CodeSigning.Dlib.dll'
if (-not (Test-Path $dlib)) { throw "the client package has no bin\x64\Azure.CodeSigning.Dlib.dll" }

# ── 2. SignTool ────────────────────────────────────────────────────────────
# The dlib needs the SignTool of Windows SDK 10.0.22621 or newer and does not
# work with the 20348 SDK. The runner image ships several SDKs side by side;
# take the newest one that qualifies.
$kitsBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$signtool = Get-ChildItem -Path $kitsBin -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } |
  ForEach-Object { [pscustomobject]@{ Version = [version]$_.Name; Path = Join-Path $_.FullName 'x64\signtool.exe' } } |
  Where-Object { $_.Version.Build -ge 22621 -and (Test-Path $_.Path) } |
  Sort-Object Version -Descending |
  Select-Object -First 1
if (-not $signtool) { throw "no SignTool of Windows SDK 10.0.22621 or newer under $kitsBin" }
Write-Host "SignTool $((Get-Item $signtool.Path).VersionInfo.FileVersion): $($signtool.Path)"

# ── 3. metadata.json ───────────────────────────────────────────────────────
# Only the environment credential is tried. Without the exclusions the dlib
# walks through every credential source Azure knows before it reaches the one
# that exists on a hosted runner.
$metadata = Join-Path $toolsDir 'metadata.json'
[ordered]@{
  Endpoint = $endpoint.TrimEnd('/')
  CodeSigningAccountName = $account
  CertificateProfileName = $certificateProfile
  CorrelationId = "$env:GITHUB_REPOSITORY/$env:GITHUB_RUN_ID"
  ExcludeCredentials = @(
    'ManagedIdentityCredential',
    'WorkloadIdentityCredential',
    'SharedTokenCacheCredential',
    'VisualStudioCredential',
    'VisualStudioCodeCredential',
    'AzureCliCredential',
    'AzurePowerShellCredential',
    'AzureDeveloperCliCredential',
    'InteractiveBrowserCredential'
  )
} | ConvertTo-Json | Set-Content -Path $metadata -Encoding utf8

# ── 4. The Tauri overlay ───────────────────────────────────────────────────
# The object form of signCommand, so the spaces in "Program Files (x86)" need
# no quoting. %1 is the file the bundler wants signed. The timestamp server is
# the one Microsoft names for this service; its certificates are valid for
# three days, so a signature without a timestamp would expire with them.
$overlayRel = 'src-tauri/tauri.signing.conf.json'
$overlay = Join-Path $workspace $overlayRel
[ordered]@{
  bundle = [ordered]@{
    windows = [ordered]@{
      signCommand = [ordered]@{
        cmd = $signtool.Path
        args = @(
          'sign', '/v', '/fd', 'SHA256',
          '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256',
          '/dlib', $dlib,
          '/dmdf', $metadata,
          '%1'
        )
      }
    }
  }
} | ConvertTo-Json -Depth 6 | Set-Content -Path $overlay -Encoding utf8

"config_args=--config $overlayRel" | Add-Content -Path $env:GITHUB_OUTPUT
"signtool=$($signtool.Path)" | Add-Content -Path $env:GITHUB_OUTPUT
Write-Host "Windows signing is configured: $overlayRel"
