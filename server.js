// Minimal bridge: serves the static viewer, binds one UDP listener per
// player on consecutive ports, and forwards parsed poses (tagged with
// their player index) to browsers via WebSocket.

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');

const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
const BASE_PORT = Number(process.env.UDP_PORT) || 4242;
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
      listening: activeCount > 0,
      basePort: BASE_PORT,
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

const POSE_LIMIT = 1e9;
function isSanePose(p) {
  return Number.isFinite(p.x) && Math.abs(p.x) <= POSE_LIMIT
    && Number.isFinite(p.y) && Math.abs(p.y) <= POSE_LIMIT
    && Number.isFinite(p.z) && Math.abs(p.z) <= POSE_LIMIT
    && Number.isFinite(p.yaw) && Math.abs(p.yaw) <= POSE_LIMIT
    && Number.isFinite(p.pitch) && Math.abs(p.pitch) <= POSE_LIMIT
    && Number.isFinite(p.roll) && Math.abs(p.roll) <= POSE_LIMIT;
}

// ---------- UDP listeners (one per player, bound for the whole run) ----------
// Every player's port is bound at startup and stays bound; the player count
// only decides which ports get forwarded. Docker Desktop's UDP port forwarder
// permanently stops listening on a published port once the container answers
// a datagram on it with "port unreachable", so a tracker that is already
// streaming before its pane exists would otherwise be cut off until the
// container restarts.
// Map<player, dgram.Socket>
const sockets = new Map();
// Map<player, message> for ports whose last bind attempt failed
const bindErrors = new Map();
let activeCount = 0;

function describePlayers() {
  const out = [];
  for (let player = 0; player < activeCount; player++) {
    const entry = { player, port: BASE_PORT + player, ok: sockets.has(player) };
    if (!entry.ok) entry.message = bindErrors.get(player);
    out.push(entry);
  }
  return out;
}

// basePort rides along even when stopped: it's how the page learns which
// port UDP_PORT actually configured, before it asks for any players.
function statusPayload() {
  if (activeCount > 0) {
    return { type: 'status', state: 'listening', basePort: BASE_PORT, players: describePlayers() };
  }
  return { type: 'status', state: 'stopped', basePort: BASE_PORT };
}

function broadcastStatus() {
  broadcast(statusPayload());
}

function stopForwarding() {
  activeCount = 0;
  broadcastStatus();
}

function bindPlayer(player) {
  const port = BASE_PORT + player;
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');

    sock.on('error', (err) => {
      console.error(`[udp] player ${player} on :${port} error: ${err.message}`);
      broadcast({ type: 'status', state: 'error', player, port, message: err.message });
      try { sock.close(); } catch (_) { /* ignore */ }
      sockets.delete(player);
      bindErrors.set(player, err.message);
      resolve();
    });

    sock.on('listening', () => {
      const addr = sock.address();
      console.log(`[udp] player ${player} on ${addr.address}:${addr.port}`);
      sockets.set(player, sock);
      bindErrors.delete(player);
      resolve();
    });

    // Per-port wire statistics. A source can send at 60 Hz and still LOOK like 30:
    // what a viewer perceives is the rate of DISTINCT poses and the regularity of
    // their arrival, not the packet count. Reported separately so a low-framerate
    // complaint can be attributed instead of guessed at.
    const st = { n: 0, distinct: 0, last: null, prevT: 0, gaps: [], t0: Date.now() };

    sock.on('message', (msg) => {
      if (player >= activeCount) return;
      if (msg.length < 48) return;
      const now = Number(process.hrtime.bigint() / 1000n) / 1000.0;
      if (st.prevT) st.gaps.push(now - st.prevT);
      st.prevT = now;
      st.n++;
      // Signature covers only the pose bytes: the 56-byte extension carries a
      // per-packet send time that would make every packet read as distinct.
      const sig = msg.toString('latin1', 0, 48);
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
      // Arrival on the server's monotonic clock. Every source is stamped by the
      // same clock here, which is what makes cross-source lag measurable: the
      // browser's own receive times carry WS batching and scheduling noise that
      // differs per pane.
      const pose = {
        type: 'pose',
        player,
        rt: now,
        x: msg.readDoubleLE(0),
        y: msg.readDoubleLE(8),
        z: msg.readDoubleLE(16),
        yaw: msg.readDoubleLE(24),
        pitch: msg.readDoubleLE(32),
        roll: msg.readDoubleLE(40),
      };
      // The socket is open to anything on the wire, and any 48 bytes decode to
      // six doubles, so a mis-framed sender produces enormous garbage. The
      // magnitude bound matters as much as finiteness: the page unwraps angles
      // by subtracting 360, and past about 1.6e18 degrees that subtraction
      // rounds back to the same double and loops until the tab is killed. No
      // real pose is within nine orders of magnitude of the limit.
      if (!isSanePose(pose)) return;
      // 56-byte extension (headcam): a 7th double carrying the sender's
      // monotonic send time. Lets the client rebuild the pose stream on the
      // send timeline, where delivery jitter doesn't exist. Finite-gated:
      // an arbitrary >48-byte datagram from another sender decodes to junk.
      if (msg.length >= 56) {
        const sendTime = msg.readDoubleLE(48);
        if (Number.isFinite(sendTime)) pose.st = sendTime;
      }
      broadcast(pose);
    });

    sock.bind(port);
  });
}

// Shared so overlapping callers never bind the same port twice. Rerun on
// every setPlayers, which picks up a port that was busy at startup once
// whatever held it lets go.
let binding = null;
function bindMissing() {
  binding ??= (async () => {
    for (let player = 0; player < MAX_PLAYERS; player++) {
      if (!sockets.has(player)) await bindPlayer(player);
    }
  })().finally(() => { binding = null; });
  return binding;
}

async function setPlayers(count) {
  activeCount = Math.max(1, Math.min(MAX_PLAYERS, count | 0));
  await bindMissing();
  broadcastStatus();
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw.toString()); } catch (_) { return; }
    if (cmd.action === 'setPlayers') {
      setPlayers(cmd.count);
    } else if (cmd.action === 'stop') {
      stopForwarding();
    }
  });
  // tell this client the current state immediately
  ws.send(JSON.stringify(statusPayload()));
});

bindMissing().then(() => {
  server.listen(HTTP_PORT, () => {
    console.log(`[http] head-tracking-tester on http://localhost:${HTTP_PORT}`);
  });
});

function shutdown() {
  for (const sock of sockets.values()) sock.close();
  sockets.clear();
  // Live WebSockets are keep-alive connections; without dropping them
  // server.close() never calls back and the container waits out docker's
  // 10s SIGKILL grace period.
  for (const ws of clients) ws.terminate();
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
