// HTTP static-server integration tests.
//
// These run the real server.js as a child process bound to an ephemeral
// HTTP port, then drive it via fetch(). We verify the contract:
//   - file serving from public/
//   - 404 for missing files
//   - 403 for path traversal escaping PUBLIC_DIR
//   - per-extension MIME assignment + octet-stream fallback
//   - query strings ignored when resolving the file path

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server-harness.mjs';
import { freeTcpPort } from '../helpers/free-ports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

let server;

before(async () => {
  const httpPort = await freeTcpPort();
  server = await startServer({ httpPort });
});

after(async () => { if (server) await server.stop(); });

describe('HTTP static file server', () => {
  test('GET / serves index.html with text/html content-type', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    const body = await res.text();
    const expected = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    assert.equal(body, expected);
  });

  test('GET /index.html resolves the same file as GET /', async () => {
    const [a, b] = await Promise.all([
      fetch(`${server.baseUrl}/`).then((r) => r.text()),
      fetch(`${server.baseUrl}/index.html`).then((r) => r.text()),
    ]);
    assert.equal(a, b);
  });

  test('GET /renderer.js returns 200 with application/javascript', async () => {
    const res = await fetch(`${server.baseUrl}/renderer.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/javascript/);
    // Body should be the on-disk file. Just spot-check the length and a
    // known prefix rather than diffing 550KB.
    const expected = fs.readFileSync(path.join(PUBLIC_DIR, 'renderer.js'), 'utf8');
    const body = await res.text();
    assert.equal(body.length, expected.length);
    assert.ok(body.startsWith("import * as THREE from 'three';"));
  });

  test('GET non-existent path returns 404', async () => {
    const res = await fetch(`${server.baseUrl}/does-not-exist.html`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'not found');
  });

  test('GET nested non-existent path returns 404', async () => {
    const res = await fetch(`${server.baseUrl}/deeply/nested/missing.json`);
    assert.equal(res.status, 404);
  });

  test('percent-encoded slashes stay literal (no implicit decode) → safe 404', async () => {
    // Characterization test: server.js does NOT decodeURIComponent the
    // request path. So "..%2F..%2Fserver.js" lands as a single literal
    // filename under PUBLIC_DIR, which does not exist, yielding 404.
    // The path-traversal guard isn't reached because nothing escaped
    // PUBLIC_DIR in the first place. This is still safe — the literal
    // %2F isn't a path separator on disk — but it's worth pinning so a
    // future "let's decode URLs" change doesn't accidentally open the
    // door without also keeping the guard intact.
    const res = await fetch(`${server.baseUrl}/..%2F..%2Fserver.js`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'not found');
  });

  test('path traversal via literal ../ is blocked with 403', async () => {
    // fetch() collapses ".." against the URL base, so we hand-craft the
    // request via the lower-level http module to keep the raw path intact.
    const http = await import('node:http');
    const url = new URL(server.baseUrl);
    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: '/../server.js',
        method: 'GET',
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body.status, 403);
    assert.equal(body.body, 'forbidden');
  });

  test('query string is stripped before file lookup', async () => {
    const res = await fetch(`${server.baseUrl}/index.html?cachebust=abc123`);
    assert.equal(res.status, 200);
    const expected = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    assert.equal(await res.text(), expected);
  });

  test('MIME map covers expected extensions', async () => {
    // We rely on the vendored renderer.js (.js) and index.html (.html)
    // plus a synthetic test via a known vendored file. The MIME map in
    // server.js is the source of truth; we re-verify here by extension.
    const cases = [
      { url: '/index.html', mime: /^text\/html/ },
      { url: '/renderer.js', mime: /^application\/javascript/ },
    ];
    for (const c of cases) {
      const r = await fetch(`${server.baseUrl}${c.url}`);
      assert.equal(r.status, 200, `expected 200 for ${c.url}`);
      assert.match(r.headers.get('content-type') ?? '', c.mime, `wrong content-type for ${c.url}`);
    }
  });

  test('a public/ sibling sharing the directory prefix is blocked with 403', async () => {
    // Guard is a prefix match on PUBLIC_DIR; without the trailing separator
    // "/../publicX/secret" would resolve outside public/ and still pass.
    const http = await import('node:http');
    const url = new URL(server.baseUrl);
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: '/../public-elsewhere/secret.txt',
        method: 'GET',
      }, (r) => {
        let buf = '';
        r.on('data', (c) => { buf += c.toString(); });
        r.on('end', () => resolve({ status: r.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 403);
    assert.equal(res.body, 'forbidden');
  });

  test('unknown extension falls back to application/octet-stream', async () => {
    // Create a temporary file in public/ with an unknown extension so we
    // can exercise the fallback branch. We restore the directory in
    // an after-each style with a try/finally.
    const tmpName = `__test_fallback_${process.pid}.weirdext`;
    const tmpPath = path.join(PUBLIC_DIR, tmpName);
    fs.writeFileSync(tmpPath, 'hello-bytes');
    try {
      const res = await fetch(`${server.baseUrl}/${tmpName}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      assert.equal(await res.text(), 'hello-bytes');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});
