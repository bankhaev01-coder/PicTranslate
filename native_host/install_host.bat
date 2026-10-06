@echo off
setlocal DisableDelayedExpansion

REM ---------------------------------------------------------------------------
REM  Устанавливает манифест Native Messaging хоста для расширения Image Translator.
REM  Chrome / Edge / Brave читают манифест из реестра.
REM
REM  Использование:
REM    install_host.bat <EXTENSION_ID>
REM    install_host.bat --uninstall
REM
REM  <EXTENSION_ID> смотрите на chrome://extensions (включён «Режим разработчика») —
REM  это 32-символьный id на карточке расширения.
REM
REM  Манифест пишется самим Python в UTF-8: echo писал его в OEM-кодировке
REM  консоли, и при кириллице в пути (C:\Users\Имя\...) Chrome не мог его прочитать.
REM  DelayedExpansion выключен: с ним из путей пропадали символы "!".
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

REM -- найти рабочий python 3.8+ (заглушка Microsoft Store не подходит) -----
set "PY_EXE="
for /f "delims=" %%i in ('where python 2^>nul') do (
  if not defined PY_EXE call :try_python "%%i"
)
if not defined PY_EXE (
  for /f "delims=" %%i in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do (
    if not defined PY_EXE call :try_python "%%i"
  )
)
if not defined PY_EXE (
  echo [!] Working Python 3.8+ was not found.
  echo     Install it from https://www.python.org/downloads/ and enable "Add python.exe to PATH".
  echo     The Microsoft Store stub in WindowsApps is not enough.
  exit /b 1
)
echo [ok] python: %PY_EXE%

REM -- проверить id расширения (32 символа a-p) ------------------------------
"%PY_EXE%" -c "import re,sys; sys.exit(0 if re.fullmatch('[a-p]{32}', sys.argv[1]) else 1)" "%EXT_ID%"
if errorlevel 1 (
  echo [!] Invalid extension id: %EXT_ID%
  echo     Expected 32 letters a-p, as shown on chrome://extensions.
  exit /b 1
)

REM -- записать launcher .bat, запускающий python-хост -----------------------
set "LAUNCHER=%SCRIPT_DIR%host_launcher.bat"
> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo "%PY_EXE%" -X utf8 "%HOST_PY%" %%*

REM -- отрендерить манифест (UTF-8 JSON через python) -------------------------
"%PY_EXE%" -X utf8 -c "import json,sys; m={'name':sys.argv[1],'description':'Local Tesseract OCR host for the Image Translator extension','path':sys.argv[2],'type':'stdio','allowed_origins':['chrome-extension://'+sys.argv[3]+'/']}; f=open(sys.argv[4],'w',encoding='utf-8'); json.dump(m,f,indent=2,ensure_ascii=False); f.close()" "%HOST_NAME%" "%LAUNCHER%" "%EXT_ID%" "%MANIFEST%"
if errorlevel 1 (
  echo [!] Failed to write manifest: %MANIFEST%
  exit /b 1
)

REM -- зарегистрировать для Chrome / Edge / Brave ----------------------------
set "KEY_CHROME=HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
set "KEY_EDGE=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%"
set "KEY_BRAVE=HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%"

for %%K in ("%KEY_CHROME%" "%KEY_EDGE%" "%KEY_BRAVE%") do (
  reg add %%K /ve /t REG_SZ /d "%MANIFEST%" /f >nul 2>nul && (echo [ok] registered %%K) || (echo [--] skipped %%K)
)

echo.
echo [done] Native host installed.
echo        manifest: %MANIFEST%
echo        launcher: %LAUNCHER%
echo.
echo        Note: install Tesseract and ensure tesseract.exe is on PATH
echo        (winget install UB-Mannheim.TesseractOCR) for OCR to work.
exit /b 0

REM -- :try_python <path> — принять кандидата, если это настоящий Python 3.8+ --
:try_python
set "CAND=%~1"
if not "%CAND:\WindowsApps\=%"=="%CAND%" exit /b 0
"%CAND%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul
if errorlevel 1 exit /b 0
set "PY_EXE=%CAND%"
exit /b 0
