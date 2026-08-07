"use strict";

/* =========================================================================
 * HARVEST — ore fields (finite, slowly regrowing) and the Ore Miner loop:
 * drive to ore → fill cargo → drive back to a refinery → convert to credits.
 * ========================================================================= */

/* ----------------------------- ORE FIELDS ------------------------------- */
// Add one ore tile (ignored if a tile already sits there).
function addOre(x, y, amount) {
  const k = tileKey(x, y);
  if (state.oreIndex.has(k)) return;
  const t = { x, y, amount, max: ORE.tileMax };
  state.ore.push(t);
  state.oreIndex.set(k, t);
}

// Lay down one ragged ore patch of radius R centered on (cx,cy). Tiles are
// denser toward the center; anything too near the base (clearR) is skipped.
function addOreCluster(cx, cy, R, clearR) {
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      if (Math.random() > 1 - d / (R + 1)) continue; // denser center, ragged edge
      const x = cx + dx, y = cy + dy;
      if (x < 1 || y < 1 || x >= CONFIG.MAP_W - 1 || y >= CONFIG.MAP_H - 1) continue;
      if (Math.hypot(x - 64, y - 64) < clearR) continue;
      addOre(x, y, ORE.tileMax * (0.6 + Math.random() * 0.4));
    }
}

// Scatter a handful of ore patches ("crops") across the map, plus one starter
// patch close to the player's base so harvesting can begin right away.
function spawnOreFields() {
  state.ore = [];
  state.oreIndex = new Map();

  // Guaranteed starter patch, a short haul from the base (64,64).
  const ang = Math.random() * Math.PI * 2;
  addOreCluster(Math.round(64 + Math.cos(ang) * 15),
                Math.round(64 + Math.sin(ang) * 15),
                ORE.clusterR + 1, 9);

  // The rest, spread out and kept well away from the start.
  for (let i = 0; i < ORE.clusters; i++) {
    let cx, cy, tries = 0;
    do {
      cx = 12 + Math.floor(Math.random() * (CONFIG.MAP_W - 24));
      cy = 12 + Math.floor(Math.random() * (CONFIG.MAP_H - 24));
      tries++;
    } while (Math.hypot(cx - 64, cy - 64) < 30 && tries < 40);
    addOreCluster(cx, cy, ORE.clusterR + Math.floor(Math.random() * 3), 12);
  }
}

/* ------------------------------ QUERIES --------------------------------- */
function oreAmount(x, y) { const t = state.oreIndex.get(tileKey(x, y)); return t ? t.amount : 0; }
function hasAnyOre() { for (const t of state.ore) if (t.amount >= ORE.min) return true; return false; }

// Nearest worth-mining ore tile to a point, or null (used to find a fresh field
// when the current one is spent).
function nearestOreTileTo(cx, cy) {
  let best = null, bestD = Infinity;
  for (const t of state.ore) {
    if (t.amount < ORE.min) continue;
    const d = Math.hypot(t.x - cx, t.y - cy);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// The RICHEST ore tile within `radius` of a point (ties broken by nearer). This
// keeps a miner working the fullest tiles of its own patch instead of nibbling
// the thin, near-empty edges.
function richestOreTileNear(cx, cy, radius) {
  let best = null, bestAmt = ORE.min, bestD = Infinity;
  for (const t of state.ore) {
    if (t.amount < ORE.min) continue;
    const d = Math.hypot(t.x - cx, t.y - cy);
    if (d > radius) continue;
    if (t.amount > bestAmt || (t.amount === bestAmt && d < bestD)) {
      bestAmt = t.amount; bestD = d; best = t;
    }
  }
  return best;
}

// Nearest worth-mining ore tile within `radius` of a tile — used to resolve a
// player click onto a specific field.
function oreNear(gx, gy, radius) {
  let best = null, bestD = Infinity;
  for (const t of state.ore) {
    if (t.amount < ORE.min) continue;
    const d = Math.hypot(t.x - gx, t.y - gy);
    if (d <= radius && d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// The RICHEST worth-mining ore tile directly under the miner's footprint, or
// null. Footprint-only, so the miner must actually drive onto the patch to mine;
// once the tiles it covers drop below ORE.min it returns null, prompting a move
// to the next-richest tile instead of trickle-mining a near-empty one.
function oreUnderMiner(u) {
  const ax = Math.round(u.tx), ay = Math.round(u.ty);
  let best = null, bestAmt = ORE.min;
  for (let y = ay; y < ay + u.size; y++)
    for (let x = ax; x < ax + u.size; x++) {
      const t = state.oreIndex.get(tileKey(x, y));
      if (t && t.amount > bestAmt) { bestAmt = t.amount; best = t; }
    }
  return best;
}

// Nearest finished, alive refinery to a unit, or null.
function nearestRefinery(u) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings) {
    if (b.type !== "refinery" || !b.built || b.hp <= 0) continue;
    const d = u.distTo(b);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

/* ------------------------------- UPDATE --------------------------------- */
function updateHarvesters(dt) {
  // Ore slowly regrows toward each tile's cap.
  for (const t of state.ore)
    if (t.amount < t.max) t.amount = Math.min(t.max, t.amount + ORE.regenPerSec * dt);

  for (const u of state.units) {
    if (!u.isMiner || u.hp <= 0) continue;
    u.mining = false;

    // Manual: the player parked/moved this miner. It stays put (or finishes its
    // move) and does NOT auto-resume — the player re-starts it by clicking ore or
    // the refinery (see input.js). This lets it sit still to be repaired.
    if (u.minerJob === "manual") continue;

    u.forcedTarget = null; // workers don't hold attack orders

    const full = u.cargo >= u.cargoMax;

    // 1) Parked on ore (route finished) with room to spare? Scoop the richest
    //    tile under us. Gating on an empty path means we drive fully onto the
    //    patch before mining rather than freezing the moment we graze a tile.
    if (!full && u.path.length === 0) {
      const here = oreUnderMiner(u);
      if (here) {
        const want = Math.min(HARVEST.gatherPerSec * dt, u.cargoMax - u.cargo, here.amount);
        here.amount -= want;
        u.cargo += want;
        u.oreField = { x: here.x, y: here.y }; // remember this patch
        u.mining = want > 0;
        u.stop();
        u.commandedMove = false;
        continue;
      }
    }

    // 2) Full (or holding ore with none left anywhere): haul it to a refinery.
    if (full || (u.cargo > 0 && !hasAnyOre())) {
      const ref = nearestRefinery(u);
      if (!ref) { u.stop(); continue; }              // nowhere to sell — idle
      if (u.distTo(ref) <= (u.size + ref.size) / 2 + 1.2) {
        state.credits += Math.round(u.cargo);        // arrived: cash it in
        u.cargo = 0;
        u.stop();
      } else {
        const spot = u.besideTile(ref);
        u.moveTo(spot.x, spot.y);
        u.commandedMove = true;
      }
      continue;
    }

    // 3) Head for ore: prefer the RICHEST tile within its own patch (so it works
    //    the fullest ore, not the depleted edges) and only wander to a fresh
    //    field when the current patch is spent.
    let tile = u.oreField ? richestOreTileNear(u.oreField.x, u.oreField.y, ORE.workRadius) : null;
    if (!tile) tile = richestOreTileNear(u.centerX, u.centerY, ORE.workRadius);
    if (!tile) tile = nearestOreTileTo(u.centerX, u.centerY);
    if (!tile) { u.stop(); continue; }               // no ore anywhere — idle
    u.oreField = { x: tile.x, y: tile.y };
    u.moveTo(tile.x, tile.y);
    u.commandedMove = true;
  }
}
