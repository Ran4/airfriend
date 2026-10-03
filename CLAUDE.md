# AIR FRIEND HOCKEY

A fake 1994 SNES ice hockey cartridge in TypeScript + three.js (Vite). You play PAL, a bichon
frise holding the stick in his mouth, as center for the FERNFIELD PUPS (kids) against the GLACIER
BAY BLIZZARD. 5v5, 3 x 2:00 periods, sudden-death OT, force-scaled penalty roll on body checks.
No menus: the page boots straight into the intro and the opening faceoff.

- `DESIGN.md` is the spec (gameplay rules, rendering, HUD, audio). Keep it in sync when you change
  documented behavior or numbers.
- `README.md` has controls and URL params.
- `TESTING_TOOLS.md` has test mode, every test/harness command, the typecheck configs, and the
  runtime hooks tests rely on. Add new harnesses to its Commands table.

## Commands

```sh
make run        # dev server + opens Firefox (that's for the user. Don't run it yourself; use BROWSER=none)
make test       # tsc + sim-tests + ai-tests + 5 simulated games
make build      # typecheck (tsconfig.app.json) + bundle into dist/
```

If the shell rewrites `npx`, call `./node_modules/.bin/tsx` directly. TypeScript is v7 (tsgo), so
there's no TS JS API.

## Architecture rules

- **`src/sim/**` and `src/ai/**` never import three.js or touch the DOM.** They run under node
  (tests, `tools/simulate.ts`, balance tools).
- **Randomness:** all of it goes through `rand()` / `randRange()` / `gauss()` in `src/sim/util.ts`.
  Never call `Math.random` in sim/AI, because tests seed it via `setRandom(mulberry32(seed))`.
- **Data flow is one-way.** `stepGame(state, pad)` advances exactly one 1/60 s tick and starts by
  replacing `state.events`. `main.ts` dispatches events to audio, HUD and renderer after every tick.
  Render, HUD and audio only read `GameState` and never mutate it.
- **Render interpolation:** for each draw, `main.ts` writes lerped actor positions into the state
  and restores them in a `finally` (`src/core/loop.ts`). The sim never sees lerped values.
- **Shared contracts:** these live in `src/types.ts`. Keep changes additive.
- **Module APIs stay stable:**
  - sim: `createGame` and `stepGame`
  - AI: `updateAI(state, dt)`, which writes `skater.intent`
  - `GameRenderer`, `Hud` (`onEvents` and `draw(state, dt, project)`), `AudioEngine`
  - `SpriteLibrary` (`src/render/art/index.ts`)
- **Fault isolation:** every subsystem call in `main.ts` sits in its own try/catch that reports via
  `fault('<subsystem>', err)`. Wrap new calls the same way.
- **Test-only code:** the test API (`window.__airfriend`, `window.__airfriendAudio`), `?autoplay`,
  `?speed`, `?post` and `?dither` exist only on the dev server or with `?test=1`. Gate new debug
  hooks the same way (`import.meta.env.DEV || ?test=1`).

## Conventions that bite

- **Coordinates:** meters, ice plane X/Z, Y up. x runs across the width (±13) and z along the
  length (±30.5). Heading is `atan2(dir.x, dir.z)`.
- **Ends and camera:** `attackDir` / `screenToWorld` / `cameraHeading` in `src/sim/rink.ts` define the
  ends. HOME attacks +z in odd periods and OT. The camera always sits behind HOME's end, so
  screen-up means attack. Looking along +z, screen-right is world -x.
- **Sprite facing:** `screenAngle` is computed from the heading expressed in camera space, never from
  `facing - cameraHeading`.
- **SNES look:** WebGL renders at 256x224 and output is quantized to 15-bit color. Every texture
  uses NearestFilter with no mipmaps. Gameplay sprites draw at exactly 1 texel per pixel
  (`SPRITE_METERS_PER_PIXEL` in config).
- **No asset files.** Pixel art is palette-char string grids in `src/render/art/`, with team colors
  as palette slots swapped per team. All sound is synthesized in `src/audio/`.
- **HUD text:** use the 8x8 bitmap font in `src/ui/font.ts` at integer coordinates. Never use
  `ctx.fillText` with a system font.

## Tuning knobs

- `src/config.ts`: `PHYS` (skating, puck, shots, checks), `RULES` (periods, penalty roll curve,
  phase timings), `TEAMS` (rosters, attributes, colors).
- `src/ai/skater.ts`: `BLIZZARD_READ` / `OZ_READ` (the main balance lever), `CHECK_TEAM`, `DOG_FEED_MAX`.
- `src/ai/ozone.ts`: offensive-zone play (protect, cycle, point shots).
- `src/sim/actions.ts`: `POKE_SHIELD_MUL`, `CALL_FOR_TIME`.
- `src/render/camera.ts`: `CAMERA` (pitch 44°, fov 32, follow/keep windows, faceoff whip-pan).
- Balance targets, measured with the pad-only human bot: skill 1 wins ~60-70%, skill 0.6 ~50-60%,
  and the Blizzard take ~14-18 shots. Small samples swing wildly, so judge balance with
  `npx tsx tools/ai-ozstats.ts bot 240 20 1` (and `ai 120 20`), not a handful of games.

## Verifying changes

- **Never open a visible browser window or GUI.** All browser tools run headless Chromium.
- **Required:** `npx tsc --noEmit`, `tools/sim-tests.ts`, `tools/ai-tests.ts`, and `tools/simulate.ts 10`,
  which must end with `OK`.
- **Visual changes:** `node tools/playtest.mjs --params "test=1&autoplay=1&speed=2" --seconds 12 --shots 2,6,10 --out tools/out/<name>`,
  then look at the `shot-*-x3.png` files with Read. For full-game flow use
  `node tools/integ-watch.mjs --speed 6`, and `uv run tools/rink-sheet.py <dir> <out.png>` for contact sheets.
- **Headless timing:** headless runs use SwiftShader at ~30-60 ticks/s, so wall-clock timings drift.
  Assert on `window.__airfriend.state` (via `--eval`), not on elapsed time.
- **New harness scripts:** they must live inside the project (e.g. `tools/`). Scripts elsewhere
  can't resolve `vite` / `playwright`.
- **Tools tree:**
  - `tools/qa-*` are throwaway repro probes, excluded from `npx tsc --noEmit`.
  - `tools/out/` is gitignored scratch output.
  - `tools/out/final/` holds the reference contact sheets.
- **Production build:** after touching anything that ships, run `make build`, then
  `node tools/integ-dist.mjs`.
