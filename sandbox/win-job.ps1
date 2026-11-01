param(
  [Parameter(Mandatory = $true)][string]$CommandB64,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [int]$MemoryMB = 1024,
  [int]$Pids = 256,
  [int]$CpuSec = 300
)

# win-job.ps1 - Windows Job Object launcher (L2 process sandbox).
# Called by sandbox/index.js via: powershell.exe -File win-job.ps1 ...
# Creates a Job Object with memory / active-process / CPU-time limits plus
# KILL_ON_JOB_CLOSE, starts the command through cmd.exe, assigns the child to
# the job, forwards raw stdout/stderr bytes, and exits with the child code.
# IMPORTANT: keep this file ASCII-only; Windows PowerShell 5.1 reads .ps1 as
# ANSI when there is no BOM, so non-ASCII comments can break parsing.

$ErrorActionPreference = 'Stop'

$cs = @"
using System;
using System.Runtime.InteropServices;

public static class SandboxLauncher {
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr a, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint cb);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);

  const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY  = 0x00000100;
  const uint JOB_OBJECT_LIMIT_JOB_TIME        = 0x00000004;
  const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS  = 0x00000008;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int  JobObjectExtendedLimitInformation = 9;
  const uint PROCESS_SET_QUOTA = 0x0100;
  const uint PROCESS_TERMINATE = 0x0001;

  public static IntPtr CreateJob(int memoryMB, int pids, int cpuSec) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_PROCESS_MEMORY |
      JOB_OBJECT_LIMIT_JOB_TIME |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (memoryMB > 0) info.ProcessMemoryLimit = (UIntPtr)((ulong)memoryMB * 1024UL * 1024UL);
    if (pids > 0) info.BasicLimitInformation.ActiveProcessLimit = (uint)pids;
    if (cpuSec > 0) info.BasicLimitInformation.PerJobUserTimeLimit = (long)cpuSec * 10000000L;

    int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)len)) {
      CloseHandle(job);
      throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    }
    return job;
  }

  public static void Assign(IntPtr job, int pid) {
    IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try {
      if (!AssignProcessToJobObject(job, h)) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
    } finally {
      CloseHandle(h);
    }
  }

  public static void Close(IntPtr job) { if (job != IntPtr.Zero) CloseHandle(job); }
}
"@

Add-Type -TypeDefinition $cs -Language CSharp

$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandB64))
$cmdFile = Join-Path ([IO.Path]::GetTempPath()) ("sandbox-" + [Guid]::NewGuid().ToString('N') + ".cmd")
$enc = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($cmdFile, "@echo off`r`n" + $command + "`r`n", $enc)

if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }

$job = $null
$proc = $null
try {
  $job = [SandboxLauncher]::CreateJob($MemoryMB, $Pids, $CpuSec)

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c ""' + $cmdFile + '""'
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $null = $proc.Start()

  try { [SandboxLauncher]::Assign($job, $proc.Id) } catch {
    [Console]::Error.WriteLine("[sandbox] Job Object assign failed: " + $_.Exception.Message)
  }

  # Forward raw bytes so Node's console-encoding smart decoder can handle them.
  $outTask = $proc.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $errTask = $proc.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $proc.WaitForExit()
  try { [void]$outTask.Wait(5000) } catch {}
  try { [void]$errTask.Wait(5000) } catch {}

  exit $proc.ExitCode
}
catch {
  [Console]::Error.WriteLine("[sandbox] " + $_.Exception.Message)
  exit 127
}
finally {
  try { if ($proc -ne $null -and -not $proc.HasExited) { $proc.Kill() } } catch {}
  try { if ($job -ne $null) { [SandboxLauncher]::Close($job) } } catch {}
  try { Remove-Item $cmdFile -Force -ErrorAction SilentlyContinue } catch {}
}
