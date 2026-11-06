# Claude Session Monitor
#   make up       install (first time), build, start in its own window, open the browser
#   make down     stop it
#   make restart  down + up
#   make dev      live-reload mode for editing the React page (http://localhost:5173)

PORT := 4817
PS := powershell -NoProfile -Command
STOP := Get-NetTCPConnection -LocalPort $(PORT) -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force }; exit 0

.PHONY: up down restart build install dev

up: install build down
	$(PS) "Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory '$(CURDIR)' -WindowStyle Minimized"
	$(PS) "Start-Sleep -Seconds 1; Start-Process 'http://localhost:$(PORT)'"
	@echo Claude Session Monitor is up at http://localhost:$(PORT)

down:
	@$(PS) '$(STOP)'

restart: down up

build:
	npm --prefix web run build

install:
	$(PS) "if (-not (Test-Path 'web/node_modules')) { npm --prefix web install }"

dev: down
	$(PS) "Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory '$(CURDIR)' -WindowStyle Minimized"
	npm --prefix web run dev
