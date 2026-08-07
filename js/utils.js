"use strict";

/* =========================================================================
 * UTILS — pure helpers with no game state: math, iso projection, colors.
 * ========================================================================= */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// Seconds -> "m:ss".
function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60), ss = s % 60;
  return m + ":" + (ss < 10 ? "0" : "") + ss;
}

function tileKey(x, y) { return x + "," + y; }

/* --------------------------- ISO MATH ---------------------------------- */
// Tile (col,row) center -> world pixel space (before camera).
function tileToWorld(tx, ty) {
  return {
    x: (tx - ty) * HALF_W,
    y: (tx + ty) * HALF_H,
  };
}

// World pixel space -> fractional tile coords.
function worldToTile(wx, wy) {
  const tx = (wx / HALF_W + wy / HALF_H) / 2;
  const ty = (wy / HALF_H - wx / HALF_W) / 2;
  return { tx, ty };
}

// World-space pixel bounding box of the whole diamond-shaped map (with slack).
function computeWorldBounds() {
  const corners = [
    tileToWorld(0, 0),
    tileToWorld(CONFIG.MAP_W - 1, 0),
    tileToWorld(0, CONFIG.MAP_H - 1),
    tileToWorld(CONFIG.MAP_W - 1, CONFIG.MAP_H - 1),
  ];
  return {
    minX: Math.min(...corners.map(c => c.x)) - CONFIG.TILE_W,
    maxX: Math.max(...corners.map(c => c.x)) + CONFIG.TILE_W,
    minY: Math.min(...corners.map(c => c.y)) - CONFIG.TILE_H,
    maxY: Math.max(...corners.map(c => c.y)) + CONFIG.TILE_H,
  };
}

/* ------------------------- GRID SEARCH --------------------------------- */
// Walk rings of increasing Chebyshev radius (minR..maxR) around (cx,cy) and
// return the first truthy value produced by fn(x, y), or null. This is the
// shared "spiral outward until a spot fits" pattern used for group moves,
// unit spawn points and nearest-walkable lookups.
function spiralSearch(cx, cy, minR, maxR, fn) {
  for (let r = minR; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring edge only
        const v = fn(cx + dx, cy + dy);
        if (v) return v;
      }
  }
  return null;
}

// Chebyshev tile gap between two axis-aligned footprints (0 = touching).
function rectGap(ax, ay, aw, ah, bx, by, bw, bh) {
  const gx = Math.max(0, ax - (bx + bw - 1), bx - (ax + aw - 1));
  const gy = Math.max(0, ay - (by + bh - 1), by - (ay + ah - 1));
  return Math.max(gx, gy);
}

/* ---------------------------- COLORS ----------------------------------- */
// Deterministic 0..1 pseudo-random from grid coords (stable per tile).
function rand2(x, y, seed) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

// Shift a #rrggbb hex toward white (amt>0) or black (amt<0). Returns rgb().
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const target = amt < 0 ? 0 : 255, t = Math.abs(amt);
  r = Math.round(r + (target - r) * t);
  g = Math.round(g + (target - g) * t);
  b = Math.round(b + (target - b) * t);
  return `rgb(${r},${g},${b})`;
}
