# Renders sidebar.html and header.html to the 24-bit BMPs the NSIS installer needs (tauri.conf.json
# bundle.windows.nsis sidebarImage/headerImage). NSIS takes neither PNG nor 32-bit BMP. Needs Chrome.
#   powershell -File apps/desktop/src-tauri/installer/render.ps1
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "Chrome oder Edge nicht gefunden." }
$tmp = Join-Path ([IO.Path]::GetTempPath()) "forge-installer-render"
New-Item -ItemType Directory -Force $tmp | Out-Null
foreach ($img in @(@{ name = "sidebar"; w = 164; h = 314 }, @{ name = "header"; w = 150; h = 57 })) {
  $html = Join-Path $PSScriptRoot "$($img.name).html"
  $png = Join-Path $tmp "$($img.name).png"
  Remove-Item $png -ErrorAction SilentlyContinue
  & $chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 `
    "--user-data-dir=$tmp\profile" "--window-size=$($img.w),$($img.h)" "--screenshot=$png" `
    ([Uri]$html).AbsoluteUri | Out-Null
  for ($i = 0; $i -lt 50 -and -not (Test-Path $png); $i++) { Start-Sleep -Milliseconds 200 }
  $src = [Drawing.Image]::FromFile($png)
  $bmp = New-Object Drawing.Bitmap $img.w, $img.h, ([Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.DrawImage($src, 0, 0, $img.w, $img.h)
  $g.Dispose(); $src.Dispose()
  $bmp.Save((Join-Path $PSScriptRoot "$($img.name).bmp"), [Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
  Write-Host "$($img.name).bmp $($img.w)x$($img.h)"
}
