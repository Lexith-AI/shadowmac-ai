@echo off
title Shadow AI Launcher
echo ========================================
echo        Shadow AI Companion App
echo ========================================
echo Launching server and opening app window...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
pause
