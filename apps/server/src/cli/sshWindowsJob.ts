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
  struct ExtendedStartup { public StartupInfo startup; public IntPtr attributes; }
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
  static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string directory,ref ExtendedStartup startup,out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file,byte[] buffer,uint size,out uint read,IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  static void Check(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr InheritedLog(int kind) {
    IntPtr source=GetStdHandle(kind),result;
    if(source==IntPtr.Zero || source==new IntPtr(-1)) throw new Exception("Owned server log handle is unavailable");
    Check(DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),out result,0,true,2));
    return result;
  }
  public static void Run(string executable,string command,string directory) {
    IntPtr job=CreateJobObjectW(IntPtr.Zero,IntPtr.Zero);
    if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    ProcessInfo child=new ProcessInfo();
    IntPtr input=IntPtr.Zero;
    IntPtr output=IntPtr.Zero,error=IntPtr.Zero;
    IntPtr attributeList=IntPtr.Zero,handles=IntPtr.Zero;
    bool attributesInitialized=false;
    bool assigned=false;
    try {
      ExtendedLimits limits=new ExtendedLimits();
      limits.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)));
      ExtendedStartup startup=new ExtendedStartup();
      startup.startup.cb=Marshal.SizeOf(startup);
      startup.startup.flags=0x101; // hidden console and inherited owned log handles.
      SecurityAttributes attributes=new SecurityAttributes(); attributes.size=Marshal.SizeOf(attributes); attributes.inherit=1;
      input=CreateFileW("NUL",0x80000000,3,ref attributes,3,0,IntPtr.Zero);
      if(input==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      output=InheritedLog(-11); error=InheritedLog(-12);
      startup.startup.input=input; startup.startup.output=output; startup.startup.error=error;
      // PowerShell may hold other inheritable pipe handles. Never pass those to
      // the server: a copied control-pipe writer would prevent EOF shutdown.
      IntPtr size=IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      if(size==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      attributeList=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributeList,1,0,ref size));
      attributesInitialized=true;
      handles=Marshal.AllocHGlobal(3*IntPtr.Size);
      Marshal.WriteIntPtr(handles,0,input);
      Marshal.WriteIntPtr(handles,IntPtr.Size,startup.startup.output);
      Marshal.WriteIntPtr(handles,2*IntPtr.Size,startup.startup.error);
      Check(UpdateProcThreadAttribute(attributeList,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      startup.attributes=attributeList;
      Check(CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x80014,IntPtr.Zero,directory,ref startup,out child));
      Check(AssignProcessToJobObject(job,child.process));
      assigned=true;
      if(ResumeThread(child.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
      Task control=Task.Run(()=>{
        uint read;
        if(!ReadFile(GetStdHandle(-10),new byte[1],1,out read,IntPtr.Zero)) {
          int code=Marshal.GetLastWin32Error();
          if(code!=109 && code!=232) throw new Win32Exception(code);
        }
      });
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
      if(attributesInitialized) DeleteProcThreadAttributeList(attributeList);
      if(attributeList!=IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input);
      if(output!=IntPtr.Zero) CloseHandle(output);
      if(error!=IntPtr.Zero) CloseHandle(error);
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
