$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = 'Standard'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'This isolated SSH fixture runs only on a hosted Windows runner.' }
$fixtureRoot = Join-Path $env:RUNNER_TEMP ('t3-ssh-' + [Guid]::NewGuid().ToString('N'))
$taskName = 'T3SshFixture-' + [Guid]::NewGuid().ToString('N')
$registryPath = 'HKLM:\SOFTWARE\OpenSSH'
$oldShell = (Get-ItemProperty -Path $registryPath -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
New-Item -ItemType Directory -Force $fixtureRoot | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$node = (Get-Command node.exe).Source
$peer = Join-Path (Get-Location) 'apps/server/src/cli/testFixtures/sshManagedPeer.ts'
$homeDirectory = Join-Path $fixtureRoot 'remote home'
New-Item -ItemType Directory -Force $homeDirectory | Out-Null
$authUsername = 't3ssh' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$authPassword = 'Aa1!' + [Guid]::NewGuid().ToString('N')
$keyPassphrase = 'Fixture passphrase with "quotes" and $;!'
try {
  New-LocalUser -Name $authUsername -Password (ConvertTo-SecureString $authPassword -AsPlainText -Force) -Description 'Disposable T3 SSH authentication fixture' | Out-Null
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $authUsername
  $zip = Join-Path $fixtureRoot 'openssh.zip'
  Invoke-WebRequest 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64.zip' -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5') { throw 'OpenSSH fixture checksum mismatch.' }
  Expand-Archive $zip -DestinationPath $fixtureRoot
  $sshRoot = Join-Path $fixtureRoot 'OpenSSH-Win64'
  & icacls.exe $sshRoot /grant:r "$($authUsername):(OI)(CI)RX" /T | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant executable access to the disposable SFTP subsystem.' }
  $key = Join-Path $fixtureRoot 'identity'
  $hostKey = Join-Path $fixtureRoot 'hostkey'
  $authIdentity = Join-Path $fixtureRoot 'identity with spaces'
  $differentHostKey = Join-Path $fixtureRoot 'different-hostkey'
  & "$sshRoot/ssh-keygen.exe" -t ed25519 -N '' -f $key -q
  if ($LASTEXITCODE -ne 0) { throw 'Client key generation failed.' }
  & "$sshRoot/ssh-keygen.exe" -t ed25519 -N '' -f $hostKey -q
  if ($LASTEXITCODE -ne 0) { throw 'Host key generation failed.' }
  & "$sshRoot/ssh-keygen.exe" -t ed25519 -N $keyPassphrase -f $authIdentity -q
  if ($LASTEXITCODE -ne 0) { throw 'Encrypted client key generation failed.' }
  & "$sshRoot/ssh-keygen.exe" -t ed25519 -N '' -f $differentHostKey -q
  if ($LASTEXITCODE -ne 0) { throw 'Alternate fixture host key generation failed.' }
  $authorized = Join-Path $fixtureRoot 'authorized_keys'
  Copy-Item "$key.pub" $authorized
  Get-Content "$authIdentity.pub" | Add-Content $authorized
  foreach ($file in @($key, $hostKey, $authorized, $authIdentity, $differentHostKey)) {
    & icacls.exe $file /inheritance:r /grant:r "$($env:USERNAME):F" 'SYSTEM:F' 'Administrators:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict SSH fixture key permissions.' }
  }
  & icacls.exe $fixtureRoot /grant:r "$($authUsername):RX" | Out-Null
  & icacls.exe $authorized /grant:r "$($authUsername):R" | Out-Null
  & icacls.exe $hostKey /remove:g "$env:USERNAME" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not remove the host key user grant.' }
  & icacls.exe $hostKey /setowner '*S-1-5-18' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not assign the fixture host key to SYSTEM.' }
  $serverConfig = Join-Path $fixtureRoot 'sshd_config'
  @"
Port $port
ListenAddress 127.0.0.1
HostKey "$($hostKey.Replace('\','/'))"
AuthorizedKeysFile "$($authorized.Replace('\','/'))"
StrictModes no
PasswordAuthentication yes
PubkeyAuthentication yes
Subsystem sftp "$($sshRoot.Replace('\','/'))/sftp-server.exe"
AllowUsers $env:USERNAME $authUsername
LogLevel VERBOSE
"@ | Set-Content -LiteralPath $serverConfig -Encoding ascii
  $known = Join-Path $fixtureRoot 'known_hosts'
  $public = (Get-Content "$hostKey.pub" -Raw).Trim()
  "[127.0.0.1]:$port $public" | Set-Content -LiteralPath $known -Encoding ascii
  $clientConfig = Join-Path $fixtureRoot 'config'
  @"
Host t3-fixture
  HostName 127.0.0.1
  Port $port
  User $env:USERNAME
  IdentityFile "$($key.Replace('\','/'))"
  UserKnownHostsFile "$($known.Replace('\','/'))"
  StrictHostKeyChecking yes
  BatchMode yes
"@ | Set-Content -LiteralPath $clientConfig -Encoding ascii
  $daemonLog = Join-Path $fixtureRoot 'sshd.log'
  $daemonScript = Join-Path $fixtureRoot 'start-sshd.ps1'
  "& '$sshRoot/sshd.exe' -D -e -f '$serverConfig' 2>&1 | Out-File -LiteralPath '$daemonLog'" | Set-Content -LiteralPath $daemonScript -Encoding ascii
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$daemonScript`""
  Register-ScheduledTask -TaskName $taskName -Action $action -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $ready = $false
  for ($attempt=0; $attempt -lt 100; $attempt++) {
    $socket = [Net.Sockets.TcpClient]::new()
    try { $socket.Connect('127.0.0.1',$port); $ready=$true; break } catch { Start-Sleep -Milliseconds 100 } finally { $socket.Dispose() }
  }
  if (!$ready) { if(Test-Path -LiteralPath $daemonLog){Get-Content -LiteralPath $daemonLog}; throw 'The isolated Windows SSH server did not start.' }
  function Test-NativeAuthentication([string]$shellLabel) {
    $info = [Diagnostics.ProcessStartInfo]::new($node)
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment['PATH'] = "$sshRoot;$env:PATH"
    $info.ArgumentList.Add((Join-Path (Get-Location) 'scripts/imaorise/ssh-auth-windows-smoke.ts'))
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $payload = @{ root=(Join-Path $fixtureRoot $shellLabel); port=$port; username=$authUsername; password=$authPassword; passphrase=$keyPassphrase; identity=$authIdentity; differentHostKey=(Get-Content "$differentHostKey.pub" -Raw).Trim() } | ConvertTo-Json -Compress
    $process.StandardInput.WriteLine($payload)
    $process.StandardInput.Close()
    if (!$process.WaitForExit(240000)) {
      $process.Kill($true)
      $process.WaitForExit()
      Write-Output (($stdout.Result + $stderr.Result).Replace($authPassword, '[redacted]').Replace($keyPassphrase, '[redacted]'))
      throw 'Native SSH authentication fixture exceeded its deadline.'
    }
    $details = ($stdout.Result + $stderr.Result).Replace($authPassword, '[redacted]').Replace($keyPassphrase, '[redacted]')
    Write-Output $details
    if ($process.ExitCode -ne 0) {
      if (Test-Path -LiteralPath $daemonLog) { Write-Output ((Get-Content -LiteralPath $daemonLog -Tail 30 | Out-String).Replace($authPassword, '[redacted]').Replace($keyPassphrase, '[redacted]')) }
      throw 'Native SSH authentication fixture failed.'
    }
  }
  function Invoke-Peer([string]$operation, [string]$keyValue, [string]$version = '2.0.1-test') {
    $script = "`$env:HOME='$($homeDirectory.Replace("'","''"))'; `$env:USERPROFILE=`$env:HOME; & '$($node.Replace("'","''"))' '$($peer.Replace("'","''"))' '$operation' '$keyValue' '$version'; if(`$LASTEXITCODE -ne 0){exit `$LASTEXITCODE}"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $startInfo = [Diagnostics.ProcessStartInfo]::new("$sshRoot/ssh.exe")
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('-F',$clientConfig,'-o','ConnectTimeout=10','t3-fixture','powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded)) { $startInfo.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($startInfo)
    try {
      $stdout = $process.StandardOutput.ReadToEndAsync()
      $stderr = $process.StandardError.ReadToEndAsync()
      if (!$process.WaitForExit(90000)) { $process.Kill(); throw "SSH peer $operation exceeded its deadline." }
      $result = $stdout.GetAwaiter().GetResult()
      $errorText = $stderr.GetAwaiter().GetResult()
      if ($process.ExitCode -ne 0) { throw "SSH peer $operation failed: $errorText" }
      return $result
    } finally { $process.Dispose() }
  }
  New-Item -Path $registryPath -Force | Out-Null
  foreach ($shell in @("$env:SystemRoot/System32/cmd.exe", "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe")) {
    Set-ItemProperty -Path $registryPath -Name DefaultShell -Value $shell
    Test-NativeAuthentication ([IO.Path]::GetFileNameWithoutExtension($shell))
    $keyValue = if ($shell.EndsWith('cmd.exe')) { '1111111111111111' } else { '2222222222222222' }
    try {
      $first = Invoke-Peer 'resume' $keyValue | ConvertFrom-Json
      $second = Invoke-Peer 'start' $keyValue '2.0.2-newer' | ConvertFrom-Json
      if ($first.remotePort -ne $second.remotePort) { throw 'SSH reconnect replaced the remote server.' }
      $pairing = Invoke-Peer 'pair' $keyValue '2.0.2-newer' | ConvertFrom-Json
      if ($pairing.credential -ne 'disposable-fixture-credential') { throw 'Compatible runtime pairing failed.' }
      $descriptor = Invoke-RestMethod "http://127.0.0.1:$($first.remotePort)/.well-known/t3/environment"
      if ($descriptor.environmentId -ne 'fixture-environment') { throw 'Detached remote server did not survive SSH session exit.' }
      Write-Output "Passed SSH session survival and reconnect with $([IO.Path]::GetFileName($shell))."
    } finally { Invoke-Peer 'stop' $keyValue | Out-Null }
  }
} finally {
  Remove-LocalUser -Name $authUsername -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  if ($null -eq $oldShell) { Remove-ItemProperty -Path $registryPath -Name DefaultShell -ErrorAction SilentlyContinue } else { Set-ItemProperty -Path $registryPath -Name DefaultShell -Value $oldShell }
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
