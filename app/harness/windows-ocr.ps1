<#
  windows-ocr.ps1 — local OCR / PDF text extraction using Windows' built-in
  engines (Windows.Media.Ocr + Windows.Data.Pdf). No install, no network, no
  third-party binaries: the language pack ships with Windows.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File windows-ocr.ps1 -Image <file>
    powershell -NoProfile -ExecutionPolicy Bypass -File windows-ocr.ps1 -Pdf <file> [-MaxPages N] [-Dpi 170]

  Output: a single JSON object on stdout:
    { "ok": true, "engine": "en-GB", "pages": [ { "page": 1, "text": "..." } ], "text": "..." }
    { "ok": false, "error": "..." }
#>
param(
  [string]$Image,
  [string]$Pdf,
  [int]$MaxPages = 40,
  [int]$Dpi = 170
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

# --- WinRT async plumbing -------------------------------------------------
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and -not $_.IsGenericMethod -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]

function AwaitAction($action) {
    $task = $asTaskAction.Invoke($null, @($action))
    $task.Wait(-1) | Out-Null
}

function New-InMemoryStream {
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    return $stream
}

function Get-OcrText([Windows.Graphics.Imaging.SoftwareBitmap]$bitmap, $engine) {
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    if ($null -eq $result) { return '' }
    $lines = @()
    foreach ($line in $result.Lines) { $lines += $line.Text }
    return ($lines -join "`n")
}

try {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        # English is always available on Windows 11 even when the profile
        # language set has no OCR pack installed.
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
    }
    if ($null -eq $engine) {
        Write-Output '{"ok":false,"error":"no Windows OCR engine (install an OCR language pack)"}'
        exit 0
    }

    $pages = @()

    if ($Image) {
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Image)) ([Windows.Storage.StorageFile])
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            # OcrEngine caps working images at 2600px on the long side.
            $scale = 1.0
            if ($decoder.PixelWidth -gt 2600) { $scale = 2600.0 / $decoder.PixelWidth }
            $opts = New-Object Windows.Graphics.Imaging.BitmapTransform
            $opts.ScaledWidth = [uint32]([Math]::Max(1, [int]($decoder.PixelWidth * $scale)))
            $opts.ScaledHeight = [uint32]([Math]::Max(1, [int]($decoder.PixelHeight * $scale)))
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
                [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                [Windows.Graphics.Imaging.BitmapAlphaMode]::Straight,
                $opts,
                [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
                [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
            try {
                $text = Get-OcrText $bitmap $engine
                $pages += @{ page = 1; text = $text }
            } finally { $bitmap.Dispose() }
        } finally { $stream.Dispose() }
    }

    if ($Pdf) {
        $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
        $null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
        $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Pdf)) ([Windows.Storage.StorageFile])
        $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
        $count = [Math]::Min($doc.PageCount, $MaxPages)
        for ($i = 0; $i -lt $count; $i++) {
            $page = $null
            try {
                $page = $doc.GetPage([uint32]$i)
                try {
                    $stream = New-InMemoryStream
                    try {
                        $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
                        $target = [uint32]([Math]::Min(2000, [int]($page.Size.Width * $Dpi / 72.0)))
                        $opts.DestinationWidth = [Math]::Max($target, 120)
                        AwaitAction ($page.RenderToStreamAsync($stream, $opts))
                        $stream.Seek(0)
                        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
                        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
                        try {
                            $text = Get-OcrText $bitmap $engine
                            $pages += @{ page = ($i + 1); text = $text }
                        } finally { $bitmap.Dispose() }
                    } finally { $stream.Dispose() }
                } finally {
                    if ($page) { try { $page.Dispose() } catch { } }
                }
            } catch {
                $pages += @{ page = ($i + 1); text = ''; error = "$($_.Exception.Message)" }
            }
        }
    }

    $all = ($pages | ForEach-Object { $_.text }) -join "`n"
    $result = @{
        ok        = $true
        engine    = $engine.RecognizerLanguage.LanguageTag
        pageCount = $pages.Count
        pages     = $pages
        text      = $all
    }
    Write-Output (($result | ConvertTo-Json -Depth 6 -Compress))
} catch {
    $msg = "$($_.Exception.Message)"
    if ($_.Exception.InnerException) { $msg = "$msg :: $($_.Exception.InnerException.Message)" }
    if ($_.Exception.InnerException -and $_.Exception.InnerException.InnerException) { $msg = "$msg :: $($_.Exception.InnerException.InnerException.Message)" }
    $safe = $msg.Replace('"', "'")
    $payload = @{ ok = $false; error = $safe } | ConvertTo-Json -Compress
    Write-Output $payload
    exit 0
}
