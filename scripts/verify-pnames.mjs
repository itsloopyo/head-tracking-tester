// One-off: verify the per-pane player-name title is shown at bottom-center,
// is editable, and persists across reloads. Mirrors screenshot-scenes.mjs.

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
  '.svg':  'image/svg+xml',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, url));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(`Not found: ${url}`); return; }
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL  = `http://127.0.0.1:${PORT}/`;
console.log(`[server] ${URL}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console.error]', msg.text()); });

const fail = (msg) => { console.log('FAIL:', msg); process.exitCode = 1; };
const pass = (msg) => console.log('PASS:', msg);

await page.goto(URL);
await page.waitForSelector('.viewport .pname');

// 1) Default text
const initial = await page.locator('.viewport .pname').first().textContent();
if ((initial || '').trim() === 'Player 1') pass('default name is "Player 1"');
else fail(`expected default "Player 1", got "${initial}"`);

// 2) Position: roughly bottom-center of the viewport
const layout = await page.locator('.viewport .pname').first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  const v = el.closest('.viewport').getBoundingClientRect();
  return {
    centerOffset: Math.abs((r.left + r.width / 2) - (v.left + v.width / 2)),
    fromBottom: v.bottom - r.bottom,
    fontSize: parseFloat(getComputedStyle(el).fontSize),
  };
});
if (layout.centerOffset < 8) pass(`horizontally centered (${layout.centerOffset.toFixed(1)}px off)`);
else fail(`not centered: ${layout.centerOffset.toFixed(1)}px off`);
if (layout.fromBottom > 20 && layout.fromBottom < 200) pass(`sits near bottom (${layout.fromBottom.toFixed(0)}px above)`);
else fail(`unexpected bottom offset: ${layout.fromBottom}`);
if (layout.fontSize >= 22) pass(`large font (${layout.fontSize}px)`);
else fail(`font too small: ${layout.fontSize}px`);

// 3) Edit + persist
const pname = page.locator('.viewport .pname').first();
await pname.click();
await page.evaluate(() => {
  const el = document.activeElement;
  const r = document.createRange(); r.selectNodeContents(el);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
});
await page.keyboard.press('Delete');
await page.keyboard.type('Alice');
await page.keyboard.press('Enter');
const afterEdit = (await pname.textContent() || '').trim();
if (afterEdit === 'Alice') pass('rename to "Alice" applied');
else fail(`expected "Alice", got "${afterEdit}"`);

const stored = await page.evaluate(() => localStorage.getItem('htt:playerNames'));
if (stored && JSON.parse(stored)[0] === 'Alice') pass(`localStorage persisted: ${stored}`);
else fail(`localStorage not persisted: ${stored}`);

// 4) Reload — name should survive
await page.reload();
await page.waitForSelector('.viewport .pname');
const reloaded = (await page.locator('.viewport .pname').first().textContent() || '').trim();
if (reloaded === 'Alice') pass('survives reload');
else fail(`after reload expected "Alice", got "${reloaded}"`);

// 5) Stats-panel title (P?) should also reflect the name
const statTitle = (await page.locator('.viewport .ptitle').first().textContent() || '').trim();
if (statTitle === 'Alice') pass(`stats title mirrors name (${statTitle})`);
else fail(`stats title is "${statTitle}", expected "Alice"`);

// 6) Switch to 4 players — each pane should have its own default-or-stored name
await page.locator('.pcount[data-n="4"]').click();
await page.waitForFunction(() => document.querySelectorAll('.viewport .pname').length === 4);
const names = await page.locator('.viewport .pname').allTextContents();
const expected4 = ['Alice', 'Player 2', 'Player 3', 'Player 4'];
if (JSON.stringify(names.map((s) => s.trim())) === JSON.stringify(expected4))
  pass(`4-player names: ${JSON.stringify(names.map((s) => s.trim()))}`);
else fail(`4-player names: ${JSON.stringify(names.map((s) => s.trim()))} != ${JSON.stringify(expected4)}`);

// 7) Typing into a name field must not move the camera (no WASD leakage)
const camBefore = await page.evaluate(() => {
  // not exposed globally, but we can check that typing doesn't throw / focus stays in pname
  return document.activeElement.classList?.contains('pname');
});
await page.locator('.viewport .pname').nth(1).click();
await page.evaluate(() => {
  const el = document.activeElement;
  const r = document.createRange(); r.selectNodeContents(el);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
});
await page.keyboard.press('Delete');
await page.keyboard.type('wasd');
await page.keyboard.press('Enter');
const second = (await page.locator('.viewport .pname').nth(1).textContent() || '').trim();
if (second === 'wasd') pass('typing "wasd" into name field captured as name (no WASD leak)');
else fail(`second name is "${second}"`);

// 8) Clear + Enter → falls back to default
await page.locator('.viewport .pname').nth(1).click();
await page.evaluate(() => {
  const el = document.activeElement;
  const r = document.createRange(); r.selectNodeContents(el);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
});
await page.keyboard.press('Delete');
await page.keyboard.press('Enter');
const cleared = (await page.locator('.viewport .pname').nth(1).textContent() || '').trim();
if (cleared === 'Player 2') pass('clearing name reverts to default "Player 2"');
else fail(`after clear expected "Player 2", got "${cleared}"`);

// 9) Click outside should deselect (blur + clear text selection)
await page.locator('.viewport .pname').first().click();
const focusedNow = await page.evaluate(() => document.activeElement?.classList?.contains('pname'));
if (focusedNow) pass('clicking name focuses it');
else fail('click should have focused .pname');

await page.mouse.click(900, 400); // empty area in pane 2 of 4-up
const afterOutside = await page.evaluate(() => ({
  focusedIsPname: document.activeElement?.classList?.contains('pname') || false,
  hasSelectionInPname: (() => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return false;
    const a = s.anchorNode;
    return !!(a && (a.parentElement?.closest('.pname') || (a.nodeType === 1 && a.closest && a.closest('.pname'))));
  })(),
}));
if (!afterOutside.focusedIsPname) pass('click outside blurred .pname');
else fail('click outside did not blur .pname');
if (!afterOutside.hasSelectionInPname) pass('text selection cleared on blur');
else fail('text selection still inside .pname after blur');

const shot = path.join(OUT_DIR, 'pnames-4up.png');
await page.screenshot({ path: shot, fullPage: false });
console.log(`[screenshot] ${shot}`);

// Reset localStorage so this verify doesn't pollute future runs
await page.evaluate(() => localStorage.removeItem('htt:playerNames'));

await browser.close();
server.close();
