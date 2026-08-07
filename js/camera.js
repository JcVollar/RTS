"use strict";

/* =========================================================================
 * CAMERA — viewport position, screen<->world conversion, panning.
 * ========================================================================= */

// Camera position = world-space pixel at the top-left of the screen.
const camera = { x: 0, y: 0 };

function centerCameraOn(tx, ty) {
  const w = tileToWorld(tx, ty);
  camera.x = w.x - canvas.width / 2;
  camera.y = w.y - canvas.height / 2;
}

function clampCamera() {
  // Keep camera within the diamond-shaped world bounds (with slack).
  const b = computeWorldBounds();
  camera.x = clamp(camera.x, b.minX, b.maxX - canvas.width);
  camera.y = clamp(camera.y, b.minY, b.maxY - canvas.height);
}

/* Screen <-> world with camera applied. */
function screenToWorld(sx, sy) { return { x: sx + camera.x, y: sy + camera.y }; }
function worldToScreen(wx, wy) { return { x: wx - camera.x, y: wy - camera.y }; }

// Screen point of a tile grid position (fractional coords allowed).
function gridPt(tx, ty) { const w = tileToWorld(tx, ty); return worldToScreen(w.x, w.y); }

// Screen position of a unit's visual center (footprint-aware).
function unitScreen(u) {
  const w = tileToWorld(u.centerX, u.centerY);
  return worldToScreen(w.x, w.y);
}

// Keyboard + edge-of-screen + right-drag panning.
function updateCamera(dt) {
  let dx = 0, dy = 0;
  const k = input.keys;
  if (k.has("a") || k.has("arrowleft"))  dx -= 1;
  if (k.has("d") || k.has("arrowright")) dx += 1;
  if (k.has("w") || k.has("arrowup"))    dy -= 1;
  if (k.has("s") || k.has("arrowdown"))  dy += 1;

  // Edge-scroll (skipped while dragging the map with the right button).
  const m = input.mouse;
  if (!input.panning) {
    if (m.x < CONFIG.EDGE_PAN) dx -= 1;
    if (m.x > canvas.width - CONFIG.EDGE_PAN) dx += 1;
    if (m.y < CONFIG.EDGE_PAN) dy -= 1;
    if (m.y > canvas.height - CONFIG.EDGE_PAN) dy += 1;
  }

  if (dx || dy) {
    const len = Math.hypot(dx, dy) || 1;
    camera.x += (dx / len) * CONFIG.PAN_SPEED * dt;
    camera.y += (dy / len) * CONFIG.PAN_SPEED * dt;
  }

  // Right-button velocity pan: how far the cursor is from where you pressed
  // sets the slide speed (past a small deadzone). Hold still = keep sliding.
  if (input.panning) {
    const dead = 8;
    let ox = input.mouse.x - input.panStart.x;
    let oy = input.mouse.y - input.panStart.y;
    ox = Math.abs(ox) < dead ? 0 : ox - Math.sign(ox) * dead;
    oy = Math.abs(oy) < dead ? 0 : oy - Math.sign(oy) * dead;
    camera.x += ox * CONFIG.DRAG_PAN_SPEED * dt;
    camera.y += oy * CONFIG.DRAG_PAN_SPEED * dt;
  }

  clampCamera();
}
