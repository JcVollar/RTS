# Architecture

A deeper companion to the module table in [`../README.md`](../README.md). This
covers how a frame actually flows, the invariants the code relies on, and where
the sharp edges are.

---

## 1. Shape of the project

A single-page, zero-dependency, zero-build game. `index.html` loads ~20 classic
`<script>` tags in dependency order; every file adds functions and consts to the
global scope. There are no modules, no bundler, and no package.json — you edit a
file and reload the tab.

That choice has one consequence worth knowing: **load order in `index.html` is
the dependency graph.** A file may only call into files listed above it at *load*
time. At *run* time everything is global, so a file may call anything (this is why
`picking.js` can call into `sprites.js` even though it loads earlier).

```
config → utils → canvas → entities → state → pathfinding → camera → picking
       → movement → ai → combat → buildings → support → harvest → input
       → sprites → render → ui → gamemodes → main
```

Roughly: **data → simulation → presentation.**

---

## 2. The frame

`main.js:frame(now)` is the whole loop. `dt` is clamped to 50 ms so an
alt-tabbed tab doesn't teleport everything on return.

```
updateCamera(dt)        pan from keys / edge / right-drag, then clamp to world
updateProduction(dt)    construction progress + training queues
updateSupport(dt)       medic/engineer repair, tower garrison entry
updateCombat(dt)        target acquisition, firing, deaths        ← sets u.facing when aiming
updateAI(dt)            enemy chase / wander / advance
updateHarvesters(dt)    ore miner state machine
updateMovement(dt)      advance along A* waypoints                ← sets u.facing when walking
updateEffects(dt)       age out tracers
activeMode.update(dt)   wave spawning, win/lose checks
render()                draw everything
```

**Order matters in one specific place.** `updateCombat` runs *before*
`updateMovement` and sets `u.aiming = true` when a unit has a clear shot.
`updateMovement` then respects that flag and refuses to overwrite `u.facing`
with the walk direction. Swap those two calls and units would aim at where
they're walking instead of at what they're shooting.

---

## 3. Coordinate systems

There are four, and mixing them up is the most common source of bugs here.

| Space | Units | Produced by |
|---|---|---|
| **Tile** | `tx, ty` — fractional tile coords, the anchor is the footprint's *top-left* tile | game logic |
| **World** | pixels, camera-independent | `tileToWorld(tx,ty)` |
| **Screen** | pixels, camera applied | `worldToScreen`, `gridPt`, `unitScreen` |
| **Screen angle** | radians, `0` = right, `+π/2` = **down** (canvas y grows downward) | `Math.atan2(dy, dx)` |

The iso projection is `x = (tx-ty)·32`, `y = (tx+ty)·16` — a 2:1 diamond.

Two consequences that come up constantly:

- Moving along **+tx** goes *down-right* on screen ("SE"); **+ty** goes
  *down-left* ("SW"). The tile diagonals are what look axis-aligned on screen.
- `u.facing` is a **screen** angle, not a world/tile angle. Both writers agree on
  this: `movement.js` builds it from the projected delta
  (`atan2((dx+dy)·16, (dx-dy)·32)`) and `Entity.angleTo` builds it from world
  positions. Anything reading `facing` — turret barrels, muzzle flashes, sprite
  facing — is therefore working in screen space.

An entity's **anchor is its top-left tile**, but almost everything you want is
the *center* — hence `Entity.centerX/centerY`, `worldPos()`, `distTo()`. Use
those rather than `tx`/`ty` directly whenever a unit might be bigger than 1×1.

---

## 4. Invariants

These are unwritten rules the code currently honours. Breaking one won't throw —
it'll just produce a subtle bug.

1. **Simulation never touches the DOM or canvas.** `state.js` and the `update*`
   systems are pure data. This is what would let the simulation run on a server
   later. `render.js` / `ui.js` / `canvas.js` are the only files allowed to draw.
2. **Rendering never mutates simulation state.** The exceptions are deliberate,
   and both are view-only caches: `hoveredUnit` in `render.js`, and the
   `u._sprite*` fields in `sprites.js` (see §6).
3. **All tuning lives in `config.js`.** Adding a unit = one entry in
   `UNIT_TYPES` + its key in `UNIT_MENU`. Nothing else needs editing.
4. **`state.blocked` must be rebuilt whenever the building list changes.**
   `rebuildBlocked()` is the only thing keeping pathfinding honest.
5. **Depth sort key is `tx + ty + (size-1)`.** Buildings and units are sorted
   into one list so they occlude each other correctly. Any new drawable needs
   the same key or it will pop through walls.

---

## 5. Systems worth knowing

**Soft collision** (`movement.js:separateUnits`) runs after every move. Units
deliberately don't block each other in pathfinding — that would deadlock a queue
in a corridor — so without a separation pass they pile onto the same tile. The
push is scaled to each unit's **own speed** (`SEPARATION_FRAC`), never a flat
rate: a flat rate above a unit's speed lets a crowd shove its members backwards
faster than they can walk, and the group never converges.

This interacts with one non-obvious thing. `arrivalEps()` — how close counts as
"reached this waypoint" — **must stay larger than one frame of separation
push**. It used to be a hard-coded `0.02`, which is smaller than the push, so a
crowded unit got nudged off its waypoint every frame, never registered arrival,
never advanced to the next waypoint, and parked on top of whoever it was
standing on. If you retune either constant, keep `SEPARATION_FRAC × speed × dt`
comfortably below `arrivalEps`.

**Power** gates unit production only. `producerOnline()` (in `state.js`) is what
`queueUnit`, `updateProduction` and the build menu all consult. Building
*construction* deliberately keeps working while the grid is over-drawn —
otherwise a brownout is unrecoverable, since the Power Plant that fixes it is
itself a building.

**Pathfinding** (`pathfinding.js`) is 8-directional A* over a
`CONFIG.MAP_W × MAP_H` grid with an octile heuristic, a `MinHeap`, corner-cut
prevention, and a 16 000-node expansion cap. Only *buildings* block; units walk
through each other. Player units may pass their own gates (`state.gateTiles`).
Because the heuristic slightly over-weights (`PF_WEIGHT`), paths front-load their
diagonal steps — a long move is usually "all the diagonals, then all the
straights", which is why units mostly hold one facing per leg.

**Combat** (`combat.js`) resolves targets in priority order: explicit
`forcedTarget` → whoever last shot us (`retaliateTarget`, `RETALIATE_TIME`
seconds) → nearest hostile in `view`. Firing needs range *and*
`hasLineOfSight` (a walls-and-houses raycast). Kills feed `Unit.addKill()` →
veterancy → `ACCURACY[level]`. A spatial grid (`buildUnitGrid`) is rebuilt each
frame so target lookup isn't O(n²).

**Terrain caching** (`render.js`) is the main perf win: the whole map is drawn
once into an offscreen canvas at setup (`prerenderMap`) and each frame blits the
visible slice with a single `drawImage`. Ore is drawn live because it depletes.

**Culling**: units/buildings outside the viewport (plus a margin) are skipped in
the draw loop. With 100+ enemies scattered over a 160×160 map, this is what keeps
frame time flat.

---

## 6. Unit sprites

The one part of rendering with real subtlety. It has its own document:
**[SPRITES.md](SPRITES.md)** — read that before touching `js/sprites.js`.

Summary: units listed in `SPRITE_DEFS` draw from the CC0 PixVoxel Wargame art
(4 facings × N frames × 8 team colours); everything else falls back to the
procedural shapes in `render.js`. Three non-obvious things make it look right —
frames are **downscaled once into an offscreen canvas** and blitted 1:1 at
**integer coordinates** (otherwise the sprite boils as it moves), facing
selection has a **deadband** (otherwise a unit walking east flip-flops between
its front and back sprite), and the ground anchor is **measured from each
frame's drop shadow** rather than configured (otherwise units float above their
selection ring).

---

## 7. Known gaps and sharp edges

Not bugs to fix right now, just things to know.

- **Sprite coverage is partial.** Only `soldier` and `seal` have art. `engineer`,
  `medic`, `vehicle`, `heavytank` and `oreMiner` still draw as procedural
  ellipses and iso-cubes, so a mixed army looks like two different games. The
  art for all of them exists in the asset pack — see SPRITES.md §6.
- **Building art is entirely placeholder** — flat coloured blocks with name tags.
  The pack ships `Castle`, `Factory`, `Laboratory`, `Airport`, `City`, `Estate`.
- **`test/smoke.js` asserts nothing.** It runs the game headlessly for ~40 s of
  simulated time and prints a summary; it only fails on a thrown exception. It
  will not catch a rendering or balance regression. Its `trained` counter is
  netted against enemy deaths, so it routinely reads `0` — that is not a failure.
- **No save/load, no networking, no sound.**
- **`updateBuildMenu()` runs every frame** and rewrites `econEl.innerHTML` and
  `prodEl.innerHTML` each time. The selected-building panel is already guarded by
  `selRenderedId`; the other two are not. Harmless at this scale, but it's the
  first thing to throttle if the HUD ever gets heavier.
- **Unit hit-testing uses `u.radius`, not the sprite box** (`picking.js:unitHit`).
  Checked against the measured art: a soldier's figure reaches 28.5 px above its
  ground point and the click box reaches 29.7 px, so this is fine today. If you
  raise `scale` in `SPRITE_DEFAULTS`, hit-testing will silently stop matching
  what's drawn.

---

## 8. Adding things

**A unit type** — copy an entry in `UNIT_TYPES`, add the key to `UNIT_MENU`. It
will draw as a procedural body until you give it a `SPRITE_DEFS` entry.

**A building type** — copy an entry in `BUILDING_TYPES`, add the key to
`BUILD_MENU`. Special behaviour is opt-in via flags the systems look for:
`produces`, `tower`, `gate`, `heal`, `needsPower`.

**A game mode** — add an entry to `GAMEMODES` with `setup()`, `update(dt)`,
`isGameOver()`, optional `isWin()` and `hudLine()`, then list it in
`GAMEMODE_MENU`.

**Anything drawn** — it must sort with the `tx + ty + (size-1)` depth key and be
culled against the viewport, or it will pop through walls and cost frame time
off-screen.
