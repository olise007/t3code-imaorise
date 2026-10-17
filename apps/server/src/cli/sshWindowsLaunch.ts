/** Breaks out of OpenSSH's kill-on-close job without WMI or inherited SSH pipes. */
export function windowsSupervisorLaunchScript(
  executable: string,
  commandLine: string,
  home: string,
) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class T3DetachedProcess {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct StartupInfo {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct ProcessInformation { public IntPtr hProcess, hThread; public uint processId, threadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CreateProcessW(string application, StringBuilder command,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
    IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$startup=New-Object T3DetachedProcess+StartupInfo
$startup.cb=[Runtime.InteropServices.Marshal]::SizeOf($startup)
$startup.dwFlags=1
$startup.wShowWindow=0
$process=New-Object T3DetachedProcess+ProcessInformation
$command=[Text.StringBuilder]::new(${quote(commandLine)})
try {
  $created=[T3DetachedProcess]::CreateProcessW(${quote(executable)},$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x01000208,[IntPtr]::Zero,${quote(home)},[ref]$startup,[ref]$process)
  if(!$created) {
    $code=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw ('Could not launch a persistent SSH server (Win32 '+$code+'). This SSH session must allow process breakaway; no server settings were changed.')
  }
  Write-Output ('Detached supervisor PID '+$process.processId)
} finally {
  if($process.hThread -ne [IntPtr]::Zero){[void][T3DetachedProcess]::CloseHandle($process.hThread)}
  if($process.hProcess -ne [IntPtr]::Zero){[void][T3DetachedProcess]::CloseHandle($process.hProcess)}
}
`;
}
