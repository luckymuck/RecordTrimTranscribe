@echo off
REM Launch the local website (all processing happens in the browser).
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py server.py %*
) else (
  python server.py %*
)
endlocal
