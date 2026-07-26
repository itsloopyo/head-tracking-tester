// Tiny WebSocket test client. Buffers received JSON messages, exposes
// waitFor(predicate, opts) and a send(obj) helper. Throws on parse
// errors so tests notice if the server starts emitting non-JSON.

import { WebSocket } from 'ws';

export function createClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = new Set();

  ws.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch (err) {
      throw new Error(`server sent non-JSON over WS: ${raw.toString()}`);
    }
    messages.push(parsed);
    for (const w of waiters) w();
  });

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return {
    messages,
    async connected() { await opened; },
    send(obj) { ws.send(JSON.stringify(obj)); },
    async waitFor(predicate, { timeoutMs = 2000, label = 'message' } = {}) {
      const found = messages.find(predicate);
      if (found) return found;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(notify);
          reject(new Error(
            `waitFor(${label}) timed out after ${timeoutMs}ms.\n` +
            `received: ${JSON.stringify(messages, null, 2)}`,
          ));
        }, timeoutMs);
        const notify = () => {
          const f = messages.find(predicate);
          if (f) {
            clearTimeout(timer);
            waiters.delete(notify);
            resolve(f);
          }
        };
        waiters.add(notify);
      });
    },
    drainStatus() {
      // Discards all status messages currently in the buffer; useful
      // between phases of a test so subsequent waitFor() sees only new
      // events.
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === 'status') messages.splice(i, 1);
      }
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise((resolve) => {
          ws.once('close', resolve);
          try { ws.close(); } catch { resolve(); }
        });
      }
    },
  };
}
