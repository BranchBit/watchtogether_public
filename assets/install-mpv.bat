@echo off
setlocal ENABLEDELAYEDEXPANSION

:: Configuration
set "SEVENZIP_URL=https://www.7-zip.org/a/7zr.exe"
set "SEVENZIP_EXE=7zr.exe"
set "MPV_URL=https://github.com/zhongfly/mpv-winbuild/releases/download/2025-07-28-a6f3236/mpv-x86_64-20250728-git-a6f3236.7z"
set "MPV_ARCHIVE=mpv.7z"
set "MPV_FOLDER=mpv"
set "INSTALL_DIR=%USERPROFILE%\mpv"

:: Create a temp working dir
set "TMP_DIR=%TEMP%\mpvsetup"
mkdir "%TMP_DIR%" 2>nul
cd /d "%TMP_DIR%"

:: Step 1: Download 7zr.exe if not exists
if not exist "%TMP_DIR%\%SEVENZIP_EXE%" (
    echo 🔽 Downloading 7zr.exe...
    powershell -Command "Invoke-WebRequest -Uri '%SEVENZIP_URL%' -OutFile '%TMP_DIR%\%SEVENZIP_EXE%'"
)

:: Step 2: Download mpv
echo 🔽 Downloading mpv build...
powershell -Command "Invoke-WebRequest -Uri '%MPV_URL%' -OutFile '%MPV_ARCHIVE%'"

:: Step 3: Extract
echo 📦 Extracting mpv...
"%TMP_DIR%\%SEVENZIP_EXE%" x "%MPV_ARCHIVE%" -o"%TMP_DIR%\%MPV_FOLDER%" -y >nul

:: Step 4: Move to user folder
echo 📁 Installing to %INSTALL_DIR%...
rmdir /s /q "%INSTALL_DIR%" 2>nul
move /y "%TMP_DIR%\%MPV_FOLDER%" "%INSTALL_DIR%" >nul

:: Step 5: Add to user PATH
set "NEWPATH=%INSTALL_DIR%"
set "OLDPATH="

for /f "tokens=2*" %%a in ('reg query HKCU\Environment /v PATH 2^>nul') do set "OLDPATH=%%b"

if not defined OLDPATH (
    echo [WARN] Could not read PATH from registry. Using current session PATH.
    set "OLDPATH=%PATH%"
)

echo %OLDPATH% | find /i "%NEWPATH%" >nul
if %errorlevel% neq 0 (
    echo ➕ Adding mpv to user PATH...
    setx PATH "%OLDPATH%;%NEWPATH%"
) else (
    echo ✅ mpv is already in PATH.
)

:: Step 6: Cleanup and debug info
echo.
echo ✅ Done! MPV installed to: %INSTALL_DIR%
echo 🧠 You may need to log out and back in for the PATH to update everywhere.
echo.
echo 🧪 User PATH now includes:
reg query HKCU\Environment /v PATH
echo.

pause

