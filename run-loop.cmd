@echo off
rem 保持邮件服务常驻：崩了 5 秒后重来
cd /d "%~dp0"
:loop
if exist err.log for %%A in (err.log) do if %%~zA GTR 1048576 move /y err.log err.old.log >nul 2>nul
node mailbot.mjs >> out.log 2>> err.log
timeout /t 5 /nobreak >nul
goto loop
