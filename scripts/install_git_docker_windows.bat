@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM  install_git_docker_windows.bat
REM
REM  Installs Git for Windows and Docker Desktop on a Windows Server 2025,
REM  then clones the Progeo detection-docker-setup repository into a local
REM  folder.
REM
REM  Usage:
REM    install_git_docker_windows.bat                 (clone to %USERPROFILE%\detection-docker-setup)
REM    install_git_docker_windows.bat C:\Progeo\code  (clone to a custom folder)
REM
REM  Notes:
REM    - Run this script as Administrator (it enables Windows features and
REM      installs system-wide software).
REM    - Docker Desktop on Windows Server uses the WSL2 backend; the script
REM      enables the required features. A REBOOT is needed before Docker
REM      Desktop can start, so the script ends with a reminder.
REM    - winget is used when available (preinstalled on Server 2025); the
REM      script falls back to direct downloads otherwise.
REM ============================================================================

set "TARGET_DIR=%~1"
if "%TARGET_DIR%"=="" set "TARGET_DIR=%USERPROFILE%\detection-docker-setup"

set "REPO_URL=https://github.com/Progeo-Monitoring-GmbH/detection-docker-setup"

REM ---------------------------------------------------------------------------
REM  0. Admin check
REM ---------------------------------------------------------------------------
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [ERROR] This script must run as Administrator.
    echo         Right-click the .bat file and choose "Run as administrator".
    pause
    exit /b 1
)

echo ============================================================
echo  Progeo setup - Git + Docker Desktop installer
echo ============================================================
echo  Target folder : %TARGET_DIR%
echo  Repository    : %REPO_URL%
echo.

REM ---------------------------------------------------------------------------
REM  1. Enable required Windows features (WSL2 + Virtual Machine Platform)
REM ---------------------------------------------------------------------------
echo [1/5] Enabling Windows features for WSL2 (Docker Desktop backend) ...

dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart >nul 2>&1
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart >nul 2>&1

wsl.exe --set-default-version 2 >nul 2>&1

echo       Features enabled. (A reboot is required before Docker Desktop runs.)

REM ---------------------------------------------------------------------------
REM  2. Install Git for Windows
REM ---------------------------------------------------------------------------
echo [2/5] Installing Git for Windows ...

where winget >nul 2>&1
if "%errorlevel%"=="0" (
    winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements
    if "!errorlevel!"=="0" (
        echo       Git installed via winget.
        goto :git_done
    )
    echo       winget install failed, trying direct download ...
)

set "GIT_URL=https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
set "GIT_INSTALLER=%TEMP%\Git-2.47.1-64-bit.exe"
echo       Downloading Git from %GIT_URL%
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ^
     Invoke-WebRequest -Uri '%GIT_URL%' -OutFile '%GIT_INSTALLER%'" >nul 2>&1
if not exist "%GIT_INSTALLER%" (
    echo [ERROR] Could not download the Git installer.
    pause
    exit /b 1
)
"%GIT_INSTALLER%" /VERYSILENT /NORESTART /SP- /SUPPRESSMSGBOXES >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [ERROR] Git installer failed (errorlevel %errorlevel%).
    pause
    exit /b 1
)
echo       Git installed from direct download.

:git_done

REM ---------------------------------------------------------------------------
REM  3. Install Docker Desktop
REM ---------------------------------------------------------------------------
echo [3/5] Installing Docker Desktop ...

where winget >nul 2>&1
if "%errorlevel%"=="0" (
    winget install --id Docker.DockerDesktop -e --silent --accept-package-agreements --accept-source-agreements
    if "!errorlevel!"=="0" (
        echo       Docker Desktop installed via winget.
        goto :docker_done
    )
    echo       winget install failed, trying direct download ...
)

set "DOCKER_URL=https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
set "DOCKER_INSTALLER=%TEMP%\DockerDesktopInstaller.exe"
echo       Downloading Docker Desktop from desktop.docker.com
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ^
     Invoke-WebRequest -Uri '%DOCKER_URL%' -OutFile '%DOCKER_INSTALLER%'" >nul 2>&1
if not exist "%DOCKER_INSTALLER%" (
    echo [ERROR] Could not download the Docker Desktop installer.
    pause
    exit /b 1
)
"%DOCKER_INSTALLER%" install --quiet --accept-license --backend=wsl-2 >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [ERROR] Docker Desktop installer failed (errorlevel %errorlevel%).
    pause
    exit /b 1
)
echo       Docker Desktop installed from direct download.

:docker_done

REM ---------------------------------------------------------------------------
REM  4. Refresh PATH so git is usable in this session
REM ---------------------------------------------------------------------------
echo [4/5] Refreshing PATH ...
set "PATH=%PATH%;C:\Program Files\Git\cmd"

REM ---------------------------------------------------------------------------
REM  5. Clone the repository
REM ---------------------------------------------------------------------------
echo [5/5] Cloning repository into %TARGET_DIR% ...

if exist "%TARGET_DIR%\.git" (
    echo       Repository already exists at %TARGET_DIR% - skipping clone.
    goto :clone_done
)

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

where git >nul 2>&1
if not "%errorlevel%"=="0" (
    echo [ERROR] git is not on PATH. Reopen the shell after the install, then
    echo         run:  git clone %REPO_URL% "%TARGET_DIR%"
    pause
    exit /b 1
)

git clone --recursive "%REPO_URL%" "%TARGET_DIR%"
if not "%errorlevel%"=="0" (
    echo [ERROR] git clone failed.
    pause
    exit /b 1
)
echo       Repository cloned successfully.

:clone_done

REM ---------------------------------------------------------------------------
REM  Summary
REM ---------------------------------------------------------------------------
echo.
echo ============================================================
echo  Installation finished.
echo ============================================================
echo  Git          : installed
echo  Docker Desktop: installed (WSL2 backend)
echo  Repository   : %TARGET_DIR%
echo.
echo  IMPORTANT: A REBOOT is required before Docker Desktop can start.
echo  After rebooting, start Docker Desktop once, then:
echo      cd /d "%TARGET_DIR%"
echo      docker compose up -d
echo.
pause
endlocal
