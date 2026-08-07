"use strict";

/* =========================================================================
 * COMBAT — target acquisition, firing decisions, tower garrisons, and
 * removing the dead. The actual shooting lives in Unit.fireAt().
 * ========================================================================= */

// Spatial hash of live units, rebuilt each frame so target acquisition only
// checks nearby units instead of the whole army (O(n) instead of O(n²)).
const UNIT_CELL = 8; // tiles per bucket (≈ max view/range)
let unitGrid = new Map();
function buildUnitGrid() {
  unitGrid = new Map();
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    const k = ((u.tx / UNIT_CELL) | 0) + "," + ((u.ty / UNIT_CELL) | 0);
    let a = unitGrid.get(k);
    if (!a) unitGrid.set(k, a = []);
    a.push(u);
  }
}

// Nearest hostile within maxRange tiles, or null. Enemies also target buildings.
function nearestHostile(u, maxRange) {
  let best = null, bestD = Infinity;
  const r = Math.ceil(maxRange / UNIT_CELL);
  const bx = (u.tx / UNIT_CELL) | 0, by = (u.ty / UNIT_CELL) | 0;
  for (let gy = by - r; gy <= by + r; gy++) {
    for (let gx = bx - r; gx <= bx + r; gx++) {
      const arr = unitGrid.get(gx + "," + gy);
      if (!arr) continue;
      for (const o of arr) {
        if (o.team === u.team || o.hp <= 0) continue;
        const d = u.distTo(o);
        if (d <= maxRange && d < bestD) { bestD = d; best = o; }
      }
    }
  }
  if (u.team !== "player") { // buildings are few — a plain scan is fine
    for (const b of state.buildings) {
      if (b.hp <= 0) continue;
      const d = u.distTo(b);
      if (d <= maxRange && d < bestD) { bestD = d; best = b; }
    }
  }
  return best;
}

function updateCombat(dt) {
  buildUnitGrid(); // spatial index for this frame's target lookups
  for (const u of state.units) {
    u.aiming = false;
    if (u.muzzle > 0) u.muzzle -= dt;
    if (u.cooldown > 0) u.cooldown -= dt;
    if (u.levelFlash > 0) u.levelFlash -= dt;
    if (u.retaliateTimer > 0) { u.retaliateTimer -= dt; if (u.retaliateTimer <= 0) u.alerted = false; }
    if (u.disengageTimer > 0) u.disengageTimer -= dt;
    // Lv3 veterans self-heal.
    if (u.level >= 3 && u.hp < u.maxHp) {
      u.hp = Math.min(u.maxHp, u.hp + VETERANCY.regenPerSec * dt);
    }

    if (u.repairTarget || u.enterTarget) continue; // busy on a support/garrison order

    const provoked = u.retaliateTimer > 0 && u.retaliateTarget && u.retaliateTarget.hp > 0;

    // Pick a target: explicit attack order > the unit that just shot us > auto-acquire.
    let t = null;
    if (u.forcedTarget && u.forcedTarget.hp > 0) {
      t = u.forcedTarget;
    } else {
      u.forcedTarget = null;
      u.attackAngle = null;
      if (provoked) {
        t = u.retaliateTarget;      // return fire even if the attacker is beyond view
      } else {
        u.retaliateTarget = null;
        let a = u.target;
        // An enemy that just razed its building target breaks off and wanders
        // for a while instead of instantly locking the next structure.
        if (a && a.isBuilding && a.hp <= 0 && u.team !== "player" && u.behavior !== "advance") {
          u.disengageTimer = ENEMY_DISENGAGE;
          u.wanderTimer = 0; // pick a new roam spot right away
        }
        if (!a || a.hp <= 0 || a.team === u.team || u.distTo(a) > u.view) a = null;
        // While disengaged, don't hunt for a new target (still wanders below and
        // still returns fire via the provoked path if something shoots it).
        if (!a && !(u.team !== "player" && u.disengageTimer > 0)) a = nearestHostile(u, u.view);
        t = a;
      }
    }
    u.target = t;
    if (!t) {
      // No enemy in sight: resume a move order that combat interrupted, so units
      // finish travelling to where you sent them instead of stopping on a kill.
      if (u.moveGoal) {
        if (Math.round(u.tx) === u.moveGoal.x && Math.round(u.ty) === u.moveGoal.y) {
          u.moveGoal = null; // reached the ordered spot
        } else if (u.goalTx !== u.moveGoal.x || u.goalTy !== u.moveGoal.y) {
          u.moveTo(u.moveGoal.x, u.moveGoal.y); // was halted mid-move — carry on
          u.commandedMove = true;
        }
      }
      continue;
    }

    const d = u.distTo(t);
    // Can shoot only if in range AND nothing (wall/house) blocks the line.
    const canShoot = d <= u.weapon.range && hasLineOfSight(u, t);
    if (canShoot) {
      u.aiming = true;          // barrel tracks the target; movement won't override
      u.facing = u.angleTo(t);
      if (u.cooldown <= 0) u.fireAt(t);
    }

    if (u.forcedTarget) {
      if (canShoot) {
        u.stop();               // in range with a clear shot: freeze and fire
        u.commandedMove = false;
      } else {
        // Out of range or blocked: advance (pathing routes around walls/houses).
        const stand = u.attackStandTile(t);
        u.moveTo(stand.x, stand.y);
        u.commandedMove = true;
      }
    } else if (canShoot) {
      // Clear shot, no explicit order: stop and fire — even mid-move if we're
      // being shot at (return fire interrupts a plain move order).
      if (!u.commandedMove || provoked) u.stop();
    } else if (provoked && u.weapon.range > 0 && u.behavior !== "advance") {
      // Being shot but can't hit back yet: advance to close in / clear the line.
      // (Advancing wave enemies skip this — they keep pushing the base instead of
      // peeling off to chase a shooter, which is what left them stuck.)
      const stand = u.approachTile(t);
      u.moveTo(stand.x, stand.y);
      u.commandedMove = true;
    }
  }

  // Shared awareness: a unit that's engaging (or being shot by) an enemy rallies
  // nearby allies to that same enemy, so a whole group reacts instead of just
  // the one under fire. Allies are "provoked" (temporary) so they disengage
  // afterward rather than chasing forever.
  propagateAlerts();

  // Guard Towers fire with their garrison: OVER walls (no line-of-sight check —
  // they're elevated) at TOWER_RANGE_MULT × the garrisoned unit's range.
  for (const tower of state.buildings) {
    if (!tower.built || !tower.garrison || !tower.garrison.length) continue;
    for (const g of tower.garrison) {
      if (g.cooldown > 0) g.cooldown -= dt;
      const range = g.weapon.range * TOWER_RANGE_MULT;
      const t = nearestHostile(g, range);
      if (t && g.distTo(t) <= range) {   // no LOS check: elevated position
        g.facing = g.angleTo(t);
        if (g.cooldown <= 0) g.fireAt(t);
      }
    }
  }

  // Remove the dead.
  if (state.units.some(u => u.hp <= 0)) {
    state.units = state.units.filter(u => u.hp > 0);
  }
  if (state.buildings.some(b => b.hp <= 0)) {
    for (const b of state.buildings) if (b.hp <= 0) ejectGarrison(b); // survivors spill out
    state.buildings = state.buildings.filter(b => b.hp > 0);
    if (state.selectedBuilding && !state.buildings.includes(state.selectedBuilding)) {
      state.selectedBuilding = null;
    }
    rebuildBlocked(); // freed tiles become walkable again
  }
}

// When a unit is SHOT, rally the allies in the 3×3 of cells around it onto the
// attacker. Strictly one hop and strictly local: a unit that was only *alerted*
// (not actually shot) doesn't relay, so the alarm stops at the immediate
// neighbours instead of sweeping across the whole map.
function propagateAlerts() {
  for (const u of state.units) {
    if (u.alerted) continue;                                  // alerted-only -> don't relay
    const threat = u.retaliateTarget;
    if (!(u.retaliateTimer > 0 && threat && threat.hp > 0 && threat.team !== u.team)) continue;
    // The shot unit's footprint expanded by ALERT_CELLS in every direction.
    const ux = Math.round(u.tx), uy = Math.round(u.ty);
    const rx0 = ux - ALERT_CELLS, ry0 = uy - ALERT_CELLS;
    const rx1 = ux + u.size - 1 + ALERT_CELLS, ry1 = uy + u.size - 1 + ALERT_CELLS;
    for (const o of state.units) {
      if (o === u || o.team !== u.team) continue;
      if (!o.weapon || o.weapon.range <= 0) continue;         // non-combatants
      if (o.forcedTarget || o.retaliateTimer > 0) continue;   // busy / already engaged
      const ox = Math.round(o.tx), oy = Math.round(o.ty);
      if (ox + o.size - 1 < rx0 || ox > rx1 || oy + o.size - 1 < ry0 || oy > ry1) continue; // outside the 3×3
      o.retaliateTarget = threat;
      o.retaliateTimer = RETALIATE_TIME;
      o.alerted = true;                                       // marked so it won't relay onward
    }
  }
}

function updateEffects(dt) {
  for (const e of state.effects) e.life -= dt;
  if (state.effects.length) state.effects = state.effects.filter(e => e.life > 0);
}
