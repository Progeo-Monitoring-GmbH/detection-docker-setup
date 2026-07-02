@echo off
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0.."
pushd "%ROOT_DIR%"

if exist "%ROOT_DIR%\venv\Scripts\activate.bat" (
  call "%ROOT_DIR%\venv\Scripts\activate.bat"
)

set "TESTS_ACTIVE=1"
set "DJANGO_SETTINGS_MODULE=progeo.tests.settings"

"%ROOT_DIR%\venv\Scripts\python.exe" "%ROOT_DIR%\scripts\pytest_selector.py"
set "EXIT_CODE=%ERRORLEVEL%"

popd
exit /b %EXIT_CODE%
