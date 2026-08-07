"use strict";

/* =========================================================================
 * GAMEMODES — pluggable game modes. Each mode owns its world setup, its
 * per-frame logic (e.g. wave spawning), a HUD line, and a lose condition.
 * Add a new mode by copying an entry and dropping its id into GAMEMODE_MENU.
 *
 * A mode is: {
 *   id, name, description,
 *   setup(),            // build the world (player loadout, enemies, buildings)
 *   update(dt),         // per-frame logic; skipped once the game is over
 *   isGameOver(),       // true when the run has ended
 *   hudLine(),          // short status string, or ""
 * }
 * ========================================================================= */

// The current player starting squad (shared by modes that want it).
function spawnPlayerSquad(cx, cy) {
  spawnUnit(cx + 3, cy + 1, { type: "vehicle", level: 2 });
  spawnUnit(cx + 3, cy + 2, { type: "soldier", level: 1 });
  spawnUnit(cx + 4, cy + 2, { type: "soldier", level: 1 });
  spawnUnit(cx + 2, cy + 4, { type: "engineer" });
}

/* --------------------------- SURVIVAL WAVES ----------------------------- */
// The roaming pool present from the start: scattered across the map, wandering.
function spawnRoamingEnemies(count) {
  for (let i = 0; i < count; i++) {
    let tx, ty, tries = 0;
    do {
      tx = 5 + Math.floor(Math.random() * (CONFIG.MAP_W - 10));
      ty = 5 + Math.floor(Math.random() * (CONFIG.MAP_H - 10));
      tries++;
    } while (Math.hypot(tx - 64, ty - 64) < 16 && tries < 30); // keep clear of the base
    const r = Math.random();
    const type = r < 0.2 ? "vehicle" : (r < 0.35 ? "seal" : "soldier");
    spawnUnit(tx, ty, {
      team: "enemy", type, level: 1 + Math.floor(Math.random() * 2),
      damageMult: SURVIVAL.difficulty, armorMult: SURVIVAL.armor,
      wanderRadius: 3 + Math.floor(Math.random() * 4), wanderTimer: Math.random() * 4,
    });
  }
}

// One wave enemy's type — later waves field more Seals and tanks.
function waveUnitType(waveIdx) {
  const tankChance = 0.08 + 0.05 * waveIdx;   // 0.08 → 0.23
  const sealChance = 0.15;
  const r = Math.random();
  if (r < tankChance) return "vehicle";
  if (r < tankChance + sealChance) return "seal";
  return "soldier";
}

// A walkable spawn anchor on a specific map edge (0=top,1=bottom,2=left,3=right).
function edgeSpawnTile(size, edge) {
  const W = CONFIG.MAP_W, H = CONFIG.MAP_H;
  for (let tries = 0; tries < 40; tries++) {
    let x, y;
    if (edge === 0)      { x = 1 + Math.floor(Math.random() * (W - 2 - size)); y = 1; }
    else if (edge === 1) { x = 1 + Math.floor(Math.random() * (W - 2 - size)); y = H - 2 - size; }
    else if (edge === 2) { x = 1; y = 1 + Math.floor(Math.random() * (H - 2 - size)); }
    else                 { x = W - 2 - size; y = 1 + Math.floor(Math.random() * (H - 2 - size)); }
    const spot = nearestWalkable(x, y, size, false);
    if (spot && !footprintHasUnit(spot.x, spot.y, size)) return spot;
  }
  return null;
}

// Spawn one advancing wave: `perSide` enemies from each of the four sides.
function spawnAdvanceWave(perSide, waveIdx) {
  const level = 1 + Math.floor(waveIdx / 2);
  for (let edge = 0; edge < 4; edge++) {
    for (let i = 0; i < perSide; i++) {
      const type = waveUnitType(waveIdx);
      const spot = edgeSpawnTile(UNIT_TYPES[type].size, edge);
      if (!spot) continue;
      spawnUnit(spot.x, spot.y, { team: "enemy", type, level, behavior: "advance",
        damageMult: SURVIVAL.difficulty, armorMult: SURVIVAL.armor });
    }
  }
}

/* ------------------------------ REGISTRY -------------------------------- */
const GAMEMODES = {
  survival: {
    id: "survival",
    name: "Survival",
    description: "100 enemies roam the map. Survive escalating waves, then wipe them all out to win.",
    setup() {
      // Pre-place a finished Main House as the objective, with a starting squad.
      placeBuilding("main", 63, 63, 0);
      const main = state.buildings[state.buildings.length - 1];
      main.built = true; main.progress = 1;
      spawnPlayerSquad(63, 63);
      spawnRoamingEnemies(SURVIVAL.initialEnemies); // already on the board
      state.modeData = { elapsed: 0, nextWave: 0 }; // nextWave = index into SURVIVAL.waves
    },
    update(dt) {
      const w = state.modeData;
      w.elapsed += dt;
      if (w.nextWave < SURVIVAL.waves.length && w.elapsed >= SURVIVAL.waves[w.nextWave].at) {
        const isFinal = w.nextWave === SURVIVAL.waves.length - 1;
        spawnAdvanceWave(SURVIVAL.waves[w.nextWave].perSide, w.nextWave);
        w.nextWave++;
        // Final wave: every remaining enemy (roamers, stragglers) marches on the
        // Main House too — so you defend one spot instead of hunting them down.
        if (isFinal) {
          for (const u of state.units) {
            if (u.team !== "enemy") continue;
            u.behavior = "advance";
            u.advanceTarget = null;
            u.stationary = false;
            u.repathTimer = 0;
          }
        }
      }
    },
    // Lose if the Main House is gone.
    isGameOver() {
      return !state.buildings.some(b => b.type === "main" && b.hp > 0);
    },
    // Win once the final wave is out and every enemy is dead.
    isWin() {
      const w = state.modeData;
      return w && w.nextWave >= SURVIVAL.waves.length &&
             !state.units.some(u => u.team === "enemy");
    },
    hudLine() {
      const w = state.modeData;
      if (!w) return "";
      const enemies = state.units.filter(u => u.team === "enemy").length;
      if (w.nextWave >= SURVIVAL.waves.length) {
        return `Final wave out · ${enemies} enemies left · ${fmtTime(w.elapsed)}`;
      }
      const next = SURVIVAL.waves[w.nextWave];
      return `Wave ${w.nextWave + 1} in ${fmtTime(next.at - w.elapsed)} · ${enemies} enemies · ${fmtTime(w.elapsed)}`;
    },
  },

  skirmish: {
    id: "skirmish",
    name: "Skirmish",
    description: "Open sandbox: 100 enemies scattered across the map. Build and conquer.",
    setup() {
      spawnPlayerSquad(61, 61);
      spawnEnemies();
    },
    update(dt) {},
    isGameOver() { return false; },
    hudLine() { return ""; },
  },
};

// Order the modes appear in the start menu.
const GAMEMODE_MENU = ["survival", "skirmish"];
