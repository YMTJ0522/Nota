# Screen burst capture: ~22 fps, up to 100 s, JPEG into .keep\burst\
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\.keep\burst'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$w = $b.Width; $h = $b.Height
Write-Host "Screen $w x $h, capturing up to 100 s..."

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$n = 0
while ($sw.Elapsed.TotalSeconds -lt 100) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 70L)
  $bmp.Save((Join-Path $out ("f{0:d4}.jpg" -f $n)), $enc, $ep)
  $bmp.Dispose()
  $n++
  Start-Sleep -Milliseconds 25
}
Write-Host "Done, $n frames -> $out"
