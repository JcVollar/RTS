// Headless smoke test: stub the DOM, concatenate the game scripts, run frames.
const fs = require("fs"), path = require("path"), vm = require("vm");

function makeCtx() {
  return new Proxy({ }, {
    get(t, p) {
      if (p in t) return t[p];
      return (...a) => ({ addColorStop() {} });
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
function el() {
  return { style: {}, classList: { toggle() {} }, innerHTML: "", textContent: "",
           disabled: false, appendChild() {}, addEventListener() {}, onclick: null };
}
const canvasEl = { width: 0, height: 0, addEventListener() {}, getContext: () => makeCtx() };

let rafCb = null;
const sandbox = {
  document: {
    getElementById: id => (id === "game" ? canvasEl : el()),
    createElement: tag => (tag === "canvas"
      ? { width: 0, height: 0, getContext: () => makeCtx() } : el()),
  },
  window: { innerWidth: 1280, innerHeight: 720, addEventListener() {} },
  performance: { now: () => 0 },
  requestAnimationFrame: cb => { rafCb = cb; },
  console, Math, Set, Map, JSON,
};
vm.createContext(sandbox);

const dir = path.join(__dirname, "..", "js");
const order = ["config","utils","canvas","entities","state","pathfinding","camera","picking",
               "movement","ai","combat","buildings","support","harvest","input","sprites","render","ui","gamemodes","main"];
const code = order.map(n => fs.readFileSync(path.join(dir, n + ".js"), "utf8")).join("\n;\n");
vm.runInContext(code, sandbox, { filename: "game-concat.js" });

const driver = `
  let t = 0;
  function step(n) {
    for (let i = 0; i < n; i++) {
      t += 16.7;
      const cb = __raf.take();
      cb(t);
    }
  }
  startGame("skirmish"); // the game no longer auto-starts; pick a mode
  step(120); // ~2s of sim

  const before = state.units.length;
  placeBuilding("barracks", 68, 60, 0);
  state.buildings[state.buildings.length - 1].built = true;
  queueUnit("soldier");
  step(400); // ~6.7s: enough for the 5s train time

  const trained = state.units.length - before;
  // order a group move and let them walk
  assignGroupMove(state.units.filter(u => u.team === "player"), 72, 72);
  step(120);

  // Harvest loop: a refinery spawns a free miner; ore beside it should turn
  // into credits after a round trip.
  state.ore = []; state.oreIndex = new Map();
  for (let i = 0; i < 6; i++) addOre(58 + i, 58, ORE.tileMax);
  placeBuilding("refinery", 60, 54, 0);
  const ref = state.buildings[state.buildings.length - 1];
  ref.built = true; onBuildingComplete(ref);
  const creditsBefore = state.credits;
  step(1200); // ~20s: enough for a full harvest trip or two
  const miners = state.units.filter(u => u.isMiner).length;
  const mined = Math.round(state.credits - creditsBefore);

  ({ trained, miners, mined, units: state.units.length,
     buildings: state.buildings.length,
     credits: Math.round(state.credits), effects: state.effects.length });
`;
sandbox.__raf = { take() { const cb = rafCb; rafCb = null; if (!cb) throw new Error("no frame scheduled"); return cb; } };
const result = vm.runInContext(driver, sandbox, { filename: "driver.js" });
console.log("SMOKE OK:", JSON.stringify(result));

