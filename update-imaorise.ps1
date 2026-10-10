[CmdletBinding()]
param(
    [string]$Distribution = 'Ubuntu-26.04',
    [string]$WslRepository = '/home/imaorise/webdevfiles/Projects/t3code-imaorise',
    [string]$WindowsRepository = "$env:USERPROFILE\source\t3code-imaorise",
    [string]$ArtifactRoot = "$env:USERPROFILE\Documents\T3CodeImaoriseBuilds",
    [switch]$NoMerge
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tools = "$env:LOCALAPPDATA\T3CodeImaorise\tools"
$env:PATH = "$tools\node-v24.21.0-win-x64;$tools\vite-plus\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:VP_HOME = "$tools\vite-plus"
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$results = [System.Collections.Generic.List[object]]::new()
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$output = Join-Path $ArtifactRoot $stamp
New-Item -ItemType Directory -Force $output | Out-Null
$log = Join-Path $output 'build.log'
function Run([string]$Program, [string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Program @Arguments 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $results.Add(@{ command = "$Program $($Arguments -join ' ')"; exitCode = $code })
    if ($code -ne 0) { throw "Command failed ($code). See $log" }
}
function Wsl([string[]]$Arguments) { Run 'wsl.exe' (@('-d', $Distribution, '--exec') + $Arguments) }
function GitValue([string[]]$Arguments) {
    $value = & git -C $WindowsRepository @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Git failed.' }
    return "$value".Trim()
}
function CleanWindows {
    if (GitValue @('status', '--porcelain')) { throw 'Windows checkout is dirty; commit or stash deliberately.' }
    if ((GitValue @('branch', '--show-current')) -ne 'imaorise') { throw 'Windows must be on imaorise.' }
    if (Test-Path (Join-Path $WindowsRepository '.git\MERGE_HEAD')) { throw 'Resolve the Windows merge first.' }
}
$manifest = @{ status = 'failed'; createdAt = (Get-Date).ToUniversalTime().ToString('o'); installationApproved = $false; interactiveAcceptance = 'pending'; steps = $results }
try {
    foreach ($tool in @('node', 'vp', 'git', 'rustc', 'cargo', 'python', 'wsl.exe')) { Get-Command $tool -ErrorAction Stop | Out-Null }
    if ((& node --version) -notmatch '^v24\.') { throw 'Windows packaging requires isolated Node 24.' }
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (!(Test-Path $vswhere)) { throw 'Install Visual Studio C++ Build Tools, SDK and Spectre libraries first.' }
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$vs) { throw 'Visual Studio C++ workload is missing.' }
    $manifest.tools = @{ node = (& node --version); vp = (& vp --version); rust = (& rustc --version); git = (& git --version); python = (& python --version); visualStudio = $vs }
    CleanWindows
    $manifest.previousWindowsRevision = GitValue @('rev-parse', 'HEAD')
    Wsl @('bash', "$WslRepository/scripts/imaorise/manage.sh", 'check')
    $manifest.previousWslRevision = (& wsl.exe -d $Distribution --exec git -C $WslRepository rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read WSL revision.' }
    if (!$NoMerge) { Wsl @('bash', "$WslRepository/scripts/imaorise/manage.sh", 'update') }
    $bundle = Join-Path $output 'source.bundle'
    $wslOutput = (& wsl.exe -d $Distribution --exec wslpath -u $output).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not translate artifact path.' }
    Wsl @('bash', "$WslRepository/scripts/imaorise/manage.sh", 'bundle', "$wslOutput/source.bundle")
    Run 'git' @('-C', $WindowsRepository, 'fetch', $bundle, 'imaorise:refs/remotes/wsl/imaorise', 'main:refs/remotes/upstream/main')
    Run 'git' @('-C', $WindowsRepository, 'merge', '--ff-only', 'refs/remotes/wsl/imaorise')
    Run 'git' @('-C', $WindowsRepository, 'branch', '-f', 'main', 'upstream/main')
    $revision = GitValue @('rev-parse', 'HEAD')
    $manifest.revision = $revision
    Wsl @('bash', "$WslRepository/scripts/imaorise/manage.sh", 'build', "$wslOutput/linux", $revision)
    $linux = Get-Content "$output\linux\linux-manifest.json" -Raw | ConvertFrom-Json
    if ($linux.revision -ne $revision) { throw 'Windows and Linux revisions do not match.' }
    $manifest.linux = $linux
    $archive = Get-ChildItem "$output\linux\t3-*-linux-x64.tar.gz"
    if (@($archive).Count -ne 1) { throw 'Expected exactly one Linux runtime archive.' }
    Push-Location $WindowsRepository
    try {
        $env:T3CODE_CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsudDMuY29kZXMk'
        $env:T3CODE_CLERK_JWT_TEMPLATE = 't3-relay'
        $env:T3CODE_CLERK_CLI_OAUTH_CLIENT_ID = 'hzxSgY2cH10sDU2r'
        $env:T3CODE_RELAY_URL = 'https://relay.t3.codes'
        Run 'vp' @('install', '--frozen-lockfile')
        Run 'node' @('scripts/build-desktop-artifact.ts', '--platform', 'win', '--target', 'nsis', '--arch', 'x64', '--build-version', $linux.version, '--wsl-runtime', $archive.FullName, '--output-dir', "$output\windows", '--keep-stage')
    } finally { Pop-Location }
    CleanWindows
    if ((GitValue @('rev-parse', 'HEAD')) -ne $revision) { throw 'Windows revision changed during build.' }
    Wsl @('bash', "$WslRepository/scripts/imaorise/android.sh", "$wslOutput/android", $revision)
    $android = Get-Content "$output\android\android-manifest.json" -Raw | ConvertFrom-Json
    if ($android.revision -ne $revision) { throw 'Android and desktop revisions do not match.' }
    $manifest.android = $android
    $manifest.status = 'build-passed-awaiting-interactive-acceptance'
} catch {
    $manifest.error = $_.Exception.Message
    throw
} finally {
    $manifest | ConvertTo-Json -Depth 12 | Set-Content "$output\manifest.json" -Encoding UTF8
    Get-ChildItem $output -File -Recurse | Where-Object Name -ne 'SHA256SUMS' | ForEach-Object {
        $relative = $_.FullName.Substring($output.Length + 1).Replace('\', '/')
        "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
    } | Set-Content "$output\SHA256SUMS" -Encoding ASCII
    Write-Host "Artifacts and evidence: $output"
}
