@echo off
REM ---------------------------------------------------------------------------
REM  Starts the OLAP Object Explorer and opens it in your browser.
REM
REM  USAGE
REM      start.cmd           REM serve the built UI on http://127.0.0.1:5182
REM      start.cmd -Dev      REM Vite dev server instead (live reload)
REM
REM  PREREQUISITES
REM      1. The engine, started in ITS OWN terminal and left open:
REM             ..\start-engine.cmd
REM         (add -Anonymous if the engine build requires authentication)
REM      2. A built UI:  pnpm run build
REM         dist\ already exists in this workspace; the check below is a guard.
REM
REM  Node is located in this order:
REM    1. a `node` already on your PATH
REM    2. the Node runtime bundled with DeepSeek Harness
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
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%i"
)

if not defined NODE_EXE (
  REM Each candidate is tested on its own: a parenthesised block containing
  REM %ProgramFiles(x86)% parses badly.
  if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
  if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
)

if not defined NODE_EXE (
  REM The runtime bundled with DeepSeek Harness.
  set "DSHROOT=%USERPROFILE%"
  if not defined DSHROOT set "DSHROOT=%SystemDrive%\Users\%USERNAME%"
  if exist "!DSHROOT!\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=!DSHROOT!\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  echo.
  echo   ERROR: Node.js was not found.
  echo   Install Node 20 or newer from https://nodejs.org, then run this file again.
  echo.
  pause
  exit /b 1
)

echo   Using Node: %NODE_EXE%
"%NODE_EXE%" --version

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
  echo       pnpm install
  echo       pnpm run build
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
