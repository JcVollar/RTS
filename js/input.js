"use strict";

/* =========================================================================
 * INPUT — mouse + keyboard handling, selection, and issuing orders.
 * ========================================================================= */

const input = {
  mouse: { x: 0, y: 0 },
  keys: new Set(),
  dragging: false,               // left-button box select
  dragStart: { x: 0, y: 0 },     // screen space
  dragEnd: { x: 0, y: 0 },
  panning: false,                // right-button map drag
  panStart: { x: 0, y: 0, camX: 0, camY: 0 },
};

const controlGroups = {}; // "0".."9" -> array of unit refs

canvas.addEventListener("contextmenu", e => e.preventDefault());

canvas.addEventListener("mousemove", e => {
  input.mouse.x = e.clientX;
  input.mouse.y = e.clientY;
  if (input.dragging) { input.dragEnd.x = e.clientX; input.dragEnd.y = e.clientY; }
});

// Order the current selection to attack an enemy under (cx,cy), else move
// there. Returns false if nothing is selected. Left-click uses this.
function commandSelected(cx, cy) {
  const selected = selectedUnits();
  if (!selected.length) return false;
  for (const u of selected) { u.repairTarget = null; u.enterTarget = null; } // cancel repair/garrison

  const enemy = enemyAt(cx, cy);
  if (enemy) {
    // Miners are workers — leave them harvesting; only fighters get the order.
    assignAttackArc(selected.filter(u => !u.isMiner && u.weapon.range > 0), enemy);
    return true;
  }

  const w = screenToWorld(cx, cy);
  const t = worldToTile(w.x, w.y);
  const gx = clamp(Math.round(t.tx), 0, CONFIG.MAP_W - 1);
  const gy = clamp(Math.round(t.ty), 0, CONFIG.MAP_H - 1);

  const miners = selected.filter(u => u.isMiner);
  const others = selected.filter(u => !u.isMiner);

  // Ore Miners: clicking on (or next to) an ore patch resumes auto-harvest at
  // that field; clicking elsewhere is a manual move that STAYS parked (so you
  // can walk it to an Engineer for repairs) until you send it back to work.
  if (miners.length) {
    const ore = oreNear(gx, gy, 2);
    if (ore) {
      for (const u of miners) {
        u.forcedTarget = null;
        u.minerJob = "auto";
        u.oreField = { x: ore.x, y: ore.y };
        u.commandedMove = false; // let the harvest loop path there
        u.moveGoal = null;
      }
    } else {
      for (const u of miners) { u.forcedTarget = null; u.minerJob = "manual"; }
      assignGroupMove(miners, gx, gy);
    }
  }

  if (others.length) {
    for (const u of others) u.forcedTarget = null;  // plain move cancels attack
    assignGroupMove(others, gx, gy);
  }
  return true;
}

canvas.addEventListener("mousedown", e => {
  // Building placement mode intercepts clicks.
  if (state.placing) {
    if (e.button === 0) tryPlaceAtCursor(e.clientX, e.clientY);
    else if (e.button === 2) state.placing = null; // right-click cancels
    return;
  }

  if (e.button === 0) {
    // Left button: begin a potential select / box-select. The actual action is
    // decided on mouseup (click vs drag).
    input.dragging = true;
    input.dragStart.x = e.clientX; input.dragStart.y = e.clientY;
    input.dragEnd.x = e.clientX;   input.dragEnd.y = e.clientY;
  } else if (e.button === 2) {
    // Right-drag from a selected producer (Barracks/Garage) sets its rally point.
    const sb = state.selectedBuilding;
    if (sb && sb.produces && buildingAt(e.clientX, e.clientY) === sb) {
      state.settingRally = sb;
      return;
    }
    // Otherwise: begin dragging the map.
    input.panning = true;
    input.panStart.x = e.clientX;
    input.panStart.y = e.clientY;
    input.panStart.camX = camera.x;
    input.panStart.camY = camera.y;
  }
});

canvas.addEventListener("mouseup", e => {
  if (e.button === 2) {
    if (state.settingRally) { // finish setting a Barracks rally point
      const b = state.settingRally;
      state.settingRally = null;
      const w = screenToWorld(e.clientX, e.clientY);
      const t = worldToTile(w.x, w.y);
      b.rally = { x: clamp(Math.round(t.tx), 0, CONFIG.MAP_W - 1),
                  y: clamp(Math.round(t.ty), 0, CONFIG.MAP_H - 1) };
      return;
    }
    const wasPanning = input.panning;
    input.panning = false;
    if (!wasPanning) return; // press was consumed elsewhere (e.g. placement cancel)
    // A right-click that didn't drag the map = deselect everything.
    const moved = Math.hypot(e.clientX - input.panStart.x, e.clientY - input.panStart.y);
    if (moved < 5) deselectAll();
    return;
  }
  if (e.button !== 0 || !input.dragging) return;
  input.dragging = false;

  const dxScreen = Math.abs(input.dragEnd.x - input.dragStart.x);
  const dyScreen = Math.abs(input.dragEnd.y - input.dragStart.y);
  const isBox = dxScreen > 5 || dyScreen > 5;

  if (isBox) {
    // Box select: any player unit whose screen position falls in the rectangle.
    const x1 = Math.min(input.dragStart.x, input.dragEnd.x);
    const x2 = Math.max(input.dragStart.x, input.dragEnd.x);
    const y1 = Math.min(input.dragStart.y, input.dragEnd.y);
    const y2 = Math.max(input.dragStart.y, input.dragEnd.y);
    state.selectedBuilding = null;
    for (const u of state.units) {
      if (u.team !== "player") continue; // enemies aren't selectable
      const s = unitScreen(u);
      u.selected = s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2;
    }
    return;
  }

  // Repair/heal order: selected healers clicked on a DAMAGED friendly target.
  // (An undamaged target falls through to normal selection, so clicking a
  // healthy tank while a medic/engineer is selected still just selects it.)
  const healers = state.units.filter(u => u.selected && u.repair);
  if (healers.length) {
    const tgt = friendlyUnitAt(e.clientX, e.clientY) || buildingAt(e.clientX, e.clientY);
    if (tgt && tgt.hp < tgt.maxHp) {
      let any = false;
      for (const h of healers) if (h.canRepair(tgt)) { h.repairTarget = tgt; h.forcedTarget = null; h.moveGoal = null; any = true; }
      if (any) return;
    }
  }

  // Garrison order: selected infantry clicked on a friendly Guard Tower —
  // they walk over and enter when they reach it (see updateSupport).
  const clickedB = buildingAt(e.clientX, e.clientY);
  if (clickedB && clickedB.tower && clickedB.built && clickedB.team === "player") {
    const troops = state.units.filter(u => u.selected && u.canGarrison);
    if (troops.length) {
      for (const u of troops) {
        u.enterTarget = clickedB; u.repairTarget = null; u.forcedTarget = null; u.moveGoal = null;
      }
      return;
    }
  }

  // Single left-click. Clicking a player unit selects it (front-most wins)...
  const picked = unitAt(e.clientX, e.clientY, "player");
  if (picked) {
    state.selectedBuilding = null;
    for (const u of state.units) u.selected = (u === picked);
    return;
  }

  // ...else a friendly building. If Ore Miners are selected and you click the
  // Refinery, send them back to auto-harvesting instead of selecting it.
  const b = buildingAt(e.clientX, e.clientY);
  if (b && b.team === "player") {
    const miners = state.units.filter(u => u.selected && u.isMiner);
    if (miners.length && b.type === "refinery") {
      for (const u of miners) { u.minerJob = "auto"; u.oreField = null; u.forcedTarget = null; u.commandedMove = false; u.moveGoal = null; }
      return;
    }
    for (const u of state.units) u.selected = false;
    state.selectedBuilding = b;
    return;
  }

  // ...otherwise, command the selection (move/attack), or clear if none.
  state.selectedBuilding = null;
  if (!commandSelected(e.clientX, e.clientY)) {
    for (const u of state.units) u.selected = false;
  }
});

// Double-click a unit: select every unit of that type. On-screen only by
// default (the RTS convention — you grab the squad you're looking at); hold
// Shift to take every one of them on the whole map.
canvas.addEventListener("dblclick", e => {
  if (state.placing) return;
  const picked = unitAt(e.clientX, e.clientY, "player");
  if (!picked) return;
  state.selectedBuilding = null;
  const onScreen = u => {
    const s = unitScreen(u);
    return s.x >= 0 && s.x <= canvas.width && s.y >= 0 && s.y <= canvas.height;
  };
  for (const u of state.units) {
    u.selected = u.team === "player" && u.type === picked.type &&
                 (e.shiftKey || onScreen(u));
  }
  picked.selected = true;   // always include the one actually clicked
});

// If the cursor leaves the canvas, stop any in-progress map drag.
canvas.addEventListener("mouseleave", () => { input.panning = false; });

window.addEventListener("keydown", e => {
  input.keys.add(e.key.toLowerCase());
  if (e.key === "Escape") { state.placing = null; state.selectedBuilding = null; return; }

  // "?" toggles the controls/help list in the top-left box.
  if (e.key === "?") {
    const help = document.getElementById("help");
    if (help) help.classList.toggle("show");
    return;
  }

  // Space rotates a rotatable building (the gate) while placing.
  if (e.key === " " && state.placing && BUILDING_TYPES[state.placing.type].gate) {
    e.preventDefault();
    state.placing.rot = ((state.placing.rot || 0) + 1) % 2;
    return;
  }

  // Ctrl+H: snap the camera back to the Main House.
  if (e.ctrlKey && e.key.toLowerCase() === "h") {
    e.preventDefault();
    const main = state.buildings.find(b => b.type === "main");
    if (main) centerCameraOn(main.centerX, main.centerY);
    return;
  }

  // Ctrl+0..9 assigns the selection to a control group; 0..9 alone reselects it.
  if (/^[0-9]$/.test(e.key)) {
    if (e.ctrlKey) {
      e.preventDefault();
      controlGroups[e.key] = selectedUnits();
    } else {
      const g = (controlGroups[e.key] || []).filter(u => u.hp > 0 && state.units.includes(u));
      controlGroups[e.key] = g;
      state.selectedBuilding = null;
      for (const u of state.units) u.selected = false;
      for (const u of g) u.selected = true;
    }
  }
});
window.addEventListener("keyup", e => input.keys.delete(e.key.toLowerCase()));
