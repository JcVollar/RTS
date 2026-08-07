"use strict";

/* =========================================================================
 * SUPPORT — repair/heal orders (engineer, medic) and tower garrisons.
 * ========================================================================= */

// Nearest damaged friendly this healer/engineer can service, within reach.
// Medics find damaged infantry; engineers find damaged vehicles AND buildings
// (so an idle engineer near a hurt structure walks over and patches it up).
function nearestRepairTarget(u) {
  let best = null, bestD = Infinity;
  for (const o of state.units) {
    if (o === u || o.hp >= o.maxHp) continue;
    if (!u.canRepair(o)) continue;
    const d = u.distTo(o);
    if (d <= REPAIR_SEEK && d < bestD) { bestD = d; best = o; }
  }
  for (const b of state.buildings) {
    if (!b.built || b.hp >= b.maxHp) continue;
    if (!u.canRepair(b)) continue;
    const d = u.distTo(b);
    if (d <= REPAIR_SEEK + b.size / 2 && d < bestD) { bestD = d; best = b; } // allow for the footprint
  }
  return best;
}

// Engineers/medics repair; garrison-bound troops walk into their tower.
function updateSupport(dt) {
  const toGarrison = [];
  for (const u of state.units) {
    u.repairing = false;
    u.healingAura = false;

    // Heading into a Guard Tower.
    if (u.enterTarget) {
      const tw = u.enterTarget;
      if (!tw.tower || tw.hp <= 0 || !state.buildings.includes(tw) || tw.garrison.length >= tw.cap) {
        u.enterTarget = null;
      } else if (u.distTo(tw) <= (u.size + tw.size) / 2 + 1.0) {
        toGarrison.push([tw, u]);           // reached it — garrison after the loop
      } else {
        const spot = u.besideTile(tw);
        u.moveTo(spot.x, spot.y);
        u.commandedMove = true;
      }
      continue;
    }

    // Auto-acquire: an idle healer/engineer runs to the nearest wounded friendly
    // it can service. Skipped while under a manual move order or an explicit
    // attack order (forcedTarget), so player commands aren't overridden.
    if (u.repair && !u.repairTarget && !u.commandedMove && !u.forcedTarget) {
      u.repairTarget = nearestRepairTarget(u);
    }

    if (!u.repairTarget) continue;
    const t = u.repairTarget;
    const alive = t.hp > 0 && (t.isBuilding ? state.buildings.includes(t) : state.units.includes(t));
    if (!alive || t.hp >= t.maxHp) { u.repairTarget = null; continue; }

    const thresh = (u.size + t.size) / 2 + 0.7; // "beside" it
    if (u.distTo(t) <= thresh) {
      u.stop();
      u.facing = u.angleTo(t);
      u.repairing = true;
      t.hp = Math.min(t.maxHp, t.hp + u.repair.rate * dt);
    } else {
      const spot = u.besideTile(t);
      u.moveTo(spot.x, spot.y);
      u.commandedMove = true;
    }
  }
  for (const [tw, u] of toGarrison) garrisonUnit(tw, u); // remove from state.units safely
  updateHealAuras(dt);
}

// Buildings with a `heal` aura passively mend friendly units of the matching
// category within radius: Hospital → infantry, Garage → vehicles.
function updateHealAuras(dt) {
  for (const b of state.buildings) {
    if (!b.built || b.hp <= 0) continue;
    const aura = BUILDING_TYPES[b.type].heal;
    if (!aura) continue;
    const reach = aura.radius + b.size / 2; // measured from the building's edge
    for (const u of state.units) {
      if (u.team !== "player" || u.hp >= u.maxHp) continue;
      if (!aura.targets.includes(u.category)) continue;
      if (u.distTo(b) <= reach) {
        u.hp = Math.min(u.maxHp, u.hp + aura.rate * dt);
        u.healingAura = true;
      }
    }
  }
}

/* ------------------------------ GARRISON ------------------------------- */
// Move a unit into a tower (removed from the field, fires from the tower).
function garrisonUnit(tower, u) {
  if (tower.garrison.length >= tower.cap) return false;
  u.selected = false; u.forcedTarget = null; u.repairTarget = null; u.enterTarget = null;
  u.path = []; u.commandedMove = false; u.retaliateTimer = 0;
  const c = (tower.size - 1) / 2;
  u.tx = tower.tx + c; u.ty = tower.ty + c; // fire from the tower's center
  u.targetTx = u.tx; u.targetTy = u.ty; u.goalTx = u.tx; u.goalTy = u.ty;
  state.units = state.units.filter(x => x !== u);
  tower.garrison.push(u);
  return true;
}

// Spill a tower's garrison back onto the map (on destruction or sale).
function ejectGarrison(tower) {
  if (!tower.garrison) return;
  for (const g of tower.garrison) {
    const spot = freeTileAround(tower) || { x: tower.tx, y: tower.ty };
    g.tx = spot.x; g.ty = spot.y;
    g.targetTx = spot.x; g.targetTy = spot.y;
    g.goalTx = spot.x; g.goalTy = spot.y; g.path = [];
    g.enterTarget = null; g.commandedMove = false; // don't march back in
    state.units.push(g);
  }
  tower.garrison = [];
}
