# Unit sprites

Everything about `js/sprites.js` and the art in `assets/PixVoxel_Wargame/`.

> **Start here: `sprite-tool.html`.** Serve the project and open it. It shows
> every model in the pack under its real name, lets you assign art to each unit
> type, previews all four facings walking at game scale with the selection ring
> for reference, exposes every tuning knob as a slider, and emits a
> `SPRITE_DEFS` block to paste back into `js/sprites.js`. It previews through
> the game's own `bakeSprite`/`blitSprite`, so it cannot drift from what the
> game draws. It also tells you how many of an art's four frames actually
> differ — see §1.

---

## 1. The asset pack

CC0 **PixVoxel Wargame** — pre-rendered voxel units, 4 isometric facings, 8 team
colours.

```
assets/PixVoxel_Wargame/
  UNIT_INFO.txt            ← the pack's own manifest: read this first
  TERRAIN_INFO.txt
  LICENSE.txt
  isometric/               ← the projection this game uses
    color0..color7/          the static frames — 560 files each
      <Unit>_Large_face<dir>_<frame>.png     88 × 108 px
    animation_frames/
      color<N>_<Unit>_Large_face<dir>_<anim>_<frame>.png   248 × 308 px
    terrain/
  orthogonal/              ← a second, top-down projection. Unused here.
```

Colour index: `0` Dark, `1` White, `2` Red, `3` Orange, `4` Yellow, `5` Green,
`6` Blue, `7` Purple. The game uses **color6 for the player, color7 for the
enemy** (`SPRITE_TEAM_COLOR`).

### What the filenames actually mean

The directory names are internal codenames. `UNIT_INFO.txt` gives the real ones,
and they are **not** guessable from the artwork — guessing gets you a motorbike
where you wanted a medic:

| file | actually is | file | actually is |
|---|---|---|---|
| `Infantry` | Infantry (rifleman) | `Tank` | **Light Tank** |
| `Infantry_P` | **Bazooka** | `Tank_P` | **Heavy Tank** |
| `Infantry_S` | **Bike** (a motorcycle) | `Tank_S` | AA Tank |
| `Infantry_T` | **Sniper** | `Tank_T` | Recon Tank |
| `Civilian` | unarmed civilian | `Supply` | **Supply Truck** |
| `Artillery` | Light Artillery | `Supply_P` | Build Rig |

`UNIT_INFO.txt` also lists each unit's weapons and which attack animation it
uses — worth reading before wiring up attack animations.

### The `<frame>` suffix is a trap

The four files `face0_0` … `face0_3` look like a 4-frame animation. For many
units they are **byte-identical duplicates** — including `Infantry`, the one the
soldier uses. Distinct frames per face, by md5 (isometric, color6):

| art | face0 | face1 | face2 | face3 |
|---|---|---|---|---|
| `Infantry` | 1 | 1 | 1 | 1 |
| `Infantry_P` (Bazooka) | 1 | 1 | 1 | 1 |
| `Infantry_S` (Bike) | 4 | 4 | 4 | 4 |
| `Infantry_T` (Sniper) | 3 | 3 | 1 | 1 |
| `Civilian` | 3 | 3 | 3 | 3 |
| `Tank` | 1 | 1 | 1 | 1 |
| `Tank_P` / `Tank_S` / `Tank_T` | 4 / 3 / 3 | … | … | … |
| `Supply` | 3 | 4 | 4 | 4 |

So `SPRITE_DEFAULTS.frames` is **1**, and only art that genuinely differs opts
into more. Setting `frames: 4` for `Infantry` costs three redundant image loads
and three redundant offscreen bakes, and animates nothing.

### There is no walk cycle in this pack

Confirmed exhaustively, both projections. The complete list of named animations
in `animation_frames/` and `orthogonal/frames/` is:

```
attack_0   attack_1   fiery_explode
+ projectile/impact effects (Machine_Gun, Cannon, Rocket, Bomb,
  Arc_Missile, Long_Cannon, Torpedo, Handgun — strength_0..3)
```

Nothing matching `walk`, `move`, `run`, `step` or `idle` exists. And where the
static `_0.._3` frames *do* differ, the motion is a **stationary idle** — the
Civilian sways its arms, the Bike and vehicles vibrate in place — never
locomotion. No unit in the pack moves its legs.

Units would therefore **slide** rather than step. Since there's no walk art to
use, the renderer fakes one: `spriteBob()` lifts the sprite by `bob` pixels on
alternate half-strides while a unit is moving. At this zoom (a figure is ~25 px
tall) one pixel reads convincingly as a footfall, and because it's driven by
`u.walkPhase` — **distance travelled, not elapsed time** — a faster unit steps
faster, and a stopped unit stands still. It costs nothing and works even for the
byte-identical art.

Tuned with `bob` (pixels, 0 disables) and `bobStride` (tiles per half-step);
both are sliders in `sprite-tool.html`.

If you ever want real stepping, any 4-direction isometric pack with a walk cycle
drops into `SPRITE_DEFS` unchanged, as long as it keeps one file per direction.

---

## 2. Facing convention (measured from the art, not assumed)

```
face0 = SE   face1 = SW   face2 = NE   face3 = NW
```

where "SE" means *down-right on screen*, i.e. the `+tx` tile axis. `face0`/`face1`
are front views (you see the rifle); `face2`/`face3` are back views.

`u.facing` is a **screen** angle (`0` = right, `+π/2` = down). The four sprites
therefore represent 45°, 135°, 225° and 315°, and `dirOrder = [0, 1, 3, 2]` maps
each 90° screen quadrant onto the right file:

| screen angle | quadrant | `dirOrder` | file | looks like |
|---|---|---|---|---|
| 0–90° | down-right | 0 | `face0` | SE, front |
| 90–180° | down-left | 1 | `face1` | SW, front |
| 180–270° | up-left | 3 | `face3` | NW, back |
| 270–360° | up-right | 2 | `face2` | NE, back |

---

## 3. Why sprites used to flicker

Two independent causes, both fixed. Both are worth understanding because both
are easy to reintroduce.

### 3a. Sub-pixel rescaling ("boiling")

The source art is 88×108 and we want ~44×54, so `scale = 0.5`. The old code did
this on **every** `drawImage`:

```js
ctx.imageSmoothingEnabled = false;
ctx.drawImage(img, dx, dy, w, h);   // dx, dy fractional — camera is a float
```

With smoothing off, the browser resamples nearest-neighbour, and *which* source
pixels survive depends on the destination's sub-pixel phase. As a unit walks,
that phase sweeps continuously, so the surviving pixel set keeps changing.

Measured in Chrome, comparing the drawn figure at successive sub-pixel offsets
(whole-pixel translation factored out):

```
sub-pixel offset   pixels of the figure that change shape
+0.125                0%
+0.25                 0%
+0.5                 58%      ← more than half the soldier redraws
+0.75                58%
```

Half the soldier changing shape twice per pixel of travel is the flicker.

**The fix**: bake each frame *once* into an offscreen canvas at its final size
with smoothing **on** (a clean box-filter reduction), then blit it 1:1 at
**integer** coordinates. Same measurement after the change: **0% at every
offset.** The sprite now translates as a rigid block of pixels.

```js
const dx = Math.round(s.x - baked.w * def.anchorX + def.offX);
const dy = Math.round(s.y - baked.h * def.anchorY + def.offY);
ctx.drawImage(baked.canvas, dx, dy);   // 3-arg form: no rescale at all
```

> Do not "restore" the crisp-pixels line. `imageSmoothingEnabled = false` is the
> right setting for *upscaling* pixel art and the wrong one for downscaling it —
> at 0.5 it throws away every other row and column, and re-picks which ones each
> frame.

### 3b. Facing flip-flop at the quadrant edges

With only four facings, the bucket boundaries land on exactly 0°, 90°, 180° and
270° — screen east, south, west and north. Those are precisely the angles
produced by **diagonal tile movement**, which is the most common thing A* emits.

A unit walking due east sits exactly on the 0°/360° edge, so tiny floating-point
noise in `dx + dy` flipped it between `face0` (SE, facing the camera) and
`face2` (NE, back to the camera) — frame after frame. That is both "flickering"
and "the wrong graphic for the direction it's walking".

**The fix**: `spriteDir()` takes the bucket the unit is *already showing* and
keeps it until the angle is `turnMargin` radians (≈13°) clear of the shared
edge:

```js
let d = facing - (prev + 0.5) * step;
d = Math.atan2(Math.sin(d), Math.cos(d));            // wrap to −π..π
if (Math.abs(d) < step / 2 + def.turnMargin) bucket = prev;
```

Measured over a 31-second headless skirmish with ~70 sprited units, direction
changes per unit per second:

```
              mean     worst unit
before        0.22       1.74
after         0.10       0.39
```

The remaining changes are real turns.

### 3c. Anchoring to the wrong point (units floating high)

Related, and worth its own note because it's the easiest of the three to get
wrong. `anchorY` must be the unit's **ground point** — the tile it is standing
on — and that is the **centre of its drop shadow**, not the bottom of the art.

For `Infantry`, opaque pixels run to row 93 of 108 (`0.86`), but the shadow
plate spans rows 77–93, centred on row 85 (`0.787`). Anchoring at `0.86` drew
every soldier ~4 px high, and against a selection ring that itself sits 3 px
below the tile centre, the visible gap was ~7 px — on a figure only ~25 px
tall, that reads as clearly floating.

Rather than hand-tuning a number per unit, `bakeSprite()` now **measures it**
(`measureGroundPoint`). Every frame in the pack draws its shadow in exactly
`rgb(78, 86, 100)` — verified across all 8 team colours and every unit, and it
never occurs in a unit's body — so the shadow's bounding-box centre gives the
ground point directly. The `anchorX`/`anchorY` in `SPRITE_DEFS` are now only a
fallback for when measurement isn't possible.

This also fixes a smaller artefact: the shadow centre is **not the same per
facing** (`face0`/`face3` sit at x `0.540`, `face1`/`face2` at `0.494`), so a
single `anchorX` made units jump ~2 px sideways when they turned. Measuring
per frame removes that.

> Measurement needs `getImageData`, which throws on a tainted canvas if you open
> `index.html` over `file://`. That's caught, and the code falls back to the
> configured anchors — so the game still works from the filesystem, it just
> sits very slightly off. Serve over http:// (any static server) for the exact
> placement.

---

## 4. How drawing works now

`drawUnitSprite(u)` returns `false` if the unit has no art, in which case
`render.js` draws the procedural body instead.

1. `spriteDef(type)` merges `SPRITE_DEFS[type]` over `SPRITE_DEFAULTS`.
2. `spriteDir(def, u.facing, u._spriteBucket)` picks a facing bucket, with the
   deadband above. `spriteFace()` maps bucket → file index via `dirOrder`.
3. Frame index, but only if `def.frames > 1`.
4. `bakeSprite(path, def)` returns the cached offscreen canvas, creating it the
   first time the image is available. Returns `null` while still loading.
5. If the bake isn't ready, fall back to `u._spriteLast` — the last frame this
   unit successfully drew — so a slow-loading frame never pops the unit back to
   the procedural blob mid-walk.
6. Blit 1:1 at rounded coordinates.

`render.js` skips its own drop-shadow ellipse for sprited units
(`unitHasSprite`), because the art already has a shadow baked in — drawing both
gave every soldier a doubled, offset shadow. The muzzle flash uses
`spriteGunPoint()` rather than a radius-derived offset, since a sprite is about
twice the height of the procedural body it replaced.

### View-only fields cached on the unit

`sprites.js` writes three underscore-prefixed fields onto units. They are
renderer-owned caches, never read by simulation, and they die with the unit:

| field | purpose |
|---|---|
| `u._spriteBucket` | facing bucket currently shown — the deadband's memory |
| `u._spriteLast` | last baked frame drawn, for the no-pop fallback |
| `u._spriteH` | drawn height, for muzzle-flash placement |

This is the second sanctioned exception to "rendering never mutates state" (the
first is `hoveredUnit`). If you add more, keep the `_` prefix and document it.

---

## 5. Tuning knobs

`SPRITE_DEFAULTS` in `js/sprites.js`; any key can be overridden per unit in
`SPRITE_DEFS`.

| key | default | what it does |
|---|---|---|
| `scale` | `0.5` | 88×108 → 44×54. Raising it invalidates the hit-box assumption in `picking.js` — see ARCHITECTURE.md §7. |
| `anchorX` / `anchorY` | `0.5` / `0.787` | **Fallback only** — normally measured from the drop shadow at bake time (§3c). Used when `getImageData` is unavailable (`file://`) or the art has no shadow plate. |
| `offX` / `offY` | `0` / `3` | Whole-pixel nudge after anchoring. `offY: 3` matches the ground nudge the selection ring and procedural shadow already use, so a sprite lands inside its ring. |
| `frames` | `1` | Only raise it for art whose files actually differ (see §1). |
| `fps` | `6` | Animation rate for `frames > 1`. |
| `turnMargin` | `0.22` rad | Deadband before the sprite turns. Lower = twitchier, higher = laggier turns. |
| `gunY` | `0.55` | Muzzle-flash height as a fraction of sprite height above the feet. |
| `dirs` / `dirOrder` | `4` / `[0,1,3,2]` | Facing count and quadrant→file mapping. Don't change unless the art changes. |

Measured fallback anchors (shadow-plate centres, `face0`):

| art | shadow rows | `anchorY` | `anchorX` |
|---|---|---|---|
| `Infantry` | 77–93 | 0.787 | 0.540 |
| `Infantry_T` | 77–97 | 0.806 | 0.472 |
| `Civilian` | 77–88 | 0.764 | 0.494 |
| `Tank` | 85–96 | 0.838 | 0.665 |

You normally don't need these — the bake measures them. They only matter as the
`file://` fallback.

---

## 6. Adding art to a unit

One line, if the anchor defaults suit it:

```js
const SPRITE_DEFS = {
  soldier:  { unit: "Infantry" },
  seal:     { unit: "Infantry_T", frames: 4, anchorY: 0.89, anchorX: 0.47, gunY: 0.45 },
  engineer: { unit: "Civilian",   anchorY: 0.82 },     // ← for example
};
```

`preloadSprites()` walks `SPRITE_DEFS` at load and warms every
colour × facing × frame, so nothing else needs touching.

Unassigned art that fits the current roster. The pack's real unit names (§1)
line up with this game's roster almost exactly:

| unit type | currently | art | why |
|---|---|---|---|
| `vehicle` (Light Tank) | iso cube | `Tank` | the pack calls it "Light Tank" |
| `heavytank` (Heavy Tank) | iso cube | `Tank_P` | the pack calls it "Heavy Tank" |
| `oreMiner` | iso cube | `Supply` | "Supply Truck" |
| `engineer` | peach capsule | `Civilian` | unarmed worker; has a 3-frame idle |
| `medic` | pink capsule | — | **no good match.** The pack has no medic; the
only unarmed figure is `Civilian`, already the best fit for the engineer. Leave
it procedural, or accept two identical-looking support units. |

Do **not** reach for `Infantry_S` for a support role — it's a motorcycle.

The two-tile units (`vehicle`, `heavytank`, `oreMiner`) need their own `scale`:
a 2×2 footprint spans ~128 screen px, so `0.5` is far too small. `anchorY` is
measured automatically, so that part needs no work.

### Measuring a fallback anchor by hand

The bake does this automatically; use this only to fill in a fallback. Find the
bounding box of the shadow-coloured pixels — its centre is the ground point.

```powershell
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap "path\to\Unit_Large_face0_0.png"
$minY=999;$maxY=-1;$minX=999;$maxX=-1
for($y=0;$y -lt $b.Height;$y++){ for($x=0;$x -lt $b.Width;$x++){ $p=$b.GetPixel($x,$y)
  if($p.A -gt 8 -and $p.R -eq 78 -and $p.G -eq 86 -and $p.B -eq 100){
    if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y}
    if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x} } } }
"anchorY=$([math]::Round((($minY+$maxY)/2.0)/$b.Height,3)) anchorX=$([math]::Round((($minX+$maxX)/2.0)/$b.Width,3))"
```

---

## 7. Checking a change

`node test/smoke.js` exercises the sprite code headlessly — `Image` and
`document` are absent there, so `bakeSprite` returns `null` and every unit takes
the procedural path. It proves nothing crashed; it cannot prove anything looks
right.

For that, serve the folder and check in the browser console:

```js
spriteBaked.size                                    // frames baked so far
[...spriteImages].filter(([p,i]) => i.complete && !i.naturalWidth)   // 404s — should be []
state.units.find(u => u.type === 'soldier')._spriteBucket            // current facing
[...spriteBaked.values()].every(b => b.measured)     // anchors auto-measured? should be true
```
