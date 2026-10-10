@echo off
REM Rebuild the Rust DSP core to WASM and place it where the web app loads it.
setlocal
cd /d "%~dp0core"
echo Building WASM (web target)...
call npx -y wasm-pack build --target web --out-dir ../app/vendor/fasttalk-core --release
if errorlevel 1 (
  echo WASM build failed.
  exit /b 1
)
echo Done. Output: app\vendor\fasttalk-core
endlocal
