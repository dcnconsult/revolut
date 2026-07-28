[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._:-]+$')]
  [string] $ServerHost,

  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string] $KnownHostsPath,

  [Parameter(Mandatory = $true)]
  [string] $OutputDirectory,

  [ValidateRange(1, 65535)]
  [int] $SshPort = 22,

  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')]
  [string] $Version = '1.0.0',

  [switch] $Repair
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = $PSScriptRoot
$resolvedKnownHosts = (Resolve-Path -LiteralPath $KnownHostsPath).Path
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not (Test-Path -LiteralPath $resolvedOutput)) {
  New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
}

$hostLookup = if ($SshPort -eq 22) { $ServerHost } else { "[$ServerHost]:$SshPort" }
$knownHostLines = @(Get-Content -LiteralPath $resolvedKnownHosts |
  Where-Object {
    $_ -match '^[^#]\S*\s+ssh-ed25519\s+\S+' -and
    (($_ -split '\s+')[0].Split(',') -contains $hostLookup)
  }
)

if ($knownHostLines.Count -ne 1) {
  throw "Expected exactly one ED25519 known_hosts entry for $hostLookup."
}

$requiredSources = @(
  'install.sh',
  'launch.sh.in',
  'direct-tunnel.sh.in',
  'com.dcnconsult.RevolutSandbox.desktop.in',
  'first-run.sh.in',
  'package.desktop.in'
)
foreach ($requiredSource in $requiredSources) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory $requiredSource))) {
    throw "Missing package source: $requiredSource"
  }
}

$stagingParent = Join-Path ([System.IO.Path]::GetTempPath()) (
  'revolut-mint-package-' + [Guid]::NewGuid().ToString('N')
)
$resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$resolvedStagingParent = [System.IO.Path]::GetFullPath($stagingParent)
if (-not $resolvedStagingParent.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use a staging directory outside the system temporary directory."
}
$packageRoot = Join-Path $stagingParent 'revolut-sandbox-launcher'
$debianDirectory = Join-Path $packageRoot 'DEBIAN'
$libDirectory = Join-Path $packageRoot 'usr/lib/revolut-sandbox'
$applicationsDirectory = Join-Path $packageRoot 'usr/share/applications'
$packageName = "revolut-sandbox-launcher_${Version}_all.deb"
$containerOutput = "/work/$packageName"

try {
  New-Item -ItemType Directory -Path $debianDirectory, $libDirectory, $applicationsDirectory |
    Out-Null

  $control = @"
Package: revolut-sandbox-launcher
Version: $Version
Section: net
Priority: optional
Architecture: all
Depends: openssh-client, curl, xdg-utils, zenity, util-linux
Maintainer: DCN Consult
Description: One-click private launcher for the Revolut Sandbox operator application
 Generates a dedicated SSH key locally, installs a resilient user tunnel,
 verifies Sandbox health, and opens the operator application.
"@
  [System.IO.File]::WriteAllText(
    (Join-Path $debianDirectory 'control'),
    $control.Replace("`r`n", "`n") + "`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  foreach ($sourceName in @(
    'install.sh',
    'launch.sh.in',
    'direct-tunnel.sh.in',
    'com.dcnconsult.RevolutSandbox.desktop.in'
  )) {
    Copy-Item -LiteralPath (Join-Path $sourceDirectory $sourceName) -Destination $libDirectory
  }

  $firstRun = Get-Content -LiteralPath (Join-Path $sourceDirectory 'first-run.sh.in') -Raw
  $firstRun = $firstRun.
    Replace('@SERVER_HOST@', $ServerHost).
    Replace('@SSH_PORT@', "$SshPort").
    Replace('@PACKAGE_VERSION@', $Version)
  [System.IO.File]::WriteAllText(
    (Join-Path $libDirectory 'first-run.sh'),
    $firstRun.Replace("`r`n", "`n"),
    [System.Text.UTF8Encoding]::new($false)
  )

  $desktopEntry = Get-Content -LiteralPath (Join-Path $sourceDirectory 'package.desktop.in') -Raw
  [System.IO.File]::WriteAllText(
    (Join-Path $applicationsDirectory 'com.dcnconsult.RevolutSandboxSetup.desktop'),
    $desktopEntry.Replace("`r`n", "`n"),
    [System.Text.UTF8Encoding]::new($false)
  )

  [System.IO.File]::WriteAllText(
    (Join-Path $libDirectory 'known_hosts'),
    ($knownHostLines -join "`n") + "`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  $stagingForDocker = $stagingParent.Replace('\', '/')
  & docker run --rm `
    -v "${stagingForDocker}:/work" `
    -w /work `
    debian:bookworm-slim `
    bash -c "cp -a revolut-sandbox-launcher /tmp/revolut-sandbox-launcher && find /tmp/revolut-sandbox-launcher -type d -exec chmod 0755 '{}' + && chmod 0755 /tmp/revolut-sandbox-launcher/usr/lib/revolut-sandbox/install.sh /tmp/revolut-sandbox-launcher/usr/lib/revolut-sandbox/first-run.sh && chmod 0644 /tmp/revolut-sandbox-launcher/DEBIAN/control /tmp/revolut-sandbox-launcher/usr/lib/revolut-sandbox/*.in /tmp/revolut-sandbox-launcher/usr/lib/revolut-sandbox/known_hosts /tmp/revolut-sandbox-launcher/usr/share/applications/*.desktop && dpkg-deb --root-owner-group --build /tmp/revolut-sandbox-launcher '$containerOutput'"
  if ($LASTEXITCODE -ne 0) {
    throw "Debian package build failed."
  }

  $builtPackage = Join-Path $stagingParent $packageName
  $finalPackage = Join-Path $resolvedOutput $packageName
  Copy-Item -LiteralPath $builtPackage -Destination $finalPackage -Force

  $hash = (Get-FileHash -LiteralPath $finalPackage -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Repair) {
    $instructions = @"
REVOLUT SANDBOX REPAIR FOR LINUX MINT

1. Double-click $packageName and select Install or Update.
2. Open Revolut Sandbox Setup or Repair from the Mint application menu.
3. Wait up to 20 seconds. The existing authorized key is preserved and the
   browser login page opens automatically.
4. Use the normal Revolut Sandbox icon from then on.

Do not create or email another key. Never email tunnel_identity, a private key,
a password, or an MFA code.

Package SHA-256:
$hash
"@
  }
  else {
    $instructions = @"
REVOLUT SANDBOX FOR LINUX MINT

1. Double-click $packageName and select Install.
2. Open Revolut Sandbox Setup or Repair from the Mint application menu.
3. Setup creates Revolut-Sandbox-Public-Key.txt on the Desktop.
4. Email ONLY that public-key text file to the administrator.
5. Wait for the administrator to confirm activation.
6. Open Revolut Sandbox. The browser login page opens automatically.

Never email tunnel_identity, a private key, a password, or an MFA code.

Package SHA-256:
$hash
"@
  }
  $instructionPath = Join-Path $resolvedOutput 'READ-ME-FIRST.txt'
  [System.IO.File]::WriteAllText(
    $instructionPath,
    $instructions.Replace("`r`n", "`n"),
    [System.Text.UTF8Encoding]::new($false)
  )

  [pscustomobject]@{
    Package = $finalPackage
    Instructions = $instructionPath
    Sha256 = $hash
    ContainsPrivateKey = $false
  }
}
finally {
  if (Test-Path -LiteralPath $stagingParent) {
    Remove-Item -LiteralPath $stagingParent -Recurse -Force
  }
}
