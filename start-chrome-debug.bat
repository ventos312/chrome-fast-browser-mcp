@echo off
setlocal

:: These defaults match what chrome-fast uses when it launches Chrome itself.
:: Override any of them by setting the environment variable before running.
if not defined CHROME_PORT set CHROME_PORT=9222
if not defined CHROME_PROFILE set "CHROME_PROFILE=%LOCALAPPDATA%\NanoClaw\ChromeProfile"
:: The DevTools port has no authentication, so it only listens on this PC by
:: default. Set CHROME_DEBUG_ADDRESS=0.0.0.0 only if another machine or a
:: container must connect to Chrome directly.
if not defined CHROME_DEBUG_ADDRESS set CHROME_DEBUG_ADDRESS=127.0.0.1

echo ==========================================
echo  NanoClaw - Start Chrome Debug Mode
echo ==========================================
echo.

:: Explicit path wins
if defined CHROME_PATH if exist "%CHROME_PATH%" (
    set "CHROME=%CHROME_PATH%"
    goto :found
)

:: Try to find Chrome using 'where' first
for /f "delims=" %%i in ('where chrome 2^>nul') do (
    set "CHROME=%%i"
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
echo Please install Google Chrome, or set CHROME_PATH, and try again.
echo.
pause
exit /b 1

:found
echo Chrome found at:
echo   %CHROME%
echo.
echo Profile folder:
echo   %CHROME_PROFILE%
echo.
echo Starting Chrome on %CHROME_DEBUG_ADDRESS%:%CHROME_PORT%...
echo.

start "" "%CHROME%" --remote-debugging-port=%CHROME_PORT% --remote-debugging-address=%CHROME_DEBUG_ADDRESS% --remote-allow-origins=* --user-data-dir="%CHROME_PROFILE%" --no-first-run --no-default-browser-check

echo Chrome launched! A Chrome window should appear shortly.
echo You can close this window now.
echo.
pause
