@echo off
REM Download the Whisper models the offline desktop build bundles.
REM Run once before build-portable.bat; the files are cached under src-tauri\models.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-models.ps1"
if errorlevel 1 (
  echo Model download failed.
  exit /b 1
)
