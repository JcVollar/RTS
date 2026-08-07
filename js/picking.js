"use strict";

/* =========================================================================
 * PICKING — what's under a screen point (units, buildings), plus the shared
 * building screen-geometry used by both hit-testing and rendering.
 * ========================================================================= */

// Drawn height in px of a building block (towers stand ~3 tiles tall).
function buildingHeight(b) {
  return b.tower ? 60 : (12 + Math.max(b.bw, b.bh) * 9);
}

// Screen points of a building footprint's four ground corners. Tile centers
// are at integer coords, so the corners sit at the −0.5 edges.
function footprintCorners(b) {
  return {
    A: gridPt(b.tx - 0.5, b.ty - 0.5),
    B: gridPt(b.tx + b.bw - 0.5, b.ty - 0.5),
    C: gridPt(b.tx + b.bw - 0.5, b.ty + b.bh - 0.5),
    D: gridPt(b.tx - 0.5, b.ty + b.bh - 0.5),
  };
}

// Is a screen point over a unit's drawn body? Accounts for the raised body
// (tanks/soldiers are drawn above their ground tile), so clicks land reliably.
function unitHit(u, sx, sy) {
  const s = unitScreen(u);
  const R = u.radius;
  return sx >= s.x - R * 1.4 && sx <= s.x + R * 1.4 &&
         sy >= s.y - R * 2.7 && sy <= s.y + R * 0.8;
}

// Front-most unit under a screen point, or null. Pass a team to only
// consider that team's units during the search.
function unitAt(sx, sy, team) {
  let picked = null, bestDepth = -Infinity;
  for (const u of state.units) {
    if (team && u.team !== team) continue;
    if (unitHit(u, sx, sy)) {
      const depth = u.tx + u.ty;            // larger = nearer the camera
      if (depth >= bestDepth) { bestDepth = depth; picked = u; }
    }
  }
  return picked;
}

// Front-most hostile (non-player) unit under a screen point, or null.
function enemyAt(sx, sy) {
  const u = unitAt(sx, sy);
  return u && u.team !== "player" ? u : null;
}

// Front-most friendly unit under a screen point, or null.
function friendlyUnitAt(sx, sy) {
  const u = unitAt(sx, sy);
  return u && u.team === "player" ? u : null;
}

// The front-most building whose drawn block is under a screen point, or null.
function buildingAt(sx, sy) {
  let hit = null, bestDepth = -Infinity;
  for (const b of state.buildings) {
    const { A, B, C, D } = footprintCorners(b);
    const height = buildingHeight(b);
    const minX = Math.min(A.x, B.x, C.x, D.x), maxX = Math.max(A.x, B.x, C.x, D.x);
    const minY = Math.min(A.y, B.y, C.y, D.y) - height, maxY = Math.max(A.y, B.y, C.y, D.y);
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
      const depth = b.tx + b.ty + b.size;
      if (depth > bestDepth) { bestDepth = depth; hit = b; }
    }
  }
  return hit;
}
