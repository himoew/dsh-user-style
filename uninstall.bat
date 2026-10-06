@echo off
rem  dsh-user-style uninstaller (thin ASCII wrapper; see uninstall.bat notes in install.bat)
setlocal
chcp 65001 >nul 2>nul
echo.
echo   dsh-user-style  uninstaller
echo   ===========================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1" %*
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
