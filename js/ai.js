"use strict";

/* =========================================================================
 * AI — enemy behavior: chase a detected player, otherwise idle/wander.
 * ========================================================================= */

function updateAI(dt) {
  for (const u of state.units) {
    if (u.team !== "enemy") continue;

    // "Advance" enemies (Survival waves) RELENTLESSLY push the Main House and let
    // combat shoot whatever comes into range on the way. They never chase a
    // target, so they can't get wedged fixating on something they can't reach.
    if (u.behavior === "advance") { advanceEnemy(u, dt); continue; }

    // Other enemies: if we've spotted a target, close to firing range.
    if (u.target && u.target.hp > 0 && u.distTo(u.target) <= u.view) {
      if (u.distTo(u.target) > u.weapon.range || !hasLineOfSight(u, u.target)) {
        const t = u.approachTile(u.target);
        u.moveTo(t.x, t.y); // moveTo dedupes when the goal is unchanged
      }
      continue;
    }

    if (u.stationary) continue;

    // Otherwise wander.
    const reached = Math.hypot(u.targetTx - u.tx, u.targetTy - u.ty) < 0.05;
    u.wanderTimer -= dt;
    if (reached && u.wanderTimer <= 0) {
      const occupied = occupiedTiles(new Set([u])); // every footprint but our own
      for (let attempt = 0; attempt < 6; attempt++) {
        const nx = Math.round(u.tx + (Math.random() * 2 - 1) * u.wanderRadius);
        const ny = Math.round(u.ty + (Math.random() * 2 - 1) * u.wanderRadius);
        if (footprintFree(nx, ny, u.size, occupied) && walkable(nx, ny, u.size)) {
          u.moveTo(nx, ny); break;
        }
      }
      u.wanderTimer = 2 + Math.random() * 4; // pause 2-6s before next move
    }
  }
}

// Push toward the objective (the Main House, or the nearest building if it's
// gone). A* is throttled so a swarm of advancing units doesn't repath every
// frame. Combat handles engaging whatever comes into view en route.
function advanceEnemy(u, dt) {
  let obj = u.advanceTarget;
  if (!obj || obj.hp <= 0 || !state.buildings.includes(obj)) {
    obj = enemyObjective(u);
    u.advanceTarget = obj;
  }
  if (!obj) return; // no buildings left to attack — combat still targets units

  const nearObj = u.distTo(obj) <= (u.size + obj.size) / 2 + 2;
  const shooting = u.target && u.target.hp > 0 && u.distTo(u.target) <= u.weapon.range;

  // Stuck-breaker: sample how far we've travelled every ~1.5s. Moving less than a
  // tile in that window (while not at the base and not shooting) means we're
  // genuinely wedged — hop to a random nearby tile to dislodge, then re-path.
  // (Windowed, not per-frame: a soldier only covers ~0.03 tiles per frame, so a
  //  per-frame threshold would wrongly flag every normal mover as stuck.)
  u.advCheck -= dt;
  if (u.advCheck <= 0) {
    const travelled = Math.hypot(u.tx - u.advLastX, u.ty - u.advLastY);
    u.advLastX = u.tx; u.advLastY = u.ty;
    u.advCheck = 1.5;
    if (travelled < 1.0 && !nearObj && !shooting) {
      for (let i = 0; i < 12; i++) {
        const nx = Math.round(u.tx + (Math.random() * 2 - 1) * 5);
        const ny = Math.round(u.ty + (Math.random() * 2 - 1) * 5);
        if (walkable(nx, ny, u.size, false)) { u.moveTo(nx, ny); u.commandedMove = true; u.repathTimer = 0.8; return; }
      }
    }
  }

  // Re-evaluate the heading on the throttle only (NOT on arrival — a unit halted
  // at a wall sits on its goal, which would otherwise recompute every frame).
  u.repathTimer -= dt;
  if (u.repathTimer <= 0) {
    const dest = safeAdvanceDest(u, advanceSteer(u, obj));
    u.path = [];
    u.goalTx = dest.x; u.goalTy = dest.y;
    u.targetTx = dest.x; u.targetTy = dest.y;
    u.commandedMove = true;
    u.repathTimer = 1 + Math.random(); // 1–2s
  }
}

// advanceSteer works in continuous space and then rounds, so its result can land
// ON the wall tile it was trying to stop short of — and because advancing units
// bypass A*, updateMovement then walks them straight into the masonry and they
// sit there embedded. Snap any such destination back to open ground.
function safeAdvanceDest(u, dest) {
  if (walkable(dest.x, dest.y, u.size, false)) return dest;
  const near = nearestWalkable(dest.x, dest.y, u.size, false);
  if (near) return near;
  return { x: Math.round(u.tx), y: Math.round(u.ty) }; // stand fast rather than clip in
}

// Steer straight at the objective; if a building blocks the straight line, stop
// just short of it and let combat shoot it down (breach), then re-evaluate next
// tick. NO A* — so a walled base can't trigger the map-wide path explosion, and
// enemies always chew their way to the house instead of piling up outside.
function advanceSteer(u, obj) {
  const uc = (u.size - 1) / 2;
  const spot = u.besideTile(obj);
  if (state.blocked.size === 0) return spot;

  const sx = u.tx + uc, sy = u.ty + uc;      // our center
  const gx = spot.x + uc, gy = spot.y + uc;  // target center
  const dx = gx - sx, dy = gy - sy;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return spot;

  const ox0 = obj.tx, oy0 = obj.ty;
  const ox1 = obj.tx + (obj.bw || obj.size) - 1, oy1 = obj.ty + (obj.bh || obj.size) - 1;
  const steps = Math.ceil(dist * 2);
  let lastX = sx, lastY = sy;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = sx + dx * t, py = sy + dy * t;
    const tx = Math.floor(px), ty = Math.floor(py);
    if (tx >= ox0 && tx <= ox1 && ty >= oy0 && ty <= oy1) return spot; // reached the objective
    if (state.blocked.has(tileKey(tx, ty))) {
      // Stop short of the blocker. Back off half a tile before rounding, or the
      // round can land right on the wall tile we just refused to enter.
      const bx = lastX - (dx / dist) * 0.5, by = lastY - (dy / dist) * 0.5;
      return { x: Math.round(bx - uc), y: Math.round(by - uc) };
    }
    lastX = px; lastY = py;
  }
  return spot;
}

// The Main House if it stands, else the nearest surviving player building.
function enemyObjective(u) {
  const main = state.buildings.find(b => b.type === "main" && b.hp > 0);
  if (main) return main;
  let best = null, bestD = Infinity;
  for (const b of state.buildings) {
    if (b.hp <= 0) continue;
    const d = u.distTo(b);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}
