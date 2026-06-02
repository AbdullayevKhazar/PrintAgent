$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$iconDir = Join-Path $projectRoot "icon"
$outputPath = Join-Path $iconDir "image.ico"
$preferredSourcePath = Join-Path $iconDir "source.png"
$fallbackPngPath = Join-Path $iconDir "image.png"

New-Item -ItemType Directory -Path $iconDir -Force | Out-Null

function Test-ValidIco($path) {
  if (-not (Test-Path -LiteralPath $path)) {
    return $false
  }

  $stream = [System.IO.File]::OpenRead($path)
  try {
    if ($stream.Length -lt 6) {
      return $false
    }

    $header = New-Object byte[] 6
    [void]$stream.Read($header, 0, 6)
    return (
      $header[0] -eq 0 -and
      $header[1] -eq 0 -and
      $header[2] -eq 1 -and
      $header[3] -eq 0 -and
      $header[4] -gt 0
    )
  } finally {
    $stream.Dispose()
  }
}

function Get-IconSourcePath {
  if (Test-Path -LiteralPath $preferredSourcePath) {
    return $preferredSourcePath
  }

  if (Test-Path -LiteralPath $fallbackPngPath) {
    return $fallbackPngPath
  }

  if ((Test-Path -LiteralPath $outputPath) -and -not (Test-ValidIco $outputPath)) {
    return $outputPath
  }

  return $null
}

if (Test-ValidIco $outputPath) {
  Write-Host "[icon] Valid icon already exists: icon/image.ico"
  exit 0
}

$sourcePath = Get-IconSourcePath
if ($null -eq $sourcePath) {
  throw "Missing icon source. Add a valid icon/image.ico or put a PNG at icon/source.png."
}

Write-Host "[icon] Generating icon/image.ico from $([System.IO.Path]::GetFileName($sourcePath))"

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = @()

try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.Clear([System.Drawing.Color]::Transparent)

      $scale = [Math]::Min($size / $sourceImage.Width, $size / $sourceImage.Height)
      $drawWidth = [Math]::Max(1, [int]($sourceImage.Width * $scale))
      $drawHeight = [Math]::Max(1, [int]($sourceImage.Height * $scale))
      $drawX = [int](($size - $drawWidth) / 2)
      $drawY = [int](($size - $drawHeight) / 2)
      $graphics.DrawImage($sourceImage, $drawX, $drawY, $drawWidth, $drawHeight)

      $memoryStream = New-Object System.IO.MemoryStream
      try {
        $bitmap.Save($memoryStream, [System.Drawing.Imaging.ImageFormat]::Png)
        $entries += [pscustomobject]@{
          Size = $size
          Bytes = $memoryStream.ToArray()
        }
      } finally {
        $memoryStream.Dispose()
      }
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
} finally {
  $sourceImage.Dispose()
}

$tempPath = "$outputPath.tmp"
$fileStream = New-Object System.IO.FileStream $tempPath, ([System.IO.FileMode]::Create), ([System.IO.FileAccess]::Write)
$writer = New-Object System.IO.BinaryWriter $fileStream

try {
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$entries.Count)

  $offset = 6 + (16 * $entries.Count)
  foreach ($entry in $entries) {
    $width = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
    $writer.Write([byte]$width)
    $writer.Write([byte]$width)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$entry.Bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $entry.Bytes.Length
  }

  foreach ($entry in $entries) {
    $writer.Write($entry.Bytes)
  }
} finally {
  $writer.Dispose()
  $fileStream.Dispose()
}

Move-Item -LiteralPath $tempPath -Destination $outputPath -Force
Write-Host "[icon] Wrote icon/image.ico"
