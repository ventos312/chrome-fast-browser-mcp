@echo off
setlocal

set PORT=9222
set PROFILE=%LOCALAPPDATA%\NanoClaw\ChromeProfile

echo ==========================================
echo  NanoClaw - Start Chrome Debug Mode
echo ==========================================
echo.

:: Try to find Chrome using 'where' first
for /f "delims=" %%i in ('where chrome 2^>nul') do (
    set CHROME=%%i
    goto :found
)

:: Try common install paths
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    goto :found
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    goto :found
)
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    goto :found
)

:: Try registry
for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" /ve 2^>nul') do (
    set "CHROME=%%b"
    goto :found
)

echo ERROR: Chrome not found on this machine.
echo Please install Google Chrome and try again.
echo.
pause
exit /b 1

:found
echo Chrome found at:
echo   %CHROME%
echo.
echo Profile folder:
echo   %PROFILE%
echo.
echo Starting Chrome on port %PORT%...
echo.

start "" "%CHROME%" --remote-debugging-port=%PORT% --remote-debugging-address=0.0.0.0 --remote-allow-origins=* --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check

echo Chrome launched! A Chrome window should appear shortly.
echo You can close this window now.
echo.
pause
