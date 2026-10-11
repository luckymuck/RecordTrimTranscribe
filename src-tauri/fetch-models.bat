@echo off
REM Download the Whisper models the offline desktop build bundles.
REM Run once before build-portable.bat; the files are cached under src-tauri\models.
echo Fetching the bundled speech models (about 360 MB, one time).
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-models.ps1"
if errorlevel 1 (
  echo.
  echo Model download FAILED - the reason is above.
) else (
  echo.
  echo Models are ready.
)
echo.
pause
