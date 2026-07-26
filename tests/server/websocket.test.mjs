// WebSocket fan-out tests.
//
// Drives the real server over real WebSocket connections (no mocks).
// Verifies the connect/status/broadcast/disconnect contract:
//   - new clients receive the current state immediately
//   - setPlayers / stop broadcasts reach every connected client
//   - malformed JSON and unknown actions are tolerated, not fatal
//   - disconnects don't break broadcasts to remaining clients

import { test, before, after, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';
import { freeTcpPort, freeConsecutiveUdpPorts } from '../helpers/free-ports.mjs';
import { createClient } from '../helpers/ws-client.mjs';

let server;
const openClients = new Set();

async function newClient() {
  const c = createClient(server.wsUrl);
  openClients.add(c);
  await c.connected();
  return c;
}

before(async () => {
  const httpPort = await freeTcpPort();
  server = await startServer({ httpPort });
});
after(async () => { if (server) await server.stop(); });

afterEach(async () => {
  // Close any test clients and stop listeners between cases so each
  // test starts from a known 'stopped' baseline.
  await Promise.all([...openClients].map((c) => c.close()));
  openClients.clear();
  // Stop server-side listeners by opening one short-lived client.
  const ctrl = createClient(server.wsUrl);
  await ctrl.connected();
  ctrl.send({ action: 'stop' });
  // Brief drain; the server emits a 'stopped' status after teardown.
  try { await ctrl.waitFor((m) => m.type === 'status' && m.state === 'stopped', { timeoutMs: 1500, label: 'stopped' }); } catch { /* already stopped */ }
  await ctrl.close();
});

describe('WebSocket: initial status & basic protocol', () => {
  test('new client receives a stopped status immediately when no players are bound', async () => {
    const c = await newClient();
    const msg = await c.waitFor((m) => m.type === 'status', { label: 'initial status' });
    assert.equal(msg.type, 'status');
    assert.equal(msg.state, 'stopped');
  });

  test('a second client that connects mid-session also receives current state', async () => {
    // Start listeners via first client
    const a = await newClient();
    const basePort = await freeConsecutiveUdpPorts(1);
    a.drainStatus();
    a.send({ action: 'setPlayers', count: 1, basePort });
    await a.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'A listening' });

    // Second client connecting should be told the current state without
    // having to send anything itself.
    const b = await newClient();
    const greeting = await b.waitFor((m) => m.type === 'status', { label: 'B initial status' });
    assert.equal(greeting.state, 'listening');
    assert.equal(greeting.basePort, basePort);
    assert.deepEqual(greeting.players, [{ player: 0, port: basePort, ok: true }]);
  });

  test('malformed (non-JSON) WS messages are silently ignored', async () => {
    const c = await newClient();
    await c.waitFor((m) => m.type === 'status', { label: 'initial' });
    // Send raw garbage; the server should not crash. We then send a
    // valid stop and confirm the connection still works.
    const { WebSocket } = await import('ws');
    // Use the underlying raw send via a fresh socket so we don't have to
    // expose internals on the wrapper.
    const raw = new WebSocket(server.wsUrl);
    await new Promise((r) => raw.once('open', r));
    raw.send('not-json{{{');
    raw.send(Buffer.from([0xff, 0x00, 0xff]));
    // Verify the server is still responsive by getting a fresh greeting.
    const probe = await newClient();
    const greet = await probe.waitFor((m) => m.type === 'status', { label: 'probe status' });
    assert.equal(greet.state, 'stopped');
    raw.close();
  });

  test('unknown action is ignored without emitting an error', async () => {
    const c = await newClient();
    await c.waitFor((m) => m.type === 'status', { label: 'initial' });
    c.drainStatus();
    c.send({ action: 'definitelyNotARealCommand', foo: 1 });
    // Confirm the server stays up: no error reply, and a subsequent
    // stop still produces a stopped broadcast.
    c.send({ action: 'stop' });
    const msg = await c.waitFor((m) => m.type === 'status' && m.state === 'stopped', { label: 'stop after unknown' });
    assert.equal(msg.state, 'stopped');
  });
});

describe('WebSocket: broadcast fan-out', () => {
  test('setPlayers broadcast reaches every connected client', async () => {
    const [a, b, c] = await Promise.all([newClient(), newClient(), newClient()]);
    // Drain greetings
    for (const x of [a, b, c]) await x.waitFor((m) => m.type === 'status', { label: 'greeting' });
    for (const x of [a, b, c]) x.drainStatus();

    const basePort = await freeConsecutiveUdpPorts(2);
    a.send({ action: 'setPlayers', count: 2, basePort });

    const results = await Promise.all(
      [a, b, c].map((x) => x.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'listening broadcast' })),
    );
    for (const r of results) {
      assert.equal(r.basePort, basePort);
      assert.equal(r.players.length, 2);
      assert.deepEqual(
        r.players.map((p) => ({ player: p.player, port: p.port, ok: p.ok })),
        [
          { player: 0, port: basePort, ok: true },
          { player: 1, port: basePort + 1, ok: true },
        ],
      );
    }
  });

  test('stop broadcast reaches every connected client', async () => {
    const [a, b] = await Promise.all([newClient(), newClient()]);
    for (const x of [a, b]) await x.waitFor((m) => m.type === 'status', { label: 'greeting' });
    const basePort = await freeConsecutiveUdpPorts(1);
    a.drainStatus(); b.drainStatus();
    a.send({ action: 'setPlayers', count: 1, basePort });
    await Promise.all([a, b].map((x) => x.waitFor((m) => m.type === 'status' && m.state === 'listening')));

    a.drainStatus(); b.drainStatus();
    b.send({ action: 'stop' });
    const stops = await Promise.all([a, b].map((x) => x.waitFor((m) => m.type === 'status' && m.state === 'stopped', { label: 'stop broadcast' })));
    for (const s of stops) assert.equal(s.state, 'stopped');
  });

  test('disconnected clients are dropped from the broadcast set', async () => {
    const a = await newClient();
    const b = await newClient();
    await Promise.all([a, b].map((x) => x.waitFor((m) => m.type === 'status', { label: 'greeting' })));

    // Close b and give the server a tick to register the close event.
    await b.close();
    await new Promise((r) => setTimeout(r, 50));

    // A subsequent broadcast must still succeed for the remaining
    // client. (If the server tried to send to b's closed socket
    // unconditionally, it would throw.)
    const basePort = await freeConsecutiveUdpPorts(1);
    a.drainStatus();
    a.send({ action: 'setPlayers', count: 1, basePort });
    const msg = await a.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'A still receives' });
    assert.equal(msg.state, 'listening');
  });
});
