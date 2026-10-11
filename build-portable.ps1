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
#
# This script sits in the project root, so $PSScriptRoot IS the root.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$app = Join-Path $root "app"
$tauriDir = Join-Path $root "src-tauri"
$models = Join-Path $tauriDir "models"
$frontend = Join-Path $root "dist\tauri-frontend"
$outDir = Join-Path $root "dist\portable\RecordTrimTranscribe"
$zip = Join-Path $root "dist\portable\RecordTrimTranscribe-portable.zip"
$exeName = "record-trim-transcribe.exe"

Write-Host "Project root : $root"
Write-Host ""

$probe = Join-Path $models "onnx-community\whisper-base_timestamped\config.json"
if (-not (Test-Path -LiteralPath $probe)) {
  throw "Bundled models are missing (looked in $models). Run src-tauri\fetch-models.bat once, then retry."
}

Write-Host "1/4  Building the WASM core"
& cmd /c "`"$(Join-Path $root 'build-wasm.bat')`""
if ($LASTEXITCODE -ne 0) { throw "build-wasm.bat failed" }

Write-Host "2/4  Staging the frontend (app + models)"
if (Test-Path -LiteralPath $frontend) { Remove-Item -Recurse -Force -LiteralPath $frontend }
New-Item -ItemType Directory -Force -Path $frontend | Out-Null
Copy-Item -Recurse -Force (Join-Path $app "*") $frontend
$frontendModels = Join-Path $frontend "models"
New-Item -ItemType Directory -Force -Path $frontendModels | Out-Null
Copy-Item -Recurse -Force (Join-Path $models "*") $frontendModels
Write-Host ("     staged {0:N1} MB" -f ((Get-ChildItem -Recurse -File $frontend | Measure-Object -Property Length -Sum).Sum / 1MB))

Write-Host "3/4  Building the desktop app (tauri build --no-bundle)"
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw "cargo was not found on PATH. Install Rust from https://rustup.rs, then retry."
}

# Native tools write progress to stderr, and PowerShell 5.1 turns a redirected
# native stderr into a terminating error while $ErrorActionPreference is Stop.
# Relax it around these calls and check exit codes explicitly instead.
$strict = $ErrorActionPreference
$ErrorActionPreference = "Continue"

# Either CLI works: the Rust one (cargo install tauri-cli) or the npm one.
& cargo tauri --version *> $null
$hasCargoTauri = ($LASTEXITCODE -eq 0)
$tauriArgs = @("build", "--no-bundle", "--config", "tauri.portable.conf.json")

Push-Location $tauriDir
try {
  if ($hasCargoTauri) {
    & cargo tauri @tauriArgs
  } else {
    Write-Host "     cargo tauri not found; using the npm CLI (npx @tauri-apps/cli)"
    & npx --yes "@tauri-apps/cli@^2" @tauriArgs
  }
  $buildCode = $LASTEXITCODE
} finally {
  Pop-Location
  $ErrorActionPreference = $strict
}

if ($buildCode -ne 0) {
  throw "The Tauri build failed. Install the CLI with 'cargo install tauri-cli' or 'npm i -D @tauri-apps/cli', then retry."
}

$exe = Join-Path $tauriDir "target\release\$exeName"
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

if (Test-Path -LiteralPath $zip) { Remove-Item -Force -LiteralPath $zip }
Compress-Archive -Path $outDir -DestinationPath $zip

Write-Host "`nDone."
Write-Host ("  executable : {0} MB" -f [math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1))
Write-Host ("  portable   : {0}" -f $outDir)
Write-Host ("  zip        : {0} ({1} MB)" -f $zip, [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1))
