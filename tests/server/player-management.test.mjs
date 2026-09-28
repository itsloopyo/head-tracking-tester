// Player-management tests: setPlayers / stop semantics.
//
// Exercises the bookkeeping logic in server.js:
//   - count clamping to [1, MAX_PLAYERS=4] and integer truncation
//   - players are reported on UDP_PORT + index
//   - describePlayers result (player + port, sorted)
//   - stop and a smaller count stop forwarding without releasing ports
//   - a port that fails to bind is reported per player and retried

import { test, before, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { startServer } from '../helpers/server-harness.mjs';
import { freeTcpPort, freeConsecutiveUdpPorts } from '../helpers/free-ports.mjs';
import { createClient } from '../helpers/ws-client.mjs';

let server;
const openClients = new Set();
const sideSockets = new Set();

async function newClient(target = server) {
  const c = createClient(target.wsUrl);
  openClients.add(c);
  await c.connected();
  await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
  c.drainStatus();
  return c;
}

function newSocket() {
  const sock = dgram.createSocket('udp4');
  sideSockets.add(sock);
  return sock;
}

function bind(sock, port) {
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, '127.0.0.1', resolve);
  });
}

function pose(x) {
  const buf = Buffer.alloc(48);
  buf.writeDoubleLE(x, 0);
  return buf;
}

function send(port, buf) {
  return new Promise((resolve, reject) => {
    newSocket().send(buf, port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
}

before(async () => {
  const httpPort = await freeTcpPort();
  server = await startServer({ httpPort });
});
after(async () => { if (server) await server.stop(); });

afterEach(async () => {
  await Promise.all([...openClients].map((c) => c.close()));
  openClients.clear();
  for (const s of sideSockets) {
    try { s.close(); } catch { /* already closed */ }
  }
  sideSockets.clear();
  const ctrl = createClient(server.wsUrl);
  await ctrl.connected();
  ctrl.send({ action: 'stop' });
  try { await ctrl.waitFor((m) => m.type === 'status' && m.state === 'stopped', { timeoutMs: 1500 }); } catch { /* ignore */ }
  await ctrl.close();
});

describe('setPlayers: count clamping', () => {
  test('count > MAX_PLAYERS is clamped to 4', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 9 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening' && m.players?.length === 4,
      { label: 'clamped to 4' },
    );
    assert.deepEqual(msg.players.map((p) => p.player), [0, 1, 2, 3]);
  });

  test('count < 1 is clamped to 1', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 0 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'clamped to 1' },
    );
    assert.deepEqual(msg.players, [{ player: 0, port: server.udpPort, ok: true }]);
  });

  test('negative count is clamped to 1', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: -42 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'negative clamped' },
    );
    assert.equal(msg.players.length, 1);
  });

  test('fractional count is truncated via | 0', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 2.9 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'fractional truncated' },
    );
    // 2.9 | 0 === 2
    assert.equal(msg.players.length, 2);
  });

  test('non-numeric count → NaN | 0 = 0 → clamped to 1', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 'banana' });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'banana count' },
    );
    assert.equal(msg.players.length, 1);
  });
});

describe('ports come from UDP_PORT', () => {
  test('players are reported on UDP_PORT + index', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 2 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'listening' },
    );
    assert.equal(msg.basePort, server.udpPort);
    assert.deepEqual(msg.players.map((p) => p.port), [server.udpPort, server.udpPort + 1]);
  });
});

describe('status carries basePort while stopped', () => {
  // The page has no port control; it labels its panes from the basePort the
  // server advertises, and the greeting is the only status it gets before it
  // asks for any players.
  test('the connect-time greeting reports the configured base port', async () => {
    const c = createClient(server.wsUrl);
    openClients.add(c);
    await c.connected();
    const greeting = await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
    assert.equal(greeting.state, 'stopped');
    assert.equal(greeting.basePort, server.udpPort);
  });
});

describe('describePlayers payload shape', () => {
  test('players list is sorted by player index and includes port + ok', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 4 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening' && m.players?.length === 4,
      { label: '4-player listening' },
    );
    const base = server.udpPort;
    assert.deepEqual(
      msg.players,
      [
        { player: 0, port: base + 0, ok: true },
        { player: 1, port: base + 1, ok: true },
        { player: 2, port: base + 2, ok: true },
        { player: 3, port: base + 3, ok: true },
      ],
    );
  });
});

describe('stop', () => {
  test('stop halts forwarding, broadcasts stopped, and keeps the ports bound', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 2 });
    await c.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'listening' });
    c.drainStatus();
    c.send({ action: 'stop' });
    const stopMsg = await c.waitFor((m) => m.type === 'status' && m.state === 'stopped', { label: 'stop' });
    // No players field in stopped messages.
    assert.equal(stopMsg.players, undefined);

    await send(server.udpPort, pose(1));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.messages.filter((m) => m.type === 'pose').length, 0);

    for (const p of [server.udpPort, server.udpPort + 1]) {
      await assert.rejects(bind(newSocket(), p), { code: 'EADDRINUSE' });
    }
  });
});

describe('setPlayers: changing the count', () => {
  test('a smaller count stops forwarding the players it drops', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 2 });
    await c.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'two listening' });
    c.drainStatus();
    c.send({ action: 'setPlayers', count: 1 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening' && m.players?.length === 1,
      { label: 'one listening' },
    );
    assert.deepEqual(msg.players, [{ player: 0, port: server.udpPort, ok: true }]);

    await send(server.udpPort + 1, pose(2));
    await send(server.udpPort, pose(1));
    await c.waitFor((m) => m.type === 'pose', { label: 'player 0 pose' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(c.messages.filter((m) => m.type === 'pose').map((m) => m.player), [0]);
  });
});

describe('bind error path', () => {
  test('a port busy at startup is reported per player and bound once it frees up', async () => {
    // A separate server, because the shared one already owns its ports.
    const udpPort = await freeConsecutiveUdpPorts(4);
    const squatter = newSocket();
    await bind(squatter, udpPort + 1);
    const own = await startServer({ httpPort: await freeTcpPort(), udpPort });
    try {
      assert.match(own.stderr, new RegExp(`player 1 on :${udpPort + 1} error`));

      const c = await newClient(own);
      c.send({ action: 'setPlayers', count: 2 });
      const msg = await c.waitFor(
        (m) => m.type === 'status' && m.state === 'listening',
        { label: 'listening with a failed port' },
      );
      assert.deepEqual(msg.players[0], { player: 0, port: udpPort, ok: true });
      assert.equal(msg.players[1].player, 1);
      assert.equal(msg.players[1].port, udpPort + 1);
      assert.equal(msg.players[1].ok, false);
      assert.ok(typeof msg.players[1].message === 'string' && msg.players[1].message.length > 0,
        'failed player should carry the bind error');

      // The retry also fails while the port is held, and says so.
      const retryErr = await c.waitFor(
        (m) => m.type === 'status' && m.state === 'error',
        { label: 'retry error' },
      );
      assert.equal(retryErr.player, 1);
      assert.equal(retryErr.port, udpPort + 1);

      await new Promise((r) => squatter.close(r));
      sideSockets.delete(squatter);
      c.drainStatus();
      c.send({ action: 'setPlayers', count: 2 });
      const recovered = await c.waitFor(
        (m) => m.type === 'status' && m.state === 'listening',
        { label: 'listening after the port frees up' },
      );
      assert.deepEqual(recovered.players[1], { player: 1, port: udpPort + 1, ok: true });
    } finally {
      await own.stop();
    }
  });
});
