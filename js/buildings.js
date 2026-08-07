"use strict";

/* =========================================================================
 * BUILDINGS & ECONOMY — placement, construction, unit production, selling.
 * ========================================================================= */

// Anchor (top-left tile) for a w×h building centered on the cursor tile.
function cursorBuildAnchor(cx, cy, w, h) {
  const wp = screenToWorld(cx, cy);
  const t = worldToTile(wp.x, wp.y);
  return { ax: Math.round(t.tx) - (w >> 1), ay: Math.round(t.ty) - (h >> 1) };
}

// Why can't `type` be placed at (ax,ay)? Returns null when it CAN, otherwise a
// short player-facing reason. Keeping the reasons here (rather than a bare
// boolean) is what lets the placement ghost explain itself — "the ghost is red
// everywhere and I don't know why" is otherwise a dead end, especially for the
// Main House, which is legal only right next to an Engineer.
function placementReason(type, ax, ay, rot) {
  const { w, h } = buildingDims(type, rot);
  if (ax < 0 || ay < 0 || ax + w > CONFIG.MAP_W || ay + h > CONFIG.MAP_H) return "Off the map";
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      if (state.blocked.has(tileKey(ax + dx, ay + dy))) return "Blocked by a building";
  for (const u of state.units) {                 // don't bury a unit
    const ux = Math.round(u.tx), uy = Math.round(u.ty);
    if (ux + u.size > ax && ux < ax + w && uy + u.size > ay && uy < ay + h) return "A unit is in the way";
  }
  // The Main House founds/anchors a base, so it (and only it) needs an Engineer
  // nearby. Every other structure just has to sit within build radius of an
  // existing building — no Engineer required, even if yours has died.
  if (type === "main") {
    const cx = ax + w / 2, cy = ay + h / 2;
    for (const u of state.units) {
      if (u.team === "player" && u.type === "engineer" &&
          Math.hypot((u.tx + 0.5) - cx, (u.ty + 0.5) - cy) <= ECONOMY.buildRadius) return null;
    }
    return hasEngineer()
      ? "Move an Engineer here (build zone shown)"
      : "Needs an Engineer — train one at the Barracks";
  }
  for (const b of state.buildings) {
    if (rectGap(ax, ay, w, h, b.tx, b.ty, b.bw, b.bh) <= ECONOMY.buildRadius) return null;
  }
  return state.buildings.length ? "Too far from your base" : "Build a Main House first";
}

function placementValid(type, ax, ay, rot) {
  return placementReason(type, ax, ay, rot) === null;
}

// Tile-space centres of everything a new building of `type` may anchor to, for
// drawing the "you can build here" zone. Main House anchors to Engineers;
// everything else anchors to existing buildings.
function buildAnchors(type) {
  const out = [];
  if (type === "main") {
    for (const u of state.units)
      if (u.team === "player" && u.type === "engineer")
        out.push({ x: u.tx + 0.5, y: u.ty + 0.5, r: ECONOMY.buildRadius });
  } else {
    for (const b of state.buildings)
      out.push({ x: b.centerX, y: b.centerY, r: ECONOMY.buildRadius + Math.max(b.bw, b.bh) / 2 });
  }
  return out;
}

function placeBuilding(type, ax, ay, rot) {
  state.buildings.push(new Building(state.nextId++, type, ax, ay, rot));
  rebuildBlocked();
}

// Try to place the currently-selected building at the cursor. Cost is paid
// over time during construction, so we don't charge here.
function tryPlaceAtCursor(cx, cy) {
  const type = state.placing.type, rot = state.placing.rot || 0;
  const chainable = (type === "wall" || type === "gate");
  if (!chainable && constructingOfType(type)) return; // one of each at a time
  const { w, h } = buildingDims(type, rot);
  const { ax, ay } = cursorBuildAnchor(cx, cy, w, h);
  if (!placementValid(type, ax, ay, rot)) return;
  placeBuilding(type, ax, ay, rot);
  if (!chainable) state.placing = null; // keep placing walls/gates for chaining
}

// Credits returned when selling a building.
function sellRefund(b) { return Math.floor((b.cost || 0) * SELL_REFUND_RATE); }

// Sell a building for part of its cost (refunds credits, frees the tiles).
function sellBuilding(b) {
  state.credits += sellRefund(b);
  ejectGarrison(b); // any garrisoned troops spill out first
  state.buildings = state.buildings.filter(x => x !== b);
  if (state.selectedBuilding === b) state.selectedBuilding = null;
  rebuildBlocked();
}

// Fired the moment a building's construction finishes. A new Ore Refinery
// comes with one free Ore Miner so harvesting can start right away.
function onBuildingComplete(b) {
  if (b.type === "refinery") {
    const spot = freeTileAround(b, UNIT_TYPES.oreMiner.size);
    if (spot) spawnUnit(spot.x, spot.y, { type: "oreMiner" });
  }
}

/* --------------------------- PRODUCTION -------------------------------- */
// Queue a unit for training at its producer building.
function queueUnit(type) {
  const producer = UNIT_TYPES[type].producer;
  if (!producer || !producerOnline(producer)) return;  // no power = no training
  if (state.queues[producer].length >= queueMax(producer)) return; // scales with # of producers
  state.queues[producer].push(type);
}

// Cancel one queued unit of `type` (the most recently queued). If the cancelled
// one is currently building, refund the credits already spent on it.
function cancelUnit(producer, type) {
  const q = state.queues[producer];
  if (!q || !q.length) return false;
  for (let i = q.length - 1; i >= 0; i--) {
    if (q[i] !== type) continue;
    if (i === 0) { // the in-progress build: refund the partial paid so far
      state.credits += Math.floor((UNIT_TYPES[type].cost || 0) * state.progress[producer]);
      state.progress[producer] = 0;
    }
    q.splice(i, 1);
    return true;
  }
  return false;
}

// Cancel a building of `type` that's still under construction, refunding the
// credits paid into it so far (nothing is lost, but you don't get the building).
function cancelConstruction(type) {
  const b = state.buildings.find(x => x.type === type && !x.built);
  if (!b) return false;
  state.credits += Math.floor((b.cost || 0) * b.progress);
  state.buildings = state.buildings.filter(x => x !== b);
  if (state.selectedBuilding === b) state.selectedBuilding = null;
  rebuildBlocked();
  return true;
}

// Charge `rate = cost/time` credits per second and return the progress made
// this frame; free items advance purely by time; a broke player stalls.
function payProgress(cost, buildTime, dt) {
  // BUILD_SPEED shrinks the effective build time (faster), but total credits
  // spent stay the same because the per-second charge scales up to match.
  const t = buildTime / (CONFIG.BUILD_SPEED || 1);
  if (cost <= 0) return dt / t;
  const pay = Math.min((cost / t) * dt, state.credits);
  state.credits -= pay;
  return pay / cost;
}

// Advance building construction and every producer queue, spending credits.
function updateProduction(dt) {
  for (const b of state.buildings) {
    if (b.built) continue;
    b.progress = Math.min(1, b.progress + payProgress(b.cost, b.buildTime, dt));
    if (b.progress >= 1) { b.built = true; onBuildingComplete(b); }
  }

  for (const producer of Object.keys(state.queues)) {
    const q = state.queues[producer];
    // An unpowered producer holds its queue and its progress rather than
    // dropping them — the line resumes where it left off once power is back.
    if (q.length && !producerOnline(producer)) continue;
    if (q.length && hasBuiltProducer(producer)) {
      const def = UNIT_TYPES[q[0]];
      state.progress[producer] += payProgress(def.cost || 0, def.buildTime || 5, dt);
      if (state.progress[producer] >= 1) {
        if (spawnProducedUnit(q[0], producer)) {
          q.shift();
          state.progress[producer] = 0;
        } else {
          state.progress[producer] = 1; // done, but no room yet — wait for space
        }
      }
    } else {
      state.progress[producer] = 0;
    }
  }
}

// Spawn a finished unit on a free tile around its producer. Returns success.
function spawnProducedUnit(type, producer) {
  const bld = state.buildings.find(b => b.type === producer && b.built);
  if (!bld) return false;
  const size = UNIT_TYPES[type].size;
  const spot = freeTileAround(bld, size);
  if (!spot) return false;
  const u = spawnUnit(spot.x, spot.y, { type });
  if (bld.rally) {
    const dest = freeRallyTile(bld.rally.x, bld.rally.y, size);
    u.moveTo(dest.x, dest.y);
    u.commandedMove = true;
  }
  return true;
}

// Nearest free, walkable tile to a rally point that no other unit is already
// standing on or heading to — so units fan out around the flag instead of
// piling onto one square.
function freeRallyTile(rx, ry, size) {
  const occupied = new Set();
  for (const u of state.units) markFootprint(Math.round(u.goalTx), Math.round(u.goalTy), u.size, occupied);
  const ax0 = rx - (size >> 1), ay0 = ry - (size >> 1);
  const spot = spiralSearch(ax0, ay0, 0, 40, (ax, ay) =>
    (footprintFree(ax, ay, size, occupied) && walkable(ax, ay, size, true)) ? { x: ax, y: ay } : null);
  return spot || { x: rx, y: ry };
}
