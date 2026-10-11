@echo off
REM Build the stand-alone portable desktop build (see build-portable.ps1).
REM Run src-tauri\fetch-models.bat once first, if you have not already.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-portable.ps1"
if errorlevel 1 (
  echo Portable build failed.
  exit /b 1
)
