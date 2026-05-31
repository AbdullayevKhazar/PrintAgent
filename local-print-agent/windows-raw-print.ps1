param(
  [Parameter(Mandatory = $true)]
  [string]$DataPath,

  [string]$PrinterName
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NextCrossRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDocName;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string pOutputFile;

        [MarshalAs(UnmanagedType.LPWStr)]
        public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOC_INFO_1 pDocInfo);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]
    private static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    public static void SendBytesToPrinter(string printerName, byte[] bytes, string documentName)
    {
        IntPtr printerHandle;

        if (!OpenPrinter(printerName, out printerHandle, IntPtr.Zero))
        {
            ThrowLastWin32Error("OpenPrinter");
        }

        bool documentStarted = false;
        bool pageStarted = false;

        try
        {
            DOC_INFO_1 documentInfo = new DOC_INFO_1();
            documentInfo.pDocName = documentName;
            documentInfo.pDataType = "RAW";

            if (!StartDocPrinter(printerHandle, 1, documentInfo))
            {
                ThrowLastWin32Error("StartDocPrinter");
            }

            documentStarted = true;

            if (!StartPagePrinter(printerHandle))
            {
                ThrowLastWin32Error("StartPagePrinter");
            }

            pageStarted = true;

            int bytesWritten;
            if (!WritePrinter(printerHandle, bytes, bytes.Length, out bytesWritten))
            {
                ThrowLastWin32Error("WritePrinter");
            }

            if (bytesWritten != bytes.Length)
            {
                throw new Exception("WritePrinter wrote " + bytesWritten + " of " + bytes.Length + " bytes.");
            }
        }
        finally
        {
            if (pageStarted)
            {
                EndPagePrinter(printerHandle);
            }

            if (documentStarted)
            {
                EndDocPrinter(printerHandle);
            }

            ClosePrinter(printerHandle);
        }
    }

    private static void ThrowLastWin32Error(string operation)
    {
        int errorCode = Marshal.GetLastWin32Error();
        throw new Win32Exception(errorCode, operation + " failed");
    }
}
"@

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
    $printer = Get-WmiObject -Class Win32_Printer |
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

if (-not (Test-Path -LiteralPath $DataPath)) {
  throw "Raw data file was not found: $DataPath"
}

if ([string]::IsNullOrWhiteSpace($PrinterName)) {
  $PrinterName = Get-DefaultPrinterName
}

if ([string]::IsNullOrWhiteSpace($PrinterName)) {
  throw "No printer name was configured and Windows default printer could not be found."
}

$resolvedDataPath = (Resolve-Path -LiteralPath $DataPath).Path
[byte[]]$bytes = [System.IO.File]::ReadAllBytes($resolvedDataPath)

[NextCrossRawPrinter]::SendBytesToPrinter(
  $PrinterName,
  $bytes,
  "NextCross ESC/POS Receipt"
)

[PSCustomObject]@{
  ok = $true
  printerName = $PrinterName
  bytes = $bytes.Length
} | ConvertTo-Json -Compress
