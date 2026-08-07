"use strict";

/* =========================================================================
 * RENDER — everything drawn to the canvas: terrain cache, units, buildings,
 * effects, and overlays. No game logic here.
 * ========================================================================= */

let hoveredUnit = null;

/* --------------------------- SHARED SHAPES ------------------------------ */
function diamondPath(c, sx, sy, hw, hh) {
  c.beginPath();
  c.moveTo(sx, sy - hh);
  c.lineTo(sx + hw, sy);
  c.lineTo(sx, sy + hh);
  c.lineTo(sx - hw, sy);
  c.closePath();
}

// Highlight a single map tile (used for cursor + unit-footprint hovering).
function drawTileHighlight(gx, gy, fill, stroke) {
  if (gx < 0 || gy < 0 || gx >= CONFIG.MAP_W || gy >= CONFIG.MAP_H) return;
  const s = gridPt(gx, gy);
  diamondPath(ctx, s.x, s.y, HALF_W, HALF_H);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineWidth = 1;
}

// Health-bar color by remaining fraction.
function hpColor(frac) {
  return frac > 0.5 ? "#a6e3a1" : frac > 0.25 ? "#f9e2af" : "#f38ba8";
}

// A small centered text label with a dark backing plate (used for building
// name tags until real sprites replace the placeholder blocks).
function drawLabel(cx, baselineY, text, color) {
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(10,12,18,0.72)";
  ctx.fillRect(cx - w / 2 - 4, baselineY - 11, w + 8, 15);
  ctx.fillStyle = color;
  ctx.fillText(text, cx, baselineY);
  ctx.textAlign = "left";
}

// A framed progress/health bar (shared by units and buildings).
function drawBar(x, y, w, h, frac, color) {
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * frac, h);
}

/* ------------------------------ TERRAIN --------------------------------- */
const GRASS = ["#3f6b3a", "#457a3e", "#39602f", "#4c7d42", "#436e37"];

// One terrain tile with baked-in detail (drawn once into the map cache).
function drawTile(c, sx, sy, terrain, gx, gy) {
  const r0 = rand2(gx, gy, 1);

  // Base fill
  const base = terrain === 1
    ? shade("#6f5c3e", (r0 - 0.5) * 0.22)       // dirt
    : GRASS[(r0 * GRASS.length) | 0];           // grass
  diamondPath(c, sx, sy, HALF_W, HALF_H);
  c.fillStyle = base;
  c.fill();

  // Soft edge: faint dark seam so the grid reads subtly.
  c.strokeStyle = "rgba(0,0,0,0.10)";
  c.lineWidth = 1;
  c.stroke();

  // Scattered decoration
  const d = rand2(gx, gy, 7);
  const jx = (rand2(gx, gy, 3) - 0.5) * HALF_W;
  const jy = (rand2(gx, gy, 5) - 0.5) * HALF_H;

  if (terrain === 1) {
    // Dirt: a couple of pebbles
    if (d > 0.55) {
      for (let i = 0; i < 3; i++) {
        const px = sx + jx + (rand2(gx + i, gy, 9) - 0.5) * 20;
        const py = sy + jy + (rand2(gx, gy + i, 9) - 0.5) * 10;
        c.beginPath();
        c.ellipse(px, py, 2.2, 1.4, 0, 0, Math.PI * 2);
        c.fillStyle = shade("#6f5c3e", -0.25);
        c.fill();
      }
    }
  } else if (d > 0.9) {
    // Rock
    c.beginPath();
    c.ellipse(sx + jx, sy + jy, 4.5, 3, 0, 0, Math.PI * 2);
    c.fillStyle = "#7a7d85"; c.fill();
    c.beginPath();
    c.ellipse(sx + jx - 1, sy + jy - 1, 2, 1.3, 0, 0, Math.PI * 2);
    c.fillStyle = "#9aa0aa"; c.fill();
  } else if (d > 0.78) {
    // Tiny flower
    c.fillStyle = ["#f9e2af", "#f38ba8", "#cba6f7"][(rand2(gx, gy, 11) * 3) | 0];
    c.beginPath();
    c.arc(sx + jx, sy + jy - 2, 1.8, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = shade(base, -0.15);
    c.beginPath(); c.moveTo(sx + jx, sy + jy); c.lineTo(sx + jx, sy + jy - 2); c.stroke();
  } else if (d > 0.5) {
    // Grass tufts
    c.strokeStyle = shade(base, 0.18);
    c.lineWidth = 1;
    for (let i = -1; i <= 1; i++) {
      c.beginPath();
      c.moveTo(sx + jx + i * 2.5, sy + jy + 1);
      c.lineTo(sx + jx + i * 2.5 + i, sy + jy - 3);
      c.stroke();
    }
  }
}

/* -------------------- TERRAIN CACHE (offscreen) ------------------------
 * The map is static, so render every tile ONCE into an offscreen canvas.
 * Each frame we blit just the visible slice with a single drawImage call
 * instead of re-stroking thousands of diamonds. This is the main perf win.
 * --------------------------------------------------------------------- */
let mapCanvas = null;
let mapOffX = 0, mapOffY = 0; // world-space -> offscreen-canvas pixel offset

function prerenderMap() {
  const b = computeWorldBounds();
  mapOffX = -b.minX;
  mapOffY = -b.minY;
  mapCanvas = document.createElement("canvas");
  mapCanvas.width = Math.ceil(b.maxX - b.minX);
  mapCanvas.height = Math.ceil(b.maxY - b.minY);
  const mctx = mapCanvas.getContext("2d");
  for (let y = 0; y < CONFIG.MAP_H; y++) {
    for (let x = 0; x < CONFIG.MAP_W; x++) {
      const w = tileToWorld(x, y);
      drawTile(mctx, w.x + mapOffX, w.y + mapOffY, state.map[y][x], x, y);
    }
  }
}

// Blit the visible region of the cached map, clamped to the buffer bounds.
function blitMap() {
  let sx = camera.x + mapOffX;
  let sy = camera.y + mapOffY;
  let sw = canvas.width, sh = canvas.height;
  let dx = 0, dy = 0;
  if (sx < 0) { dx = -sx; sw += sx; sx = 0; }
  if (sy < 0) { dy = -sy; sh += sy; sy = 0; }
  if (sx + sw > mapCanvas.width)  sw = mapCanvas.width - sx;
  if (sy + sh > mapCanvas.height) sh = mapCanvas.height - sy;
  if (sw > 0 && sh > 0) {
    ctx.drawImage(mapCanvas, sx, sy, sw, sh, dx, dy, sw, sh);
  }
}

/* -------------------------------- ORE ----------------------------------- */
// Glittering ore tiles, drawn live each frame (they deplete/regrow, so they
// can't be baked into the static terrain cache). Brighter = more ore left.
function drawOre() {
  for (const t of state.ore) {
    if (t.amount <= 0) continue;
    const s = gridPt(t.x, t.y);
    if (s.x < -HALF_W || s.x > canvas.width + HALF_W ||
        s.y < -HALF_H || s.y > canvas.height + HALF_H) continue; // off-screen
    const f = t.amount / t.max;
    diamondPath(ctx, s.x, s.y, HALF_W * 0.94, HALF_H * 0.94);
    ctx.fillStyle = shade("#c9962f", (f - 0.5) * 0.5);
    ctx.globalAlpha = 0.4 + 0.5 * f;
    ctx.fill();
    ctx.globalAlpha = 1;
    // A couple of stable "nuggets" that fade as the tile is mined out.
    const n = 1 + Math.round(f * 2);
    ctx.fillStyle = "#f4d67a";
    for (let i = 0; i < n; i++) {
      const px = s.x + (rand2(t.x, t.y, i + 1) - 0.5) * HALF_W;
      const py = s.y + (rand2(t.x, t.y, i + 5) - 0.5) * HALF_H;
      ctx.beginPath();
      ctx.arc(px, py, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ------------------------------- UNITS ---------------------------------- */
// An isometric box: top diamond face + left/right side faces of height h.
function drawIsoCube(c, cx, cyTop, hw, hh, h, topCol, leftCol, rightCol) {
  const Tx = cx, Ty = cyTop - hh;
  const Rx = cx + hw, Ry = cyTop;
  const Bx = cx, By = cyTop + hh;
  const Lx = cx - hw, Ly = cyTop;

  // Right side
  c.beginPath();
  c.moveTo(Rx, Ry); c.lineTo(Bx, By); c.lineTo(Bx, By + h); c.lineTo(Rx, Ry + h); c.closePath();
  c.fillStyle = rightCol; c.fill();
  // Left side
  c.beginPath();
  c.moveTo(Lx, Ly); c.lineTo(Bx, By); c.lineTo(Bx, By + h); c.lineTo(Lx, Ly + h); c.closePath();
  c.fillStyle = leftCol; c.fill();
  // Top
  c.beginPath();
  c.moveTo(Tx, Ty); c.lineTo(Rx, Ry); c.lineTo(Bx, By); c.lineTo(Lx, Ly); c.closePath();
  c.fillStyle = topCol; c.fill();
  c.strokeStyle = "rgba(0,0,0,0.35)"; c.lineWidth = 1; c.stroke();
}

// A tank: 3D hull + turret + a barrel that points where it's heading.
function drawVehicleBody(s, R, col, facing) {
  const height = R * 0.7;
  const topY = s.y - height;
  drawIsoCube(ctx, s.x, topY, R * 1.2, R * 0.6, height,
    shade(col, 0.05), shade(col, -0.38), shade(col, -0.22));

  const tR = R * 0.62;
  ctx.beginPath();
  ctx.arc(s.x, topY, tR, 0, Math.PI * 2);
  ctx.fillStyle = shade(col, 0.2);
  ctx.fill();
  ctx.strokeStyle = shade(col, -0.45);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const bl = R * 1.5;
  ctx.strokeStyle = shade(col, -0.3);
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s.x, topY);
  ctx.lineTo(s.x + Math.cos(facing) * bl, topY + Math.sin(facing) * bl * 0.6);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.lineCap = "butt";
}

// A little figure: torso + head, team-colored.
function drawPersonBody(s, R, col) {
  ctx.beginPath();
  ctx.ellipse(s.x, s.y - R * 0.75, R * 0.55, R * 0.95, 0, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.strokeStyle = shade(col, -0.45);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Highlight for a bit of volume
  ctx.beginPath();
  ctx.ellipse(s.x - R * 0.15, s.y - R * 0.95, R * 0.18, R * 0.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = shade(col, 0.28);
  ctx.fill();

  // Head
  ctx.beginPath();
  ctx.arc(s.x, s.y - R * 1.8, R * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = shade(col, 0.15);
  ctx.fill();
  ctx.strokeStyle = shade(col, -0.45);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawUnit(u) {
  const s = unitScreen(u);
  const R = u.radius;
  const col = u.color;
  const sprited = unitHasSprite(u);

  // Ground shadow — skipped for sprited units, whose art has one baked in
  // (drawing both gave every soldier a doubled, offset shadow).
  if (!sprited) {
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + 3, R * 1.15, R * 0.55, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fill();
  }

  // Selection: green targeting ring on the ground (drawn under the unit).
  if (u.selected) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#a6e3a1";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + 3, R * 1.55, R * 0.78, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  // Hover: white ring normally, red when it's an enemy you could attack.
  if (u === hoveredUnit) {
    const attackable = u.team === "enemy" && state.units.some(x => x.selected);
    ctx.strokeStyle = attackable ? "rgba(243,139,168,0.95)" : "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + 3, R * 1.55, R * 0.78, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Promotion pulse: an expanding, fading gold ring when just leveled up.
  if (u.levelFlash > 0) {
    const p = 1 - u.levelFlash / 0.6; // 0 -> 1 over the flash
    ctx.strokeStyle = `rgba(249,226,175,${1 - p})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + 3, R * (1.4 + p * 1.4), R * (0.7 + p * 0.7), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Image sprite if this unit type has art loaded, else the procedural body.
  const usedSprite = drawUnitSprite(u);
  if (!usedSprite) {
    if (u.size >= 2) drawVehicleBody(s, R, col, u.facing);
    else drawPersonBody(s, R, col);
  }

  // Muzzle flash at the gun tip while firing (also over sprites, which use the
  // idle frames rather than a separate attack animation for now). Sprites are
  // roughly twice the height of a procedural body, so they get their own gun
  // point instead of one derived from the collision radius.
  if (u.muzzle > 0) {
    let fx, fy;
    if (usedSprite) {
      const p = spriteGunPoint(u, s);
      fx = p.x; fy = p.y;
    } else {
      const gunLen = u.size >= 2 ? R * 1.5 : R * 0.9;
      fx = s.x + Math.cos(u.facing) * gunLen;
      fy = (s.y - R * 0.7) + Math.sin(u.facing) * gunLen * 0.6;
    }
    ctx.beginPath();
    ctx.arc(fx, fy, R * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = "#ffe08a";
    ctx.fill();
  }

  // Health bar (only when selected or damaged)
  const barY = s.y - R * 2.5;
  if (u.selected || u.hp < u.maxHp) {
    const bw = R * 2.2;
    const frac = Math.max(0, u.hp / u.maxHp);
    drawBar(s.x - bw / 2, barY, bw, 4, frac, hpColor(frac));
  }

  // Ore Miner cargo bar (gold), just under the health bar when carrying.
  if (u.isMiner && u.cargo > 0) {
    const bw = R * 2.2;
    drawBar(s.x - bw / 2, barY + 6, bw, 3, u.cargo / u.cargoMax, "#e8c07d");
  }

  // Heal-aura marker: a green "+" floating over a unit being mended by a Hospital/Garage.
  if (u.healingAura) {
    const hy = s.y - R * 3.2;
    ctx.strokeStyle = "#a6e3a1";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.x - 3, hy); ctx.lineTo(s.x + 3, hy);
    ctx.moveTo(s.x, hy - 3); ctx.lineTo(s.x, hy + 3);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Rank pips: one gold chevron per level, just above the health bar.
  for (let i = 0; i < u.level; i++) {
    const px = s.x - (u.level - 1) * 3 + i * 6;
    const py = barY - 6;
    ctx.beginPath();
    ctx.moveTo(px - 2.5, py + 2);
    ctx.lineTo(px, py - 2);
    ctx.lineTo(px + 2.5, py + 2);
    ctx.strokeStyle = "#f9e2af";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

/* ----------------------------- BUILDINGS -------------------------------- */
// Draw a building as a chunky iso block over its (possibly non-square) footprint.
function drawBuilding(b, ghost) {
  const W = b.bw, H = b.bh;
  const s = gridPt(b.tx + (W - 1) / 2, b.ty + (H - 1) / 2); // footprint center
  const height = buildingHeight(b);
  const constructing = !ghost && !b.built;
  const unpowered = !ghost && b.built && b.needsPower && isLowPower();
  let col = b.color;
  if (unpowered) col = shade(col, -0.35);

  const { A, B, C, D } = footprintCorners(b);

  // Selection ring on the ground (footprint outline).
  if (!ghost && state.selectedBuilding === b) {
    ctx.beginPath();
    ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.lineTo(C.x, C.y); ctx.lineTo(D.x, D.y); ctx.closePath();
    ctx.strokeStyle = "#a6e3a1"; ctx.lineWidth = 2.5; ctx.stroke(); ctx.lineWidth = 1;
  }

  ctx.globalAlpha = ghost ? 0.5 : (constructing ? 0.5 : 1);
  const top = shade(col, 0.06), left = shade(col, -0.42), right = shade(col, -0.26);
  // right face (B->C), then left/front face (D->C), then the top.
  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.moveTo(B.x, B.y - height); ctx.lineTo(C.x, C.y - height); ctx.lineTo(C.x, C.y); ctx.lineTo(B.x, B.y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(D.x, D.y - height); ctx.lineTo(C.x, C.y - height); ctx.lineTo(C.x, C.y); ctx.lineTo(D.x, D.y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.moveTo(A.x, A.y - height); ctx.lineTo(B.x, B.y - height); ctx.lineTo(C.x, C.y - height); ctx.lineTo(D.x, D.y - height); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.stroke();
  ctx.globalAlpha = 1;

  if (ghost) return;

  const hw = Math.max(W, H) * HALF_W;
  const topBar = A.y - height - 12;

  // Name tag so each placeholder block is identifiable at a glance. Walls are
  // skipped (too many, and obvious). Sits right on the block's roof.
  if (b.type !== "wall") {
    const label = constructing ? `${b.name} (building…)` : b.name;
    drawLabel(s.x, s.y - height + 6, label, unpowered ? "#f9e2af" : "#e6e9ef");
  }

  if (constructing) {
    // Construction progress bar (cyan) while building.
    drawBar(s.x - hw * 0.7, topBar, hw * 1.4, 6, b.progress, "#89dceb");
  } else if (b.hp < b.maxHp) {
    // Health bar when damaged.
    const frac = Math.max(0, b.hp / b.maxHp);
    drawBar(s.x - hw * 0.7, topBar, hw * 1.4, 5, frac, hpColor(frac));
  }
  // Low-power marker.
  if (unpowered) {
    ctx.fillStyle = "#f9e2af";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("⚡", s.x, topBar - 8);
    ctx.textAlign = "left";
  }
  // Garrison count on a Guard Tower.
  if (b.tower && b.built) {
    ctx.fillStyle = "#11151e";
    ctx.fillRect(s.x - 15, s.y - height - 6, 30, 15);
    ctx.fillStyle = b.garrison.length ? "#a6e3a1" : "#6c7086";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${b.garrison.length}/${b.cap}`, s.x, s.y - height + 5);
    ctx.textAlign = "left";
  }
}

// Faint ground ring showing a Hospital/Garage heal-aura zone (green = infantry
// heal, blue = vehicle repair).
function drawHealAuras() {
  for (const b of state.buildings) {
    if (!b.built) continue;
    const aura = BUILDING_TYPES[b.type].heal;
    if (!aura) continue;
    const c = gridPt(b.tx + (b.bw - 1) / 2, b.ty + (b.bh - 1) / 2);
    const R = aura.radius + b.size / 2;
    const rx = R * HALF_W * Math.SQRT2, ry = R * HALF_H * Math.SQRT2;
    if (c.x + rx < 0 || c.x - rx > canvas.width || c.y + ry < 0 || c.y - ry > canvas.height) continue;
    const rgb = aura.targets.includes("vehicle") ? "137,180,250" : "166,227,161";
    ctx.fillStyle = `rgba(${rgb},0.05)`;
    ctx.strokeStyle = `rgba(${rgb},0.35)`;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }
}

/* ------------------------------ OVERLAYS -------------------------------- */
// Hover: just record what's under the cursor. Hovering a unit is shown by the
// ring drawn under it in drawUnit() — no tile highlight, which read as clutter.
// Ground tiles are only highlighted while placing a building.
function drawHover() {
  hoveredUnit = unitAt(input.mouse.x, input.mouse.y);
  if (!hoveredUnit && state.placing) {
    const wm = screenToWorld(input.mouse.x, input.mouse.y);
    const tm = worldToTile(wm.x, wm.y);
    drawTileHighlight(Math.round(tm.tx), Math.round(tm.ty),
      "rgba(255,255,255,0.08)", "rgba(255,255,255,0.5)");
  }
}

// Bullet tracers.
function drawEffects() {
  for (const e of state.effects) {
    const a = worldToScreen(e.x1, e.y1);
    const b = worldToScreen(e.x2, e.y2);
    ctx.globalAlpha = Math.max(0, e.life / TRACER_LIFE);
    ctx.strokeStyle = e.hit ? "#fdf6b2" : "rgba(210,210,210,0.7)";
    ctx.lineWidth = e.hit ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
}

// Healing links (engineer/first-aid actively repairing).
function drawRepairLinks() {
  for (const u of state.units) {
    if (!u.repairing || !u.repairTarget) continue;
    const a = unitScreen(u);
    const tw = u.repairTarget.worldPos();
    const b = worldToScreen(tw.x, tw.y);
    ctx.strokeStyle = "rgba(166,227,161,0.8)";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - u.radius);
    ctx.lineTo(b.x, b.y - 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    // green plus over the healer
    ctx.strokeStyle = "#a6e3a1";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x - 4, a.y - u.radius * 2.4); ctx.lineTo(a.x + 4, a.y - u.radius * 2.4);
    ctx.moveTo(a.x, a.y - u.radius * 2.4 - 4); ctx.lineTo(a.x, a.y - u.radius * 2.4 + 4);
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

// Producer rally-point link (while dragging one, or when a producer is selected).
function drawRallyLink() {
  const rb = state.settingRally ||
    (state.selectedBuilding && state.selectedBuilding.produces
      ? state.selectedBuilding : null);
  if (!rb) return;
  const bs = gridPt(rb.tx + rb.bw / 2, rb.ty + rb.bh / 2);
  let tx = null, ty = null;
  if (state.settingRally === rb) { tx = input.mouse.x; ty = input.mouse.y; }
  else if (rb.rally) { const p = gridPt(rb.rally.x, rb.rally.y); tx = p.x; ty = p.y; }
  if (tx === null) return;
  ctx.strokeStyle = "rgba(137,220,235,0.85)";
  ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(bs.x, bs.y); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.setLineDash([]); ctx.lineWidth = 1;
  ctx.fillStyle = "#89dceb";
  ctx.beginPath(); ctx.moveTo(tx, ty - 16); ctx.lineTo(tx + 11, ty - 12); ctx.lineTo(tx, ty - 8); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#11151e";
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx, ty - 16); ctx.stroke();
}

// Drag-select rectangle.
function drawSelectionBox() {
  if (!input.dragging) return;
  const x = Math.min(input.dragStart.x, input.dragEnd.x);
  const y = Math.min(input.dragStart.y, input.dragEnd.y);
  const w = Math.abs(input.dragEnd.x - input.dragStart.x);
  const h = Math.abs(input.dragEnd.y - input.dragStart.y);
  ctx.fillStyle = "rgba(137,180,250,0.15)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#89b4fa";
  ctx.strokeRect(x, y, w, h);
}

// Building placement ghost, plus the zone you're allowed to build in and — when
// the spot is illegal — why.
function drawPlacementGhost() {
  if (!state.placing) return;
  const type = state.placing.type;
  const def = BUILDING_TYPES[type];
  const rot = state.placing.rot || 0;
  const { w, h } = buildingDims(type, rot);
  const { ax, ay } = cursorBuildAnchor(input.mouse.x, input.mouse.y, w, h);
  const reason = placementReason(type, ax, ay, rot);
  const ok = reason === null;

  // The legal zone: rings around whatever this building may anchor to. Without
  // this the Main House in particular is guesswork — it's only legal within a
  // few tiles of an Engineer, who may be off across the map.
  for (const a of buildAnchors(type)) {
    const c = gridPt(a.x, a.y);
    const rx = a.r * HALF_W * Math.SQRT2, ry = a.r * HALF_H * Math.SQRT2;
    if (c.x + rx < 0 || c.x - rx > canvas.width || c.y + ry < 0 || c.y - ry > canvas.height) continue;
    ctx.fillStyle = "rgba(166,227,161,0.06)";
    ctx.strokeStyle = "rgba(166,227,161,0.45)";
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }

  const fill = ok ? "rgba(166,227,161,0.18)" : "rgba(243,139,168,0.20)";
  const stroke = ok ? "rgba(166,227,161,0.9)" : "rgba(243,139,168,0.9)";
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      drawTileHighlight(ax + dx, ay + dy, fill, stroke);
  drawBuilding({ tx: ax, ty: ay, bw: w, bh: h, size: Math.max(w, h),
                 color: def.color, tower: def.tower, gate: def.gate }, true);

  if (!ok) drawLabel(input.mouse.x, input.mouse.y - 18, reason, "#f38ba8");
}

// Vignette for a bit of mood.
function drawVignette() {
  const vg = ctx.createRadialGradient(
    canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * 0.35,
    canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Bottom status line: selection count + details of a single selected unit.
function updateStatusLine() {
  const selUnits = selectedUnits();
  const enemies = state.units.filter(u => u.team === "enemy").length;
  let txt = "";
  if (state.activeMode && state.activeMode.hudLine) {
    const line = state.activeMode.hudLine();
    if (line) txt += line + "  |  ";
  }
  txt += `Selected: ${selUnits.length}  |  Enemies: ${enemies}`;
  if (selUnits.length === 1) {
    const u = selUnits[0];
    const w = u.weapon;
    txt += `  |  ${u.type} Lv${u.level} (${Math.round((ACCURACY[u.level] || 0) * 100)}% acc)`
         + `  HP ${Math.max(0, Math.ceil(u.hp))}/${u.maxHp}`
         + `  kills ${u.kills}`
         + `  view ${u.view}  range ${w.range}  dmg ${w.damage}`;
  }
  statusEl.textContent = txt;
}

/* ------------------------------- FRAME ---------------------------------- */
function render() {
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Terrain: one blit of the pre-rendered map instead of thousands of tiles.
  blitMap();
  drawOre();
  drawHealAuras();

  drawHover();

  // Buildings + units, depth-sorted together so overlaps look right. Off-screen
  // objects are culled — with hundreds of units only a handful are visible, so
  // this is the single biggest frame-time win at scale.
  const drawList = [...state.buildings, ...state.units];
  drawList.sort((a, b) => (a.tx + a.ty + (a.size - 1)) - (b.tx + b.ty + (b.size - 1)));
  const W = canvas.width, H = canvas.height;
  for (const o of drawList) {
    const s = o.isBuilding ? gridPt(o.tx + (o.bw - 1) / 2, o.ty + (o.bh - 1) / 2) : unitScreen(o);
    const mx = o.isBuilding ? 140 : 60, myTop = o.isBuilding ? 160 : 90, myBot = 60;
    if (s.x < -mx || s.x > W + mx || s.y < -myTop || s.y > H + myBot) continue; // off-screen
    if (o.isBuilding) drawBuilding(o);
    else drawUnit(o);
  }

  drawEffects();
  drawRepairLinks();
  drawRallyLink();
  drawSelectionBox();
  drawPlacementGhost();
  drawVignette();

  updateStatusLine();
  updateBuildMenu();
}
