// UDP pose-parsing tests.
//
// We spin up the real server, send raw OpenTrack-format UDP datagrams
// from a local dgram socket, and verify the parsed pose appears on the
// WebSocket fan-out.
//
// OpenTrack frame: 48 bytes = 6 × little-endian float64 in the order
//   X, Y, Z, Yaw, Pitch, Roll
// (translation in cm, rotation in degrees — the server forwards raw,
// it doesn't apply TRANSLATION_SCALE; that lives in the renderer).

import { test, before, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { startServer } from '../helpers/server-harness.mjs';
import { freeTcpPort, freeConsecutiveUdpPorts } from '../helpers/free-ports.mjs';
import { createClient } from '../helpers/ws-client.mjs';

let server;
const openClients = new Set();
const openSockets = new Set();

function packOpenTrack({ x, y, z, yaw, pitch, roll }) {
  const buf = Buffer.alloc(48);
  buf.writeDoubleLE(x, 0);
  buf.writeDoubleLE(y, 8);
  buf.writeDoubleLE(z, 16);
  buf.writeDoubleLE(yaw, 24);
  buf.writeDoubleLE(pitch, 32);
  buf.writeDoubleLE(roll, 40);
  return buf;
}

async function newClient() {
  const c = createClient(server.wsUrl);
  openClients.add(c);
  await c.connected();
  return c;
}

function newSender() {
  const sock = dgram.createSocket('udp4');
  openSockets.add(sock);
  return sock;
}

function send(sock, port, buf) {
  return new Promise((resolve, reject) => {
    sock.send(buf, port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
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
  for (const s of openSockets) {
    try { s.close(); } catch { /* already closed */ }
  }
  openSockets.clear();
  // Reset listeners between tests.
  const ctrl = createClient(server.wsUrl);
  await ctrl.connected();
  ctrl.send({ action: 'stop' });
  try { await ctrl.waitFor((m) => m.type === 'status' && m.state === 'stopped', { timeoutMs: 1500 }); } catch { /* ignore */ }
  await ctrl.close();
});

describe('UDP → WebSocket pose forwarding', () => {
  test('valid 48-byte packet is parsed and forwarded with correct values', async () => {
    const c = await newClient();
    await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
    const basePort = await freeConsecutiveUdpPorts(1);
    c.drainStatus();
    c.send({ action: 'setPlayers', count: 1, basePort });
    await c.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'listening' });

    const pose = { x: 1.5, y: -2.25, z: 3.75, yaw: 10, pitch: -20, roll: 0.5 };
    const sender = newSender();
    await send(sender, basePort, packOpenTrack(pose));

    const got = await c.waitFor((m) => m.type === 'pose', { label: 'pose', timeoutMs: 1500 });
    assert.equal(got.type, 'pose');
    assert.equal(got.player, 0);
    assert.equal(got.x, pose.x);
    assert.equal(got.y, pose.y);
    assert.equal(got.z, pose.z);
    assert.equal(got.yaw, pose.yaw);
    assert.equal(got.pitch, pose.pitch);
    assert.equal(got.roll, pose.roll);
  });

  test('packet shorter than 48 bytes is silently dropped', async () => {
    const c = await newClient();
    await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
    const basePort = await freeConsecutiveUdpPorts(1);
    c.drainStatus();
    c.send({ action: 'setPlayers', count: 1, basePort });
    await c.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'listening' });

    const sender = newSender();
    await send(sender, basePort, Buffer.alloc(40)); // 40 bytes — too short
    // Then send a valid packet; the valid one must arrive without any
    // ghost pose ahead of it.
    await send(sender, basePort, packOpenTrack({ x: 9, y: 9, z: 9, yaw: 9, pitch: 9, roll: 9 }));

    const got = await c.waitFor((m) => m.type === 'pose', { label: 'pose after short' });
    assert.equal(got.x, 9);
    // And no pose came from the short packet. (Only one pose should
    // exist in the buffer by now.)
    const poses = c.messages.filter((m) => m.type === 'pose');
    assert.equal(poses.length, 1, `expected exactly 1 pose, got ${poses.length}`);
  });

  test('packet longer than 48 bytes is accepted and reads only the first 48 bytes', async () => {
    const c = await newClient();
    await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
    const basePort = await freeConsecutiveUdpPorts(1);
    c.drainStatus();
    c.send({ action: 'setPlayers', count: 1, basePort });
    await c.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'listening' });

    const pose = { x: 11, y: 22, z: 33, yaw: 44, pitch: 55, roll: 66 };
    const buf = Buffer.concat([packOpenTrack(pose), Buffer.from('JUNKAFTER')]);
    const sender = newSender();
    await send(sender, basePort, buf);

    const got = await c.waitFor((m) => m.type === 'pose', { label: 'pose from oversize' });
    assert.equal(got.x, 11);
    assert.equal(got.roll, 66);
  });

  test('multi-player: packet on basePort+i is tagged with player=i', async () => {
    const c = await newClient();
    await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
    const basePort = await freeConsecutiveUdpPorts(3);
    c.drainStatus();
    c.send({ action: 'setPlayers', count: 3, basePort });
    await c.waitFor(
      (m) => m.type === 'status' && m.state === 'listening' && m.players?.length === 3,
      { label: '3 players listening' },
    );

    const sender = newSender();
    // Send a distinguishable pose to each port.
    await send(sender, basePort + 0, packOpenTrack({ x: 100, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }));
    await send(sender, basePort + 1, packOpenTrack({ x: 200, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }));
    await send(sender, basePort + 2, packOpenTrack({ x: 300, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }));

    // Wait until we've seen one pose per player.
    await c.waitFor((m) => m.type === 'pose' && m.player === 0 && m.x === 100, { label: 'p0' });
    await c.waitFor((m) => m.type === 'pose' && m.player === 1 && m.x === 200, { label: 'p1' });
    await c.waitFor((m) => m.type === 'pose' && m.player === 2 && m.x === 300, { label: 'p2' });
  });

  test('byte order is little-endian float64 across all six fields', async () => {
    // Use values whose IEEE-754 LE encoding is asymmetric so a BE bug
    // would produce wildly different (and detectable) numbers.
    const c = await newClient();
    await c.waitFor((m) => m.type === 'status', { label: 'greeting' });
    const basePort = await freeConsecutiveUdpPorts(1);
    c.drainStatus();
    c.send({ action: 'setPlayers', count: 1, basePort });
    await c.waitFor((m) => m.type === 'status' && m.state === 'listening', { label: 'listening' });

    const pose = {
      x: 1.234567890123,
      y: -987.6543210987,
      z: 0.00012345,
      yaw: 179.999,
      pitch: -89.5,
      roll: 12345.6789,
    };
    const sender = newSender();
    await send(sender, basePort, packOpenTrack(pose));

    const got = await c.waitFor((m) => m.type === 'pose', { label: 'precision pose' });
    // float64 round-trips exactly through the same LE encoding, so
    // strict equality is correct here.
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch', 'roll']) {
      assert.equal(got[k], pose[k], `field ${k} mismatched`);
    }
  });
});
