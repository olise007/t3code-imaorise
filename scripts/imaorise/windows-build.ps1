param(
  [Parameter(Mandatory=$true)][string]$Repository,
  [Parameter(Mandatory=$true)][string]$Revision,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$WslRuntime,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
if ($Revision -notmatch '^[a-f0-9]{40}$') { throw 'A full pinned revision is required.' }
$Output = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force $Output | Out-Null
$stage = Join-Path ([IO.Path]::GetTempPath()) ('t3-personal-build-' + [Guid]::NewGuid())
# Clone into a new directory; never merge or reset a developer checkout.
git clone --no-checkout --no-hardlinks $Repository $stage
if ($LASTEXITCODE -ne 0) { throw 'Isolated source clone failed.' }
try {
  Push-Location $stage
  try {
    git checkout --detach $Revision
    if ($LASTEXITCODE -ne 0 -or (git rev-parse HEAD).Trim() -ne $Revision) { throw 'Pinned source checkout failed.' }
    if (git status --porcelain) { throw 'Isolated source must be clean.' }
    vp install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = 'olise007/t3code-imaorise'
    node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64 --build-version $Version --wsl-runtime $WslRuntime --output-dir $Output --verbose
    if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed.' }
  } finally { Pop-Location }
} finally {
  # This invocation created and owns this exact temporary directory.
  if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
