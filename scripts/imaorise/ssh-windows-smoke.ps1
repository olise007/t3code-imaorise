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
try {
  $zip = Join-Path $fixtureRoot 'openssh.zip'
  Invoke-WebRequest 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.0.0.0p2-Preview/OpenSSH-Win64.zip' -OutFile $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5') { throw 'OpenSSH fixture checksum mismatch.' }
  Expand-Archive $zip -DestinationPath $fixtureRoot
  $sshRoot = Join-Path $fixtureRoot 'OpenSSH-Win64'
  $key = Join-Path $fixtureRoot 'identity'
  $hostKey = Join-Path $fixtureRoot 'hostkey'
  & "$sshRoot/ssh-keygen.exe" -t ed25519 -N '' -f $key -q
  if ($LASTEXITCODE -ne 0) { throw 'Client key generation failed.' }
  & "$sshRoot/ssh-keygen.exe" -t ed25519 -N '' -f $hostKey -q
  if ($LASTEXITCODE -ne 0) { throw 'Host key generation failed.' }
  $authorized = Join-Path $fixtureRoot 'authorized_keys'
  Copy-Item "$key.pub" $authorized
  foreach ($file in @($key, $hostKey, $authorized)) {
    & icacls.exe $file /inheritance:r /grant:r "$($env:USERNAME):F" 'SYSTEM:F' 'Administrators:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict SSH fixture key permissions.' }
  }
  $serverConfig = Join-Path $fixtureRoot 'sshd_config'
  @"
Port $port
ListenAddress 127.0.0.1
HostKey "$($hostKey.Replace('\','/'))"
AuthorizedKeysFile "$($authorized.Replace('\','/'))"
StrictModes no
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers $env:USERNAME
LogLevel ERROR
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
  function Invoke-Peer([string]$operation, [string]$keyValue) {
    $script = "`$env:HOME='$($homeDirectory.Replace("'","''"))'; `$env:USERPROFILE=`$env:HOME; & '$($node.Replace("'","''"))' '$($peer.Replace("'","''"))' '$operation' '$keyValue' '2.0.1-test'; if(`$LASTEXITCODE -ne 0){exit `$LASTEXITCODE}"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $result = & "$sshRoot/ssh.exe" -F $clientConfig t3-fixture powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded
    if ($LASTEXITCODE -ne 0) { throw "SSH peer $operation failed." }
    return ($result -join "`n")
  }
  New-Item -Path $registryPath -Force | Out-Null
  foreach ($shell in @("$env:SystemRoot/System32/cmd.exe", "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe")) {
    Set-ItemProperty -Path $registryPath -Name DefaultShell -Value $shell
    $keyValue = if ($shell.EndsWith('cmd.exe')) { '1111111111111111' } else { '2222222222222222' }
    try {
      $first = Invoke-Peer 'start' $keyValue | ConvertFrom-Json
      $second = Invoke-Peer 'start' $keyValue | ConvertFrom-Json
      if ($first.remotePort -ne $second.remotePort) { throw 'SSH reconnect replaced the remote server.' }
      $descriptor = Invoke-RestMethod "http://127.0.0.1:$($first.remotePort)/.well-known/t3/environment"
      if ($descriptor.environmentId -ne 'fixture-environment') { throw 'Detached remote server did not survive SSH session exit.' }
      Write-Output "Passed SSH session survival and reconnect with $([IO.Path]::GetFileName($shell))."
    } finally { Invoke-Peer 'stop' $keyValue | Out-Null }
  }
} finally {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  if ($null -eq $oldShell) { Remove-ItemProperty -Path $registryPath -Name DefaultShell -ErrorAction SilentlyContinue } else { Set-ItemProperty -Path $registryPath -Name DefaultShell -Value $oldShell }
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
