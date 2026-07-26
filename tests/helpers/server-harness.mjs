// Spawn the real server.js as a child process, wait for the "[http]
// head-tracking-tester on http://localhost:PORT" line, and expose a
// controller for clean shutdown. We avoid importing server.js directly
// because it begins listening at module load.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.resolve(__dirname, '..', '..', 'server.js');

const READY_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 2000;

export async function startServer({ httpPort, udpPort } = {}) {
  if (!httpPort) throw new Error('startServer requires httpPort');

  const env = {
    ...process.env,
    HTTP_PORT: String(httpPort),
  };
  if (udpPort !== undefined) env.UDP_PORT = String(udpPort);

  const child = spawn(process.execPath, [SERVER_JS], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const readyMarker = `http://localhost:${httpPort}`;
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const onExit = (code) => {
      reject(new Error(
        `server exited before becoming ready (code=${code})\n` +
        `stdout: ${stdout}\nstderr: ${stderr}`,
      ));
    };
    child.once('exit', onExit);
    const poll = () => {
      if (stdout.includes(readyMarker)) {
        child.removeListener('exit', onExit);
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        child.removeListener('exit', onExit);
        reject(new Error(
          `server did not become ready within ${READY_TIMEOUT_MS}ms\n` +
          `stdout: ${stdout}\nstderr: ${stderr}`,
        ));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });

  return {
    httpPort,
    udpPort,
    baseUrl: `http://localhost:${httpPort}`,
    wsUrl: `ws://localhost:${httpPort}`,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGINT');
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
    },
  };
}
