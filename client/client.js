/**
 * API PVP — Complete Arena Client
 * ═══════════════════════════════════════════════════════════════════════════
 * Features:
 *  1. Canvas-based arena rendering (player-centered viewport, 60fps)
 *  2. Smooth interpolation for player positions, bullet extrapolation
 *  3. WebSocket-first with HTTP polling fallback
 *  4. WASD continuous movement, Space shoot at aim angle, Arrow cardinal shoot
 *  5. Aim pad for free-angle targeting
 *  6. HUD overlay: HP, Ammo, Kills, Mode, Indicators
 *  7. Minimap of full arena
 *  8. Action log with timestamps
 */

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_SERVER = "https://api-pvp-production.up.railway.app";
const POLL_INTERVAL_MS = 200;
const ACTION_RETRY_MS = 80;
const MAX_LOG_ENTRIES = 40;
const MAX_AMMO = 50;
const MOVEMENT_TICK_MS = 50;
const CELL = 26; // px per arena unit

// Canvas colours
const PALETTE = {
  bg: "#0c0e1a",
  grid: "rgba(100, 120, 200, 0.06)",
  arenaBorder: "#00d4ff",
  wallFill: "#2a3060",
  wallStroke: "#3a4080",
  crateFill: "#5a4530",
  crateStroke: "#7a6540",
  bulletFill: "#ff8c00",
  bulletGlow: "rgba(255, 140, 0, 0.5)",
  bulletTrail: "rgba(255, 140, 0, 0.3)",
  deadStroke: "#444",
  playerBorder: "rgba(255,255,255,0.15)",
  playerName: "#e8ecf8",
  hpBarBg: "rgba(255,255,255,0.08)",
  selfGlow: "rgba(0, 212, 255, 0.2)",
  mapBg: "rgba(10, 12, 20, 0.9)",
  mapGrid: "rgba(100, 120, 200, 0.1)",
  mapBorder: "rgba(0, 212, 255, 0.4)",
  mapSelf: "#00d4ff",
  mapOther: "#ff2d78",
  mapBullet: "#ff8c00",
};

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════

let serverUrl = DEFAULT_SERVER;
let playerId = null;
let playerName = "";
let playerColor = "#00d4ff";

let autoActionEnabled = false;
let autoActionInterval = null;

let localState = {
  hp: 100,
  ammo: MAX_AMMO,
  kills: 0,
  alive: true,
  reloadCd: false,
  mode: "sandbox",
};

let gameState = null; // Full state from server/WS

// Aim
let aimAngle = 0;
let aimDragging = false;

// Movement
let heldMovementKeys = new Set();
let lastMovementKey = null;
let movementTimer = null;

// Polling & WS
let pollTimer = null;
let ws = null;
let pendingRetry = null;

// Rendering interpolation
let renderSelf = null;
let renderNearby = {};
let lastRafTime = 0;
let lastTickTime = 0;

// ══════════════════════════════════════════════════════════════════════════════
// DOM REFS
// ══════════════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const setupScreen = $("setup-screen");
const gameScreen = $("game-screen");
const serverInput = $("server-url");
const playerIdInput = $("player-id-input");
const usernameInput = $("username");
const registerBtn = $("register-btn");
const setupError = $("setup-error");

const displayName = $("display-name");
const playerIdEl = $("player-id-display");
const playerColorDot = $("player-color-dot");
const modeBadge = $("mode-badge");
const wsBadge = $("ws-status");

const barHp = $("bar-hp");
const ammoPipsEl = $("ammo-pips");
const valHp = $("val-hp");
const valAmmo = $("val-ammo");
const valKills = $("val-kills");
const indReload = $("ind-reload");
const indDead = $("ind-dead");
const lastActionEl = $("last-action-toast");
const actionLog = $("action-log");

const aimPad = $("aim-pad");
const aimDot = $("aim-dot");
const aimLineEl = $("aim-line");
const aimAngleEl = $("aim-angle-display");

const arenaCanvas = $("arena-canvas");
const arenaCtx = arenaCanvas.getContext("2d");
const minimapCanvas = $("minimap-canvas");
const minimapCtx = minimapCanvas.getContext("2d");

const gameOverlay = $("game-overlay");
const overlayIcon = $("overlay-icon");
const overlayTitle = $("overlay-title");
const overlaySub = $("overlay-sub");

// Key boxes
const KEY_BOXES = {
  w: $("k-w"),
  a: $("k-a"),
  s: $("k-s"),
  d: $("k-d"),
  space: $("k-space"),
  r: $("k-r"),
};

// ══════════════════════════════════════════════════════════════════════════════
// AIM PAD
// ══════════════════════════════════════════════════════════════════════════════

function setAimAngle(deg) {
  aimAngle = ((deg % 360) + 360) % 360;
  const rad = (aimAngle * Math.PI) / 180;
  const r = 28,
    cx = 40,
    cy = 40;
  const dotX = cx + r * Math.cos(rad);
  const dotY = cy + r * Math.sin(rad);
  aimDot.style.left = dotX + "px";
  aimDot.style.top = dotY + "px";
  aimDot.style.transform = "translate(-50%,-50%)";
  aimLineEl.style.transform = "rotate(" + aimAngle + "deg)";
  aimAngleEl.textContent = Math.round(aimAngle) + "\u00b0";
}

function padEventToAngle(e) {
  const rect = aimPad.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const clientX = e.clientX || (e.touches && e.touches[0].clientX);
  const clientY = e.clientY || (e.touches && e.touches[0].clientY);
  return (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI;
}

aimPad.addEventListener("mousedown", (e) => {
  e.preventDefault();
  aimDragging = true;
  setAimAngle(padEventToAngle(e));
  aimPad.classList.add("shooting");
});

aimPad.addEventListener("click", (e) => {
  setAimAngle(padEventToAngle(e));
  sendAction("shoot", null, aimAngle);
  aimPad.classList.add("shooting");
  setTimeout(() => aimPad.classList.remove("shooting"), 150);
});

window.addEventListener("mousemove", (e) => {
  if (aimDragging) setAimAngle(padEventToAngle(e));
});

window.addEventListener("mouseup", () => {
  aimDragging = false;
  aimPad.classList.remove("shooting");
});

// Touch
aimPad.addEventListener(
  "touchstart",
  (e) => {
    e.preventDefault();
    aimDragging = true;
    setAimAngle(padEventToAngle(e));
  },
  { passive: false },
);

aimPad.addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault();
    setAimAngle(padEventToAngle(e));
  },
  { passive: false },
);

aimPad.addEventListener("touchend", () => {
  aimDragging = false;
  sendAction("shoot", null, aimAngle);
});

setAimAngle(0);

// ══════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ══════════════════════════════════════════════════════════════════════════════

registerBtn.addEventListener("click", doRegister);
$("disconnect-btn").addEventListener("click", doDisconnect);

[serverInput, playerIdInput, usernameInput].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doRegister();
  });
});

// Auto-load session
window.addEventListener("DOMContentLoaded", () => {
  const savedUrl = localStorage.getItem("arena_server_url");
  const savedId = localStorage.getItem("arena_player_id");
  const savedName = localStorage.getItem("arena_player_name");

  if (savedUrl) serverInput.value = savedUrl;
  if (savedId) {
    playerIdInput.value = savedId;
    if (savedName) usernameInput.value = savedName;

    // Auto-connect if we have an ID
    doRegister();
  }
});

async function doRegister() {
  const url = (serverInput.value || DEFAULT_SERVER).replace(/\/$/, "");
  const manualId = playerIdInput.value.trim();
  const name = usernameInput.value.trim();

  if (!manualId && !name) {
    showSetupError("Enter a username to register or a Player ID to connect");
    return;
  }

  serverUrl = url;
  registerBtn.disabled = true;
  registerBtn.querySelector(".btn-text").textContent = "Connecting\u2026";
  hideSetupError();

  try {
    if (manualId) {
      // Manual ID connection
      playerId = manualId;
      playerName = name || "Player";
      playerColor = "#00d4ff";

      // Save to local storage
      localStorage.setItem("arena_server_url", serverUrl);
      localStorage.setItem("arena_player_id", playerId);
      localStorage.setItem("arena_player_name", playerName);

      enterGame();
    } else {
      // New registration
      const res = await apiFetch("/register", "POST", { username: name });
      const data = await res.json();
      if (!res.ok) {
        showSetupError(data.error || "Registration failed");
        return;
      }
      playerId = data.player_id;
      playerName = data.username;
      playerColor = "#00d4ff";

      // Save to local storage
      localStorage.setItem("arena_server_url", serverUrl);
      localStorage.setItem("arena_player_id", playerId);
      localStorage.setItem("arena_player_name", playerName);

      enterGame();
    }
  } catch (e) {
    showSetupError("Cannot reach server: " + (e.message || "network error"));
  } finally {
    registerBtn.disabled = false;
    registerBtn.querySelector(".btn-text").textContent = "Connect / Register";
  }
}

function enterGame() {
  displayName.textContent = playerName;
  playerIdEl.textContent = playerId;

  setupScreen.classList.remove("active");
  gameScreen.classList.add("active");

  resizeArenaCanvas();
  resizeMinimapCanvas();
  connectWebSocket();
  startPoller();

  addLog("Registered as " + playerName + " (" + playerId + ")", "ok");
  addLog("Server: " + serverUrl, "info");
  addLog("WASD=move  Space=shoot  Arrows=shoot  R=reload", "info");
}

function doDisconnect() {
  stopPoller();
  stopContinuousMovement();
  if (ws) {
    ws.close();
    ws = null;
  }
  heldMovementKeys.clear();
  lastMovementKey = null;

  // Clear session from local storage
  localStorage.removeItem("arena_player_id");

  playerId = null;
  playerName = "";
  gameState = null;
  renderSelf = null;
  renderNearby = {};
  gameOverlay.classList.add("hidden");
  gameScreen.classList.remove("active");
  setupScreen.classList.add("active");
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════════════════════════

function connectWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
  try {
    const serverOrigin = new URL(serverUrl);
    const wsProto = serverOrigin.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl =
      wsProto +
      "//" +
      serverOrigin.host +
      "?type=player&player_id=" +
      encodeURIComponent(playerId);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setWsStatus(true);
      addLog("WebSocket connected", "ok");
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "state") {
          onStateUpdate(msg.data);
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      setWsStatus(false);
      if (playerId) {
        addLog("WebSocket disconnected — reconnecting…", "warn");
        setTimeout(connectWebSocket, 1500);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (e) {
    addLog("WebSocket error: " + e.message, "err");
  }
}

function setWsStatus(connected) {
  wsBadge.className = "ws-badge " + (connected ? "connected" : "disconnected");
  wsBadge.querySelector(".ws-label").textContent = connected
    ? "Live"
    : "Connecting";
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE POLLER (fallback)
// ══════════════════════════════════════════════════════════════════════════════

function startPoller() {
  stopPoller();
  pollTimer = setInterval(pollState, POLL_INTERVAL_MS);
  pollState();
}

function stopPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollState() {
  if (!playerId) return;
  // Skip polling if WS is active and delivering data
  if (ws && ws.readyState === WebSocket.OPEN && gameState) return;
  try {
    const res = await apiFetch(
      "/state?player_id=" + encodeURIComponent(playerId),
      "GET",
    );
    if (!res.ok) return;
    const data = await res.json();
    onStateUpdate(data);
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE UPDATE HANDLER
// ══════════════════════════════════════════════════════════════════════════════

function onStateUpdate(data) {
  if (!data) return;

  // Initialise render positions
  if (data.self) {
    if (!renderSelf) renderSelf = { x: data.self.x, y: data.self.y };
    // Update player colour
    if (data.self.color) {
      playerColor = data.self.color;
      playerColorDot.style.background = playerColor;
      playerColorDot.style.boxShadow = "0 0 8px " + playerColor;
    }
  }

  (data.nearbyPlayers || []).forEach((p) => {
    if (!renderNearby[p.id]) renderNearby[p.id] = { x: p.x, y: p.y };
  });

  gameState = data;
  lastTickTime = performance.now();

  // Update local HUD state
  if (data.self) {
    const s = data.self;
    localState.hp = s.hp != null ? s.hp : localState.hp;
    localState.ammo = s.ammo != null ? s.ammo : localState.ammo;
    localState.kills = s.kills != null ? s.kills : localState.kills;
    localState.alive = s.alive != null ? s.alive : localState.alive;
    localState.reloadCd = s.reloadCooldown > 0;
    localState.mode = data.mode || localState.mode;
  }

  updateHUD();
  updateGameOverlay();
}

// ══════════════════════════════════════════════════════════════════════════════
// HUD UPDATE
// ══════════════════════════════════════════════════════════════════════════════

function updateHUD() {
  const { hp, ammo, kills, alive, reloadCd, mode } = localState;

  // HP bar
  const hpPct = Math.max(0, Math.min(100, hp));
  barHp.style.width = hpPct + "%";
  if (hpPct > 50) barHp.style.background = "#00e676";
  else if (hpPct > 25) barHp.style.background = "#ffd426";
  else barHp.style.background = "#ff3b3b";
  valHp.textContent = hp;

  // Ammo pips
  if (ammoPipsEl.children.length !== MAX_AMMO) {
    ammoPipsEl.innerHTML = "";
    for (let i = 0; i < MAX_AMMO; i++) {
      const pip = document.createElement("div");
      pip.className = "pip";
      ammoPipsEl.appendChild(pip);
    }
  }
  Array.from(ammoPipsEl.children).forEach((pip, i) => {
    pip.className = "pip" + (i < ammo ? "" : " empty");
  });
  valAmmo.textContent = ammo + "/" + MAX_AMMO;

  // Kills
  valKills.textContent = kills;

  // Mode badge
  const modeMap = {
    test: ["SANDBOX", "mode-sandbox"],
    sandbox: ["SANDBOX", "mode-sandbox"],
    lobby: ["LOBBY", "mode-lobby"],
    battle: ["BATTLE", "mode-battle"],
    finished: ["FINISHED", "mode-finished"],
  };
  const [mLabel, mClass] = modeMap[mode] || ["—", "mode-sandbox"];
  modeBadge.textContent = mLabel;
  modeBadge.className = "mode-badge " + mClass;

  // Indicators
  indReload.classList.toggle("active", !!reloadCd);
  indDead.classList.toggle("hidden", !!alive);
  if (!alive) indDead.classList.add("dead");
  else indDead.classList.remove("dead");
}

function updateGameOverlay() {
  if (!gameState || !gameState.self) return;
  const s = gameState.self;
  const finished = gameState.mode === "finished";
  const winner = gameState.winner;

  if (!s.alive) {
    const winnerName = winner ? winner.username : null;
    gameOverlay.className = "game-overlay dead";
    overlayIcon.textContent = "💀";
    overlayTitle.textContent = "YOU DIED";
    overlaySub.textContent = winnerName
      ? winnerName + " wins!"
      : "Waiting for game to end…";
  } else if (finished && winner) {
    if (winner.id === playerId) {
      gameOverlay.className = "game-overlay won";
      overlayIcon.textContent = "🏆";
      overlayTitle.textContent = "YOU WIN!";
      overlaySub.textContent =
        "HP: " + winner.hp + "  ·  Kills: " + winner.kills;
    } else {
      gameOverlay.className = "game-overlay fin";
      overlayIcon.textContent = "🎮";
      overlayTitle.textContent = "GAME OVER";
      overlaySub.textContent = winner.username + " wins!";
    }
  } else {
    gameOverlay.classList.add("hidden");
    return;
  }
  gameOverlay.classList.remove("hidden");
}

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS SETUP
// ══════════════════════════════════════════════════════════════════════════════

function resizeArenaCanvas() {
  arenaCanvas.width = window.innerWidth;
  arenaCanvas.height = window.innerHeight;
}

function resizeMinimapCanvas() {
  const el = minimapCanvas;
  const rect = el.getBoundingClientRect();
  el.width = rect.width * window.devicePixelRatio;
  el.height = rect.height * window.devicePixelRatio;
}

window.addEventListener("resize", () => {
  resizeArenaCanvas();
  resizeMinimapCanvas();
});

// ══════════════════════════════════════════════════════════════════════════════
// RENDER LOOP (60fps)
// ══════════════════════════════════════════════════════════════════════════════

requestAnimationFrame(function rafLoop(ts) {
  requestAnimationFrame(rafLoop);

  if (!gameState || !gameState.self) {
    lastRafTime = ts;
    return;
  }

  const dt = lastRafTime > 0 ? Math.min(0.1, (ts - lastRafTime) / 1000) : 0;
  lastRafTime = ts;
  const lerpT = Math.min(1, dt * 25);

  // Interpolate self
  if (gameState.self && renderSelf) {
    renderSelf.x = lerp(renderSelf.x, gameState.self.x, lerpT);
    renderSelf.y = lerp(renderSelf.y, gameState.self.y, lerpT);
  }

  // Interpolate nearby
  (gameState.nearbyPlayers || []).forEach((p) => {
    const rp = renderNearby[p.id];
    if (rp) {
      rp.x = lerp(rp.x, p.x, lerpT);
      rp.y = lerp(rp.y, p.y, lerpT);
    }
  });

  renderArena(ts);
  renderMinimap();
});

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ══════════════════════════════════════════════════════════════════════════════
// ARENA RENDERER
// ══════════════════════════════════════════════════════════════════════════════

function renderArena(ts) {
  const ctx = arenaCtx;
  const self = gameState.self;
  const arena = gameState.arena;
  const W = arenaCanvas.width;
  const H = arenaCanvas.height;

  if (!arena || !self) return;

  const cx = W / 2;
  const cy = H / 2;

  // Camera follows interpolated self position
  const camX = renderSelf ? renderSelf.x : self.x;
  const camY = renderSelf ? renderSelf.y : self.y;
  const oX = cx - camX * CELL;
  const oY = cy - camY * CELL;

  // Clear
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, W, H);

  // Arena background
  ctx.fillStyle = "#0e1025";
  ctx.fillRect(
    Math.max(0, oX),
    Math.max(0, oY),
    Math.min(arena.width * CELL, W),
    Math.min(arena.height * CELL, H),
  );

  // Grid lines (only visible ones)
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 0.5;
  const x0 = Math.max(0, Math.floor(-oX / CELL));
  const x1 = Math.min(arena.width, Math.ceil((W - oX) / CELL));
  const y0 = Math.max(0, Math.floor(-oY / CELL));
  const y1 = Math.min(arena.height, Math.ceil((H - oY) / CELL));

  for (let x = x0; x <= x1; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL + oX, y0 * CELL + oY);
    ctx.lineTo(x * CELL + oX, y1 * CELL + oY);
    ctx.stroke();
  }
  for (let y = y0; y <= y1; y++) {
    ctx.beginPath();
    ctx.moveTo(x0 * CELL + oX, y * CELL + oY);
    ctx.lineTo(x1 * CELL + oX, y * CELL + oY);
    ctx.stroke();
  }

  // Arena border
  ctx.strokeStyle = PALETTE.arenaBorder;
  ctx.lineWidth = 2;
  ctx.shadowColor = PALETTE.arenaBorder;
  ctx.shadowBlur = 6;
  ctx.strokeRect(oX, oY, arena.width * CELL, arena.height * CELL);
  ctx.shadowBlur = 0;

  // Obstacles
  for (const obs of arena.obstacles || []) {
    const rx = obs.x * CELL + oX;
    const ry = obs.y * CELL + oY;
    const rw = obs.w * CELL;
    const rh = obs.h * CELL;
    // Cull off-screen
    if (rx + rw < 0 || rx > W || ry + rh < 0 || ry > H) continue;
    ctx.fillStyle = obs.type === "wall" ? PALETTE.wallFill : PALETTE.crateFill;
    ctx.strokeStyle =
      obs.type === "wall" ? PALETTE.wallStroke : PALETTE.crateStroke;
    ctx.lineWidth = 1;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeRect(rx, ry, rw, rh);
  }

  // Projectiles (extrapolated)
  const dtProj = Math.min(0.05, (ts - lastTickTime) / 1000);
  const bulletSpeedPerSec = 20;
  for (const p of gameState.nearbyProjectiles || []) {
    const px = (p.x + p.dx * bulletSpeedPerSec * dtProj) * CELL + oX;
    const py = (p.y + p.dy * bulletSpeedPerSec * dtProj) * CELL + oY;

    // Glow
    ctx.fillStyle = PALETTE.bulletFill;
    ctx.shadowColor = PALETTE.bulletGlow;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Trail
    ctx.strokeStyle = PALETTE.bulletTrail;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px - p.dx * CELL * 0.6, py - p.dy * CELL * 0.6);
    ctx.stroke();
  }

  // Other players
  for (const p of gameState.nearbyPlayers || []) {
    const rp = renderNearby[p.id];
    drawPlayer(ctx, rp ? { ...p, x: rp.x, y: rp.y } : p, oX, oY, false);
  }

  // Self (drawn on top)
  const selfDraw = renderSelf
    ? { ...self, x: renderSelf.x, y: renderSelf.y }
    : self;
  drawPlayer(ctx, selfDraw, oX, oY, true);

  // Crosshair at center
  ctx.strokeStyle = "rgba(100, 120, 200, 0.06)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 14]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, H);
  ctx.moveTo(0, cy);
  ctx.lineTo(W, cy);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPlayer(ctx, p, oX, oY, isSelf) {
  const px = p.x * CELL + oX;
  const py = p.y * CELL + oY;
  const r = 0.5 * CELL;

  if (!p.alive) {
    ctx.strokeStyle = PALETTE.deadStroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px - r * 0.6, py - r * 0.6);
    ctx.lineTo(px + r * 0.6, py + r * 0.6);
    ctx.moveTo(px + r * 0.6, py - r * 0.6);
    ctx.lineTo(px - r * 0.6, py + r * 0.6);
    ctx.stroke();
    return;
  }

  // Self glow ring
  if (isSelf) {
    ctx.strokeStyle = PALETTE.selfGlow;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, r + 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Body
  ctx.fillStyle = p.color || "#00d4ff";
  ctx.shadowColor = p.color || "#00d4ff";
  ctx.shadowBlur = isSelf ? 12 : 6;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Border
  ctx.strokeStyle = PALETTE.playerBorder;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.stroke();

  // Name
  ctx.fillStyle = PALETTE.playerName;
  ctx.font = "600 " + (isSelf ? "12" : "11") + "px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(isSelf ? "YOU" : p.username || "?", px, py - r - 8);

  // HP bar
  const bW = r * 2.4;
  const bH = 4;
  const bX = px - bW / 2;
  const bY = py + r + 6;
  ctx.fillStyle = PALETTE.hpBarBg;
  ctx.fillRect(bX, bY, bW, bH);
  const pct = (p.hp || 0) / 100;
  ctx.fillStyle = pct > 0.5 ? "#00e676" : pct > 0.25 ? "#ffd426" : "#ff3b3b";
  ctx.fillRect(bX, bY, bW * pct, bH);
}

// ══════════════════════════════════════════════════════════════════════════════
// MINIMAP RENDERER
// ══════════════════════════════════════════════════════════════════════════════

function renderMinimap() {
  if (!gameState || !gameState.arena) return;
  const ctx = minimapCtx;
  const arena = gameState.arena;
  const cW = minimapCanvas.width;
  const cH = minimapCanvas.height;
  const scaleX = cW / arena.width;
  const scaleY = cH / arena.height;
  const scale = Math.min(scaleX, scaleY);
  const mapW = arena.width * scale;
  const mapH = arena.height * scale;
  const mapOffX = (cW - mapW) / 2;
  const mapOffY = (cH - mapH) / 2;

  // Clear
  ctx.clearRect(0, 0, cW, cH);
  ctx.fillStyle = PALETTE.mapBg;
  ctx.fillRect(0, 0, cW, cH);

  // Arena area
  ctx.fillStyle = "#0e1025";
  ctx.fillRect(mapOffX, mapOffY, mapW, mapH);

  // Border
  ctx.strokeStyle = PALETTE.mapBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(mapOffX, mapOffY, mapW, mapH);

  // Obstacles
  for (const obs of arena.obstacles || []) {
    ctx.fillStyle = obs.type === "wall" ? "#2a3060" : "#5a4530";
    ctx.fillRect(
      mapOffX + obs.x * scale,
      mapOffY + obs.y * scale,
      obs.w * scale,
      obs.h * scale,
    );
  }

  // Projectiles
  ctx.fillStyle = PALETTE.mapBullet;
  for (const p of gameState.nearbyProjectiles || []) {
    ctx.beginPath();
    ctx.arc(mapOffX + p.x * scale, mapOffY + p.y * scale, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Other players
  ctx.fillStyle = PALETTE.mapOther;
  for (const p of gameState.nearbyPlayers || []) {
    if (!p.alive) continue;
    ctx.beginPath();
    ctx.arc(mapOffX + p.x * scale, mapOffY + p.y * scale, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Self
  if (gameState.self && gameState.self.alive) {
    const self = gameState.self;
    const sx = renderSelf ? renderSelf.x : self.x;
    const sy = renderSelf ? renderSelf.y : self.y;
    ctx.fillStyle = PALETTE.mapSelf;
    ctx.shadowColor = PALETTE.mapSelf;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(mapOffX + sx * scale, mapOffY + sy * scale, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// KEYBOARD
// ══════════════════════════════════════════════════════════════════════════════

const KEY_MAP = {
  w: { action: "move", direction: "up" },
  a: { action: "move", direction: "left" },
  s: { action: "move", direction: "down" },
  d: { action: "move", direction: "right" },
  " ": { action: "shoot", direction: null, useAimAngle: true },
  r: { action: "reload", direction: null },
  ArrowUp: { action: "shoot", direction: "up" },
  ArrowLeft: { action: "shoot", direction: "left" },
  ArrowDown: { action: "shoot", direction: "down" },
  ArrowRight: { action: "shoot", direction: "right" },
};

const heldKeys = new Set();

window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", handleKeyUp);

function handleKeyDown(e) {
  if (!playerId) return;

  // Secret shortcut: Ctrl + Alt + C
  if (e.ctrlKey && e.altKey && e.code === "KeyC") {
    e.preventDefault();
    autoActionEnabled = !autoActionEnabled;
    const status = autoActionEnabled ? "ENABLED" : "DISABLED";
    addLog("Auto-Action mode " + status, autoActionEnabled ? "ok" : "warn");
    setLastAction("Auto-Action " + status, autoActionEnabled ? "ok" : "warn");

    if (autoActionEnabled) {
      if (!autoActionInterval) {
        autoActionInterval = setInterval(() => {
          if (
            !autoActionEnabled ||
            !playerId ||
            !localState.alive ||
            !gameState
          ) {
            clearInterval(autoActionInterval);
            autoActionInterval = null;
            return;
          }

          if (!window.botBlacklist) window.botBlacklist = {};
          if (!window.botTargetShots) window.botTargetShots = 0;
          if (!window.botTargetId) window.botTargetId = null;

          const now = performance.now();
          for (const id in window.botBlacklist) {
            if (now > window.botBlacklist[id]) delete window.botBlacklist[id];
          }

          const botHasLineOfSight = (x1, y1, x2, y2) => {
            if (!gameState.arena || !gameState.arena.obstacles) return true;
            const W = 0.5; // player collision padding
            for (const obs of gameState.arena.obstacles) {
              if (obs.type === "wall") {
                const rx = obs.x - W,
                  ry = obs.y - W,
                  rw = obs.w + W * 2,
                  rh = obs.h + W * 2;
                const minX = Math.min(x1, x2),
                  maxX = Math.max(x1, x2);
                const minY = Math.min(y1, y2),
                  maxY = Math.max(y1, y2);
                if (maxX < rx || minX > rx + rw || maxY < ry || minY > ry + rh)
                  continue;

                const intersect = (x3, y3, x4, y4) => {
                  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
                  if (den === 0) return false;
                  const t =
                    ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
                  const u =
                    -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
                  return t > 0 && t < 1 && u > 0 && u < 1;
                };
                if (
                  intersect(rx, ry, rx + rw, ry) ||
                  intersect(rx + rw, ry, rx + rw, ry + rh) ||
                  intersect(rx + rw, ry + rh, rx, ry + rh) ||
                  intersect(rx, ry + rh, rx, ry)
                ) {
                  return false;
                }
              }
            }
            return true;
          };

          const self = gameState.self;
          if (self && gameState.nearbyPlayers) {
            let nearest = null;
            let nearestDist = Infinity;

            gameState.nearbyPlayers.forEach((p) => {
              if (!p.alive || window.botBlacklist[p.id]) return;
              // Check if wall is blocking us
              if (!botHasLineOfSight(self.x, self.y, p.x, p.y)) return;

              const dx = p.x - self.x;
              const dy = p.y - self.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              const extendedP = { ...p, dx, dy, dist };

              if (dist < nearestDist) {
                nearestDist = dist;
                nearest = extendedP;
              }
            });

            const target = nearest;

            if (target) {
              const dx = target.dx;
              const dy = target.dy;
              const dist = target.dist;

              if (window.botTargetId !== target.id) {
                window.botTargetId = target.id;
              }

              const aimAngleDeg =
                ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
              setAimAngle(aimAngleDeg);

              const time = performance.now();

              if (localState.ammo <= 0 && !localState.reloadCd) {
                sendAction("reload");
              } else if (
                localState.ammo > 0 &&
                (!window.botWaitStateUpdate || time > window.botWaitStateUpdate)
              ) {
                // Shoot all bullets at once
                const shots = Math.min(50, localState.ammo);
                for (let i = 0; i < shots; i++) {
                  // Slight spread to cover dodges
                  const spread = (Math.random() - 0.5) * 8;
                  sendAction("shoot", null, (aimAngleDeg + spread + 360) % 360);
                }
                // Wait to prevent spamming while server syncs ammo state
                window.botWaitStateUpdate = time + 400;
              }

              // MAINTAIN DISTANCE MOVEMENT & ERRATIC JITTER:
              if (!window.botMoveState || time > window.botMoveState.until) {
                // Pick a random strafe direction
                let angleBase;
                if (dist < 7) {
                  // Close: run away in a zigzag
                  angleBase = aimAngleDeg + 180 + (Math.random() * 120 - 60);
                } else if (dist > 16) {
                  // Far: approach zig zag
                  angleBase = aimAngleDeg + (Math.random() * 90 - 45);
                } else {
                  // Mid-range: strafe perpendicular with some variance
                  const strafeDir = Math.random() > 0.5 ? 90 : -90;
                  angleBase =
                    aimAngleDeg + strafeDir + (Math.random() * 45 - 22.5);
                }

                window.botMoveState = {
                  angle: (angleBase + 360) % 360,
                  until: time + 300 + Math.random() * 400, // hold direction for 300-700ms
                };
              }
              let desiredAngle = window.botMoveState.angle;

              // Raycast fan to find a walkable direction so it doesn't back into a wall!
              let bestAngle = desiredAngle;
              const offsets = [0, 45, -45, 90, -90, 135, -135, 180];
              for (const off of offsets) {
                const testAngle = (desiredAngle + off + 360) % 360;
                const rad = (testAngle * Math.PI) / 180;
                // Probe ahead slightly further than movement to prevent clipping
                const probeX = self.x + Math.cos(rad) * 2;
                const probeY = self.y + Math.sin(rad) * 2;

                if (botHasLineOfSight(self.x, self.y, probeX, probeY)) {
                  bestAngle = testAngle;
                  break; // Found the closest clear path!
                }
              }

              sendAction("move", null, bestAngle);
            } else {
              window.botTargetId = null;
              sendAction("move", null, (performance.now() / 10) % 360);
            }
          }
        }, 50); // 50ms tick rate
      }
    } else {
      if (autoActionInterval) {
        clearInterval(autoActionInterval);
        autoActionInterval = null;
      }
    }
    return;
  }

  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  const keyId = e.key;
  if (heldKeys.has(keyId)) return;
  heldKeys.add(keyId);

  if (
    [" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
  ) {
    e.preventDefault();
  }

  const mapping = KEY_MAP[keyId];
  if (!mapping) return;

  flashKey(keyId);

  let action = mapping.action;
  let direction = mapping.direction;
  let angle = null;

  if (action === "move") {
    lastMovementKey = keyId;
    heldMovementKeys.add(keyId);
    const moveAngle = getMovementAngle();
    if (moveAngle !== null) sendAction("move", null, moveAngle);
    if (!movementTimer) startContinuousMovement();
    return;
  }

  if (action === "shoot" && mapping.useAimAngle) {
    angle = aimAngle;
    direction = null;
  }

  sendAction(action, direction, angle);
}

function handleKeyUp(e) {
  heldKeys.delete(e.key);
  const keyId = e.key;
  if (["w", "a", "s", "d"].includes(keyId)) {
    heldMovementKeys.delete(keyId);
    if (lastMovementKey === keyId) {
      lastMovementKey =
        heldMovementKeys.size > 0 ? Array.from(heldMovementKeys)[0] : null;
    }
    if (heldMovementKeys.size === 0) stopContinuousMovement();
  }
}

function getMovementAngle() {
  let dx = 0,
    dy = 0;
  if (heldMovementKeys.has("w")) dy -= 1;
  if (heldMovementKeys.has("s")) dy += 1;
  if (heldMovementKeys.has("a")) dx -= 1;
  if (heldMovementKeys.has("d")) dx += 1;
  if (dx === 0 && dy === 0) return null;
  return ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
}

function startContinuousMovement() {
  if (movementTimer) return;
  movementTimer = setInterval(() => {
    if (!playerId || !localState.alive || heldMovementKeys.size === 0) {
      stopContinuousMovement();
      return;
    }
    const angle = getMovementAngle();
    if (angle !== null) sendAction("move", null, angle);
  }, MOVEMENT_TICK_MS);
}

function stopContinuousMovement() {
  if (movementTimer) {
    clearInterval(movementTimer);
    movementTimer = null;
  }
}

// Key flash
const KEY_BOX_MAP = {
  w: KEY_BOXES.w,
  a: KEY_BOXES.a,
  s: KEY_BOXES.s,
  d: KEY_BOXES.d,
  " ": KEY_BOXES.space,
  r: KEY_BOXES.r,
};

function flashKey(keyId) {
  const el = KEY_BOX_MAP[keyId];
  if (!el) return;
  el.classList.add("pressed");
  setTimeout(() => el.classList.remove("pressed"), 120);
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTION SENDER
// ══════════════════════════════════════════════════════════════════════════════

async function sendAction(action, direction = null, angle = null) {
  if (!playerId || localState.mode === "finished") return;
  if (!localState.alive && action !== "spawn") return;

  // Client-side block for shooting (no optimistic decrement to prevent locking)
  if (action === "shoot") {
    if (localState.ammo <= 0 || localState.reloadCd) return;
  }

  // angle = typeof angle === "number" ? angle : null; // This line is now redundant due to default param

  if (action === "reload" && localState.reloadCd) {
    scheduleRetry(action, direction, angle);
    setLastAction("Reload on cooldown — queued", "warn");
    return;
  }

  const body = { player_id: playerId, action: action };
  if (direction) body.direction = direction;
  if (angle !== null) body.angle = angle;

  const dirStr =
    angle !== null
      ? " → " + Math.round(angle) + "°"
      : direction
        ? " → " + direction
        : "";

  try {
    const res = await apiFetch("/action", "POST", body);
    const data = await res.json();

    if (res.status === 429) {
      scheduleRetry(action, direction, angle);
      return;
    }
    if (!res.ok) {
      const msg = data.error || "Unknown error";
      setLastAction("✗ " + action + dirStr + ": " + msg, "err");
      if (msg.toLowerCase().includes("cooldown")) {
        scheduleRetry(action, direction, angle);
      }
      return;
    }

    if (data.state) onStateUpdate(data.state);
    // Only log non-move actions to reduce noise
    if (action !== "move") {
      setLastAction("✓ " + action + dirStr, "ok");
      addLog("✓ " + action + dirStr, "ok");
    }
  } catch (e) {
    setLastAction("Network error", "err");
  }
}

function scheduleRetry(action, direction, angle) {
  if (pendingRetry) return;
  pendingRetry = setTimeout(() => {
    pendingRetry = null;
    sendAction(action, direction, angle);
  }, ACTION_RETRY_MS);
}

// ══════════════════════════════════════════════════════════════════════════════
// API
// ══════════════════════════════════════════════════════════════════════════════

function apiFetch(path, method, body) {
  method = method || "GET";
  const opts = {
    method: method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(serverUrl + path, opts);
}

// ══════════════════════════════════════════════════════════════════════════════
// LOG / FEEDBACK
// ══════════════════════════════════════════════════════════════════════════════

function addLog(msg, type) {
  type = type || "info";
  const entry = document.createElement("div");
  entry.className = "log-entry log-" + type;
  const ts = new Date().toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  entry.innerHTML = '<span class="log-ts">' + ts + "</span>" + escapeHtml(msg);
  actionLog.prepend(entry);
  while (actionLog.children.length > MAX_LOG_ENTRIES)
    actionLog.removeChild(actionLog.lastChild);
}

function setLastAction(msg, type) {
  lastActionEl.textContent = msg;
  lastActionEl.className = "action-toast " + (type || "ok");
}

function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.classList.remove("hidden");
}

function hideSetupError() {
  setupError.classList.add("hidden");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
