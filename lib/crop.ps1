# dsh-screenshot / crop.ps1
# Server-side crop of a captured PNG: clone the given physical-pixel rectangle
# into a new PNG. The host half computes those coordinates from the PNG's real
# size and the browser's display-space selection.
#
# Usage:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#       -File crop.ps1 -Source C:\path\in.png -OutPath C:\path\out.png `
#       -X 0 -Y 0 -W 800 -H 600
#
# stdout: one JSON line { ok } or { ok: false, error }.

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

$exitCode = 0
$result = @{ ok = $false; error = 'unknown failure' }

try {
  if ($X -lt 0 -or $Y -lt 0 -or $W -le 0 -or $H -le 0) {
    throw "invalid crop rectangle ($X,$Y,$W,$H)"
  }

  $bitmap = New-Object System.Drawing.Bitmap($Source)
  try {
    if ($X + $W -gt $bitmap.Width -or $Y + $H -gt $bitmap.Height) {
      throw "crop rectangle ($X,$Y,$W,$H) is outside the source image ($($bitmap.Width)x$($bitmap.Height))"
    }
    $rect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
    # Force a deterministic 32-bit surface: cloning into an indexed format can
    # fail to encode when the source PNG uses a palette.
    $crop = $bitmap.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $crop.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $crop.Dispose()
    }
  } finally {
    $bitmap.Dispose()
  }
  $result = @{ ok = $true }
} catch {
  $exitCode = 1
  $result = @{ ok = $false; error = [string]$_.Exception.Message }
}

[Console]::Out.Write(($result | ConvertTo-Json -Compress))
exit $exitCode
