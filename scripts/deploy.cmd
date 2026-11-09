@echo off
rem Deploy dist\win-unpacked to %LOCALAPPDATA%\MuseAgent and launch from there.
rem Running from D:\...\REA breaks Chromium (ICU init) - always launch the copy.
setlocal
set "SRC=%~dp0..\dist\win-unpacked"
set "DST=%LOCALAPPDATA%\MuseAgent"

if not exist "%SRC%\Muse Agent.exe" (
  echo No build found: "%SRC%\Muse Agent.exe"
  echo Run: npm run dist:dir   ^(or dist:portable^)   first.
  pause
  exit /b 1
)

echo [1/3] Stopping any running Muse Agent...
taskkill /f /im "Muse Agent.exe" >nul 2>&1
rem ping = portable sleep; timeout.exe fails under redirected input (ISE/VS Code)
ping -n 3 127.0.0.1 >nul

echo [2/3] Copying ~250 MB to "%DST%" (takes ~30-90 s)...
if not exist "%DST%" mkdir "%DST%"
xcopy "%SRC%\*" "%DST%\" /E /Y /I
if errorlevel 4 (
  echo.
  echo xcopy failed - a file is probably still locked. Close the app and retry.
  pause
  exit /b 1
)

echo [3/3] Launching...
start "" "%DST%\Muse Agent.exe"
echo Deployed. This window can be closed.
pause
