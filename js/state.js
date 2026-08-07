"use strict";

/* =========================================================================
 * GAME STATE — pure data + queries. No canvas/DOM here on purpose, so this
 * (plus the update systems) could later run on a server.
 * ========================================================================= */

const state = {
  map: [],             // map[y][x] = terrain id
  units: [],
  buildings: [],
  effects: [],         // transient visuals (tracers)
  ore: [],             // ore field tiles: { x, y, amount, max }
  oreIndex: new Map(), // tileKey -> ore tile (fast lookup)
  blocked: new Set(),  // tile keys occupied by buildings (pathing obstacles)
  gateTiles: new Set(),// blocked tiles that friendly units may pass through
  credits: 0,
  placing: null,       // { type, rot } while choosing where to place a building
  settingRally: null,  // building whose rally point is being dragged
  queues: { barracks: [], garage: [] },   // per-producer training queues
  progress: { barracks: 0, garage: 0 },   // 0..1 progress on each queue's front
  selectedBuilding: null,
  nextId: 1,
  activeMode: null,    // the running game mode object (see gamemodes.js)
  modeData: null,      // per-mode runtime state (e.g. survival wave/timer)
  gameOver: false,
};

function buildMap() {
  for (let y = 0; y < CONFIG.MAP_H; y++) {
    const row = [];
    for (let x = 0; x < CONFIG.MAP_W; x++) {
      // Layered sine "noise" makes organic dirt patches instead of speckles.
      const v = Math.sin(x * 0.15) + Math.cos(y * 0.15)
              + Math.sin((x + y) * 0.08) * 1.4
              + Math.sin((x - y) * 0.11) * 0.8;
      row.push(v > 1.6 ? 1 : 0); // 1 = dirt, 0 = grass
    }
    state.map.push(row);
  }
}

/* ------------------------------ SPAWNING -------------------------------- */
function spawnUnit(tx, ty, opts = {}) {
  const u = new Unit(state.nextId++, tx, ty, opts);
  state.units.push(u);
  return u;
}

// Scatter enemies across the map, away from the player's start.
function spawnEnemies() {
  const count = 100;
  for (let i = 0; i < count; i++) {
    let tx, ty;
    do {
      tx = 5 + Math.floor(Math.random() * (CONFIG.MAP_W - 10));
      ty = 5 + Math.floor(Math.random() * (CONFIG.MAP_H - 10));
    } while (Math.hypot(tx - 64, ty - 64) < 10); // keep clear of the player
    spawnUnit(tx, ty, {
      team: "enemy",                    // blue by default (see Unit)
      type: Math.random() < 0.3 ? "vehicle" : "soldier",
      level: 1 + Math.floor(Math.random() * 3), // 1..3
      stationary: Math.random() < 0.4,  // ~40% just stand still
      wanderRadius: 3 + Math.floor(Math.random() * 4),
      wanderTimer: Math.random() * 4,   // desync their first move
    });
  }
}

/* ---------------------------- FOOTPRINTS -------------------------------- */
// Mark every tile a size×size footprint at (ax,ay) covers into `set`.
function markFootprint(ax, ay, size, set) {
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++)
      set.add(tileKey(ax + dx, ay + dy));
}

function markRect(ax, ay, w, h, set) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      set.add(tileKey(ax + dx, ay + dy));
}

// Can a size×size footprint sit at (ax,ay)? In bounds and no tile taken.
function footprintFree(ax, ay, size, occupied) {
  if (ax < 0 || ay < 0 || ax + size > CONFIG.MAP_W || ay + size > CONFIG.MAP_H) return false;
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++)
      if (occupied.has(tileKey(ax + dx, ay + dy))) return false;
  return true;
}

// Tiles that units are resting on / heading to (their full footprints).
function occupiedTiles(exclude) {
  const set = new Set();
  for (const u of state.units) {
    if (exclude && exclude.has(u)) continue;
    markFootprint(Math.round(u.targetTx), Math.round(u.targetTy), u.size, set);
  }
  return set;
}

// Does any unit's current tile overlap a size×size footprint at (ax,ay)?
function footprintHasUnit(ax, ay, size) {
  for (const u of state.units) {
    const ux = Math.round(u.tx), uy = Math.round(u.ty);
    if (ux + u.size > ax && ux < ax + size && uy + u.size > ay && uy < ay + size) return true;
  }
  return false;
}

// A free, walkable, unoccupied anchor for a `size` footprint just outside a
// building, or null.
function freeTileAround(b, size = 1) {
  const cx = b.tx + b.size / 2, cy = b.ty + b.size / 2;
  return spiralSearch(cx, cy, Math.ceil(b.size / 2), 15, (fx, fy) => {
    const x = Math.round(fx), y = Math.round(fy);
    if (walkable(x, y, size, true) && !footprintHasUnit(x, y, size)) return { x, y };
    return null;
  });
}

// Rebuild the pathing-obstacle sets from the current building list.
function rebuildBlocked() {
  state.blocked = new Set();
  state.gateTiles = new Set();
  for (const b of state.buildings) {
    markRect(b.tx, b.ty, b.bw, b.bh, state.blocked);
    if (b.gate) markRect(b.tx, b.ty, b.bw, b.bh, state.gateTiles); // friendlies pass
  }
}

/* ------------------------------ QUERIES --------------------------------- */
function powerBalance() {
  let produced = 0, consumed = 0;
  for (const b of state.buildings) {
    if (!b.built) continue; // no power until construction finishes
    if (b.power > 0) produced += b.power; else consumed += -b.power;
  }
  return { produced, consumed };
}
function isLowPower() { const p = powerBalance(); return p.consumed > p.produced; }

function hasEngineer() {
  return state.units.some(u => u.team === "player" && u.type === "engineer");
}

// Is there a built producer building of the given type ("barracks"/"garage")?
function hasBuiltProducer(ptype) {
  return state.buildings.some(b => b.type === ptype && b.built && b.hp > 0);
}

// Can a producer actually train right now? A Barracks/Garage that needs power
// goes dark when the grid is over-drawn, so unit production stops until you
// build a Power Plant (or sell something). Building CONSTRUCTION deliberately
// keeps working while unpowered — otherwise a brownout would be unrecoverable,
// since the Power Plant you need is itself a building.
function producerOnline(ptype) {
  if (!hasBuiltProducer(ptype)) return false;
  const def = BUILDING_TYPES[ptype];
  return !(def && def.needsPower && isLowPower());
}

// How many built, alive producers of a type exist.
function producerCount(ptype) {
  let n = 0;
  for (const b of state.buildings) if (b.type === ptype && b.built && b.hp > 0) n++;
  return n;
}

// Training-queue capacity for a producer type: QUEUE_MAX per building, so a
// second Barracks/Garage doubles it, a third triples it, and so on.
function queueMax(ptype) {
  return QUEUE_MAX * producerCount(ptype);
}

// Is there a finished, alive Ore Refinery? (Miners need one to sell into.)
function hasBuiltRefinery() {
  return state.buildings.some(b => b.type === "refinery" && b.built && b.hp > 0);
}

function constructingOfType(type) {
  return state.buildings.some(b => b.type === type && !b.built);
}

function selectedUnits() { return state.units.filter(u => u.selected); }

function deselectAll() {
  for (const u of state.units) u.selected = false;
  state.selectedBuilding = null;
}
