// Player-management tests: setPlayers / stop semantics.
//
// Exercises the bookkeeping logic in server.js:
//   - count clamping to [1, MAX_PLAYERS=4] and integer truncation
//   - basePort fallback when 0 / negative / non-numeric
//   - describePlayers result (player + port, sorted)
//   - setPlayers tears down existing sockets before rebinding
//   - bind-error broadcast when the requested port is already in use

import { test, before, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { startServer } from '../helpers/server-harness.mjs';
import { freeTcpPort, freeUdpPort, freeConsecutiveUdpPorts } from '../helpers/free-ports.mjs';
import { createClient } from '../helpers/ws-client.mjs';

let server;
let defaultUdpPort;
const openClients = new Set();
const sideSockets = new Set();

async function newClient() {
  const c = createClient(server.wsUrl);
  openClients.add(c);
  await c.connected();
  await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
  c.drainStatus();
  return c;
}

before(async () => {
  const httpPort = await freeTcpPort();
  // Pre-allocate a free UDP port the server will keep as its default
  // base port, so basePort-fallback tests don't collide with whatever
  // is running on 4242 on the host machine.
  defaultUdpPort = await freeConsecutiveUdpPorts(4);
  server = await startServer({ httpPort, udpPort: defaultUdpPort });
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
    const basePort = await freeConsecutiveUdpPorts(4);
    c.send({ action: 'setPlayers', count: 9, basePort });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening' && m.players?.length === 4,
      { label: 'clamped to 4' },
    );
    assert.equal(msg.players.length, 4);
    assert.deepEqual(msg.players.map((p) => p.player), [0, 1, 2, 3]);
  });

  test('count < 1 is clamped to 1', async () => {
    const c = await newClient();
    const basePort = await freeConsecutiveUdpPorts(1);
    c.send({ action: 'setPlayers', count: 0, basePort });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening' && m.players?.length === 1,
      { label: 'clamped to 1' },
    );
    assert.deepEqual(msg.players, [{ player: 0, port: basePort, ok: true }]);
  });

  test('negative count is clamped to 1', async () => {
    const c = await newClient();
    const basePort = await freeConsecutiveUdpPorts(1);
    c.send({ action: 'setPlayers', count: -42, basePort });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'negative clamped' },
    );
    assert.equal(msg.players.length, 1);
  });

  test('fractional count is truncated via | 0', async () => {
    const c = await newClient();
    const basePort = await freeConsecutiveUdpPorts(2);
    c.send({ action: 'setPlayers', count: 2.9, basePort });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'fractional truncated' },
    );
    // 2.9 | 0 === 2
    assert.equal(msg.players.length, 2);
  });

  test('non-numeric count → NaN | 0 = 0 → clamped to 1', async () => {
    const c = await newClient();
    const basePort = await freeConsecutiveUdpPorts(1);
    c.send({ action: 'setPlayers', count: 'banana', basePort });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'banana count' },
    );
    assert.equal(msg.players.length, 1);
  });
});

describe('setPlayers: basePort fallback', () => {
  test('basePort = 0 falls back to default UDP_PORT', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 1, basePort: 0 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'fallback zero' },
    );
    assert.equal(msg.basePort, defaultUdpPort);
    assert.equal(msg.players[0].port, defaultUdpPort);
  });

  test('basePort < 0 falls back to default UDP_PORT', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 1, basePort: -123 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'fallback negative' },
    );
    assert.equal(msg.basePort, defaultUdpPort);
  });

  test('basePort non-numeric falls back to default UDP_PORT', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 1, basePort: 'nope' });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'fallback non-numeric' },
    );
    assert.equal(msg.basePort, defaultUdpPort);
  });

  test('omitting basePort entirely uses UDP_PORT — this is what the page sends', async () => {
    const c = await newClient();
    c.send({ action: 'setPlayers', count: 2 });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'omitted basePort' },
    );
    assert.equal(msg.basePort, defaultUdpPort);
    assert.deepEqual(msg.players.map((p) => p.port), [defaultUdpPort, defaultUdpPort + 1]);
  });
});

describe('status carries basePort while stopped', () => {
  // The page has no port control; it labels its panes from the basePort the
  // server advertises, and the greeting is the only status it gets before it
  // asks for any listeners.
  test('the connect-time greeting reports the configured base port', async () => {
    const c = createClient(server.wsUrl);
    openClients.add(c);
    await c.connected();
    const greeting = await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
    assert.equal(greeting.state, 'stopped');
    assert.equal(greeting.basePort, defaultUdpPort);
  });
});

describe('describePlayers payload shape', () => {
  test('players list is sorted by player index and includes port + ok', async () => {
    const c = await newClient();
    const basePort = await freeConsecutiveUdpPorts(4);
    c.send({ action: 'setPlayers', count: 4, basePort });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening' && m.players?.length === 4,
      { label: '4-player listening' },
    );
    assert.deepEqual(
      msg.players,
      [
        { player: 0, port: basePort + 0, ok: true },
        { player: 1, port: basePort + 1, ok: true },
        { player: 2, port: basePort + 2, ok: true },
        { player: 3, port: basePort + 3, ok: true },
      ],
    );
  });
});

describe('stop', () => {
  test('stop tears down all listeners and broadcasts stopped', async () => {
    const c = await newClient();
    const basePort = await freeConsecutiveUdpPorts(2);
    c.send({ action: 'setPlayers', count: 2, basePort });
    await c.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'listening' });
    c.drainStatus();
    c.send({ action: 'stop' });
    const stopMsg = await c.waitFor((m) => m.type === 'status' && m.state === 'stopped', { label: 'stop' });
    assert.equal(stopMsg.state, 'stopped');
    // No players field in stopped messages per current behaviour.
    assert.equal(stopMsg.players, undefined);

    // Once stopped, the freed ports must actually be released —
    // confirm by binding them externally.
    for (const p of [basePort, basePort + 1]) {
      const sock = dgram.createSocket('udp4');
      sideSockets.add(sock);
      await new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.bind(p, '127.0.0.1', resolve);
      });
    }
  });
});

describe('setPlayers: replace existing', () => {
  test('calling setPlayers again rebinds with new count/port and frees old ports', async () => {
    const c = await newClient();
    const portA = await freeConsecutiveUdpPorts(1);
    c.send({ action: 'setPlayers', count: 1, basePort: portA });
    await c.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'A listening' });
    c.drainStatus();

    const portB = await freeConsecutiveUdpPorts(2);
    c.send({ action: 'setPlayers', count: 2, basePort: portB });
    const msg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening' && m.basePort === portB && m.players?.length === 2,
      { label: 'B listening' },
    );
    assert.equal(msg.basePort, portB);
    assert.deepEqual(msg.players.map((p) => p.port), [portB, portB + 1]);

    // Old port A must be free again.
    const sock = dgram.createSocket('udp4');
    sideSockets.add(sock);
    await new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(portA, '127.0.0.1', resolve);
    });
  });
});

describe('bind error path', () => {
  test('binding to an already-used port broadcasts a status:error for that player', async () => {
    // Squat on a port from a separate dgram socket, then ask the server
    // to bind it. The server should emit a status:error referencing
    // that player and port.
    const conflictPort = await freeUdpPort();
    const squatter = dgram.createSocket('udp4');
    sideSockets.add(squatter);
    await new Promise((resolve, reject) => {
      squatter.once('error', reject);
      squatter.bind(conflictPort, '127.0.0.1', resolve);
    });

    const c = await newClient();
    c.send({ action: 'setPlayers', count: 1, basePort: conflictPort });
    const errMsg = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'error',
      { label: 'bind error', timeoutMs: 3000 },
    );
    assert.equal(errMsg.player, 0);
    assert.equal(errMsg.port, conflictPort);
    assert.ok(typeof errMsg.message === 'string' && errMsg.message.length > 0,
      'error message should be a non-empty string');

    // After the failure, since no socket bound successfully,
    // broadcastStatus should report 'stopped' (sockets.size === 0).
    const stopped = await c.waitFor(
      (m) => m.type === 'status' && m.state === 'stopped',
      { label: 'stopped after failure', timeoutMs: 3000 },
    );
    assert.equal(stopped.state, 'stopped');
  });
});
