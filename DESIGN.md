# AIR FRIEND HOCKEY: design doc

A fake 1994 Super Nintendo ice hockey cartridge. You play **PAL**, a bichon
frise who plays center for the FERNFIELD PUPS, a team of kids, against the
GLACIER BAY BLIZZARD. It's Air Bud on ice. 5 v 5 (4 skaters + goalie).
TypeScript + three.js, built with Vite.

**No menus.** Loading the page drops you straight into the game: a short intro
(title flash over the arena, then a camera sweep), then the opening faceoff. Everything
else (score bug, banners, intermission and final screens, pause) is in-game
interface that looks like a real SNES game.

---------------------------------------------------------------------------

## 1. Controls

| Key | Name | With the puck | Without the puck |
|---|---|---|---|
| Arrows / WASD | move | skate (screen-relative; **up = attack**) | skate |
| Z / J | SHOOT | hold = wind up (power meter), release = shoot. Tap = quick wrist shot. LEFT/RIGHT held picks that corner; the charge sets the height | Poke check. If a teammate has the puck or a pass is on its way: no poke; held SHOOT primes a one-timer, and a press is a "call for shot" (answered only within ~16 m facing the net, else the teammate passes to you if the lane is open) |
| X / K | PASS | pass toward the held direction (else to the best open teammate) | Body check (lunge). If a teammate has the puck: "call for pass" (teammate passes to you); while a teammate's pass is in flight it does nothing |
| C / L | TURBO | hold = sprint (drains stamina meter). **BARK** (dog): a press barks when an opposing carrier is within ~4.5 m (or a defender is right in front of a carrying PAL); a quick tap (< 0.18 s) always barks; otherwise TURBO only sprints | same |
| Enter / P / Esc | START | pause / unpause; skip intermission; rematch on final screen | |
| M | | mute toggle | |
| V | | CRT scanline overlay toggle | |
| F / double-click | | fullscreen toggle (Esc also leaves it) | |

Faceoffs: after the ref drops the puck, the first center to press SHOOT or PASS wins it.
Pressing before the drop is a false start and loses the faceoff.

The human always controls the dog (`state.controlledId = 0`). While PAL sits in
the penalty box, control auto-switches to the home skater nearest the puck, with
hysteresis. The new controlled skater gets a `controlSwitch` event and a marker.

---------------------------------------------------------------------------

## 2. Architecture and file ownership

```
src/types.ts          shared contracts (DO NOT change shapes without need; additive changes OK)
src/config.ts         constants: screen, rink, physics, rules, teams/rosters/colors
src/main.ts           boot, fixed-step loop, test API (window.__airfriend)
src/core/input.ts     keyboard -> PadState (done)
src/sim/*             SIM agent: rink geometry, physics, actions, rules, penalties, faceoffs, referee
src/ai/*              AI agent: skater AI, goalie AI, team tactics -> writes Intent
src/render/art/*      ART agent: pixel-art sprite data + atlas builder (SpriteLibrary)
src/render/renderer.ts, rink.ts, camera.ts, post.ts   RINK agent: arena, camera, SNES post-processing
src/render/actors.ts, effects.ts                      ACTORS agent: sprite billboards, shadows, FX
src/ui/*              HUD agent: bitmap font, HUD, banners, intermission/final/pause screens
src/audio/*           AUDIO agent: WebAudio synth, SFX, chiptune music
tools/playtest.mjs    headless browser playtest (screenshots, key scripts, state dump)
tools/simulate.ts     headless full-game sim in node (balance/rules testing)
```

Hard rules:
- `src/sim/**` and `src/ai/**` must not import three.js or touch the DOM. They run under node.
- No external asset files. All art is pixel data in code, and all sound is synthesized.
- The data flow is one-way. Render, HUD and audio only READ `GameState` and react to `state.events`.
  They never mutate the sim.
- `stepGame(state, pad)` advances exactly one 1/60 s tick. It begins by clearing `state.events`.
  main.ts dispatches events to audio, HUD and renderer after every tick.
- Each module keeps its public API (see the stubs). Additive changes are fine.
- Add new files inside your own directory as you like (e.g. `src/sim/physics.ts`).

---------------------------------------------------------------------------

## 3. Coordinates and orientation

- Meters, with the ice plane on X/Z and Y up. Origin is center ice. x runs across the width (±13), z along the length (±30.5).
- Heading angles: `a = atan2(dir.x, dir.z)`, so 0 faces +z.
- `attackDir(team, period)` (sim/rink.ts): HOME attacks +z in periods 1 and 3 and in OT, and -z in period 2.
- **The camera always sits behind HOME's defending end, looking along HOME's attack direction**
  (`cameraHeading(period)`). Up on screen means attack for the human, every period. The camera flips during
  the intermission (`snap`).
- `screenToWorld(pad, period)` maps screen directions to world directions. Screen right is world `-attackDir` on x.
- The screen angle for sprites is `screenAngle = facing - cameraHeading(period)`: 0 is moving up-screen,
  +PI/2 is screen-right, PI is toward the camera. (Looking along +z the camera's right is world -x; heading
  +PI/2 = world +x, which is screen-LEFT when the camera looks +z. **Account for the mirror**: compute it
  as the angle of the heading vector expressed in camera space, x_screen = dot(dir, camRight),
  y_screen = dot(dir, camForward), `screenAngle = atan2(x_screen, y_screen)`.)

---------------------------------------------------------------------------

## 4. Gameplay spec (SIM + AI)

### Skating
- Intent `move` (world, |v| ≤ 1) sets the desired velocity `move * maxSpeed` (×`PHYS.turboMul` with turbo).
- Acceleration is limited by `attrs.accel`. Reversing direction or changing it sharply uses `PHYS.stopDecel`
  scaled by `turn`. A sharp stop at speed above about 5 m/s emits `hardStop` (ice spray).
- With no input, skaters coast with `PHYS.iceFriction`. Ice should feel slippery but controllable,
  arcade-style like NHL '94.
- Skaters collide with boards (a rounded rectangle with `RINK.cornerRadius`), with each other (circles),
  and with goal frames (they cannot skate through nets).
- `facing` follows velocity, or the move intent when nearly stopped (instant turn on the spot).
- Turbo: hold to sprint while `stamina > 0`. Stamina drains and regenerates per config. At 0 the
  skater can't turbo until stamina is back above 0.25.

### Puck
- When owned, the puck sits `PHYS.puckCarryDist` in front of the carrier on the forehand side, with a
  slight dribble wobble. When loose, it slides with friction, bounces off boards (`boards` event with
  speed), posts (`post`) and the outside of the net (`netHit`). It can fly (y > 0) on lifted shots and
  falls with gravity.
- Pickup happens when the puck comes within `PHYS.pickupRadius` of the stick point (in front of the
  skater), y < 0.6, and the skater isn't blocked or fallen. Fast pucks (above `maxPickupSpeed`) get a
  handling-based reception roll. Picking up emits `pickup`. A pass arriving at its target emits `passReceived`.
- `pickupBlock`/`blockId` keep the passer or shooter from instantly re-grabbing their own release (~0.25 s).
- Goal: the puck fully crosses the goal line between the posts below the crossbar, entering from the
  front. Emits `goal` and switches to phase `goal`. The puck stays in the net.
- Puck out of play (over the glass): `whistle{offIce}`, then a faceoff at the nearest dot. Keep this rare.

### Shooting
- With the puck, SHOOT held means `windup` (charge 0..1 over `PHYS.windupTime`). The skater slows to
  about 60% speed and cannot pass. On release the shot speed is lerp(shotSpeedMin, shotSpeedMax,
  charge) × (0.8 + 0.2·shot). The direction aims at the opponent goal: with LEFT/RIGHT held the human aims inside
  that post (`SHOT.cornerX`), and the height comes only from the charge (tap low, slapper high); with no side held it
  auto-aims (`SHOT.autoX`). UP/DOWN never change the shot. Inaccuracy grows with charge and shrinks with `shot`.
  SHOOT already held when a pass arrives fires a one-timer (held < 1.2 s and within 18 m of the net), else it
  becomes a windup at the charge built so far. Full-charge shots are lifted
  (vy ~2 to 4) and low charge stays mostly on the ice. Emits `shot` and increments the `shots` stat only when on target.
- AI may pass `intent.aimAt`.

### Passing
- PASS with the puck: choose the teammate (not the goalie unless no other option) with the best score:
  alignment with the held direction (or facing if none) and distance, penalized if an opponent is near the
  lane. Pass speed is `passSpeed` scaled by distance and `pass`, led toward the receiver's velocity.
  A long pass with a defender in the lane becomes a saucer pass (small vy). Emits `pass`.
- AI sets `intent.passTarget`.
- Teammates are smart about the dog. Calling for a pass (PASS without the puck while a teammate has it) makes
  that teammate pass to the dog within about 0.3 s if any lane exists.

### Poke check
- SHOOT without the puck plays a 0.35 s poke. An opposing carrier within `pokeRange` in front loses the puck
  with probability based on (poker.handling vs carrier.handling, and angle). The puck squirts loose.
  Emits `poke` (success flag) and `steal` on success. There is a cooldown.
- A puck the carrier keeps on the far side of his body (his back to the poker, the puck tucked in) is reached
  around him: the chance is multiplied by `POKE_SHIELD_MUL` (0.5, sim/actions.ts `shieldedFrom`). That is what
  makes AI puck protection work, and it applies to PAL skating away from a checker too.

### Body check and penalties (the user specifically wants these)
- PASS without the puck (and no teammate carrying): lunge forward for 0.3 s at +`checkLungeSpeed`.
  Contact with an opponent inside `checkRange` during the lunge is a hit.
- Hit force = relative closing speed along the contact normal × (hitter.weight / victim.weight)^0.5 ×
  (0.6 + 0.8·check). Turbo makes hits heavier.
- The victim loses the puck. If `force > knockdownForce`, they fall (`fallen` for `fallTime`, then get
  `invuln` for 0.6 s). Smaller hits make them stumble. Getting slammed into the boards adds force and
  emits `bodyBoards`. Emits `check{force, knockedDown}`.
- **Penalty roll** (sim/penalties.ts): `p = clamp((force - penaltyForceMin)/(penaltyForceMax -
  penaltyForceMin), 0, 1)^penaltyCurve * penaltyMaxChance`, multiplied by situational factors:
  victim without the puck ×1.6 (INTERFERENCE), hit from behind ×1.5, victim near the boards ×1.2, victim is
  the goalie ×3 (GOALIE INTERFERENCE). Roll `Math.random() < p`. Heavier hits are likelier to be called.
  - Infraction name by situation and force: INTERFERENCE (no puck), ROUGHING (light), CHARGING (heavy,
    lots of travel or turbo), BOARDING (near boards), CHECKING FROM BEHIND, ELBOWING (random flavor at
    medium force), GOALIE INTERFERENCE.
  - Force ≥ `RULES.majorForce` gives a MAJOR (`majorLength`), otherwise a minor (`minorLength`).
  - **Delayed penalty:** the whistle waits while the fouled team keeps the puck (`state.delayedPenalty`, ref points,
    HUD chip). Any touch by the offending team, a dead puck, the horn or 10 s calls it. A goal by the fouled team
    wipes out the pending minor (majors are still served).
  - Called penalty: whistle, then phase `penalty` (banner for `penaltyBannerTime`). The offender goes to their team's penalty box
    (`RINK.penaltyBoxX`, `penaltyBoxZ[team]`, state `box`). They are off the ice and their team plays a man short.
    Next comes a faceoff at an end-zone dot in the offending team's defensive zone.
  - The penalty clock runs only while the game clock runs. A minor ends early if the opponent scores on
    the power play. Expiry: the skater returns to the ice next to the box (`penaltyExpired`).
  - A team never drops below 3 skaters (2 concurrent penalties max per team; extras queue).
  - **The dog can be penalized too** (its checks are weak, so rarely). Control switches as described above.
- Players emit hits stats. AI defenders check often enough that a typical game has about 1 to 4 penalties total.

### BARK (dog only)
- With `barkCooldown == 0`, a TURBO press barks when it is wanted (an opposing carrier within ~4.5 m, or a defender
  right in front of a carrying PAL), and a quick tap always barks (on release); any other press just sprints
  (cooldown 2.5 s). Opponents within 3 m get `stun` 0.4 s (slowed, flinch). An opposing puck carrier within 2.5 m
  fumbles the puck (`BARK_FUMBLE_BASE` 20% chance, scaled by their handling). Emits `bark{startled}` and `fumble`. The bark also starts turbo if held.

### Faceoffs
- Formation around `faceoff.spot`. Each team's center is at the spot, 1.2 m back toward their own goal. Winger
  and defensemen take standard positions, and goalies sit in their creases. When a skater is in the box, the formation adapts.
- `faceoffSetup`, then after a random 0.8 to 1.6 s (1.9 to 2.5 s on period openers; `state.faceoff.dropTime`) the ref
  drops it (`faceoffDrop`), so the drop can't be timed by rhythm. The beaten center can't touch the puck for 0.3 s, and a
  human center who wins with a direction held draws it to the teammate on that side. The first center to press
  SHOOT or PASS after the drop wins. The AI center reacts in 0.18 to 0.45 s (random). A false start (press before
  the drop) loses. Nobody pressing within 1.2 s gives a coin flip. The winner's puck goes back toward their
  defenseman or winger (`faceoffWin`). Then phase `play`.
- Faceoff locations: center after goals and period starts. End-zone dot (nearest side) after a goalie freeze or a penalty
  (offending team's zone). Nearest dot after a puck goes off the ice.

### Goalies (AI)
- Stay in or near the crease and slide on the arc between the puck and the goal center to cut the angle,
  with limited speed and a short reaction delay (worse when the puck moves fast laterally, as on cross-crease passes).
- The save is geometric: the goalie has a hitbox (stance ~0.9 m wide, butterfly ~1.5 m wide but only 0.6 m
  tall, dive sideways ~1.8 m reach). A shot reaching the goal line passes the goalie plane. If it intersects the hitbox → save.
  Shots near the edge get a reflex roll on `handling`. A save either produces a rebound (puck deflects out) or a catch
  (`gHold`). A hold leads to a whistle after `goalieHoldTime` and an end-zone faceoff.
- Goalies can play a loose puck near the crease by clearing it to a teammate or the corner.
- Balance target: about 25 to 32 shots and 5 to 8 goals per 6-minute game (AI vs AI). Against the scripted human
  bot (`tools/ai-ozstats.ts bot`): skill 1 wins ~60-70% with ~15 Blizzard shots against, skill 0.6 ~50-60%.

### Teams and AI tactics
- Positions: C (dog, or opposing center), W (winger), LD and RD (defense).
- Offense: the carrier drives toward the net, avoids defenders, passes when pressured or when a teammate is
  more open, and shoots from a good slot position or on a decent angle. Support players spread to
  lanes (W wide, C trailer/slot), and D hold the blue line ("points").
- Offensive zone (src/ai/ozone.ts, both teams): a carrier who comes in with a checker on him, or alone, does not
  throw a hopeful shot. On the wall or down low he **protects** the puck: back to the checker, skating away along
  the boards (deeper, around behind the net, never back over the blue line), the puck tucked away from him. The
  support forward hangs on the half-wall above him (`cycle`), the other at the net front, the D on the points,
  and the first clean lane gets the puck: the **cycle** pass low, or back to the point (`cycleBonus`). A D at the
  point walks the line toward the middle, shoots through a clear lane (more with a screen in front) or slides it
  D-to-D. When a shot goes, the forwards **crash** the net (screen + two rebound spots) and a rebound off the
  goalie keeps the attack shape instead of turning everybody around. A D **pinches** down the wall to keep a puck
  in when a teammate is back. A zone clock (`TeamMem.ozSince`) sets the shot appetite: for the first
  `SETUP_TIME` (1.2 s) a so-so look isn't worth the puck (set it up first, curl off with `ENTRY_DELAY_P`), after
  that the team puts pucks on net (low-danger volume from the wall and the point).
- Defense: the nearest defender pressures the carrier. Others cover passing lanes or the slot, and D stay
  between the puck and the net. Opponents body-check now and then (more if `check` is high). The PUPS kids
  check at 1.5x the base rate (`CHECK_TEAM`), so they finish a few hits a game too (mostly on the carrier, inside
  the same force limits).
- Sprinting (src/ai/index.ts `turboButton`, wishes in skater.ts): every TURBO press is a `turboStart` (a whoosh),
  so the AI sprints in bursts that go somewhere, with start/keep hysteresis: a carrier with open ice skating up ice
  (never curling back), a chaser racing for a puck 12 m off, a defender getting back to a spot well behind him (a
  backcheck only while the other team has the puck or it's loose), a support man joining a rush. A burst starts off
  a rest (4.5 s) with most of the stamina bar and runs 1.5 s or more, usually until the bar is spent. About 175-185
  `turboStart`s a game AI vs AI (`tools/simulate.ts`, `tools/ai-turbodiag.ts`), ~3.4 per skater-minute. The
  autoplay dog barks only at a carrier it can startle (or a defender squaring up in front of it), ~12 a game, and
  never starts a sprint where the press would bark by accident (`dogTurboOk`).
- HOME AI teammates feed the dog. They pass to PAL whenever PAL is open (an Air Bud fantasy, but don't
  make it robotic), and they skate into support positions relative to PAL.
- When shorthanded, the AI plays a tighter box. Power play: more shooting.
- Difficulty: the human should win most games with decent play, but not without effort.

### Referee (decoration plus faceoff drops)
- One ref stays near the play but out of the way (2 to 4 m from the puck, off the passing lanes, avoiding skaters).
  It drops the puck at faceoffs (it stands at the spot, then backs off), whistles (`state: 'whistle'`), and points at penalties.

### Phases and flow
`intro` (introTime) → `faceoff` → `play` ⇄ (`goal` | `stoppage` | `penalty`) → `faceoff` ...
When the clock hits 0: `periodEnd` (horn) → `intermission` (intermissionTime, START skips; teams
switch ends, penalties carry over) → `faceoff` for the next period. After period 3: if not tied,
`gameOver`. If tied, period 4 = sudden-death OT (overtimeLength). Still tied after OT means `gameOver` with
winner 'tie'. On `gameOver` pressing START triggers a rematch (`rematch` event, full reset, no intro title wait beyond 1.5 s).
The game clock only runs in `play`. In the last 10 s, emit `clockWarning` once per second.
Pause (START during play/faceoff) freezes everything. The HUD shows a pause window.

---------------------------------------------------------------------------

## 5. Rendering spec

### SNES framebuffer
- WebGL renders at **256×224**. Displayed at 4:3 (like a real SNES on a TV), nearest-neighbor
  upscaled (main.ts handles the CSS). No antialiasing, no mipmapped blur. All textures use NearestFilter.
- Post-process (post.ts): quantize the output to 15-bit color (5 bits per channel). An optional subtle ordered
  dither is acceptable. The HUD canvas (2D, 256×224) sits on top with the same pixel grid.
- Palette direction: bright, saturated 16-bit colors, like NHL '94, Super Hockey and Mario Kart. The ice is near-white
  with a cool blue tint, with crisp red and blue lines.

### Camera (camera.ts): "Mode-7-ish"
- A perspective camera behind and above HOME's defending end looking along `cameraHeading(period)`, pitched
  44° down (fov 32°). The rink's long axis runs up the screen and the far end recedes in perspective
  (the Mode 7 feel). **Scale:** around the middle of the screen, 1 m should be about 13 px (1/SPRITE_METERS_PER_PIXEL),
  so sprites draw at about 1 texel per pixel. That shows about 19 m of the 26 m rink width, and the camera pans
  sideways (clamped at the boards). Gameplay sprites are always drawn at exactly 1 texel per pixel
  wherever they are (perspective sets only position and depth order); only the ice and arena foreshorten (about 0.70× at
  the top edge, 1.30× at the bottom). The one exception is the intro's high wide shot, where all sprites shrink uniformly.
- Follow: target = puck, blended toward the controlled skater (~25%), with lead in the puck's direction of travel,
  critically damped smoothing, clamped so it never looks far outside the rink. Slight zoom-in or tilt on
  goals and celebrations is nice. The intro sweeps from a high wide shot down to the faceoff.
- Keep-in-frame priorities (live play): the puck's window always wins (never off-screen). In the follow target the
  offensive-zone net keep (far crossbar below the score bug) outranks the controlled skater's window, but a hard hold
  on the spring output keeps the controlled skater's body on screen and outranks the net: the human steers PAL, so a
  PAL hanging back at the blue line stays in frame and the crossbar slides under the score bug instead (never off the
  top of the screen). PAL still leaves the screen when he is 18+ m up-ice of the puck, more than one frame spans:
  ~1-1.6% of live play with the scripted human, ~2.5-3.7% with the AI playing PAL (`tools/rink-frame.ts`).
- Faceoffs: a new lineup somewhere off-frame (after a goal at the far net, a penalty in a corner) gets a fast 0.22 s
  eased whip-pan to the dot (zoom reset included) instead of the follow spring's glide, so the FACE OFF! banner
  never shows over empty ice (`tools/rink-faceoff.ts`: dot framed from 0.25 s on in every faceoff).
- `snap(state)` jumps instantly (called when the period changes or on rematch).

### Arena (rink.ts)
- Ice: one large canvas texture (e.g. 4 px per meter, around 104×244 px → or 8 px/m) drawn procedurally in pixel-art style:
  white-blue ice with subtle scuffs and dither, red center line (dashed look), blue lines, goal lines,
  5 faceoff circles with hash marks, 4 neutral dots, a blue crease, a big center-ice logo (a paw print or
  bichon head in a circle) and maybe "FERNFIELD" lettering. Rounded corners.
- Boards: a low wall following the rounded rectangle, white with a yellow kick plate, and pixel-art ad panels
  ("KIBBLE KING", "WOOF MART", "BONE ZONE", "SNOW CONE", "PUP SODA" etc.). Glass is very faint/transparent
  above, with stanchion posts.
- Goals: red posts and crossbar, white netting (texture with a grid, alpha-tested), and a red goal light
  behind each net that flashes on goals.
- Stands: sloped tiers beyond the glass with an animated pixel crowd texture (2 to 3 frames of heads and
  arms). They cheer harder (faster frame swap, jumping) on goals and big hits. Team-colored seats. The rink is
  surrounded and the arena is dark above.
- Penalty boxes on the +x side and team benches on the -x side (simple booths). Boxed skaters are drawn by
  the actor layer at their sim positions.

### Sprites (art/)
- All characters use the same pixel density: `SPRITE_METERS_PER_PIXEL` = 0.075 m/px from config.ts
  (exposed as `SpriteLibrary.metersPerPixel`). Each frame is a cell up to 32×32 px with an anchor at the
  skate or ice contact point. A kid is about 26 px tall and PAL is about 20×16 px.
- **8 facing directions**: draw N, NE, E, SE, S (5 unique), with W, SW, NW as horizontal mirrors.
  Screen-angle sectors are 45° wide, centered on each direction.
- **PAL the bichon frise**: a fluffy white cotton-ball body with a cloud-like curly outline and pale cream
  shading, a round puffy head, black button eyes and nose, a small pink tongue, a plumed tail curled over the back,
  a tiny team-color jersey (red, with white "K9" on the back for N/NE views), a little helmet optional,
  and four tiny black skates. **The hockey stick is held in its mouth** (diagonal, blade near the ice).
  Very cute. The ~20×16 px body inside the 32 cell reads clearly at 1x.
  Anims: idle (2), skate (4, paws scampering, ears bouncing), windup (stick pulled back), shoot (2),
  pass (1-2), poke, check (head-down lunge), fallen (on back, paws up), celebrate (hop + spin, 4),
  faceoff (crouched), bark (mouth open, stick still in teeth or briefly dropped).
- **Kids**: about 26 to 30 px tall, with a helmet (team helmet color) and cage, a jersey in team colors with
  number-ish detail, pants, socks and skates, and a stick in their hands. They are drawn once with palette
  slots (jersey, jerseyDark, trim, pants, helmet, socks) and recolored per team at atlas-build time.
  Anims: idle (2), skate (4 stride), windup, shoot (2), pass, poke, check (shoulder lunge), fallen,
  celebrate (stick raised, 2 to 4), faceoff (crouched, stick down).
- **Goalies**: bulky pads, blocker and glove, mask (team colors via the same palette swap). Anims: gReady
  (stance), gSkate (shuffle, 2), gButterfly, gDiveL, gDiveR, gHold (puck in glove). They face the play,
  so 5 directions are optional. N/S/E minimum.
- **Referee**: black and white stripes, orange armbands. refSkate (2 to 4), refWhistle, refPoint.
- Misc: puck (tiny black ellipse ~3×2 px), blob shadows (dark translucent ellipse; skater ~14×5,
  puck ~4×2), marker (a bouncing yellow/white arrow or star above the controlled player), "ARF!" speech
  bubble, ice-spray particles, sparkle star.
- Atlases are built once at startup into CanvasTextures (Nearest, no mipmaps, SRGB).

### Actors (actors.ts)
- Each skater, the ref and the puck are camera-facing billboards anchored at the ice contact point. Use
  cylindrical billboarding (rotate about Y to face the camera, stay upright) so feet stay planted.
- Use world size from `metersPerPixel`. Draw from far to near (or depth test plus alpha test). Blob
  shadows sit flat on the ice under each skater. The puck shows its height via the gap above its shadow.
- Anim choice comes from `skater.state` plus speed (idle vs skate, with skate frame rate scaled by speed). Fallen/celebrate
  use their anims. Goalie states map to g* anims, and boxed skaters show idle in the box.
- The controlled player gets the marker sprite above its head. The dog should be easy to find, so a subtle
  outline or flashing marker helps.

### Effects (effects.ts)
- Ice spray particles on `hardStop` and on checks. Puck-trail streaks on hard shots. "ARF!" bubble above the dog on
  `bark` (~0.7 s). Small stars over a fallen player's head. A sparkle burst plus net shake on `goal`.
  Everything stays pixel-crisp.

---------------------------------------------------------------------------

## 6. HUD and interface spec (ui/)

Everything is drawn into the 256×224 HUD canvas with a **custom 8×8 bitmap font** (defined as bit data in
code, uppercase plus digits plus punctuation, with a drop shadow) and SNES-style **window boxes** (a blue
vertical gradient with a 1 to 2 px white/gray bevel border, like a 16-bit RPG or sports-game dialog). Keep
the action visible. Respect overscan, so keep critical text inside about 8 px margins.

- **Score bug** (top center, always during play): `PUP 2 ● BLZ 1   2ND 1:23`. Team abbreviations go in team-color
  boxes. The clock flashes red in the last 10 s. Power-play indicator below: `POWER PLAY 0:24`
  (or `SHORTHANDED`), with the penalized player's number.
- **Turbo meter**: a small stamina bar near a corner, with a dog paw icon. **Shot power meter**: a tiny bar above the controlled
  skater while winding up (use the projector).
- **Controlled-player tag**: optional small name tag (`PAL`) above the dog when it's off near the screen edge.
  An off-screen arrow points at the dog if it leaves the view.
- **Banners** (big, centered, chunky 2× or 3× font, with flashes and slides):
  - Intro: game logo "AIR FRIEND / HOCKEY" plus "FERNFIELD PUPS VS GLACIER BAY BLIZZARD", then
    "1ST PERIOD" and "GET READY!". Also a small controls window (`Z/J SHOOT  X/K PASS/CHECK  C/L TURBO/BARK  ↑↓←→ SKATE`)
    shown during the intro and the first faceoff.
  - Faceoff: "FACE OFF!" and "DROP!". "FALSE START!" when a center jumps the drop.
  - GOAL: a huge flashing "GOAL!!" with the team color, then a scorer window: `GOAL  #K9 PAL` /
    `ASSIST #7 JOSH` / `1ST  1:12`, with PP/SH tags. If PAL scores: "WHAT A DOG!" or similar flavor.
  - PENALTY: a window with `PENALTY`, `#44 BUTCH  BLZ`, `BOARDING  0:30` (MAJOR says `MAJOR 1:00`).
  - Hits: a small "BIG HIT!" pop on knockdowns. "SAVE!" pops on big saves (optional). "POST!" on posts.
  - "END OF 1ST PERIOD", and "OVERTIME! SUDDEN DEATH".
- **Intermission screen**: a full window with a scoring summary by period (table), shots, hits, PIM, and the
  scorers list. "PRESS START".
- **Final screen**: "FINAL" with the score, winner text ("PUPS WIN!" / "BLIZZARD WIN" / "TIE GAME"),
  **THREE STARS** (★ #K9 PAL …) picked from goals, assists and hits, and "PRESS START FOR REMATCH".
- **Pause**: a dimmed screen plus a window with "PAUSE" and the controls list, "M MUTE  V CRT" and "F FULLSCREEN", each with its ON/OFF state.

---------------------------------------------------------------------------

## 7. Audio spec (audio/)

WebAudio only, with no files. Aim for SPC700 flavor: short sampled-ish timbres from oscillators and noise,
everything through a gentle **echo/delay bus** (the classic SNES echo) and a master compressor.
Respect mute (M) and `?mute=1`. Unlock on the first keydown (browser policy).

SFX by event: stick handling clicks (pickup), pass (short tick), shot (slap = noise burst plus low thump,
scaled by power), save (pad thud) or catch (glove pop), post (metallic "ting!"), boards (dull thud,
volume by speed), body check (crunch), bodyBoards (glass rattle), whistle (two-tone pea whistle),
goal horn (a big detuned square-wave chord ~2 s), crowd roar swell on goals, crowd "ooh" on posts and
big hits, bark ("ARF!": a pitch-swept formant-ish square burst, cute), turbo (whoosh), hardStop (ice
scrape noise), penalty (low buzzer plus whistle), delayed penalty (the ref's arm goes up: a soft "di-DONG"
chime around 520 Hz, 0.2 s after the foul, plus a low crowd murmur, rising if the PUPS get the power play,
grumbling if one of ours is going; it plays under live play, so it stays out of the stick-click band),
period-end horn, faceoff drop (tick), clock warning beeps.

Mix rules (asserted by tools/audio-test.html): the home goal is the loudest thing; the whistle sits ~8 dB
under it (>= 7.5); stick handling is played by ear, so pickups clear the live crowd bed by >= 6 dB even at
its 0.65 cap, and passes / wrist shots by >= 3 dB.

Music: a looping chiptune "arena organ" theme during the intro and stoppages (not over live play, where the
crowd ambience bed plays instead, like real SNES hockey games), a "CHARGE!" organ stinger on some faceoffs
and power plays, a goal fanfare, an intermission theme, a victory jingle (home win) and a sad jingle (loss).
The crowd ambience bed (filtered noise) changes intensity with play (puck in the offensive zone, scoring chances).

---------------------------------------------------------------------------

## 8. Testing tools (use them!)

- `npx tsc --noEmit`: must pass with no errors in your files.
- `npx tsx tools/simulate.ts 5`: runs 5 AI-vs-AI full games in node and prints event and score stats.
  Every game must reach `gameOver` with no NaN.
- `node tools/playtest.mjs --params "autoplay=1&speed=2" --seconds 12 --shots 2,6,10 --out tools/out/<you>`:
  headless browser run that saves `shot-*-x3.png` screenshots (open them with the Read tool and LOOK at them)
  and prints console errors and a state summary. `--keys file.json` scripts keyboard input,
  and `--eval "<js>"` reads `window.__airfriend.state`.
- `window.__airfriend` gives `state`, `step(n)`, `setPadOverride(fn)`, `capture()` and `restart()`.
- Use a unique `--out` directory per agent (several agents run playtests in parallel).
