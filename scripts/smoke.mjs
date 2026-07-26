// End-to-end smoke test of the built image: boots the container and drives
// the full path a real session uses — HTTP page load, /healthz, WebSocket
// control channel, and an OpenTrack UDP datagram coming back out as a pose.
//
// Run via `pixi run smoke` (builds the image first). Exits non-zero on the
// first thing that doesn't work; nothing is retried past its deadline.

import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';

const IMAGE = process.env.SMOKE_IMAGE || 'head-tracking-tester:dev';
const NAME = 'head-tracking-tester-smoke';
const BOOT_TIMEOUT_MS = 30_000;
const POSE_TIMEOUT_MS = 5_000;

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...opts }).trim();
}

function freePort(kind) {
  if (kind === 'udp') {
    const sock = dgram.createSocket('udp4');
    return new Promise((resolve, reject) => {
      sock.on('error', reject);
      sock.bind(0, '127.0.0.1', () => {
        const { port } = sock.address();
        sock.close(() => resolve(port));
      });
    });
  }
  const srv = net.createServer();
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      const body = await res.json();
      if (res.ok && body.status === 'ok') return body;
      lastError = `HTTP ${res.status} ${JSON.stringify(body)}`;
    } catch (err) {
      lastError = err.message;
    }
    await sleep(250);
  }
  throw new Error(`/healthz never became ready within ${BOOT_TIMEOUT_MS}ms (last: ${lastError})`);
}

// OpenTrack wire format: six little-endian float64s, X Y Z Yaw Pitch Roll.
function openTrackPacket(values) {
  const buf = Buffer.allocUnsafe(48);
  values.forEach((v, i) => buf.writeDoubleLE(v, i * 8));
  return buf;
}

function openWebSocket(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    messages.push(msg);
    for (const w of waiters.splice(0)) w(msg);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`WebSocket to ${url} failed`)));
  });
  return {
    ws,
    ready,
    send: (obj) => ws.send(JSON.stringify(obj)),
    async waitFor(predicate, timeoutMs, what) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const hit = messages.find(predicate);
        if (hit) return hit;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await Promise.race([
          new Promise((resolve) => waiters.push(resolve)),
          sleep(remaining),
        ]);
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; saw ${JSON.stringify(messages)}`);
    },
  };
}

function cleanup() {
  spawnSync('docker', ['rm', '--force', NAME], { stdio: 'ignore' });
}

const httpPort = await freePort('tcp');
const udpPort = await freePort('udp');
const base = `http://127.0.0.1:${httpPort}`;

cleanup();
console.log(`[smoke] starting ${IMAGE} on http :${httpPort}, udp :${udpPort}`);
docker([
  'run', '--detach', '--name', NAME,
  '--publish', `127.0.0.1:${httpPort}:8080/tcp`,
  '--publish', `127.0.0.1:${udpPort}:4242/udp`,
  IMAGE,
]);

try {
  const health = await waitForHealth(base);
  console.log(`[smoke] /healthz ok (uptime ${health.uptime}s, listening=${health.listening})`);

  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (!page.ok) throw new Error(`GET / returned HTTP ${page.status}`);
  if (!html.includes('<title>Head Tracking Tester</title>')) {
    throw new Error('GET / did not return the viewer page');
  }
  const contentType = page.headers.get('content-type');
  if (!contentType.startsWith('text/html')) {
    throw new Error(`GET / had content-type ${contentType}`);
  }
  console.log(`[smoke] GET / served the viewer (${html.length} bytes)`);

  const renderer = await fetch(`${base}/renderer.js`);
  if (!renderer.ok) throw new Error(`GET /renderer.js returned HTTP ${renderer.status}`);
  console.log(`[smoke] GET /renderer.js ok (${(await renderer.text()).length} bytes)`);

  const client = openWebSocket(`ws://127.0.0.1:${httpPort}`);
  await client.ready;
  await client.waitFor((m) => m.type === 'status', 5_000, 'initial status');
  // No basePort, exactly like the page: the server uses its own UDP_PORT.
  client.send({ action: 'setPlayers', count: 1 });
  await client.waitFor(
    (m) => m.type === 'status' && m.state === 'listening',
    5_000,
    'listening status after setPlayers',
  );
  console.log('[smoke] websocket control channel bound the UDP listener');

  const sender = dgram.createSocket('udp4');
  const packet = openTrackPacket([1.5, -2.5, 3.5, 10.25, -20.5, 30.75]);
  const poseSeen = client.waitFor((m) => m.type === 'pose', POSE_TIMEOUT_MS, 'a forwarded pose');
  // Datagrams sent before the listener is fully wired are simply lost, so
  // keep re-sending until one comes back through the WebSocket.
  const pump = setInterval(() => sender.send(packet, udpPort, '127.0.0.1'), 100);
  let pose;
  try {
    pose = await poseSeen;
  } finally {
    clearInterval(pump);
    sender.close();
  }
  if (pose.yaw !== 10.25 || pose.pitch !== -20.5 || pose.roll !== 30.75) {
    throw new Error(`pose round-tripped with wrong values: ${JSON.stringify(pose)}`);
  }
  console.log(`[smoke] udp → websocket pose round-trip ok (player ${pose.player})`);

  client.ws.close();
  console.log('[smoke] PASS');
} catch (err) {
  console.error('[smoke] FAIL:', err.message);
  console.error('[smoke] container logs:');
  spawnSync('docker', ['logs', NAME], { stdio: 'inherit' });
  process.exitCode = 1;
} finally {
  cleanup();
}
