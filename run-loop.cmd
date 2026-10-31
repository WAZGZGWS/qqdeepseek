@echo off
rem keep the mail service alive: restart 5s after it dies
cd /d "%~dp0"
:loop
if exist err.log for %%A in (err.log) do if %%~zA GTR 1048576 move /y err.log err.old.log >nul 2>nul
if exist out.log for %%A in (out.log) do if %%~zA GTR 1048576 move /y out.log out.old.log >nul 2>nul
node mailbot.mjs >> out.log 2>> err.log
timeout /t 5 /nobreak >nul
goto loop
