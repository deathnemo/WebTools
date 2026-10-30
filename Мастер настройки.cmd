@echo off
rem Мастер настройки: двойной клик запускает сервер TuneWizard\windows\serve.ps1 и открывает мастер в браузере.
rem Файл в UTF-8 без BOM. Русские сообщения — только после chcp 65001 (подпрограмма :utf8): cmd читает файл построчно
rem в кодовой странице консоли, и echo с кириллицей до chcp вывел бы мусор. Коды serve.ps1: 0 — работает или вкладка открыта,
rem 2 — отказ (сообщение показано, клавиша уже нажата), прочие — сбой PowerShell: окно не закрывать.
setlocal
if not exist "%~dp0TuneWizard\windows\serve.ps1" goto no_folder
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0TuneWizard\windows\serve.ps1" -Root "%~dp0." %*
set "tw_code=%errorlevel%"
if "%tw_code%"=="0" exit /b 0
if "%tw_code%"=="2" exit /b 2
call :utf8
echo.
echo Мастер настройки завершился с ошибкой (код %tw_code%) — причина в сообщении выше.
goto wait
:no_folder
set "tw_code=1"
call :utf8
echo Рядом с «Мастер настройки.cmd» нет папки TuneWizard: файл запущен не из своей папки
echo (прямо из zip-архива или копия на рабочем столе).
echo Распакуйте весь архив в папку и запустите «Мастер настройки.cmd» оттуда.
:wait
pause
if defined tw_cp chcp %tw_cp% >nul
exit /b %tw_code%
:utf8
for /f "tokens=2 delims=:" %%c in ('chcp') do set "tw_cp=%%c"
set "tw_cp=%tw_cp: =%"
set "tw_cp=%tw_cp:.=%"
chcp 65001 >nul
exit /b 0
