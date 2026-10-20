# dsh-screenshot / screenshot.ps1
# Full-screen capture with optional foreground-window hiding (WeChat-style
# "hide current window, then screenshot").
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#       -File screenshot.ps1 -OutPath C:\path\shot.png -HideWindow 1 -AllScreens 0
#
# stdout: one JSON line { ok, width, height } or { ok: false, error }.
# The host half spawns this script once per capture.
#
# Crash safety: before hiding, the foreground window handle is written to
# "<OutPath>.hwnd". Every normal exit removes it; if this process is killed
# (host timeout), the host restores the window from that marker.

param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$HideWindow = 0,
  [int]$AllScreens = 0,
  [int]$DelayMs = 250
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshShotNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

$marker = "$OutPath.hwnd"
$hwnd = [IntPtr]::Zero
$exitCode = 0
$result = @{ ok = $false; error = 'unknown failure' }

try {
  # Capture physical pixels under display scaling.
  [DshShotNative]::SetProcessDPIAware() | Out-Null

  if ($HideWindow -eq 1) {
    $hwnd = [DshShotNative]::GetForegroundWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
      [System.IO.File]::WriteAllText($marker, $hwnd.ToInt64().ToString())
      # SW_HIDE = 0
      [DshShotNative]::ShowWindow($hwnd, 0) | Out-Null
    }
    Start-Sleep -Milliseconds $DelayMs
  }

  if ($AllScreens -eq 1) {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  } else {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  }

  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
    } finally {
      $graphics.Dispose()
    }
    $bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }

  $result = @{ ok = $true; width = $bounds.Width; height = $bounds.Height }
} catch {
  $exitCode = 1
  $result = @{ ok = $false; error = [string]$_.Exception.Message }
} finally {
  if ($hwnd -ne [IntPtr]::Zero) {
    try {
      # SW_SHOW = 5
      [DshShotNative]::ShowWindow($hwnd, 5) | Out-Null
      [DshShotNative]::SetForegroundWindow($hwnd) | Out-Null
    } catch { }
  }
  if (Test-Path -LiteralPath $marker) {
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  }
}

[Console]::Out.Write(($result | ConvertTo-Json -Compress))
exit $exitCode
