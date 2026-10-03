# AIR FRIEND HOCKEY
#   make run       dev server + open the game in Firefox (Ctrl+C stops it)
#   make preview   production build, served + opened in Firefox
#   make build     typecheck + bundle into dist/
#   make test      typecheck, rules/AI tests, 5 simulated full games
#   make clean     remove dist/

BROWSER ?= firefox
VITE    := ./node_modules/.bin/vite
TSX     := ./node_modules/.bin/tsx

.PHONY: run dev preview build test clean

# Vite opens $(BROWSER) once the server is ready, on whatever port it got.
run: node_modules
	BROWSER=$(BROWSER) $(VITE) --open

dev: run

preview: build
	BROWSER=$(BROWSER) $(VITE) preview --open

build: node_modules
	npm run build

test: node_modules
	npx tsc --noEmit
	$(TSX) tools/sim-tests.ts
	$(TSX) tools/ai-tests.ts
	$(TSX) tools/simulate.ts 5

clean:
	rm -rf dist

node_modules: package.json package-lock.json
	npm install
	@touch node_modules
