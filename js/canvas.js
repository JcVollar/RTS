"use strict";

/* =========================================================================
 * CANVAS — the DOM canvas and 2d context every render/input module shares.
 * ========================================================================= */

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
