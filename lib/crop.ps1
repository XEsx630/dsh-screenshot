# dsh-screenshot / crop.ps1
# Server-side crop of a captured PNG: clone the given pixel rectangle into a
# new PNG. The host half computes physical-pixel coordinates (it knows the
# source PNG dimensions and the on-screen stage size) and passes them here.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File crop.ps1 `
#       -Source C:\path\in.png -OutPath C:\path\out.png -X 0 -Y 0 -W 800 -H 600
#
# stdout: one JSON line { ok } or { ok:false, error }.

param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

try {
  $bmp = New-Object System.Drawing.Bitmap($Source)
  try {
    if ($X -lt 0 -or $Y -lt 0 -or $W -le 0 -or $H -le 0 -or $X + $W -gt $bmp.Width -or $Y + $H -gt $bmp.Height) {
      throw "crop rectangle ($X,$Y,$W,$H) is outside the source image ($($bmp.Width)x$($bmp.Height))"
    }
    $rect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
    $crop = $bmp.Clone($rect, $bmp.PixelFormat)
    try {
      $crop.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $crop.Dispose()
    }
  } finally {
    $bmp.Dispose()
  }
  [Console]::Out.Write('{"ok":true}')
  exit 0
} catch {
  [Console]::Out.Write((@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
  exit 1
}