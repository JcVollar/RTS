"use strict";

/* =========================================================================
 * UI — the DOM build menu (right-hand bar): tabs, buttons, production
 * status, and the selected-building panel.
 * ========================================================================= */

const econEl = document.getElementById("econ");
const structListEl = document.getElementById("structlist");
const unitListEl = document.getElementById("unitlist");
const prodEl = document.getElementById("prod");
const selEl = document.getElementById("selinfo");
const tabStruct = document.getElementById("tab-struct");
const tabUnits = document.getElementById("tab-units");
const structButtons = {};
const unitButtons = {};
let activeTab = "struct";
let selRenderedId = null;

function unitLabel(key) { return UNIT_TYPES[key].label || cap(key); }

function setTab(t) {
  if (t === "units" && tabUnits.disabled) return;
  activeTab = t;
  tabStruct.classList.toggle("active", t === "struct");
  tabUnits.classList.toggle("active", t === "units");
  structListEl.style.display = t === "struct" ? "flex" : "none";
  unitListEl.style.display = t === "units" ? "flex" : "none";
  prodEl.style.display = t === "units" ? "block" : "none";
  if (t !== "struct") state.placing = null;
}

function initBuildMenu() {
  for (const key of BUILD_MENU) {
    const def = BUILDING_TYPES[key];
    const btn = document.createElement("button");
    btn.className = "buildbtn";
    const pwr = def.power ? ` · ${def.power > 0 ? "+" : ""}${def.power}⚡` : "";
    btn.innerHTML = `<b>${def.name}</b><span>${def.size}×${def.size} · $${def.cost}${pwr}</span>`;
    btn.addEventListener("click", () => {
      if (btn.classList.contains("disabled")) return;
      state.placing = (state.placing && state.placing.type === key) ? null : { type: key, rot: 0 };
    });
    // Right-click cancels: a placement in progress, else a building of this type
    // that's still under construction (refunding what's been spent).
    btn.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (state.placing && state.placing.type === key) { state.placing = null; return; }
      cancelConstruction(key);
    });
    structListEl.appendChild(btn);
    structButtons[key] = btn;
  }
  for (const key of UNIT_MENU) {
    const def = UNIT_TYPES[key];
    const btn = document.createElement("button");
    btn.className = "buildbtn";
    btn.innerHTML = `<b>${unitLabel(key)}</b><span>$${def.cost} · ${def.buildTime}s</span>`;
    btn.addEventListener("click", () => { if (!btn.classList.contains("disabled")) queueUnit(key); });
    // Right-click removes one queued unit of this type (refunds the in-progress one).
    btn.addEventListener("contextmenu", e => { e.preventDefault(); cancelUnit(def.producer, key); });
    unitListEl.appendChild(btn);
    unitButtons[key] = btn;
  }
  tabStruct.addEventListener("click", () => setTab("struct"));
  tabUnits.addEventListener("click", () => setTab("units"));
  setTab("struct");
}

function updateBuildMenu() {
  const p = powerBalance();
  const low = p.consumed > p.produced;
  const eng = hasEngineer();
  const hasMain = state.buildings.some(b => b.type === "main");
  const noBase = state.buildings.length === 0;
  const anyProducer = hasBuiltProducer("barracks") || hasBuiltProducer("garage");

  econEl.innerHTML =
    `<div>Credits: <b>$${Math.floor(state.credits)}</b></div>` +
    `<div class="${low ? "low" : ""}">Power: ${p.produced} / ${p.consumed}${low ? " ⚠" : ""}</div>` +
    (low ? `<div class="low">Low power — unit training halted</div>` : "") +
    (!eng && !hasMain ? `<div class="low">Engineer needed to build a Main House</div>` : "");

  for (const key of BUILD_MENU) {
    const btn = structButtons[key];
    const chainable = key === "wall" || key === "gate";
    // Only the Main House needs an Engineer; everything else just needs an
    // existing building to anchor to. (Class, not the `disabled` attribute, so
    // right-click-to-cancel still fires.)
    let dis = !chainable && constructingOfType(key);
    if (key === "main") dis = dis || !eng;
    else dis = dis || noBase;
    btn.classList.toggle("disabled", dis);
    btn.classList.toggle("active", !!state.placing && state.placing.type === key);
  }

  tabUnits.disabled = !anyProducer;
  if (!anyProducer && activeTab === "units") setTab("struct");
  for (const key of UNIT_MENU) {
    const producer = UNIT_TYPES[key].producer;
    const full = state.queues[producer] && state.queues[producer].length >= queueMax(producer);
    const needsRefinery = key === "oreMiner" && !hasBuiltRefinery();
    unitButtons[key].classList.toggle("disabled", !producerOnline(producer) || full || needsRefinery);
  }

  // Production status per producer (Units tab).
  if (!anyProducer) {
    prodEl.innerHTML = `<div class="dim">Build a Barracks or Garage to train units.</div>`;
  } else if (low) {
    prodEl.innerHTML = `<div class="low">Power out — training halted.<br>Build a Power Plant to resume.</div>`;
  } else {
    let html = "";
    for (const producer of Object.keys(state.queues)) {
      if (!hasBuiltProducer(producer)) continue;
      const q = state.queues[producer];
      if (!q.length) {
        html += `<div class="dim">${cap(producer)}: idle</div>`;
        continue;
      }
      const counts = {};
      for (const t of q) counts[t] = (counts[t] || 0) + 1;
      const list = UNIT_MENU.filter(k => counts[k]).map(k => `${unitLabel(k)} ×${counts[k]}`).join(", ");
      html +=
        `<div class="prodtitle">${cap(producer)}: ${unitLabel(q[0])} — ${q.length}/${queueMax(producer)}</div>` +
        `<div class="pbar"><div class="pfill" style="width:${Math.round(state.progress[producer] * 100)}%"></div></div>` +
        `<div class="dim">${list}</div>`;
    }
    prodEl.innerHTML = html;
  }

  // Selected-building panel (Sell). Rebuild only when the selection changes so
  // the Sell button stays clickable; refresh the HP line each frame.
  const b = state.selectedBuilding;
  if (b) {
    if (selRenderedId !== b.id) {
      selRenderedId = b.id;
      selEl.style.display = "block";
      selEl.innerHTML =
        `<div class="prodtitle">${b.name}</div>` +
        `<div class="dim" id="selhp"></div>` +
        (b.tower ? `<button id="evacbtn" class="sellbtn" style="border-color:#89dceb;color:#89dceb;background:#1a2a30">Evacuate</button>` : "") +
        `<button id="sellbtn" class="sellbtn">Sell (+$${sellRefund(b)})</button>`;
      document.getElementById("sellbtn").onclick = () => sellBuilding(b);
      if (b.tower) document.getElementById("evacbtn").onclick = () => ejectGarrison(b);
    }
    const hpEl = document.getElementById("selhp");
    if (hpEl) hpEl.textContent =
      `HP ${Math.max(0, Math.ceil(b.hp))}/${b.maxHp}${b.built ? "" : " · building…"}` +
      (b.tower ? ` · garrison ${b.garrison.length}/${b.cap}` : "");
  } else if (selRenderedId !== null) {
    selRenderedId = null;
    selEl.style.display = "none";
    selEl.innerHTML = "";
  }
}
