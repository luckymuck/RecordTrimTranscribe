# Build the stand-alone portable desktop build.
#
#   1. rebuild the WASM DSP core
#   2. stage a frontend tree = app/ + the bundled models
#   3. build the Tauri app against that tree, with the portable data override
#   4. assemble dist/portable/ and zip it
#
# Everything the app needs is embedded in the executable, so the result is one
# .exe plus a writable app-data folder it creates on first run. Nothing is
# downloaded at runtime, and the CSP is restricted to 'self'.

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$app = Join-Path $root "app"
$models = Join-Path $here "models"
$frontend = Join-Path $root "dist\tauri-frontend"
$outDir = Join-Path $root "dist\portable\RecordTrimTranscribe"
$exeName = "record-trim-transcribe.exe"

if (-not (Test-Path -LiteralPath (Join-Path $models "onnx-community\whisper-base_timestamped\config.json"))) {
  throw "Bundled models are missing. Run src-tauri\fetch-models.bat once, then retry."
}

Write-Host "1/4  Building the WASM core"
& cmd /c "`"$root\build-wasm.bat`""
if ($LASTEXITCODE -ne 0) { throw "build-wasm.bat failed" }

Write-Host "2/4  Staging the frontend (app + models)"
if (Test-Path -LiteralPath $frontend) { Remove-Item -Recurse -Force -LiteralPath $frontend }
New-Item -ItemType Directory -Force -Path $frontend | Out-Null
Copy-Item -Recurse -Force (Join-Path $app "*") $frontend
New-Item -ItemType Directory -Force -Path (Join-Path $frontend "models") | Out-Null
Copy-Item -Recurse -Force (Join-Path $models "*") (Join-Path $frontend "models")

Write-Host "3/4  Building the desktop app (cargo tauri build --no-bundle)"
Push-Location $here
try {
  & cargo tauri build --no-bundle --config "tauri.portable.conf.json"
  if ($LASTEXITCODE -ne 0) { throw "cargo tauri build failed (is the Tauri CLI installed? cargo install tauri-cli)" }
} finally {
  Pop-Location
}

$exe = Join-Path $here "target\release\$exeName"
if (-not (Test-Path -LiteralPath $exe)) { throw "Expected executable not found at $exe" }

Write-Host "4/4  Assembling the portable folder"
if (Test-Path -LiteralPath $outDir) { Remove-Item -Recurse -Force -LiteralPath $outDir }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -Force $exe (Join-Path $outDir "RecordTrimTranscribe.exe")

$readme = @"
Record - Trim - Transcribe (portable)

Run RecordTrimTranscribe.exe. No installation is needed, and nothing is
downloaded: the speech models are built into the executable.

Everything the app saves - recordings, sessions and settings - is kept in the
"app-data" folder created next to the executable, so this whole folder can be
moved, copied to a USB stick, or deleted without leaving anything behind.

Requirements
  - Windows 10 (April 2018 or later) or Windows 11, which include the
    WebView2 runtime. On an older machine without it, install "Microsoft Edge
    WebView2 Runtime" first, from https://developer.microsoft.com/microsoft-edge/webview2/
  - Extract to a folder you can write to (Desktop, Documents, a USB stick).
    Not Program Files.
"@
Set-Content -Path (Join-Path $outDir "README.txt") -Value $readme -Encoding utf8

$zip = Join-Path $root "dist\portable\RecordTrimTranscribe-portable.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -Force -LiteralPath $zip }
Compress-Archive -Path $outDir -DestinationPath $zip

$exeMb = [math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1)
$zipMb = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Host "`nDone."
Write-Host ("  executable : {0} MB" -f $exeMb)
Write-Host ("  portable   : {0}" -f $outDir)
Write-Host ("  zip        : {0} ({1} MB)" -f $zip, $zipMb)
