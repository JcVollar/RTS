"use strict";

/* =========================================================================
 * ENTITIES — Unit and Building classes on a shared Entity base.
 * The base class owns the footprint math (center, distance, angle) that the
 * old code repeated everywhere; systems call these methods instead.
 * ========================================================================= */

class Entity {
  constructor(id, tx, ty) {
    this.id = id;
    this.tx = tx;   // anchor = top-left tile of the footprint
    this.ty = ty;
  }

  // Footprint dimensions in tiles (buildings may be non-square via bw/bh).
  get fw() { return this.bw || this.size; }
  get fh() { return this.bh || this.size; }

  // Footprint center in tile space.
  get centerX() { return this.tx + (this.fw - 1) / 2; }
  get centerY() { return this.ty + (this.fh - 1) / 2; }

  // World-space pixel center (footprint-aware).
  worldPos() { return tileToWorld(this.centerX, this.centerY); }

  // Distance to another entity in tiles (center to center).
  distTo(o) { return Math.hypot(this.centerX - o.centerX, this.centerY - o.centerY); }

  // Screen-space angle toward another entity (for barrel facing).
  angleTo(o) {
    const a = this.worldPos(), b = o.worldPos();
    return Math.atan2(b.y - a.y, b.x - a.x);
  }
}

/* ------------------------------- UNIT ----------------------------------- */
class Unit extends Entity {
  constructor(id, tx, ty, opts = {}) {
    super(id, tx, ty);
    const type = opts.type || "soldier";
    const def = UNIT_TYPES[type];
    this.type = type;
    this.size = def.size;       // footprint is size×size tiles (person 1, vehicle 2)
    this.targetTx = tx;         // current waypoint being moved toward
    this.targetTy = ty;
    this.goalTx = tx;           // final destination of the current path
    this.goalTy = ty;
    this.path = [];             // remaining waypoints (tile anchors) from A*
    this.selected = false;
    this.radius = def.radius;
    this.facing = 2.2;          // barrel angle (screen-space radians)
    this.hp = def.maxHp;
    this.maxHp = def.maxHp;
    this.view = opts.view || def.view;        // detection range (tiles)
    this.armor = opts.armor || def.armor;     // damage class taken as
    this.weapon = opts.weapon || def.weapon;  // weapon template (read-only)
    this.level = opts.level || 1;             // 1..3 skill -> ACCURACY
    this.team = opts.team || "player";
    // Enemies are always the team colour; only friendlies keep a per-type tint
    // (orange engineer, pink medic, gold miner) over the team default.
    this.color = opts.color ||
      (this.team === "enemy" ? TEAM_COLORS.enemy : (def.color || TEAM_COLORS.player));
    this.speed = opts.speed || def.speed;     // per-unit override wins
    this.damageMult = opts.damageMult || 1;   // scales damage this unit DEALS (difficulty)
    this.armorMult = opts.armorMult || 1;     // scales damage this unit TAKES (lower = tougher)
    // combat runtime state
    this.target = null;         // current auto-acquired or forced target
    this.forcedTarget = null;   // explicit attack order (overrides auto-acquire)
    this.attackAngle = null;    // assigned slot around a forced target (arc formation)
    this.commandedMove = false; // moving under a user order (overrides auto-stop)
    this.moving = false;        // actually advanced this frame (drives the sprite step-bob)
    this.walkPhase = 0;         // tiles travelled, ever — the bob's clock
    this._sepX = 0; this._sepY = 0; // soft-collision push (movement.js)
    this.moveGoal = null;       // {x,y} destination of a user move order — resumed after combat
    this.cooldown = 0;          // seconds until next shot allowed
    this.burstCount = 0;        // shots fired in the current burst
    this.muzzle = 0;            // muzzle-flash timer
    this.aiming = false;        // locked onto a target this frame (barrel tracks it)
    this.retaliateTarget = null;// who last shot us (auto-return-fire)
    this.retaliateTimer = 0;    // seconds of provoked aggression remaining
    this.alerted = false;       // provoked via an ally's alarm (won't relay it further)
    this.repair = def.repair || null;   // healer ability (engineer / first aid)
    this.repairTarget = null;   // friendly unit/building being repaired
    this.repairing = false;     // actively repairing this frame (for the visual)
    this.healingAura = false;   // inside a Hospital/Garage heal aura this frame (visual)
    this.enterTarget = null;    // Guard Tower this unit is walking into
    this.kills = 0;             // confirmed kills -> veterancy
    this.levelFlash = 0;        // promotion pulse timer
    // AI (enemies only)
    this.stationary = opts.stationary || false;
    this.wanderRadius = opts.wanderRadius || 4;
    this.wanderTimer = opts.wanderTimer || 0;
    this.disengageTimer = 0;    // >0 = wander, don't hunt (set after razing a building)
    this.behavior = opts.behavior || null;  // enemy pattern: null/"wander" or "advance"
    this.advanceTarget = null;  // building an "advance" enemy is pushing toward
    this.repathTimer = 0;       // throttles A* recompute while advancing
    this.advLastX = tx; this.advLastY = ty; // sampled position for the advance stuck-check
    this.advCheck = 1.5;        // seconds until the next progress sample
    // Ore miner state (only meaningful when type === "oreMiner")
    this.cargo = 0;                        // credits' worth currently carried
    this.cargoMax = def.cargo || 0;        // full load
    this.minerJob = "auto";                // "auto" = harvest loop, "manual" = player-parked
    this.oreField = null;                  // {x,y} the patch this miner works (stays local)
    this.mining = false;                   // draining ore this frame (for the visual)
  }

  get isMiner() { return this.type === "oreMiner"; }

  // Category a healer cares about ("infantry" / "vehicle"; buildings override).
  // Anything with a 2×2 footprint (tanks, miners) repairs as a vehicle.
  get category() { return this.size >= 2 ? "vehicle" : "infantry"; }

  // Which units may enter a Guard Tower: armed infantry that aren't healers.
  get canGarrison() {
    return this.size === 1 && !this.repair && this.weapon && this.weapon.range > 0;
  }

  // May this unit repair/heal target `t`?
  canRepair(t) {
    return this.repair && t.team === "player" && t !== this &&
           this.repair.targets.includes(t.category);
  }

  /* ------------------------------ ORDERS -------------------------------- */
  // Route to (gx,gy) via A*, following waypoints around buildings.
  moveTo(gx, gy) {
    gx = clamp(gx, 0, CONFIG.MAP_W - this.size);
    gy = clamp(gy, 0, CONFIG.MAP_H - this.size);
    if (this.goalTx === gx && this.goalTy === gy) return; // already routing there
    this.goalTx = gx; this.goalTy = gy;
    const path = findPath(this, gx, gy);
    this.path = path;
    if (path.length) {
      this.targetTx = path[0].x; this.targetTy = path[0].y;
    } else {
      // No route (blocked/unreachable): stay put.
      this.targetTx = Math.round(this.tx);
      this.targetTy = Math.round(this.ty);
    }
  }

  // Stop exactly where we stand (used when halting to fire).
  stop() {
    this.path = [];
    this.targetTx = this.tx; this.targetTy = this.ty;
    this.goalTx = Math.round(this.tx); this.goalTy = Math.round(this.ty);
  }

  /* --------------------------- POSITIONING ------------------------------ */
  // A tile to stand on so we are just inside weapon range of `target`.
  approachTile(target) {
    const uc = (this.size - 1) / 2, tc = (target.size - 1) / 2;
    const ux = this.tx + uc, uy = this.ty + uc;
    const tx = target.tx + tc, ty = target.ty + tc;
    const dx = ux - tx, dy = uy - ty;
    const d = Math.hypot(dx, dy) || 1;
    const stand = Math.max(1, this.weapon.range * 0.8);
    return {
      x: Math.round(tx + (dx / d) * stand - uc),
      y: Math.round(ty + (dy / d) * stand - tc),
    };
  }

  // Where to stand when attacking `target`: at the assigned slot angle
  // (arc formation) and a fixed standoff, so a group rings the target evenly.
  attackStandTile(target) {
    const tc = (target.size - 1) / 2, uc = (this.size - 1) / 2;
    const tcx = target.tx + tc, tcy = target.ty + tc;
    const standoff = Math.max(1.2, this.weapon.range * 0.85);
    let ang = this.attackAngle;
    if (ang == null) ang = Math.atan2((this.ty + uc) - tcy, (this.tx + uc) - tcx);
    return {
      x: clamp(Math.round(tcx + Math.cos(ang) * standoff - uc), 0, CONFIG.MAP_W - this.size),
      y: clamp(Math.round(tcy + Math.sin(ang) * standoff - uc), 0, CONFIG.MAP_H - this.size),
    };
  }

  // A tile just outside the target's footprint, nearest to us (repair/garrison).
  besideTile(target) {
    const uc = (this.size - 1) / 2, tc = (target.size - 1) / 2;
    const tx = target.tx + tc, ty = target.ty + tc;
    const dx = (this.tx + uc) - tx, dy = (this.ty + uc) - ty;
    const d = Math.hypot(dx, dy) || 1;
    const stand = tc + 1;
    return {
      x: clamp(Math.round(tx + (dx / d) * stand - uc), 0, CONFIG.MAP_W - this.size),
      y: clamp(Math.round(ty + (dy / d) * stand - uc), 0, CONFIG.MAP_H - this.size),
    };
  }

  /* ------------------------------ COMBAT -------------------------------- */
  // Credit a kill and promote if it crosses a veterancy tier.
  addKill() {
    this.kills++;
    let lvl = 1;
    if (this.kills >= VETERANCY.kills[1]) lvl = 3;
    else if (this.kills >= VETERANCY.kills[0]) lvl = 2;
    if (lvl > this.level) {
      this.level = lvl;
      this.levelFlash = 0.6; // gold promotion pulse
    }
  }

  // Fire one shot: roll to hit, apply damage, schedule the next shot, spawn tracer.
  fireAt(target) {
    const wpn = this.weapon;
    this.burstCount++;
    if (this.burstCount >= wpn.burst) { this.burstCount = 0; this.cooldown = wpn.reload; }
    else { this.cooldown = wpn.fireDelay; }
    this.muzzle = 0.05;

    const hit = Math.random() < (ACCURACY[this.level] || 0.25);
    if (hit) {
      let mult = (wpn.vs && wpn.vs[target.armor] != null) ? wpn.vs[target.armor] : 1;
      if (target.isBuilding) {                 // tanks & co. hit structures harder
        mult *= wpn.vsBuilding || 1;
        if (target.tower) mult *= wpn.vsTower || 1;
      }
      target.hp -= wpn.damage * mult * this.damageMult * (target.armorMult || 1);
      if (target.hp <= 0) this.addKill();
      else if (!target.isBuilding) {           // provoke return fire
        target.retaliateTarget = this;
        target.retaliateTimer = RETALIATE_TIME;
        target.alerted = false;                // genuinely shot: allowed to relay the alarm
      }
    }

    // Tracer (world coords). A miss scatters the endpoint so you can see it.
    const a = this.worldPos(), b = target.worldPos();
    const ex = b.x + (hit ? 0 : (Math.random() * 2 - 1) * 22);
    const ey = b.y + (hit ? 0 : (Math.random() * 2 - 1) * 22);
    state.effects.push({ x1: a.x, y1: a.y - 12, x2: ex, y2: ey - 12, life: TRACER_LIFE, hit });
  }
}

/* ----------------------------- BUILDING --------------------------------- */
// Footprint dimensions for a building type at a rotation (gates are 4x1 / 1x4).
function buildingDims(type, rot) {
  const def = BUILDING_TYPES[type];
  if (def.gate) return (rot % 2 === 0) ? { w: 4, h: 1 } : { w: 1, h: 4 };
  return { w: def.size, h: def.size };
}

class Building extends Entity {
  constructor(id, type, ax, ay, rot = 0) {
    super(id, ax, ay);
    const def = BUILDING_TYPES[type];
    const { w, h } = buildingDims(type, rot);
    this.isBuilding = true;
    this.type = type;
    this.name = def.name;
    this.team = "player";
    this.bw = w; this.bh = h;
    this.size = Math.max(w, h);
    this.hp = def.hp;
    this.maxHp = def.hp;
    this.armor = "heavy";
    this.power = def.power;
    this.needsPower = def.needsPower;
    this.color = def.color;
    this.built = false;
    this.progress = 0;
    this.buildTime = def.buildTime;
    this.cost = def.cost;
    this.tower = !!def.tower;
    this.cap = def.cap || 0;
    this.garrison = def.tower ? [] : null;
    this.gate = !!def.gate;
    this.rally = null;          // producers: where fresh units walk to
  }

  get category() { return "building"; }

  // "infantry" / "vehicle" if this building trains units, else null.
  get produces() { return BUILDING_TYPES[this.type].produces || null; }
}
