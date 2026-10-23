@echo off
rem ============================================================
rem  Arcade FPS - Build script
rem  Outputs to dist\ (avoids bin\ which may be file-locked)
rem ============================================================
setlocal
cd /d "%~dp0"

echo [1/2] restore...
dotnet restore src\ArcadeFPS\ArcadeFPS.csproj || goto :err

echo [2/2] build...
dotnet build src\ArcadeFPS\ArcadeFPS.csproj -c Release --no-restore -p:OutputPath="%~dp0dist\" || goto :err

echo.
echo Build OK: dist\ArcadeFPS.exe
echo.
pause
exit /b 0

:err
echo.
echo Build FAILED. See errors above.
pause
exit /b 1
