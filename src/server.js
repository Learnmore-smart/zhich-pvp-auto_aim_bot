const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const GameEngine = require("./game/GameEngine");
const SandboxManager = require("./game/SandboxManager");
const createApiRouter = require("./routes/api");
const { rateLimiter } = require("./middleware/rateLimiter");

const PORT = process.env.PORT || 3000;

// ── App Setup ─────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ── CORS — allow any origin (clients on Vercel, local dev, etc.) ──────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204); // preflight fast-path
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "views")));
app.use("/client", express.static(path.join(__dirname, "../client")));

// ── Root Redirect ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.redirect("/bigscreen");
});

// ── Game State ────────────────────────────────────────────────────────────────
//  playerRegistry  → global source of truth for all registered players
//  sandboxManager  → one isolated GameEngine per player (sandbox / test mode)
//  battleEngine    → single shared arena for battle, null when not active
const playerRegistry = new Map(); // playerId → { username, ready, color }
const sandboxManager = new SandboxManager();
let battleEngine = null;
let battleActive = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getEngineForPlayer(playerId) {
  if (battleActive && battleEngine) return battleEngine;
  return sandboxManager.get(playerId);
}

function getLobbyState() {
  const players = [];
  for (const [id, info] of playerRegistry) {
    players.push({
      id,
      username: info.username,
      ready: info.ready,
      color: info.color,
    });
  }
  return {
    mode: "lobby",
    tick: 0,
    players,
    arena: null,
    projectiles: [],
    winner: null,
  };
}

function doStartBattle() {
  if (battleActive) return { error: "Battle already in progress" };
  if (playerRegistry.size === 0) return { error: "No players registered" };

  const engine = new GameEngine();

  // Register every player preserving their sandbox ID and colour
  for (const [playerId, info] of playerRegistry) {
    engine.registerPlayer(info.username, playerId, info.color);
  }

  const result = engine.startBattle();
  if (result.error) return result;

  battleEngine = engine;
  battleActive = true;

  // Broadcast on every battle tick
  battleEngine.onStateUpdate = (fullState) => {
    for (const client of wsClients) {
      if (client.ws.readyState !== 1) continue;
      try {
        if (client.type === "bigscreen") {
          client.ws.send(JSON.stringify({ type: "state", data: fullState }));
        } else if (client.type === "player" && client.playerId) {
          const pState = battleEngine.getPlayerState(client.playerId);
          if (pState)
            client.ws.send(JSON.stringify({ type: "state", data: pState }));
        }
      } catch (_) {
        /* stale connection */
      }
    }
  };

  return result;
}

function doReset() {
  if (battleEngine) {
    battleEngine._stopTickLoop();
    battleEngine = null;
  }
  battleActive = false;

  for (const [playerId, info] of playerRegistry) {
    const sandbox = sandboxManager.get(playerId);
    if (sandbox) sandbox.resetToLobby();
    info.ready = false;
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const type = url.searchParams.get("type") || "bigscreen";
  const playerId = url.searchParams.get("player_id") || null;

  const client = { ws, type, playerId };
  wsClients.add(client);

  sendToClient(client);

  ws.on("close", () => wsClients.delete(client));
  ws.on("error", () => wsClients.delete(client));
});

function sendToClient(client) {
  if (client.ws.readyState !== 1) return;
  try {
    if (client.type === "bigscreen") {
      const state =
        battleActive && battleEngine
          ? battleEngine.getFullState()
          : getLobbyState();
      client.ws.send(JSON.stringify({ type: "state", data: state }));
    } else if (client.type === "player" && client.playerId) {
      const engine = getEngineForPlayer(client.playerId);
      if (!engine) return;
      const state = engine.getPlayerState(client.playerId);
      if (state) client.ws.send(JSON.stringify({ type: "state", data: state }));
    }
  } catch (_) {
    /* ignore */
  }
}

// Periodic push for sandbox/lobby — battle engine broadcasts itself via onStateUpdate
setInterval(() => {
  if (battleActive) return;
  for (const client of wsClients) {
    if (client.ws.readyState !== 1) continue;
    try {
      if (client.type === "bigscreen") {
        client.ws.send(
          JSON.stringify({ type: "state", data: getLobbyState() }),
        );
      } else if (client.type === "player" && client.playerId) {
        const sandbox = sandboxManager.get(client.playerId);
        if (!sandbox) continue;
        const state = sandbox.getPlayerState(client.playerId);
        if (state)
          client.ws.send(JSON.stringify({ type: "state", data: state }));
      }
    } catch (_) {
      /* ignore */
    }
  }
}, 50);

// ── API Routes ────────────────────────────────────────────────────────────────
const context = {
  get battleActive() {
    return battleActive;
  },
  get battleEngine() {
    return battleEngine;
  },
  sandboxManager,
  playerRegistry,
  getEngineForPlayer,
  doStartBattle,
  doReset,
};

app.use("/action", rateLimiter);
app.use("/", createApiRouter(context));

// ── Views ─────────────────────────────────────────────────────────────────────
app.get("/bigscreen", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "bigscreen.html"));
});
app.get("/monitor", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "player.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║           🎮  API PVP ARENA  🎮                  ║
╠═══════════════════════════════════════════════════╣
║                                                   ║
║  Big Screen: http://localhost:${PORT}/             ║
║  Control:    http://localhost:${PORT}/client       ║
║  Monitor:    http://localhost:${PORT}/monitor      ║
║                                                   ║
║  Modes:  sandbox (isolated per player)            ║
║          → battle (shared arena)                  ║
║                                                   ║
║  POST /register  → creates private sandbox        ║
║  POST /action    → sandbox or battle (auto-routed)║
║  GET  /state     → player or full arena state     ║
║  POST /ready     → signal ready for battle        ║
║  POST /start     → launch shared battle           ║
║  POST /reset     → back to sandbox mode           ║
║  GET  /debug     → full debug info                ║
║  GET  /players   → list all players               ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
  `);
});
