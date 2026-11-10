@echo off
REM ---------------------------------------------------------------------------
REM  Starts the OLAP Object Explorer and opens it in your browser.
REM
REM  USAGE
REM      start.cmd           REM serve the built UI on http://127.0.0.1:5182
REM      start.cmd -Dev      REM Vite dev server instead (live reload)
REM      start.cmd -Check    REM print the Node selection and exit (no server)
REM
REM  PREREQUISITES
REM      1. The engine, started in ITS OWN terminal and left open:
REM             ..\start-engine.cmd
REM         (add -Anonymous if the engine build requires authentication)
REM      2. Dependencies installed, and a built UI:  npm install && npm run build
REM         dist\ already exists in this workspace; the check below is a guard.
REM
REM  Node is located in this order, but only a Node whose architecture matches
REM  the native rollup/esbuild packages in node_modules is accepted:
REM    1. %OLAP_EXPLORER_NODE% (explicit override)
REM    2. a `node` already on your PATH
REM    3. common Node installations
REM    4. the Node runtime bundled with DeepSeek Harness
REM  This matters on Windows-on-ARM: node_modules can be installed under x64
REM  (emulated) while a newer arm64 Node is first on PATH, or vice versa. An
REM  architecture mismatch otherwise fails later with a confusing rollup
REM  "Cannot find module @rollup/rollup-win32-..." error, so it is checked here.
REM  Set OLAP_EXPLORER_NODE to force a particular node.exe.
REM
REM  Leave this window open: it IS the server. Ctrl+C stops it.
REM
REM  Why not start the engine from here? The engine belongs to its own terminal;
REM  a server started by a session or a script dies with it. This script only
REM  serves static files and proxies /v1 to the engine you started yourself.
REM ---------------------------------------------------------------------------

setlocal enabledelayedexpansion
cd /d "%~dp0"

if not defined PORT set "PORT=5182"
if not defined HOST set "HOST=127.0.0.1"

REM --- locate Node ---------------------------------------------------------
REM  An architecture-mismatched Node cannot load node_modules' native packages
REM  (rollup/esbuild), so candidates are accepted only when the matching package
REM  directories exist. See the header for the ordering.
if not exist "node_modules\vite\bin\vite.js" (
  echo.
  echo   ERROR: dependencies are not installed in this folder.
  echo.
  echo   Install them with the Node you intend to use, then retry:
  echo       npm install
  echo   or  pnpm install
  echo.
  pause
  exit /b 1
)

set "NODE_EXE="
set "NODE_ARCH="

REM  scripts\find-node.ps1 prints one node.exe whose architecture matches the
REM  native rollup/esbuild packages in node_modules; diagnostics go to stderr.
for /f "usebackq delims=" %%n in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\find-node.ps1"`) do set "NODE_EXE=%%n"

if not defined NODE_EXE (
  echo.
  echo   ERROR: could not select a Node for this checkout. See the diagnostics above.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%a in ('"%NODE_EXE%" -p process.arch 2^>nul') do set "NODE_ARCH=%%a"
if not defined NODE_ARCH set "NODE_ARCH=unknown"

echo   Using Node: %NODE_EXE% (win32-%NODE_ARCH%)
"%NODE_EXE%" --version

if /i "%~1"=="-Check" (
  echo   Node selection OK. Set OLAP_EXPLORER_NODE to override.
  exit /b 0
)

REM --- is the engine answering? -------------------------------------------
where curl >nul 2>nul
if errorlevel 1 goto engine_checked
curl -s -o NUL --max-time 2 "http://127.0.0.1:8080/v1/capabilities"
if not errorlevel 1 goto engine_checked

echo.
echo   WARNING: no engine answered on http://127.0.0.1:8080/v1/capabilities
echo            Start it in its own terminal first:  ..\start-engine.cmd
echo            The explorer will show an offline banner until it is up.
echo.

:engine_checked

REM --- dev mode? -----------------------------------------------------------
if /i "%~1"=="-Dev" goto dev

if not exist "dist\index.html" (
  echo.
  echo   ERROR: no built UI found at dist\index.html
  echo.
  echo   Build it first, in a terminal with network access for the first install:
  echo       npm install
  echo       npm run build
  echo.
  pause
  exit /b 1
)

echo.
echo   OLAP Object Explorer  -^>  http://%HOST%:%PORT%/
echo   Proxying /v1 to the engine on 127.0.0.1:8080 (no CORS needed).
echo   If the engine requires sign-in, a login form appears (create users with serve.exe --add-user).
echo   Keep this window open. Press Ctrl+C to stop.
echo.

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://%HOST%:%PORT%/"
"%NODE_EXE%" "node_modules\vite\bin\vite.js" preview --host %HOST% --port %PORT% --strictPort
goto stopped

:dev
echo.
echo   OLAP Object Explorer (dev, live reload)  -^>  http://%HOST%:%PORT%/
echo   Proxying /v1 to the engine on 127.0.0.1:8080 (no CORS needed).
echo   If the engine requires sign-in, a login form appears (create users with serve.exe --add-user).
echo   Keep this window open. Press Ctrl+C to stop.
echo.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://%HOST%:%PORT%/"
"%NODE_EXE%" "node_modules\vite\bin\vite.js" --host %HOST% --port %PORT% --strictPort

:stopped
echo.
echo   Explorer stopped.
pause
endlocal
goto :eof
