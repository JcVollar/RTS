"use strict";

/* =========================================================================
 * PATHFINDING — walkability, A* with a binary heap, and line of sight.
 * ========================================================================= */

// A size×size footprint at (x,y) is walkable if in bounds and building-free.
// passGates=true lets a unit walk through gate tiles (friendly units only).
function walkable(x, y, size, passGates) {
  if (x < 0 || y < 0 || x + size > CONFIG.MAP_W || y + size > CONFIG.MAP_H) return false;
  if (state.blocked.size === 0) return true; // fast path: no buildings yet
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const k = tileKey(x + dx, y + dy);
      if (state.blocked.has(k) && !(passGates && state.gateTiles.has(k))) return false;
    }
  return true;
}

// Nearest walkable anchor to (gx,gy) for a given footprint, or null.
function nearestWalkable(gx, gy, size, passGates) {
  if (walkable(gx, gy, size, passGates)) return { x: gx, y: gy };
  return spiralSearch(gx, gy, 1, 13, (x, y) =>
    walkable(x, y, size, passGates) ? { x, y } : null);
}

// Octile heuristic, slightly over-weighted (weighted A*). The bump breaks the
// huge fan of equal-cost paths that open terrain produces, so A* beelines to the
// goal instead of exploring a giant diamond and blowing past the expansion cap
// (which left units spawned in far corners unable to find a route — they stalled).
const PF_WEIGHT = 1.15;
function heur(x, y, gx, gy) {
  const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
  return ((dx + dy) - 0.5858 * Math.min(dx, dy)) * PF_WEIGHT;
}

// Tiny binary min-heap for the A* open set.
class MinHeap {
  constructor() { this.a = []; }
  size() { return this.a.length; }
  push(item, pri) {
    const a = this.a; a.push({ item, pri }); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].pri <= a[i].pri) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0; const n = a.length;
      for (;;) {
        let l = 2 * i + 1, r = 2 * i + 2, s = i;
        if (l < n && a[l].pri < a[s].pri) s = l;
        if (r < n && a[r].pri < a[s].pri) s = r;
        if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s;
      }
    }
    return top.item;
  }
}

const PF_DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

// A* from the unit's current tile to (gx,gy). Returns [{x,y}...] waypoints
// (excluding the start, including the goal), or [] if unreachable.
function findPath(u, gx, gy) {
  const size = u.size;
  const pass = u.team === "player"; // your units may walk through your gates
  const start = { x: Math.round(u.tx), y: Math.round(u.ty) };
  let goal = walkable(gx, gy, size, pass) ? { x: gx, y: gy } : nearestWalkable(gx, gy, size, pass);
  if (!goal) return [];
  if (start.x === goal.x && start.y === goal.y) return [];

  const W = CONFIG.MAP_W;
  const startI = start.y * W + start.x, goalI = goal.y * W + goal.x;
  const open = new MinHeap();
  const g = new Map(); const came = new Map();
  g.set(startI, 0);
  open.push(startI, heur(start.x, start.y, goal.x, goal.y));

  let expanded = 0;
  const MAX = 16000; // safety cap
  while (open.size() && expanded < MAX) {
    const cur = open.pop();
    if (cur === goalI) {
      const path = [];
      let c = cur;
      while (c !== startI) { const x = c % W, y = (c - x) / W; path.push({ x, y }); c = came.get(c); }
      path.reverse();
      return path;
    }
    expanded++;
    const cx = cur % W, cy = (cur - cx) / W;
    const cg = g.get(cur);
    for (const [dx, dy] of PF_DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(nx, ny, size, pass)) continue;
      if (dx && dy && (!walkable(cx + dx, cy, size, pass) || !walkable(cx, cy + dy, size, pass))) continue; // no corner cut
      const ni = ny * W + nx;
      const ng = cg + (dx && dy ? 1.4142 : 1);
      if (!g.has(ni) || ng < g.get(ni)) {
        g.set(ni, ng); came.set(ni, cur);
        open.push(ni, ng + heur(nx, ny, goal.x, goal.y));
      }
    }
  }
  return []; // no route
}

/* ------------------------- LINE OF SIGHT ------------------------------- */
// Does a straight line (tile space) cross any building tile not in `ignore`?
function lineBlocked(x0, y0, x1, y1, ignore) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist * 2);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const key = tileKey(Math.floor(x0 + dx * t), Math.floor(y0 + dy * t));
    if (state.blocked.has(key) && !ignore.has(key)) return true;
  }
  return false;
}

// Can `u` see/shoot `t` — i.e. no wall or house sits between them? The shooter's
// and target's own footprints never block.
function hasLineOfSight(u, t) {
  if (state.blocked.size === 0) return true;
  const ignore = new Set();
  markFootprint(Math.round(u.tx), Math.round(u.ty), u.size, ignore);
  markFootprint(Math.round(t.tx), Math.round(t.ty), t.size, ignore);
  const uc = (u.size - 1) / 2, tc = (t.size - 1) / 2;
  return !lineBlocked(u.tx + uc, u.ty + uc, t.tx + tc, t.ty + tc, ignore);
}
