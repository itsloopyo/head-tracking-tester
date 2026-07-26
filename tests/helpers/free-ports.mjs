// Ephemeral-port helpers. We bind to port 0, read the OS-assigned port,
// then release it. There's a small race window before the SUT grabs the
// port — acceptable for localhost integration tests.

import net from 'node:net';
import dgram from 'node:dgram';

export function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      const { port } = sock.address();
      sock.close(() => resolve(port));
    });
  });
}

// Find a base UDP port such that [base, base+n) are all currently free.
// Retries up to 20 times; throws on failure. Used for multi-player tests
// where setPlayers binds consecutive ports.
export async function freeConsecutiveUdpPorts(n) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = await freeUdpPort();
    const sockets = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const s = dgram.createSocket('udp4');
      try {
        await new Promise((resolve, reject) => {
          s.once('error', reject);
          s.bind(base + i, '127.0.0.1', resolve);
        });
        sockets.push(s);
      } catch {
        ok = false;
        break;
      }
    }
    await Promise.all(sockets.map((s) => new Promise((r) => s.close(r))));
    if (ok) return base;
  }
  throw new Error(`could not find ${n} consecutive free UDP ports`);
}
