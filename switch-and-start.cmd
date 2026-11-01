@echo off
chcp 65001 >nul
title chatbot-zero - switch to unpacked renderer mode
cd /d "%~dp0"

echo ============================================
echo  chatbot-zero: switch to external renderer mode
echo ============================================
echo.
echo Close chatbot-zero.exe first if it is running.
echo This renames resources\app.asar to app.asar.bak,
echo then chatbot-zero.exe loads the sibling renderer\ directory.
echo.

if not exist "dist\win-unpacked\resources\app\main.js" (
  echo [1/2] Preparing resources\app ...
  node scripts\switch-to-unpacked.js
  if errorlevel 1 goto :fail
) else (
  echo [1/2] resources\app already prepared.
)

echo [2/2] Removing app.asar ...
if exist "dist\win-unpacked\resources\app.asar" (
  move /y "dist\win-unpacked\resources\app.asar" "dist\win-unpacked\resources\app.asar.bak" >nul
  if errorlevel 1 goto :fail
)
if exist "dist\win-unpacked\resources\app.asar" goto :fail

echo.
echo [OK] Switched. Run dist\win-unpacked\chatbot-zero.exe directly from now on.
echo      Upgrading = overwrite the sibling renderer\ directory.
echo.
start "" "dist\win-unpacked\chatbot-zero.exe"
exit /b 0

:fail
echo.
echo [FAIL] app.asar is still locked or preparation failed.
echo Make sure chatbot-zero.exe has fully exited, then retry.
pause
exit /b 1
