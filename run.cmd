@echo off
rem ============================================================
rem  Arcade FPS - Launch
rem  Runs dist\ArcadeFPS.exe (builds it first if missing)
rem ============================================================
setlocal
cd /d "%~dp0"

set "EXE=dist\ArcadeFPS.exe"

if not exist "%EXE%" (
  echo Not built yet, building...
  dotnet build src\ArcadeFPS\ArcadeFPS.csproj -c Release -p:OutputPath="%~dp0dist\" || (
    echo Build FAILED.
    pause
    exit /b 1
  )
)

echo Starting Arcade FPS...
echo (click desktop blank area to play; Esc to exit back to wallpaper)
start "" "%EXE%" %*
exit /b 0
