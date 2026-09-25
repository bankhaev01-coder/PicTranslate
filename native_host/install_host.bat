@echo off
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------------------
REM  Устанавливает манифест Native Messaging хоста для расширения Image Translator.
REM  Chrome / Edge / Brave читают манифест из реестра.
REM
REM  Использование:
REM    install_host.bat <EXTENSION_ID>
REM
REM  <EXTENSION_ID> смотрите на chrome://extensions (включён «Режим разработчика») —
REM  это 32-символьный id на карточке расширения.
REM ---------------------------------------------------------------------------

set "HOST_NAME=com.manga.translate.host"
set "SCRIPT_DIR=%~dp0"
set "HOST_PY=%~dp0host.py"
set "MANIFEST=%~dp0%HOST_NAME%.json"
set "EXT_ID=%~1"

if /i "%EXT_ID%"=="--uninstall" (
  for %%K in (
    "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
    "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%"
    "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%"
  ) do (
    reg delete %%K /f >nul 2>nul
    echo [ok] removed %%K
  )
  if exist "%MANIFEST%" del /q "%MANIFEST%"
  if exist "%SCRIPT_DIR%host_launcher.bat" del /q "%SCRIPT_DIR%host_launcher.bat"
  echo [done] Native host uninstalled.
  exit /b 0
)

if "%EXT_ID%"=="" (
  echo [!] Extension id is required.
  echo     Usage: install_host.bat ^<EXTENSION_ID^>
  echo     Open chrome://extensions, enable Developer mode and copy the id.
  exit /b 1
)

REM -- найти python ----------------------------------------------------------
set "PY_EXE="
for /f "delims=" %%i in ('where python 2^>nul') do (
  if not defined PY_EXE set "PY_EXE=%%i"
)
if not defined PY_EXE (
  echo [!] python.exe was not found on PATH. Install Python 3.8+ first.
  exit /b 1
)

REM -- записать launcher .bat, запускающий python-хост -----------------------
set "LAUNCHER=%SCRIPT_DIR%host_launcher.bat"
> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo "%PY_EXE%" -X utf8 "%HOST_PY%" %%*

REM -- отрендерить манифест ---------------------------------------------------
> "%MANIFEST%" echo {
>> "%MANIFEST%" echo   "name": "%HOST_NAME%",
>> "%MANIFEST%" echo   "description": "Local Tesseract OCR host for the Image Translator extension",
>> "%MANIFEST%" echo   "path": "%LAUNCHER:\=\\%",
>> "%MANIFEST%" echo   "type": "stdio",
>> "%MANIFEST%" echo   "allowed_origins": [
>> "%MANIFEST%" echo     "chrome-extension://%EXT_ID%/"
>> "%MANIFEST%" echo   ]
>> "%MANIFEST%" echo }

REM -- зарегистрировать для Chrome / Edge / Brave ----------------------------
set "KEY_CHROME=HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
set "KEY_EDGE=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%"
set "KEY_BRAVE=HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%"

for %%K in ("%KEY_CHROME%" "%KEY_EDGE%" "%KEY_BRAVE%") do (
  reg add %%K /ve /t REG_SZ /d "%MANIFEST%" /f >nul
  if !errorlevel! equ 0 (
    echo [ok] registered %%K
  ) else (
    echo [--] skipped %%K
  )
)

echo.
echo [done] Native host installed.
echo        manifest: %MANIFEST%
echo        launcher: %LAUNCHER%
echo.
echo        Note: install Tesseract and ensure tesseract.exe is on PATH
echo        (winget install UB-Mannheim.TesseractOCR) for OCR to work.
exit /b 0
