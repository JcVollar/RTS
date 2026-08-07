"use strict";

/* =========================================================================
 * SPRITES — image-based unit rendering using the CC0 PixVoxel Wargame set.
 * Picks a facing direction + animation frame, draws it crisp and STABLE, and
 * falls back to the procedural bodies (render.js) for any unit without art,
 * so the game always renders even while art is being added.
 *
 * PixVoxel layout:  assets/PixVoxel_Wargame/isometric/<color>/<Unit>_Large_face<dir>_<frame>.png
 *   <color> = color0..color7  (0 Dark,1 White,2 Red,3 Orange,4 Yellow,5 Green,6 Blue,7 Purple)
 *   <dir>   = 0..3  — measured from the art: face0 SE, face1 SW, face2 NE, face3 NW
 *                     ("SE" = down-right on screen, i.e. the +tx tile axis)
 *   <frame> = 0..3  — NOTE: for most units these four files are byte-identical.
 *                     Only a few (Infantry_T) are a real loop. See `frames`.
 *
 * Two things make sprites look right instead of shimmering:
 *
 *   1. BAKED SCALING. The source art is 88x108 and we want ~44x54. Rescaling
 *      on every drawImage with imageSmoothingEnabled=false resamples at a new
 *      sub-pixel phase each frame, so ~40-50% of the figure's visible pixels
 *      change as a unit walks — that is the "flickering". Instead each frame
 *      is downscaled ONCE into an offscreen canvas and then blitted 1:1 at
 *      integer coordinates, so a walking unit is pixel-stable.
 *
 *   2. TURN HYSTERESIS. With only 4 facings the bucket edges sit exactly on
 *      screen-east/south/west/north — which is exactly where diagonal tile
 *      movement points. Without a deadband a unit walking east flip-flops
 *      between the SE (front) and NE (back) sprite. `turnMargin` makes a unit
 *      hold its current facing until the angle is clearly inside the next one.
 * ========================================================================= */

const SPRITE_ROOT = "assets/PixVoxel_Wargame/isometric";
const SPRITE_TEAM_COLOR = { player: "color6", enemy: "color7" }; // Blue vs Purple

// Every unit model in the pack, with the real name from its UNIT_INFO.txt.
// The filenames are internal codenames and are NOT guessable from the artwork
// (Infantry_S is a motorbike), so this is the lookup table sprite-tool.html
// shows when you're choosing art. Buildings are listed too, for later.
const SPRITE_CATALOG = [
  { file: "Infantry",    name: "Infantry (rifleman)", kind: "infantry" },
  { file: "Infantry_P",  name: "Bazooka",             kind: "infantry" },
  { file: "Infantry_S",  name: "Bike (motorcycle)",   kind: "infantry" },
  { file: "Infantry_T",  name: "Sniper",              kind: "infantry" },
  { file: "Civilian",    name: "Civilian (unarmed)",  kind: "infantry" },
  { file: "Tank",        name: "Light Tank",          kind: "vehicle" },
  { file: "Tank_P",      name: "Heavy Tank",          kind: "vehicle" },
  { file: "Tank_S",      name: "AA Tank",             kind: "vehicle" },
  { file: "Tank_T",      name: "Recon Tank",          kind: "vehicle" },
  { file: "Artillery",   name: "Light Artillery",     kind: "vehicle" },
  { file: "Artillery_P", name: "Defensive Artillery", kind: "vehicle" },
  { file: "Artillery_S", name: "AA Artillery",        kind: "vehicle" },
  { file: "Artillery_T", name: "Stealth Artillery",   kind: "vehicle" },
  { file: "Supply",      name: "Supply Truck",        kind: "vehicle" },
  { file: "Supply_P",    name: "Build Rig",           kind: "vehicle" },
  { file: "Supply_S",    name: "Amphi Transport",     kind: "vehicle" },
  { file: "Supply_T",    name: "Jammer",              kind: "vehicle" },
  { file: "Copter",      name: "Transport Copter",    kind: "air" },
  { file: "Copter_P",    name: "Gunship Copter",      kind: "air" },
  { file: "Copter_S",    name: "Blitz Copter",        kind: "air" },
  { file: "Copter_T",    name: "Comm Copter",         kind: "air" },
  { file: "Plane",       name: "Prop Plane",          kind: "air" },
  { file: "Plane_P",     name: "Ground Bomber",       kind: "air" },
  { file: "Plane_S",     name: "Fighter Jet",         kind: "air" },
  { file: "Plane_T",     name: "Stealth Jet",         kind: "air" },
  { file: "Boat",        name: "Patrol Boat",         kind: "naval" },
  { file: "Boat_P",      name: "Battleship",          kind: "naval" },
  { file: "Boat_S",      name: "Cruiser",             kind: "naval" },
  { file: "Boat_T",      name: "Submarine",           kind: "naval" },
  { file: "City",        name: "City",                kind: "building" },
  { file: "Factory",     name: "Factory",             kind: "building" },
  { file: "Airport",     name: "Airport",             kind: "building" },
  { file: "Laboratory",  name: "Laboratory",          kind: "building" },
  { file: "Castle",      name: "Castle",              kind: "building" },
  { file: "Estate",      name: "Estate",              kind: "building" },
];

// Which PixVoxel unit each game unit type uses, plus per-unit look tuning.
// Anything not listed here draws the old procedural body.
// Codenames come from the pack's UNIT_INFO.txt, not from the filenames:
// Infantry_T is the Sniper, Infantry_P the Bazooka, Infantry_S a motorbike.
const SPRITE_DEFS = {
  engineer: { unit: "Civilian" },
  soldier: { unit: "Infantry" },
  // The Sniper is one of the few whose four files really differ (on its two
  // front facings only), so it gets a genuine idle loop.
  seal: { unit: "Infantry_T", frames: 4, gunY: 0.24 },
  medic: { unit: "Infantry_P" },
  vehicle: { unit: "Civilian" },
  oreMiner: { unit: "Tank_S" },
};

// Shared defaults (merged into each entry). Tweak the look here / per-unit.
const SPRITE_DEFAULTS = {
  size: "Large",
  dirs: 4,
  dirOrder: [0, 1, 3, 2],       // face index per clockwise screen quadrant: SE,SW,NW,NE
  frames: 1,                    // 1 = static. Only raise it for art that really animates.
  fps: 6,
  scale: 0.5,                   // 88x108 source -> 44x54 on screen (figure ~29px tall)
  // Ground point in the frame. These are only a FALLBACK: bakeSprite() measures
  // the real one from each frame's drop shadow (see SHADOW_RGB below), which is
  // both more accurate and different per facing.
  anchorX: 0.5, anchorY: 0.787,
  offX: 0, offY: 3,             // +3y matches the ground nudge the selection ring uses
  turnMargin: 0.22,             // radians past a facing edge before the sprite turns (~13 deg)
  gunY: 0.19,                   // muzzle height above the ground point, as a fraction of sprite height
  // STEP BOB. The pack has no walk cycle (see docs/SPRITES.md) — every unit
  // would otherwise slide. Nudging the sprite up by a pixel on a distance-based
  // cadence stands in for one: at ~25px tall a single pixel reads as a footfall,
  // it costs nothing, and it works even for art whose frames are identical.
  // Distance-based, not time-based, so a faster unit steps faster.
  bob: 1,                       // pixels of lift at the top of a step (0 = off)
  bobStride: 0.35,              // tiles travelled per half-step
};

// The pack draws every unit standing on a flat drop shadow in exactly this
// colour — verified across all 8 team colours and every unit, and it never
// appears in a unit's body. The CENTRE of that shadow is the tile the unit is
// standing on, which is the point we must line up with its screen position.
// Anchoring to the bottom of the art instead puts a soldier ~7px too high.
const SHADOW_RGB = [78, 86, 100];

function spriteDef(type) {
  const d = SPRITE_DEFS[type];
  return d ? Object.assign({}, SPRITE_DEFAULTS, d) : null;
}

// True if this unit draws from art (render.js uses it to skip the procedural
// drop shadow — the sprites already have one baked in).
function unitHasSprite(u) { return !!SPRITE_DEFS[u.type]; }

function spritePath(def, team, dir, frame) {
  const color = SPRITE_TEAM_COLOR[team] || SPRITE_TEAM_COLOR.player;
  return `${SPRITE_ROOT}/${color}/${def.unit}_${def.size}_face${dir}_${frame}.png`;
}

/* ------------------------------ LOADING --------------------------------- */
const spriteImages = new Map(); // path -> Image (or a dummy when there's no DOM)
const spriteBaked = new Map();  // path -> {canvas,w,h} once downscaled

function loadSprite(path) {
  let img = spriteImages.get(path);
  if (img) return img;
  if (typeof Image === "undefined") {      // headless (tests) — never "loads"
    img = { complete: false, naturalWidth: 0 };
  } else {
    img = new Image();
    img.src = path;                        // a 404 just leaves naturalWidth === 0
  }
  spriteImages.set(path, img);
  return img;
}

// A frame's ground point as {x,y} fractions of its size, or null if it can't be
// measured (no shadow plate, or a tainted canvas when the page is opened over
// file:// instead of http://).
//
//   x = centre of the drop shadow  — the unit's horizontal position
//   y = the BOTTOM OF THE BODY     — where the boots/treads meet the ground
//
// The shadow plate is a diamond whose centre sits ~2px ABOVE the feet, so using
// its centre for y hangs the figure a pixel off the deck. The feet are the real
// contact point, and that's what makes a unit look planted rather than floating.
function measureGroundPoint(img) {
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    const probe = document.createElement("canvas");
    probe.width = w; probe.height = h;
    const px = probe.getContext("2d", { willReadFrequently: true });
    px.drawImage(img, 0, 0);
    const d = px.getImageData(0, 0, w, h).data;
    const [R, G, B] = SHADOW_RGB;
    let minX = w, maxX = -1, minY = h, maxY = -1, n = 0;
    let feetY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] <= 8) continue;
        if (d[i] === R && d[i + 1] === G && d[i + 2] === B) {
          n++;                                     // shadow plate
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        } else if (d[i] || d[i + 1] || d[i + 2]) {
          if (y > feetY) feetY = y;                // body (skip the black outline)
        }
      }
    }
    // Sanity: a real shadow is a decent-sized plate low in the frame. Anything
    // else means this art doesn't follow the convention — use the fallback.
    if (n < 16 || minY < h * 0.5) return null;
    const shadowCentreY = (minY + maxY) / 2;
    return {
      x: (minX + maxX) / 2 / w,
      y: (feetY >= shadowCentreY ? feetY : shadowCentreY) / h,
    };
  } catch (e) {
    return null;                         // tainted canvas (file:// origin)
  }
}

// Downscale a frame once into an offscreen canvas at its final on-screen size,
// with smoothing ON so the reduction is a clean box filter rather than a
// half-the-pixels-thrown-away mess, and record where its ground point is.
// Returns null until the image has loaded.
function bakeSprite(path, def) {
  const hit = spriteBaked.get(path);
  if (hit) return hit;
  if (typeof document === "undefined") return null;
  const img = loadSprite(path);
  if (!img.complete || !img.naturalWidth) return null; // still loading (or 404)

  const w = Math.max(1, Math.round(img.naturalWidth * def.scale));
  const h = Math.max(1, Math.round(img.naturalHeight * def.scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = "high";
  cx.drawImage(img, 0, 0, w, h);

  const g = measureGroundPoint(img);
  const baked = {
    canvas: c, w, h,
    ax: g ? g.x : def.anchorX,
    ay: g ? g.y : def.anchorY,
    measured: !!g,
  };
  spriteBaked.set(path, baked);
  return baked;
}

function preloadSprites() {
  if (typeof Image === "undefined") return;
  for (const type in SPRITE_DEFS) {
    const def = spriteDef(type);
    for (const team in SPRITE_TEAM_COLOR)
      for (let dir = 0; dir < def.dirs; dir++)
        for (let f = 0; f < def.frames; f++)
          loadSprite(spritePath(def, team, dir, f));
  }
}

/* ------------------------------ SELECT ---------------------------------- */
function spriteClock() { return (typeof performance !== "undefined" ? performance.now() : 0) / 1000; }

// Screen-space facing angle -> facing bucket (0..dirs-1, clockwise from east).
// `prev` is the bucket this unit is already showing; passing it adds the
// deadband that stops boundary flip-flop. Returns the BUCKET, not the file
// index — call spriteFace() to get that.
function spriteDir(def, facing, prev) {
  const step = (Math.PI * 2) / def.dirs;
  let t = facing / (Math.PI * 2);
  t -= Math.floor(t);                      // 0..1
  let bucket = Math.floor(t * def.dirs) % def.dirs;
  if (prev != null && prev !== bucket && prev >= 0 && prev < def.dirs) {
    // How far are we from the middle of the bucket we're currently showing?
    let d = facing - (prev + 0.5) * step;
    d = Math.atan2(Math.sin(d), Math.cos(d));            // wrap to -pi..pi
    if (Math.abs(d) < step / 2 + def.turnMargin) bucket = prev; // not far enough: hold
  }
  return bucket;
}

// Facing bucket -> the face index used in the filename.
function spriteFace(def, bucket) { return def.dirOrder[bucket]; }

// Screen point the muzzle flash should sit at for a sprited unit. Measured from
// the unit's ground point (s.y), not from the top of the frame.
function spriteGunPoint(u, s) {
  const def = spriteDef(u.type);
  const h = u._spriteH || 54;
  const gunLen = h * 0.22;
  return {
    x: s.x + Math.cos(u.facing) * gunLen,
    y: (s.y - h * def.gunY) + Math.sin(u.facing) * gunLen * 0.6,
  };
}

/* ------------------------------- DRAW ----------------------------------- */
// Step bob: lift the figure by `bob` px on alternate half-strides while walking.
function spriteBob(u, def) {
  if (!u.moving || !def.bob) return 0;
  return Math.floor(u.walkPhase / def.bobStride) % 2 ? def.bob : 0;
}

// Blit one baked frame so its ground point lands on screen (x, y). 1:1 at
// integer coordinates — no rescale, no sub-pixel resampling, so the pixels stay
// put while the unit walks. sprite-tool.html previews through this same
// function, so what the tool shows is exactly what the game draws.
function blitSprite(c, baked, def, x, y, bob) {
  const dx = Math.round(x - baked.w * baked.ax + def.offX);
  const dy = Math.round(y - baked.h * baked.ay + def.offY) - (bob || 0);
  c.drawImage(baked.canvas, dx, dy);
}

// Draw unit `u` from its sprite; return false (-> procedural body) if it has
// no art or nothing has loaded for it yet.
//
// Renderer-owned fields cached on the unit (view state only, never game logic):
//   u._spriteBucket  facing bucket currently shown, for the turn deadband
//   u._spriteLast    last baked frame drawn, so a not-yet-loaded frame never
//                    pops the unit back to the procedural blob
//   u._spriteH       drawn height, for muzzle-flash placement
function drawUnitSprite(u) {
  const def = spriteDef(u.type);
  if (!def) return false;
  const team = u.team === "enemy" ? "enemy" : "player";

  const bucket = spriteDir(def, u.facing, u._spriteBucket);
  u._spriteBucket = bucket;
  const frame = def.frames > 1 ? Math.floor(spriteClock() * def.fps) % def.frames : 0;

  const baked = bakeSprite(spritePath(def, team, spriteFace(def, bucket), frame), def)
             || u._spriteLast;
  if (!baked) return false;
  u._spriteLast = baked;
  u._spriteH = baked.h;

  const s = unitScreen(u);
  blitSprite(ctx, baked, def, s.x, s.y, spriteBob(u, def));
  return true;
}

preloadSprites();
