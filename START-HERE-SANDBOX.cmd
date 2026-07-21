@echo off
setlocal
cd /d "%~dp0"
title REVOLUTE Sandbox Helper

:header
cls
echo ============================================================
echo  REVOLUTE - Revolut Business Sandbox Helper
echo ============================================================
echo.
echo This helper uses Revolut Sandbox only.
echo It does not send a Production payment.
echo.

where node.exe >nul 2>nul
if errorlevel 1 goto no_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto no_node

if not exist "node_modules\jose\package.json" (
  echo Installing the project files needed for testing...
  echo This may display many lines. That is normal.
  echo.
  call npm ci
  if errorlevel 1 goto install_failed
)

:menu
echo.
echo Choose one action:
echo.
echo   1. First-time Revolut Sandbox setup
echo   2. Test the saved Sandbox account connection
echo   3. Add test funds to a Sandbox account
echo   4. Run all safe local code tests
echo   5. Close this window
echo.
choice /C 12345 /N /M "Type 1, 2, 3, 4, or 5: "
set "menuChoice=%errorlevel%"

if "%menuChoice%"=="5" goto done
if "%menuChoice%"=="4" goto local_tests
if "%menuChoice%"=="3" goto topup
if "%menuChoice%"=="2" goto accounts
if "%menuChoice%"=="1" goto setup
goto menu

:setup
cls
call npm run sandbox:setup
goto finished_action

:accounts
cls
call npm run sandbox:accounts
goto finished_action

:topup
cls
call npm run sandbox:topup
goto finished_action

:local_tests
cls
call npm run check
goto finished_action

:finished_action
echo.
echo ------------------------------------------------------------
echo The selected action is finished.
echo Read any SUCCESS or FAILED message above.
echo ------------------------------------------------------------
pause
goto header

:no_node
cls
echo Node.js was not found.
echo Ask the project maintainer to install the approved Node.js version.
echo Then close and reopen this helper.
echo.
pause
goto done

:install_failed
echo.
echo The project installation failed.
echo Copy only the final error message to the project maintainer.
echo Never include certificate files or tokens in the message.
echo.
pause
goto done

:done
endlocal
exit /b 0
