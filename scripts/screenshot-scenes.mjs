// Screenshot every scene in the registry.
//
// Spawns a static file server bound to 127.0.0.1 (no UDP/WS — the WebGL
// scenes don't need them), drives Playwright through each scene in the
// dropdown, and writes a PNG per scene under ./screenshots.
//
// Run with: node scripts/screenshot-scenes.mjs

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const OUT_DIR    = path.resolve(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, url));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(`Not found: ${url}`); return; }
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL  = `http://127.0.0.1:${PORT}/`;
console.log(`[server] serving ${PUBLIC_DIR} on ${URL}`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

const pageErrors  = [];
const consoleErrs = [];
const sceneErrors = new Map(); // key: sceneKey, value: messages collected while it was current
let currentSceneForErrors = null;
function recordErr(line) {
  if (currentSceneForErrors) {
    if (!sceneErrors.has(currentSceneForErrors)) sceneErrors.set(currentSceneForErrors, []);
    sceneErrors.get(currentSceneForErrors).push(line);
  }
}
page.on('pageerror', (e)  => { pageErrors.push(e.message); recordErr(`pageerror: ${e.message}`); });
page.on('console',   (m)  => {
  const t = m.type();
  const txt = m.text();
  if (t === 'error' || t === 'warning') {
    if (t === 'error') consoleErrs.push(txt);
    recordErr(`${t}: ${txt}`);
  }
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
// wait for the scene dropdown to be populated
await page.waitForFunction(() => {
  const sel = document.getElementById('sceneSelect');
  return sel && sel.options.length > 0;
}, null, { timeout: 10000 });

const sceneKeys = await page.$$eval('#sceneSelect option', (els) => els.map((e) => e.value));
console.log(`[scenes] ${sceneKeys.length}:`, sceneKeys.join(', '));

// give the very first scene (plaza) a moment of frames to warm shaders before we start
await page.waitForTimeout(800);

const results = [];
for (const key of sceneKeys) {
  currentSceneForErrors = key;
  // switch scene via the dropdown change handler used by the UI
  await page.evaluate((k) => {
    const sel = document.getElementById('sceneSelect');
    sel.value = k;
    sel.dispatchEvent(new Event('change'));
  }, key);
  // wait for animations to settle (lights pulse, particles spawn, etc.)
  await page.waitForTimeout(1800);

  const out = path.join(OUT_DIR, `${key}.png`);
  await page.screenshot({ path: out, fullPage: false });

  // also capture a "looking down" frame for scenes where we want to verify
  // the floor actually rendered (drag mouse downward on the canvas to pitch).
  if (['volcano'].includes(key)) {
    const canvas = await page.$('canvas.scene');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // drag mouse downward 200px → pitches camera down ~57°
    await page.mouse.move(cx, cy + 240, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const downOut = path.join(OUT_DIR, `${key}__down.png`);
    await page.screenshot({ path: downOut, fullPage: false });
    // reset by dragging back up
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 240, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }

  // sample the center of the screenshot to detect a fully-black scene
  const stats = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.scene');
    if (!canvas) return { hasCanvas: false };
    const w = canvas.width, h = canvas.height;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { hasCanvas: true, hasGL: false };
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { hasCanvas: true, hasGL: true, center: [px[0], px[1], px[2], px[3]], w, h };
  });

  const blackish =
    stats.center &&
    stats.center[0] < 8 && stats.center[1] < 8 && stats.center[2] < 8;
  const status = blackish ? '⚠ BLACK CENTER' : 'ok';
  console.log(`[${status}] ${key.padEnd(15)} ${out}  center=${JSON.stringify(stats.center ?? null)}`);
  results.push({ key, out, center: stats.center, blackish });
}

await browser.close();
server.close();

const blackList = results.filter((r) => r.blackish).map((r) => r.key);
console.log('');
console.log('---- summary ----');
console.log(`scenes captured: ${results.length}`);
console.log(`black-center:    ${blackList.length}${blackList.length ? ' (' + blackList.join(', ') + ')' : ''}`);
if (pageErrors.length)  console.log(`page errors:     ${pageErrors.length}\n  - ${pageErrors.join('\n  - ')}`);
// per-scene error breakdown (filter out the always-present WS handshake noise)
const noisy = (s) => /WebSocket connection|Error during WebSocket handshake/i.test(s);
for (const [key, msgs] of sceneErrors.entries()) {
  const filtered = msgs.filter((m) => !noisy(m));
  if (filtered.length) {
    console.log(`\nerrors while on '${key}':`);
    for (const m of filtered.slice(0, 6)) console.log('  - ' + m.slice(0, 280));
  }
}
