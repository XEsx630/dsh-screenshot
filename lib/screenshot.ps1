# dsh-screenshot / screenshot.ps1
# Full-screen capture with optional foreground-window hiding (WeChat-style
# "hide current window then screenshot").
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File screenshot.ps1 `
#       -OutPath C:\path\to\out.png -HideWindow 1 -AllScreens 0 -DelayMs 300
#
# stdout: one JSON line { ok, width, height } or { ok:false, error }.
# The DSH host half spawns this script per capture request.

param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$HideWindow = 0,
  [int]$AllScreens = 0,
  [int]$DelayMs = 300
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Native entry points (user32) for DPI awareness, hiding, and restoring the
# foreground window. Compiled with Add-Type; requires FullLanguage (the host
# spawns powershell.exe outside the DSH tool sandbox).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshScreenshotNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

$hwnd = [IntPtr]::Zero
$hidden = $false

function Restore-Window {
  if ($hidden -and $hwnd -ne [IntPtr]::Zero) {
    try {
      # SW_SHOW = 5
      [DshScreenshotNative]::ShowWindow($hwnd, 5) | Out-Null
      [DshScreenshotNative]::SetForegroundWindow($hwnd) | Out-Null
    } catch { }
  }
}

try {
  # Physical-pixel capture under DPI scaling
  [DshScreenshotNative]::SetProcessDPIAware() | Out-Null

  if ($HideWindow -eq 1) {
    $hwnd = [DshScreenshotNative]::GetForegroundWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
      # SW_HIDE = 0
      [DshScreenshotNative]::ShowWindow($hwnd, 0) | Out-Null
      $hidden = $true
    }
    Start-Sleep -Milliseconds $DelayMs
  }

  if ($AllScreens -eq 1) {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  } else {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  }

  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
  } finally {
    $g.Dispose()
  }

  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  Restore-Window

  [Console]::Out.Write((@{ ok = $true; width = $bounds.Width; height = $bounds.Height } | ConvertTo-Json -Compress))
  exit 0
} catch {
  Restore-Window
  [Console]::Out.Write((@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}