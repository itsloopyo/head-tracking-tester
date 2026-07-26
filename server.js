// Minimal bridge: serves the static viewer, binds N UDP listeners on
// consecutive ports on demand, and forwards parsed poses (tagged with
// their player index) to browsers via WebSocket.

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');

const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
const DEFAULT_BASE_PORT = Number(process.env.UDP_PORT) || 4242;
const MAX_PLAYERS = 4;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Trailing separator so a sibling directory sharing the prefix (…/public-x)
// can't pass the containment check.
const PUBLIC_PREFIX = PUBLIC_DIR + path.sep;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ---------- static file server ----------
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/healthz') {
    const body = JSON.stringify({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      listening: sockets.size > 0,
      basePort: currentBasePort,
      players: describePlayers(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
    return;
  }
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_PREFIX)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- websocket fan-out ----------
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ---------- UDP listeners (started on demand, one per player) ----------
// Map<port, { sock, player }>
const sockets = new Map();
let currentBasePort = DEFAULT_BASE_PORT;

function describePlayers() {
  const out = [];
  for (const [port, { player }] of sockets) out.push({ player, port, ok: true });
  out.sort((a, b) => a.player - b.player);
  return out;
}

// basePort rides along even when stopped: it's how the page learns which
// port UDP_PORT actually configured, before anything is bound.
function statusPayload() {
  if (sockets.size > 0) {
    return { type: 'status', state: 'listening', basePort: currentBasePort, players: describePlayers() };
  }
  return { type: 'status', state: 'stopped', basePort: currentBasePort };
}

function broadcastStatus() {
  broadcast(statusPayload());
}

function stopAll() {
  for (const { sock } of sockets.values()) {
    try { sock.close(); } catch (_) { /* ignore */ }
  }
  sockets.clear();
  broadcastStatus();
}

function bindPlayer(player, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');

    sock.on('error', (err) => {
      console.error(`[udp] player ${player} on :${port} error: ${err.message}`);
      broadcast({ type: 'status', state: 'error', player, port, message: err.message });
      try { sock.close(); } catch (_) { /* ignore */ }
      sockets.delete(port);
      resolve(false);
    });

    sock.on('listening', () => {
      const addr = sock.address();
      console.log(`[udp] player ${player} on ${addr.address}:${addr.port}`);
      sockets.set(port, { sock, player });
      resolve(true);
    });

    // Per-port wire statistics. A source can send at 60 Hz and still LOOK like 30:
    // what a viewer perceives is the rate of DISTINCT poses and the regularity of
    // their arrival, not the packet count. Reported separately so a low-framerate
    // complaint can be attributed instead of guessed at.
    const st = { n: 0, distinct: 0, last: null, prevT: 0, gaps: [], t0: Date.now() };

    sock.on('message', (msg) => {
      if (msg.length < 48) return;
      const now = Number(process.hrtime.bigint() / 1000n) / 1000.0;
      if (st.prevT) st.gaps.push(now - st.prevT);
      st.prevT = now;
      st.n++;
      const sig = msg.toString('latin1');
      if (sig !== st.last) { st.distinct++; st.last = sig; }
      if (Date.now() - st.t0 >= 2000) {
        const g = st.gaps.slice().sort((a, b) => a - b);
        const q = (f) => g.length ? g[Math.min(g.length - 1, Math.floor(f * g.length))] : 0;
        const secs = (Date.now() - st.t0) / 1000;
        console.log(`[wire] :${port}  ${(st.n / secs).toFixed(1)} pkt/s  ` +
          `${(st.distinct / secs).toFixed(1)} DISTINCT/s  ` +
          `gap ms p50 ${q(0.5).toFixed(1)} p95 ${q(0.95).toFixed(1)} max ${q(0.999).toFixed(1)}`);
        st.n = 0; st.distinct = 0; st.gaps = []; st.t0 = Date.now();
      }
      broadcast({
        type: 'pose',
        player,
        x: msg.readDoubleLE(0),
        y: msg.readDoubleLE(8),
        z: msg.readDoubleLE(16),
        yaw: msg.readDoubleLE(24),
        pitch: msg.readDoubleLE(32),
        roll: msg.readDoubleLE(40),
      });
    });

    sock.bind(port);
  });
}

async function setPlayers(count, basePort) {
  count = Math.max(1, Math.min(MAX_PLAYERS, count | 0));
  basePort = Number(basePort) > 0 ? Number(basePort) : DEFAULT_BASE_PORT;
  // tear down everything, then rebind so it's clean
  for (const { sock } of sockets.values()) {
    try { sock.close(); } catch (_) { /* ignore */ }
  }
  sockets.clear();
  currentBasePort = basePort;
  for (let i = 0; i < count; i++) {
    await bindPlayer(i, basePort + i);
  }
  broadcastStatus();
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw.toString()); } catch (_) { return; }
    if (cmd.action === 'setPlayers') {
      setPlayers(cmd.count, cmd.basePort);
    } else if (cmd.action === 'stop') {
      stopAll();
    }
  });
  // tell this client the current state immediately
  ws.send(JSON.stringify(statusPayload()));
});

server.listen(HTTP_PORT, () => {
  console.log(`[http] head-tracking-tester on http://localhost:${HTTP_PORT}`);
  console.log(`[udp] default base port ${DEFAULT_BASE_PORT} (start from the UI)`);
});

function shutdown() {
  stopAll();
  // Live WebSockets are keep-alive connections; without dropping them
  // server.close() never calls back and the container waits out docker's
  // 10s SIGKILL grace period.
  for (const ws of clients) ws.terminate();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
