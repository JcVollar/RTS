"use strict";

/* =========================================================================
 * CONFIG — every tuning knob in one place.
 * Add a new unit or building by copying an entry in UNIT_TYPES /
 * BUILDING_TYPES and putting its key into the matching *_MENU list.
 * ========================================================================= */

const CONFIG = {
  MAP_W: 160,          // tiles across   (RA2 maps top out ~ 200)
  MAP_H: 160,          // tiles down
  TILE_W: 64,          // iso tile width in px
  TILE_H: 32,          // iso tile height in px
  EDGE_PAN: 24,        // px from screen edge that triggers pan
  DRAG_PAN_SPEED: 6,   // right-drag: map slide speed per px of cursor offset
  PAN_SPEED: 900,      // px per second
  BUILD_SPEED: 3,      // construction/training speed multiplier (3 = 300%, same cost)
};

const HALF_W = CONFIG.TILE_W / 2;
const HALF_H = CONFIG.TILE_H / 2;

// Team colours for units drawn WITHOUT art. Sampled from the sprite sheets so a
// procedural body sits next to a sprite without a colour clash: the player's
// PixVoxel colour is color6 (blue), the enemy's is color7 (purple).
// Enemy always wins over a unit type's own colour — you must be able to tell
// sides apart at a glance. See js/sprites.js SPRITE_TEAM_COLOR.
const TEAM_COLORS = { player: "#2b49d7", enemy: "#723593" };

// Hit chance by skill level (editable). Lv1 rookie .. Lv3 veteran.
const ACCURACY = { 1: 0.25, 2: 0.50, 3: 0.70 };

// Veterancy (editable): total kills to reach Lv2 and Lv3, and the health a
// Lv3 veteran regenerates per second.
const VETERANCY = { kills: [2, 5], regenPerSec: 0.3 };

const RETALIATE_TIME = 4;   // seconds a unit stays provoked after being shot
const ALERT_CELLS = 1;      // a shot unit alerts allies within this many tiles (1 = the 3×3 around it)
const TOWER_RANGE_MULT = 1.2; // garrisoned tower shoots this × the unit's range (over walls; +20% for a soldier)
const REPAIR_SEEK = 8;      // tiles: how far an idle engineer/medic looks for something to fix/heal
const ENEMY_DISENGAGE = 6;  // seconds an enemy wanders off after leveling a building
const TRACER_LIFE = 0.08;   // seconds a bullet tracer stays visible
const QUEUE_MAX = 20;       // max units waiting in one producer queue
const SELL_REFUND_RATE = 0.5; // fraction of cost returned when selling

// Unit archetypes — the tuning table. Copy an entry, tweak the numbers, and
// you have a brand-new unit type; every value here is meant to be changed.
//   size     footprint in tiles (person 1 => 1x1, vehicle 2 => 2x2)
//   speed    move speed in tiles/sec (per-unit opts.speed can override)
//   radius   draw size in px
//   maxHp    health
//   view     detection range in tiles (how far it spots enemies)
//   armor    damage class the unit takes hits as ("flesh", "heavy", ...)
//   weapon.range      firing range in tiles
//   weapon.damage     base hp removed per shot that hits
//   weapon.burst      shots fired before reloading
//   weapon.fireDelay  seconds between shots within a burst
//   weapon.reload     seconds to wait after a burst
//   weapon.vs         damage multiplier by the target's armor class
const UNIT_TYPES = {
  soldier: {
    label: "Soldier", producer: "barracks",
    size: 1, speed: 1.6, radius: 11, maxHp: 60, view: 6, armor: "flesh",
    cost: 100, buildTime: 5,
    weapon: { range: 5, damage: 6, burst: 12, fireDelay: 0.09, reload: 1.3,
              vs: { flesh: 1.0, heavy: 0.4 } }, // rifles barely dent armor
  },
  seal: { // elite: ~25% more damage, tougher, and 10% faster than a soldier
    label: "Seal", producer: "barracks",
    size: 1, speed: 1.76, radius: 11, maxHp: 75, view: 7, armor: "flesh",
    cost: 200, buildTime: 8, color: "#94e2d5",
    weapon: { range: 6, damage: 8, burst: 12, fireDelay: 0.08, reload: 1.2,
              vs: { flesh: 1.0, heavy: 0.45 } },
  },
  engineer: { // enables construction; a poor fighter; repairs buildings & tanks
    label: "Engineer", producer: "barracks",
    size: 1, speed: 1.8, radius: 11, maxHp: 50, view: 4, armor: "flesh",
    cost: 100, buildTime: 5, color: "#fab387",
    weapon: { range: 3, damage: 2, burst: 3, fireDelay: 0.18, reload: 2.2,
              vs: { flesh: 0.6, heavy: 0.15 } },
    repair: { rate: 20, targets: ["building", "vehicle"] }, // hp/sec when adjacent
  },
  medic: { // heals infantry when standing beside them; also fights, weakly
    label: "Medic", producer: "barracks",
    size: 1, speed: 1.7, radius: 11, maxHp: 45, view: 5, armor: "flesh",
    cost: 150, buildTime: 6, color: "#f5c2e7",
    weapon: { range: 4, damage: 3, burst: 6, fireDelay: 0.12, reload: 1.6,
              vs: { flesh: 0.6, heavy: 0.15 } }, // half a rifleman's punch
    repair: { rate: 6, targets: ["infantry"] },
  },
  vehicle: {
    label: "Light Tank", producer: "garage",
    size: 2, speed: 3.2, radius: 18, maxHp: 220, view: 8, armor: "heavy",
    cost: 700, buildTime: 10,
    weapon: { range: 7, damage: 40, burst: 1, fireDelay: 0, reload: 4.5,
              vs: { flesh: 1.1, heavy: 2.0 },   // +10% vs people, brutal vs armor
              vsBuilding: 2, vsTower: 2 },      // ×2 vs any building, ×2 again vs Guard Towers
  },
  heavytank: { // Heavy Tank: 5× the cost & firepower of a Light Tank, but crawls at a soldier's pace
    label: "Heavy Tank", producer: "garage",
    size: 2, speed: 1.6, radius: 21, maxHp: 450, view: 8, armor: "heavy",
    cost: 3500, buildTime: 30, color: "#9399b2",
    weapon: { range: 7, damage: 200, burst: 1, fireDelay: 0, reload: 4.5,
              vs: { flesh: 1.1, heavy: 2.0 },
              vsBuilding: 2, vsTower: 2 },
  },
  oreMiner: { // gathers ore and hauls it back to a refinery for credits
    label: "Ore Miner", producer: "garage",
    size: 2, speed: 2.6, radius: 17, maxHp: 200, view: 5, armor: "heavy",
    cost: 500, buildTime: 8, color: "#e8c07d", cargo: 500, // credits per full load
    weapon: { range: 4, damage: 8, burst: 3, fireDelay: 0.12, reload: 2.2,
              vs: { flesh: 1.0, heavy: 0.3 } }, // light self-defense only
  },
};

// Units you can train, in menu order (each needs its producer building).
const UNIT_MENU = ["engineer", "soldier", "seal", "medic", "vehicle", "heavytank", "oreMiner"];

// Ore fields + harvesting tuning (editable).
//   tileMax      credits' worth an ore tile holds when full
//   regenPerSec  how fast each tile slowly regrows toward tileMax
//   clusters     number of ore patches scattered on the map
//   clusterR     rough radius (tiles) of each patch
//   gatherPerSec how fast a miner drains ore into its cargo
// min = tile treated as spent below this, so miners move on.
// workRadius = how far a miner looks for the RICHEST tile within its own patch
// before considering a different field.
const ORE = { tileMax: 400, regenPerSec: 2, clusters: 5, clusterR: 4, min: 4, workRadius: 9 };
const HARVEST = { gatherPerSec: 150 };

// Building archetypes (editable). size = footprint (NxN tiles). power > 0
// produces, < 0 consumes; needsPower buildings run "unpowered" during a deficit.
// cost is in credits. hp lets enemies destroy them.
const BUILDING_TYPES = {
  main:     { name: "Main House",  size: 3, hp: 1500, cost: 0,   power: 50,  needsPower: false, buildTime: 6, color: "#b4befe" },
  barracks: { name: "Barracks",    size: 2, hp: 800,  cost: 400, power: -40, needsPower: true,  buildTime: 4, color: "#f9e2af", produces: "infantry" },
  garage:   { name: "Garage",      size: 3, hp: 900,  cost: 600, power: -50, needsPower: true,  buildTime: 5, color: "#89b4fa", produces: "vehicle",
              heal: { rate: 5, radius: 5, targets: ["vehicle"] } },    // slowly repairs vehicles parked within 5 tiles
  refinery: { name: "Ore Refinery",size: 3, hp: 1000, cost: 800, power: -50, needsPower: true,  buildTime: 5, color: "#e8c07d" }, // drop-off point; spawns a free Ore Miner
  hospital: { name: "Hospital",    size: 2, hp: 700,  cost: 600, power: -30, needsPower: true,  buildTime: 4, color: "#f5c2e7",
              heal: { rate: 2.5, radius: 5, targets: ["infantry"] } }, // slowly heals infantry within 5 tiles
  power:    { name: "Power Plant", size: 2, hp: 600,  cost: 300, power: 100, needsPower: false, buildTime: 3, color: "#a6e3a1" },
  tower:    { name: "Guard Tower", size: 1, hp: 700,  cost: 500, power: -20, needsPower: true,  buildTime: 4, color: "#eba0ac", tower: true, cap: 5 }, // 1x1, tall
  gate:     { name: "Wall Gate",   size: 4, hp: 600,  cost: 150, power: 0,   needsPower: false, buildTime: 2, color: "#7f849c", gate: true }, // 4x1, rotatable, friendly units pass
  wall:     { name: "Wall",        size: 1, hp: 400,  cost: 25,  power: 0,   needsPower: false, buildTime: 1, color: "#9399b2" },
};

// Order shown in the right-hand build menu.
const BUILD_MENU = ["main", "barracks", "garage", "refinery", "hospital", "power", "tower", "gate", "wall"];

// Economy knobs. buildRadius = max tile gap a new building may sit from an
// existing one (must be within this many squares of the base).
const ECONOMY = { startCredits: 3000, buildRadius: 4 };

// Survival mode: a pool of enemies already roams the board; then timed waves
// march on the base from all four sides, growing each time. Clear every enemy
// after the final wave to WIN; lose if the Main House falls.
//   initialEnemies  roaming enemies present from the start
//   difficulty      global enemy DAMAGE multiplier (1.1 = enemies hit 10% harder)
//   armor           enemy damage-TAKEN multiplier (0.8 = 20% tougher / harder to kill)
//   waves           schedule of advancing waves: { at: seconds, perSide: N }
const SURVIVAL = {
  initialEnemies: 100,
  difficulty: 1.1,
  armor: 0.8,
  waves: [
    { at: 600,  perSide: 10 },   // 10 min: 10 from each side (40)
    { at: 900,  perSide: 20 },   // 15 min: 20 from each side (80)
    { at: 1200, perSide: 30 },   // 20 min: 30 from each side (120)
    { at: 1500, perSide: 50 },   // 25 min: 50 from each side (200)
  ],
};
