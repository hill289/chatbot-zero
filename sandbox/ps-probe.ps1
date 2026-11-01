$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public static class WinJobProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);
  public static bool Create() {
    IntPtr h = CreateJobObject(IntPtr.Zero, null);
    if (h == IntPtr.Zero) return false;
    CloseHandle(h);
    return true;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
if ([WinJobProbe]::Create()) { Write-Output "JOB_OK" } else { Write-Output "JOB_FAIL" }
