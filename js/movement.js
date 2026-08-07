"use strict";

/* =========================================================================
 * MOVEMENT — advancing units along their paths, and translating group
 * orders (move / attack) into per-unit destinations.
 * ========================================================================= */

// How close counts as "reached this waypoint". Scaled to the distance a unit
// covers in one frame, with a floor so a stalled/slow frame can't shrink it to
// nothing. Must stay comfortably above SEPARATION_FRAC × speed × dt.
function arrivalEps(u, dt) {
  return Math.max(0.06, u.speed * dt);
}

// Advance movement by dt seconds, following each unit's A* path waypoints.
function updateMovement(dt) {
  for (const u of state.units) {
    const dx = u.targetTx - u.tx;
    const dy = u.targetTy - u.ty;
    const dist = Math.hypot(dx, dy);
    // "Close enough" must be bigger than one frame of movement AND bigger than
    // one frame of separation push, or a crowded unit gets nudged off its
    // waypoint every frame, never registers arrival, never advances to the next
    // waypoint, and parks forever on whoever it's standing on.
    if (dist < arrivalEps(u, dt)) {
      u.tx = u.targetTx; u.ty = u.targetTy;
      u.moving = false;                     // for the sprite step-bob
      if (u.path && u.path.length) {
        u.path.shift();                     // reached this waypoint
        if (u.path.length) {
          u.targetTx = u.path[0].x; u.targetTy = u.path[0].y;
        } else {
          u.commandedMove = false;          // arrived at the final goal
        }
      } else {
        u.commandedMove = false;
      }
      continue;
    }
    // Face the movement direction, unless we're locked onto a combat target.
    if (!u.aiming) {
      u.facing = Math.atan2((dx + dy) * HALF_H, (dx - dy) * HALF_W);
    }
    const step = Math.min(dist, u.speed * dt);
    u.tx += (dx / dist) * step;
    u.ty += (dy / dist) * step;
    u.moving = true;
    u.walkPhase += step;                    // distance-based, so the bob tracks speed
  }
  separateUnits(dt);
}

/* --------------------------- SOFT COLLISION ----------------------------- */
// Units don't block each other in pathfinding (that would deadlock a queue in a
// corridor), so without this they happily occupy the same tile — most visibly
// when several tanks are sent to one spot, or when a group auto-approaches the
// same target. This is the standard RTS fix: a gentle push apart, proportional
// to how much two units overlap, applied after everyone has moved.
// The push is scaled to each unit's OWN speed rather than being a flat rate.
// A flat rate that exceeds a unit's speed lets a crowd shove its members
// backwards faster than they can walk, so a group sent to one spot never
// converges — it mills around several tiles off target. Keeping it below 1
// guarantees movement always out-runs separation, so units still arrive; the
// push only wins once they've stopped, which is exactly when overlap matters.
const SEPARATION_FRAC = 0.4; // fraction of a unit's speed, at full overlap
const SEP_CELL = 3;          // spatial-hash cell size in tiles

function separateUnits(dt) {
  const grid = new Map();
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    const k = ((u.centerX / SEP_CELL) | 0) + "," + ((u.centerY / SEP_CELL) | 0);
    let a = grid.get(k);
    if (!a) grid.set(k, a = []);
    a.push(u);
  }

  // Pass 1: accumulate each unit's push vector from its neighbours. Computed
  // for everyone BEFORE anything moves, so the result doesn't depend on order.
  for (const u of state.units) {
    let px = 0, py = 0;
    if (u.hp > 0) {
      const bx = (u.centerX / SEP_CELL) | 0, by = (u.centerY / SEP_CELL) | 0;
      for (let gy = by - 1; gy <= by + 1; gy++) {
        for (let gx = bx - 1; gx <= bx + 1; gx++) {
          const arr = grid.get(gx + "," + gy);
          if (!arr) continue;
          for (const o of arr) {
            if (o === u) continue;
            const minD = (u.size + o.size) * 0.45;   // 0.9 tiles apart for two soldiers
            const dx = u.centerX - o.centerX, dy = u.centerY - o.centerY;
            const d = Math.hypot(dx, dy);
            if (d >= minD) continue;
            if (d < 1e-4) {
              // Exactly stacked: fan out on a per-unit fixed heading so the
              // pile unpacks instead of jittering on a random vector.
              const a = (u.id % 8) * (Math.PI / 4);
              px += Math.cos(a); py += Math.sin(a);
            } else {
              const overlap = (minD - d) / minD;     // 0 = touching, 1 = concentric
              px += (dx / d) * overlap; py += (dy / d) * overlap;
            }
          }
        }
      }
    }
    u._sepX = px; u._sepY = py;
  }

  // Pass 2: apply, but never into a building — better to overlap a friend than
  // to be shoved inside a wall.
  for (const u of state.units) {
    const m = Math.hypot(u._sepX, u._sepY);
    if (m < 1e-4) continue;
    const step = Math.min(m, 1) * u.speed * SEPARATION_FRAC * dt;
    const nx = clamp(u.tx + (u._sepX / m) * step, 0, CONFIG.MAP_W - u.size);
    const ny = clamp(u.ty + (u._sepY / m) * step, 0, CONFIG.MAP_H - u.size);
    if (walkable(Math.round(nx), Math.round(ny), u.size, u.team === "player")) {
      u.tx = nx; u.ty = ny;
    }
  }
}

// Move a group to (cx,cy), giving each unit a distinct free destination tile
// found by spiralling outward from the click. One unit per resting tile.
function assignGroupMove(group, cx, cy) {
  const occupied = occupiedTiles(new Set(group)); // tiles held by units NOT moving
  const taken = new Set();                          // footprints claimed this order
  const maxR = Math.max(CONFIG.MAP_W, CONFIG.MAP_H);

  // Closest units claim the closest spots for a natural-looking spread.
  const ordered = group.slice().sort((a, b) =>
    Math.hypot(a.tx - cx, a.ty - cy) - Math.hypot(b.tx - cx, b.ty - cy));

  for (const u of ordered) {
    // Center the footprint roughly on the clicked tile.
    const ax0 = cx - (u.size >> 1);
    const ay0 = cy - (u.size >> 1);
    const placed = spiralSearch(ax0, ay0, 0, maxR, (ax, ay) =>
      (footprintFree(ax, ay, u.size, occupied) &&
       footprintFree(ax, ay, u.size, taken) &&
       walkable(ax, ay, u.size, u.team === "player")) // not on a building
        ? { x: ax, y: ay } : null);
    const spot = placed || { x: ax0, y: ay0 };
    markFootprint(spot.x, spot.y, u.size, taken);
    u.moveTo(spot.x, spot.y);
    u.commandedMove = true;              // overrides auto-stop until arrival
    u.moveGoal = { x: spot.x, y: spot.y }; // remembered so combat interruptions resume it
  }
}

// Order a group to attack `enemy`: form a shoulder-to-shoulder arc on the
// side the group is approaching from — never wrapping to the far side.
function assignAttackArc(group, enemy) {
  const ec = (enemy.size - 1) / 2;
  let gx = 0, gy = 0;
  for (const u of group) { gx += u.centerX; gy += u.centerY; }
  gx /= group.length; gy /= group.length;
  const base = Math.atan2(gy - (enemy.ty + ec), gx - (enemy.tx + ec));

  const n = group.length;
  const maxArc = Math.PI * 0.9;                  // cap so slots stay near side
  const step = n > 1 ? Math.min(0.38, maxArc / (n - 1)) : 0; // ~22° apart
  const start = base - step * (n - 1) / 2;       // centered on the approach

  // Assign slots left-to-right across the arc so units don't cross over.
  const perpx = -Math.sin(base), perpy = Math.cos(base);
  const ordered = group.slice().sort((a, b) =>
    ((a.centerX - gx) * perpx + (a.centerY - gy) * perpy)
  - ((b.centerX - gx) * perpx + (b.centerY - gy) * perpy));
  ordered.forEach((u, i) => {
    u.forcedTarget = enemy;
    u.attackAngle = start + i * step;
    u.moveGoal = null; // an attack order replaces any pending move destination
  });
}
