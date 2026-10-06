@echo off
rem ---------------------------------------------------------------------------
rem  dsh-user-style one-click installer (thin ASCII wrapper).
rem
rem  All real work happens in scripts\install.ps1 so that Chinese output and
rem  JSON editing are handled with proper UTF-8. This file stays ASCII-only on
rem  purpose: cmd.exe interprets batch bytes with the console code page, and
rem  mixing UTF-8 text into a .bat is a reliable way to get garbled output.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul 2>nul
echo.
echo   dsh-user-style  installer
echo   =========================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo   Done. Now FULLY QUIT DeepSeek Harness and open it again.
) else (
  echo   FAILED ^(exit code %RC%^). Read the messages above.
)
echo.
pause
endlocal
exit /b %RC%
