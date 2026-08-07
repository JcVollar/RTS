"use strict";

/* =========================================================================
 * MAIN — the start menu, world setup per game mode, and the game loop.
 * ========================================================================= */

let last = performance.now();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  updateCamera(dt);
  updateProduction(dt);
  updateSupport(dt);
  updateCombat(dt);
  updateAI(dt);
  updateHarvesters(dt);
  updateMovement(dt);
  updateEffects(dt);

  // Mode logic (wave spawning, etc.) plus the win / lose checks.
  if (state.activeMode && !state.gameOver) {
    state.activeMode.update(dt);
    if (state.activeMode.isGameOver()) endGame("lose");
    else if (state.activeMode.isWin && state.activeMode.isWin()) endGame("win");
  }

  render();
  requestAnimationFrame(frame);
}

// Build the static world, then let the chosen mode populate it.
function setupWorld(modeId) {
  const mode = GAMEMODES[modeId] || GAMEMODES.skirmish;
  state.activeMode = mode;
  state.modeData = null;
  state.gameOver = false;
  // Clean slate so a fresh game never inherits a previous run's entities.
  state.units = [];
  state.buildings = [];
  state.effects = [];
  state.blocked = new Set();
  state.gateTiles = new Set();
  state.selectedBuilding = null;
  state.queues = { barracks: [], garage: [] };
  state.progress = { barracks: 0, garage: 0 };
  resize();
  buildMap();
  prerenderMap();
  spawnOreFields();
  state.credits = ECONOMY.startCredits;
  mode.setup();
  initBuildMenu();

  const main = state.buildings.find(b => b.type === "main");
  if (main) centerCameraOn(main.centerX, main.centerY);
  else if (state.units.length) centerCameraOn(state.units[0].tx, state.units[0].ty);
}

function startGame(modeId) {
  const menu = document.getElementById("menu");
  if (menu) menu.style.display = "none";
  const over = document.getElementById("gameover");
  if (over) over.style.display = "none";
  setupWorld(modeId);
  last = performance.now();
  requestAnimationFrame(frame);
}

// Populate the start-menu screen from the mode registry.
function buildStartMenu() {
  const list = document.getElementById("modelist");
  if (list) {
    for (const id of GAMEMODE_MENU) {
      const m = GAMEMODES[id];
      const btn = document.createElement("button");
      btn.className = "modebtn";
      btn.innerHTML = `<b>${m.name}</b><span>${m.description}</span>`;
      btn.addEventListener("click", () => startGame(id));
      list.appendChild(btn);
    }
  }
  const again = document.getElementById("goAgain");
  if (again) again.addEventListener("click", () => location.reload());
}

// End the run and show the win/lose screen.
function endGame(result) {
  state.gameOver = true;
  state.gameResult = result;
  showGameOver();
}

// Show the end screen with the run's result.
function showGameOver() {
  const el = document.getElementById("gameover");
  const title = document.getElementById("goTitle");
  const stats = document.getElementById("goStats");
  const w = state.modeData || {};
  const won = state.gameResult === "win";
  if (title) title.textContent = won ? "Victory!" : "Main House Lost";
  if (stats) stats.textContent = won
    ? `You wiped out every enemy in ${fmtTime(w.elapsed || 0)}.`
    : `You held out for ${fmtTime(w.elapsed || 0)}.`;
  if (el) { el.classList.toggle("win", won); el.style.display = "flex"; }
}

buildStartMenu(); // show the menu; a mode click calls startGame()
