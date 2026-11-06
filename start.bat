@echo off
cd /d "%~dp0"
if not exist web\node_modules call npm --prefix web install
start "" http://localhost:4817
npm start
