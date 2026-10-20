# dsh-screenshot / restore.ps1
# Re-show a window that screenshot.ps1 hid but could not restore because its
# process was killed. The host only spawns this when a ".hwnd" marker survived
# a capture.
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#       -File restore.ps1 -Hwnd 123456

param(
  [Parameter(Mandatory = $true)][long]$Hwnd
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshRestoreNative {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

try {
  $handle = [IntPtr]$Hwnd
  # SW_SHOW = 5
  [DshRestoreNative]::ShowWindow($handle, 5) | Out-Null
  [DshRestoreNative]::SetForegroundWindow($handle) | Out-Null
  [Console]::Out.Write('{"ok":true}')
  exit 0
} catch {
  [Console]::Out.Write((@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}
