// /healthz is what the container's HEALTHCHECK and any orchestrator poll,
// so its shape is a contract: 200 + JSON, and the listener state has to
// track what the WebSocket control channel actually did.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';
import { freeTcpPort, freeConsecutiveUdpPorts } from '../helpers/free-ports.mjs';
import { createClient } from '../helpers/ws-client.mjs';

let server;

before(async () => {
  const httpPort = await freeTcpPort();
  server = await startServer({ httpPort });
});

after(async () => { if (server) await server.stop(); });

describe('GET /healthz', () => {
  test('returns 200 with JSON while idle', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.listening, false);
    assert.deepEqual(body.players, []);
    assert.equal(typeof body.uptime, 'number');
    assert.equal(typeof body.basePort, 'number');
  });

  test('query strings are ignored', async () => {
    const res = await fetch(`${server.baseUrl}/healthz?probe=1`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });

  test('reports the bound listeners once players are started', async () => {
    const basePort = await freeConsecutiveUdpPorts(2);
    const client = createClient(server.wsUrl);
    await client.connected();
    client.send({ action: 'setPlayers', count: 2, basePort });
    await client.waitFor(
      (m) => m.type === 'status' && m.state === 'listening',
      { label: 'listening' },
    );

    const listening = await (await fetch(`${server.baseUrl}/healthz`)).json();
    assert.equal(listening.status, 'ok');
    assert.equal(listening.listening, true);
    assert.equal(listening.basePort, basePort);
    assert.deepEqual(listening.players, [
      { player: 0, port: basePort, ok: true },
      { player: 1, port: basePort + 1, ok: true },
    ]);

    client.drainStatus();
    client.send({ action: 'stop' });
    await client.waitFor(
      (m) => m.type === 'status' && m.state === 'stopped',
      { label: 'stopped' },
    );

    const stopped = await (await fetch(`${server.baseUrl}/healthz`)).json();
    assert.equal(stopped.listening, false);
    assert.deepEqual(stopped.players, []);

    await client.close();
  });
});
