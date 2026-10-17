/** Owns the server tree through handles, without process enumeration or administrator tools. */
export function windowsServerJobScript(executable: string, commandLine: string, home: string) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Diagnostics;
using System.Threading;
public static class T3ServerJob {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct StartupInfo {
    public int cb;
    public string reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reservedSize;
    public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long processTime,jobTime;
    public uint flags;
    public UIntPtr minimum,maximum;
    public uint active;
    public UIntPtr affinity;
    public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits basic;
    public IoCounters io;
    public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential)]
  struct SecurityAttributes { public int size; public IntPtr descriptor; public int inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
  static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string directory,ref StartupInfo startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true, ExactSpelling=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes,IntPtr name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits limits,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting accounting,uint size,IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref SecurityAttributes attributes,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  static void Check(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static void Run(string executable,string command,string directory) {
    IntPtr job=CreateJobObjectW(IntPtr.Zero,IntPtr.Zero);
    if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ProcessInfo child=new ProcessInfo();
    IntPtr input=IntPtr.Zero;
    bool assigned=false;
    try {
      ExtendedLimits limits=new ExtendedLimits();
      limits.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)));
      StartupInfo startup=new StartupInfo();
      startup.cb=Marshal.SizeOf(startup);
      startup.flags=0x101; // hidden console and inherited owned log handles.
      SecurityAttributes attributes=new SecurityAttributes(); attributes.size=Marshal.SizeOf(attributes); attributes.inherit=1;
      input=CreateFileW("NUL",0x80000000,3,ref attributes,3,0,IntPtr.Zero);
      if(input==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      startup.input=input; startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
      Check(CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x14,IntPtr.Zero,directory,ref startup,out child));
      Check(AssignProcessToJobObject(job,child.process));
      assigned=true;
      if(ResumeThread(child.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      Task control=Task.Run(()=>Console.In.ReadLine());
      Task exited=Task.Run(()=>{ if(WaitForSingleObject(child.process,0xffffffff)!=0) throw new Win32Exception(Marshal.GetLastWin32Error()); });
      int completed=Task.WaitAny(control,exited);
      (completed==0 ? control : exited).GetAwaiter().GetResult();
      Check(TerminateJobObject(job,0));
      if(WaitForSingleObject(child.process,5000)!=0) throw new Exception("Owned server did not exit after job termination");
      Stopwatch deadline=Stopwatch.StartNew();
      while(true) {
        Accounting accounting;
        Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
        if(accounting.active==0) break;
        if(deadline.ElapsedMilliseconds>=5000) throw new Exception("Owned server descendants did not exit after job termination");
        Thread.Sleep(10);
      }
    } finally {
      // A suspended process must never escape if job assignment fails.
      if(child.process!=IntPtr.Zero && !assigned) { TerminateProcess(child.process,1); WaitForSingleObject(child.process,5000); }
      CloseHandle(job);
      if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input);
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
    }
  }
}
'@
try { [T3ServerJob]::Run(${quote(executable)},${quote(commandLine)},${quote(home)}) }
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`;
}
