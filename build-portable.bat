@echo off
REM Build the stand-alone portable desktop build (see build-portable.ps1).
REM Run src-tauri\fetch-models.bat once first, if you have not already.
echo Building the portable desktop app - this takes a few minutes.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-portable.ps1"
if errorlevel 1 (
  echo.
  echo Portable build FAILED - the reason is above.
) else (
  echo.
  echo Portable build finished.
)
echo.
pause
