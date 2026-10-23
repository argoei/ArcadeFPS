@echo off
rem ============================================================
rem  Arcade FPS - Build Windows installer (same config as GhibliMeadow)
rem  Steps: dotnet publish (framework-dependent) -> Inno Setup 6
rem  Output: release\ArcadeFPS-Setup-1.0.0.exe
rem ============================================================
setlocal
cd /d "%~dp0"

set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"

echo [1/3] publish (framework-dependent, x64)...
if exist "release\app" rmdir /s /q "release\app"
dotnet publish src\ArcadeFPS\ArcadeFPS.csproj -c Release -r win-x64 --self-contained false -o "release\app" || goto :err

echo [2/3] check publish output...
if not exist "release\app\ArcadeFPS.exe" (
  echo [FAILED] ArcadeFPS.exe not found in release\app
  goto :err
)

echo [3/3] compile installer (Inno Setup 6)...
"%ISCC%" "installer\ArcadeFPS.iss" || goto :err

echo.
echo Done. Installer: release\ArcadeFPS-Setup-1.0.0.exe
echo.
pause
exit /b 0

:err
echo.
echo BUILD FAILED. See errors above.
pause
exit /b 1
