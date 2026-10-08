# windows-signing-verify.ps1: did the signed Windows build come out signed?
#
# Runs after a signing lane of the Windows build, never on the unsigned path:
#   - Azure Artifact Signing (release.yml, after `tauri build` signed in place)
#   - SignPath (.github/actions/windows-signpath, after the second signing
#     request came back)
# A configured lane that silently signed nothing must not look like a signed
# release.
#
# Hard failures:
#   - an installer (NSIS .exe or .msi) without a valid, timestamped signature
#   - installers signed by different publishers
#   - with -ExpectedPublisher: a publisher whose certificate subject does not
#     contain that text
#   - an executable inside an installer that should be signed and is not.
#     Without -SignedExecutables that is every .exe inside the NSIS installer
#     (Azure signs them all). With it, only the named files: SignPath
#     Foundation certificates may sign binaries built from this repository's
#     own source only, so the bundled llama.cpp server and the NSIS
#     uninstaller stub stay unsigned on that lane, and are listed as such.
# Warning only: a .dll inside the installer without a signature, because a
# third party library may legitimately ship unsigned.
#
# -AllowTestCertificate is for SignPath's test-signing policy, whose
# certificate is self-signed: Windows reports such a signature as present but
# not trusted. With the switch that status passes, as long as a signer
# certificate is attached and the file hash matches. Release builds never
# pass it.
#
# What this cannot check is SmartScreen. Reputation is built by downloads, not
# by a property of the file, so that stays a manual look on a clean machine.

param(
  [string]$BundleRoot = 'src-tauri/target/release/bundle',
  [string]$SignTool = '',
  [string]$ExpectedPublisher = '',
  [string[]]$SignedExecutables = @(),
  [switch]$AllowTestCertificate
)

$ErrorActionPreference = 'Stop'

function Get-Signature([string]$Path) {
  $signature = Get-AuthenticodeSignature -FilePath $Path
  [pscustomobject]@{
    Path = $Path
    Status = [string]$signature.Status
    Subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
    Timestamped = [bool]$signature.TimeStamperCertificate
  }
}

# Valid always passes. A test certificate chains to a root Windows does not
# know, which PowerShell reports as UnknownError or NotTrusted; NotSigned and
# HashMismatch never pass.
function Test-Signed($Signature) {
  if ($Signature.Status -eq 'Valid') { return $true }
  if ($AllowTestCertificate -and $Signature.Subject -and ($Signature.Status -in @('UnknownError', 'NotTrusted'))) { return $true }
  return $false
}

# The inner files that must carry a signature, and the ones that only get listed.
function Test-InnerFiles([string]$Directory, [string]$Origin) {
  $unsigned = @()
  $seen = @()
  foreach ($file in Get-ChildItem -Path $Directory -Recurse -File -Include '*.exe', '*.dll') {
    $signature = Get-Signature $file.FullName
    $relative = $file.FullName.Substring($Directory.Length + 1)
    $required = if ($SignedExecutables.Count -gt 0) { $SignedExecutables -contains $file.Name } else { $file.Extension -eq '.exe' }
    if ($required) { $seen += $file.Name }
    if (Test-Signed $signature) {
      Write-Host "ok  ${Origin}: $relative  $($signature.Subject)"
      if ($required -and $ExpectedPublisher -and ($signature.Subject -notlike "*$ExpectedPublisher*")) {
        throw "${Origin}: $relative is signed by '$($signature.Subject)', expected a publisher containing '$ExpectedPublisher'"
      }
    } elseif ($required) {
      Write-Host "::error::unsigned or invalid ($($signature.Status)): ${Origin}: $relative"
      $unsigned += $relative
    } elseif ($file.Extension -eq '.exe') {
      Write-Host "unsigned by policy ($($signature.Status)): ${Origin}: $relative"
    } else {
      Write-Host "::warning::library without a valid signature ($($signature.Status)): ${Origin}: $relative"
    }
  }
  if ($unsigned.Count -gt 0) { throw "executables inside $Origin are not signed: $($unsigned -join ', ')" }
  foreach ($name in $SignedExecutables) {
    if ($seen -notcontains $name) { throw "$Origin does not contain $name, which should be signed" }
  }
}

$installers = @(Get-ChildItem -Path $BundleRoot -Recurse -File -Include '*-setup.exe', '*.msi')
if ($installers.Count -eq 0) { throw "no NSIS or MSI installer under $BundleRoot" }

$subjects = @()
foreach ($installer in $installers) {
  # SignTool applies the Windows trust policy, which a test certificate
  # cannot pass by design.
  if ($SignTool -and -not $AllowTestCertificate) {
    & $SignTool verify /pa /v $installer.FullName
    if ($LASTEXITCODE -ne 0) { throw "SignTool does not accept the signature of $($installer.Name)" }
  }
  $signature = Get-Signature $installer.FullName
  if (-not (Test-Signed $signature)) { throw "$($installer.Name): signature status is $($signature.Status)" }
  if (-not $signature.Timestamped) { throw "$($installer.Name): the signature has no timestamp" }
  if ($ExpectedPublisher -and ($signature.Subject -notlike "*$ExpectedPublisher*")) {
    throw "$($installer.Name) is signed by '$($signature.Subject)', expected a publisher containing '$ExpectedPublisher'"
  }
  Write-Host "ok  $($installer.Name)  $($signature.Subject)"
  $subjects += $signature.Subject
}
$publishers = @($subjects | Sort-Object -Unique)
if ($publishers.Count -ne 1) { throw "the installers are signed by different publishers: $($publishers -join ' | ')" }

# The files a user ends up running sit inside the installers. 7-Zip, which the
# runner image ships, unpacks an NSIS installer without running it.
$setup = $installers | Where-Object { $_.Name -like '*-setup.exe' } | Select-Object -First 1
if ($setup) {
  $extractDir = Join-Path $env:RUNNER_TEMP 'nsis-extract'
  if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
  & 7z x "-o$extractDir" -y $setup.FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "7-Zip could not unpack $($setup.Name)" }
  Test-InnerFiles $extractDir $setup.Name
}

# The MSI is checked the same way where the caller names the files that must
# be signed. An administrative install (msiexec /a) lays the files out in a
# directory without installing anything.
$msi = $installers | Where-Object { $_.Extension -eq '.msi' } | Select-Object -First 1
if ($msi -and $SignedExecutables.Count -gt 0) {
  $extractDir = Join-Path $env:RUNNER_TEMP 'msi-extract'
  if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/a', "`"$($msi.FullName)`"", '/qn', "TARGETDIR=`"$extractDir`"") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "msiexec could not unpack $($msi.Name) (exit code $($process.ExitCode))" }
  Test-InnerFiles $extractDir $msi.Name
}

"publisher=$($publishers[0])" | Add-Content -Path $env:GITHUB_OUTPUT
Write-Host "OK: every installer carries a valid signature from $($publishers[0]), and so does every executable inside them that should"
