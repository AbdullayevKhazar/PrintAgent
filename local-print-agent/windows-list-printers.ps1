$ErrorActionPreference = "Stop"

function Get-DefaultPrinterName {
  try {
    $printer = Get-CimInstance -ClassName Win32_Printer |
      Where-Object { $_.Default } |
      Select-Object -First 1

    if ($printer -and $printer.Name) {
      return $printer.Name
    }
  } catch {
  }

  try {
    Add-Type -AssemblyName System.Drawing
    $settings = New-Object System.Drawing.Printing.PrinterSettings

    if ($settings.PrinterName) {
      return $settings.PrinterName
    }
  } catch {
  }

  return $null
}

$defaultPrinterName = Get-DefaultPrinterName
$printers = @()

try {
  $printers = Get-CimInstance -ClassName Win32_Printer |
    Sort-Object Name |
    ForEach-Object {
      [PSCustomObject]@{
        name = $_.Name
        default = [bool]$_.Default
        status = $_.PrinterStatus
        workOffline = [bool]$_.WorkOffline
        source = "cim"
      }
    }
} catch {
  $printers = @()
}

if (-not $printers -or $printers.Count -eq 0) {
  try {
    $printers = Get-Printer |
      Sort-Object Name |
      ForEach-Object {
        [PSCustomObject]@{
          name = $_.Name
          default = ($_.Name -eq $defaultPrinterName)
          status = $_.PrinterStatus
          workOffline = [bool]$_.WorkOffline
          source = "get-printer"
        }
      }
  } catch {
    $printers = @()
  }
}

if (-not $printers -or $printers.Count -eq 0) {
  try {
    Add-Type -AssemblyName System.Drawing
    $printers = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters |
      Sort-Object |
      ForEach-Object {
        [PSCustomObject]@{
          name = $_
          default = ($_ -eq $defaultPrinterName)
          status = $null
          workOffline = $null
          source = "system-drawing"
        }
      }
  } catch {
    $printers = @()
  }
}

@($printers) | ConvertTo-Json -Compress
