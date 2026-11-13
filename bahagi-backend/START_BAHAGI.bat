@echo off
title BAHAGI backend
cd /d "%~dp0"
echo.
echo  ===== BAHAGI backend =====
echo.

rem ---- 1. find Python
set "PY="
python --version >nul 2>nul && set "PY=python"
if not defined PY py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY goto :nopython

rem ---- 2. set up once, or repair a half-finished setup
if not exist ".venv\Scripts\python.exe" (
  echo  First run: creating the environment...
  %PY% -m venv .venv
)
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, multipart, httpx, PIL" >nul 2>nul
if errorlevel 1 (
  echo  Installing packages, 1-2 minutes, needs internet...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt > setup_log.txt 2>&1
  ".venv\Scripts\python.exe" -c "import fastapi, uvicorn, multipart, httpx, PIL" >nul 2>nul
  if errorlevel 1 goto :installfailed
  echo  Packages installed.
)
if not exist ".env" copy ".env.example" ".env" >nul

rem ---- 3. open the page as soon as the server is up
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 90;$i++){try{Invoke-WebRequest -UseBasicParsing http://localhost:8000/ -TimeoutSec 1 | Out-Null; Start-Process 'http://localhost:8000/'; break}catch{Start-Sleep 1}}"

echo.
echo  If Windows asks about the firewall: tick BOTH Private and Public, then click Allow.
echo  ESP32 Wi-Fi: turn on Windows Mobile Hotspot - Settings, Network, Mobile hotspot - band 2.4 GHz.
echo  Put that hotspot name and password in the ESP32 code. The box finds this laptop by itself.
echo  Keep this window OPEN. Closing it stops BAHAGI.
echo.
".venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000
echo.
echo  BAHAGI stopped. Send a screenshot of this window if that was not on purpose.
pause
exit /b

:nopython
echo  Python is not installed. Installing it now...
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
echo.
echo  Done. CLOSE this window and double-click START_BAHAGI.bat again.
echo  If that failed: install Python from python.org and tick "Add python.exe to PATH".
pause
exit /b

:installfailed
echo.
echo  Package install FAILED. Last lines of setup_log.txt:
powershell -NoProfile -Command "Get-Content setup_log.txt -Tail 15"
echo.
echo  Check the internet connection, then double-click START_BAHAGI.bat again.
pause
exit /b
