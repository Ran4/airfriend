# AIR FRIEND HOCKEY

A fake 1994 Super Nintendo ice hockey cartridge, in TypeScript + three.js.
You play **PAL**, a bichon frise who plays center for the FERNFIELD PUPS (a team
of kids) against the GLACIER BAY BLIZZARD. It's Air Bud on ice: 5 v 5, four skaters plus a goalie per team.

There are no menus. The page boots straight into the intro and the opening faceoff.
Every graphic and every sound is generated in code, so the game loads no asset files.

## Run

```sh
npm install
npm run dev        # http://localhost:5199
```

Production build (typechecks `src/` only, then bundles into `dist/`):

```sh
npm run build
npm run preview    # serve dist/
```

## Controls

| Key | With the puck | Without the puck |
|---|---|---|
| Arrows / WASD | skate (up = attack, every period) | skate |
| Z / J (SHOOT) | hold = wind up, release = shoot; tap = quick wrist shot; ←/→ held picks the corner, the charge sets the height | poke check; if a teammate has the puck: call for a shot (or for a pass, when he's out of range); held while a pass comes = one-timer |
| X / K (PASS) | pass toward the held direction (or to the best open teammate) | body check; if a teammate has the puck: call for a pass |
| C / L (TURBO) | hold = sprint (stamina meter); a press next to a puck carrier, or a quick tap, = **BARK** (startles, can make the carrier fumble) | same |
| Enter / P / Esc (START) | pause / resume, skip intermission, rematch on the final screen | |
| M | mute | |
| V | CRT scanlines | |
| F / double-click | fullscreen on/off (Esc also leaves it) | |

Faceoffs: after the ref drops the puck, the first center to press SHOOT or PASS wins it.
Pressing early is a false start. Body checks can draw penalties. PAL can be sent to the
box too, and control then switches to a teammate until PAL is back.

Sound starts on the first key press (browser autoplay policy).

The two layouts can be mixed freely: a button stays held while any of its keys is down, so
holding → and tapping D never stops PAL, and pressing J while Z is held is not a second shot.
Ctrl, Cmd/Meta and Alt chords belong to the browser (Ctrl+L, Ctrl+S, Cmd+M...): the game
ignores them and does not block them. Shift changes nothing.

Leaving the game pauses it: hiding the tab or alt-tabbing away (window blur) during a faceoff,
live play, a whistle, a goal, a penalty or the period-end horn sets PAUSE, and it stays paused
when you come back until you press START. Intermission and the final screen run on. Sound is
suspended while the tab is hidden.

URL parameters: `?mute=1`, `?crt=1`. The render debug switches `?post=0` (raw 24-bit render,
no 15-bit quantize) and `?dither=N` (ordered-dither strength in 5-bit steps, 0 = off) are
test-mode only, like the test API below: a shipped build always shows the same picture.

Test mode: the test API `window.__airfriend` (live state, `step`, `setPadOverride`, `restart`,
`setSpeed`, `capture`, ...) and the switches `?autoplay=1` (the AI plays PAL too) and `?speed=N`
(fast-forward, up to 32x) only exist on the Vite dev server (`npm run dev`, and every
`tools/*.mjs` harness that starts one) or when the URL has `?test=1`. A production build opened
without `?test=1` plays like a cartridge: `window.__airfriend` is undefined and `autoplay` /
`speed` are ignored, so the shipped game has no one-line score cheat. To drive a build, add it:
`http://localhost:4173/?test=1&autoplay=1&speed=2` (`npm run preview`).

## Layout

```
src/main.ts        boot, fixed 60 Hz loop, test API (window.__airfriend; dev server or ?test=1)
src/core/          keyboard -> pad; fixed-step clock + render interpolation (loop.ts);
                   device-pixel-exact sharp-bilinear presentation + CRT scanlines (display.ts)
src/sim/           rules, physics, penalties, faceoffs, goalies, referee (no DOM, runs in node)
src/ai/            team tactics, skater and goalie AI (no DOM)
src/render/        three.js: arena, camera, 256x224 SNES framebuffer + 15-bit post, sprites, effects
src/render/art/    all pixel art, authored as palette-char grids and packed into atlases
src/ui/            HUD: 8x8 bitmap font, windows, banners, intermission/final/pause screens
src/audio/         WebAudio synth: SFX, chiptune music, crowd
DESIGN.md          the full spec
```

## Testing tools

None of these open a visible window. Browser tools run headless Chromium.

| Command | What it does |
|---|---|
| `npx tsc --noEmit` (= `npm run typecheck`) | typecheck `src/` + the maintained harnesses `tools/*.ts`, except `tools/qa-*` |
| `npm run typecheck:app` | typecheck `src/` only, the same check `npm run build` runs |
| `npm run typecheck:qa` | also typecheck the throwaway `tools/qa-*` probes (informational; may fail) |
| `npx tsx tools/sim-tests.ts` | 73 deterministic rules/physics scenarios |
| `npx tsx tools/ai-tests.ts` | 17 AI behavior scenarios |
| `npx tsx tools/simulate.ts 10` | 10 full AI-vs-AI games in node, with event stats and a PROBLEMS/OK verdict |
| `npx tsx tools/ai-balance.ts 100 30` | AI-vs-AI plus scripted-human balance report |
| `node tools/playtest.mjs --params "autoplay=1&speed=2" --seconds 12 --shots 2,6,10 --out tools/out/run` | screenshots (256x224 + 3x) and a state dump; `--keys file.json` scripts the keyboard, `--eval` reads state |
| `node tools/integ-watch.mjs [--bot] [--speed 6]` | plays a whole game through the real main loop and screenshots on events (goals, penalties, box, periods, final, pause, rematch); `--bot` plays PAL through the pad like a human |
| `node tools/sim-keytest.mjs` | real-keyboard controls test in periods 1 and 2 |
| `node tools/integ-dist.mjs [--out dir]` | smoke-tests the production build in `dist/`: with `?test=1` the test API is there and the sim runs; without it the game still boots and draws but `window.__airfriend` is undefined |
| `node tools/integ-pause-leave.mjs [--out dir]` | steps the real game into each live phase, emulates window blur and a tab hide, and checks it pauses, stays paused on return and resumes on one START; checks the audio focus hooks (`setHidden` / `ensureRunning`) too |
| `node tools/integ-fullscreen.mjs [--out dir]` | F and double-click enter/leave fullscreen in the real page, entering doesn't trip the auto-pause, Ctrl+F stays the browser's, and the pause screen shows the switch |
| `node tools/integ-input.mjs` | keyboard through the real loop (records every polled pad via `__airfriend.input`): aliased keys share one held state with one press/release edge, Ctrl/Meta/Alt chords are neither handled nor `preventDefault`ed, keys released under Ctrl don't stick, blur drops everything |
| `npx tsx tools/integ-loop.ts [seconds]` | node: replays 59.94 / 60 / 60.05 / 120 / 144 Hz frame timings through the real clock (near-60 Hz must run exactly one sim step per frame), and checks render interpolation restores the state bit-for-bit and leaves a seeded game identical to a never-interpolated one |
| `node tools/integ-interp.mjs [--speed 1] [--hz 144] [--out dir]` | records every frame of the real loop: render and HUD see `lerp(prev, cur, alpha)` positions (teleports drawn at cur), the sim gets its own values back, also while `renderer.render` throws; `--hz` rescales rAF timestamps to emulate a refresh rate |
| `node tools/integ-dpr.mjs [--out dir]` | presentation at DPR 1 / 1.25 / 1.5 / 1.75 / 2 (browsers started at that scale, plus two DevTools-emulated runs): 1-px row / column test patterns must give one whole device-row count per source row with no blended rows, 8:7 column edges within 0.25 device px, CRT scanlines repeating every source row; live DPR change re-fits; `capture()` stays 256x224. Saves a real frame (CRT off/on) per viewport |
| `node tools/integ-robust-throw.mjs` | makes each subsystem (sim, audio, HUD, renderer) throw in the real loop and checks the game keeps ticking, drawing and delivering events |
| `node tools/hud-goalcheck.mjs` / `node tools/hud-delayedcheck.mjs` | real loop: the GOAL!! banner never covers the scored-on net; the DELAYED PENALTY chip follows the sim and stays clear of the score bug / PP strip |
| `node tools/audio-cues.mjs` / `audio-focus.mjs` / `audio-drop.mjs` | real loop audio: call-for / false-start / wind-up cues and voice leaks; tab hide, resume and mute persistence; music silent at every faceoff drop |
| `node tools/playtest.mjs --page /tools/audio-test.html --seconds 60 --eval "window.__audioReport" --out tools/out/audio` | offline render of every sound, cue and flow with the mix rules: goal loudest, whistle >= 7.5 dB under it, pickups >= 6 dB over the live crowd bed (0.5 and the 0.65 cap), the delayed-penalty cue clear in its own band and out of the stick band; `--params quick=1` renders only the sounds and those rules (~30 s, for tuning) |
| `npx tsx tools/audio-pickuprate.ts 3 7` | node: how often the pickup sound fires in AI games (per second of play, gaps between pickups) and delayed-penalty cues per game |
| `npx tsx tools/rink-frame.ts 3 7` (`BOT=1`) | camera framing stats in node: puck / PAL off-screen, HUD overlaps, far crossbar and goalie head vs the score bug |
| `npx tsx tools/rink-faceoff.ts 3 7` (`BOT=1`) | faceoff framing in node: where the faceoff dot lands on screen per faceoff, by the phase it came from (goal, penalty, stoppage...), and the share framed from 0.25 s on |
| `node tools/rink-camshots.mjs [--out dir]` | real loop, headless: screenshots of a forced post-goal faceoff (whip-pan at 0.04 / 0.12 / 0.25 / 0.6 s) and a staged PAL rush into the offensive zone |
| `npx tsx tools/sim-shotlab.ts 300` / `tools/sim-rules-soak.ts` / `tools/ai-support.ts` | shooting acceptance lab, rules soak with delayed-penalty invariants, home-support (feeds to PAL) stats |
| `npx tsx tools/ai-ozstats.ts bot 240 20 1` / `ai 120 20` | large-sample balance in parallel workers (games split over 20 seeds): win %, goals, shots, hits and penalties by team, offensive-zone possession length (per shot, and sustained through rebounds) with how possessions end, zone pass kinds; `bot` = pad-only human bot at a skill, `ai` = AI vs AI |
| `npx tsx tools/ai-cycletrace.ts [team] [n] [seed]` / `node tools/ai-cycleshot.mjs [--team 1]` | offensive-zone game (src/ai/ozone.ts): text trace of zone possessions (everybody's spot, role and events every 0.25 s), and real-game screenshots of a team cycling (fast-forwarded headless autoplay) |
| `node tools/actors-game.mjs --scenario tools/integ-scn-facing.js --params "per=2"` | stages a scene in the real game (facing, penalty box, goal framing scenarios in `tools/integ-scn-*.js`) |

Each module also has its own preview tool, e.g. `tools/art-preview.html`, `tools/hud-shoot.mjs`,
`tools/rink-shots.mjs`, `tools/actors-shots.mjs` and `tools/audio-test.html`.

The main loop isolates faults: every subsystem call in `src/main.ts` has its own try/catch, so
one exception costs that subsystem a frame, not the game. The first error per subsystem goes to
`console.error` (prefixed `[airfriend]`); repeats are only counted, and
`window.__airfriend.faults()` returns the counts. `window.__airfriend.audio` / `.hud` /
`.renderer` expose the live subsystems so tests can patch them. `window.__airfriendAudio` (the
audio engine, read by the `audio-*` tools) exists under the same rule as `window.__airfriend`:
the dev server, or `?test=1` on a build.

Motion is smooth at any refresh rate (`src/core/loop.ts`): the sim steps at exactly 60 Hz, and
each frame the renderer and HUD see actors (skaters, puck incl. height, referee) at
`lerp(prev tick, current tick, leftover / SIM_DT)`. `src/main.ts` writes those positions into the
state just for the draw and restores the sim's own values in a `finally`, so the sim never sees a
lerped number; an object that jumped more than 3 m in a tick (faceoff setup, penalty box, rematch)
is drawn where it landed. A frame within 1 ms of 1/60 s counts as exactly one tick, so 59.94 /
60.05 Hz panels run one step per frame instead of drifting into 0- and 2-step bursts.
`__airfriend.step(n)` drops the snapshot, so a frame never slides from before a test's jump to after it.

Presentation is pixel-exact at any devicePixelRatio (`src/core/display.ts`), so 125% / 150% OS
scaling and browser zoom look like 100%. The scale is picked in device pixels,
`s = floor(min(innerHeight*dpr/224, innerWidth*dpr*3/4/224))`, giving a 4:3 picture of
`round(s*224*4/3)` x `s*224` device px. Each frame the 256x224 3D and HUD canvases (never shown
themselves) are composited nearest-neighbour into a `256*floor(w/256)` x `s*224` prescale canvas,
which is drawn with bilinear filtering into `canvas.display`: a canvas fixed over the whole
viewport with one backing pixel per device pixel (ResizeObserver `device-pixel-content-box`),
the picture placed at a whole device-pixel offset. Rows are copied 1:1 and only the fractional
8:7 seam between two columns blends ("sharp bilinear"). The picture is placed inside a
viewport-sized canvas rather than by sizing an element in CSS because headless Chromium's layout
snapping put a CSS-placed box up to a device pixel off at (emulated) DPR 1.25 / 1.5 / 2, and then every row blended.
The CRT overlay (V) is a device-resolution canvas too: per source row, the top half of its device
rows bright and the bottom half dark (none at 1x). `#screen` still carries the picture's rect in
CSS px for tools that measure it. Resize, DPR change (matchMedia, device-pixel-content-box, or a
per-frame `devicePixelRatio` check for DevTools emulation) re-fit it. `__airfriend.capture()` and
the playtest screenshots read the native 256x224 frame, as before; `__airfriend.display.fitInfo`
is the current fit.

If your shell rewrites `npx`, call `./node_modules/.bin/tsx` directly.

Typecheck configs: `tsconfig.app.json` is the browser game (`src/`, no Node types) and is what
`npm run build` checks. `tsconfig.json` extends it with `tools/*.ts`, `vite.config.ts` and Node
types, and excludes `tools/qa-*`. Those are throwaway QA probes, kept as repros, so a stale probe
can never block the build or turn `npx tsc --noEmit` red. `tsconfig.qa.json` adds them back on demand.
A broken non-qa harness still fails `npx tsc --noEmit` but never `npm run build`.
