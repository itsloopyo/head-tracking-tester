import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'public');
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const fp = path.normalize(path.join(ROOT, url));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(fp);
    const m = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    res.setHeader('Content-Type', m[ext] || 'application/octet-stream');
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[prefetch]')) console.log(t);
});
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('#sceneSelect option'));

// give the background prefetch plenty of time to drain. Each scene is
// ~50-300ms compile; 27 of them fit comfortably in 20s.
console.log('waiting 20s for prefetch to drain...');
await page.waitForTimeout(20000);

// also time a switch to a "cold" scene vs a pre-built one
const keys = await page.$$eval('#sceneSelect option', els => els.map(e => e.value));
async function timeSwitch(key) {
  return await page.evaluate(async (k) => {
    const t0 = performance.now();
    const sel = document.getElementById('sceneSelect');
    sel.value = k; sel.dispatchEvent(new Event('change'));
    // wait two animation frames after the switch so any first-frame compile lands
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  }, key);
}

// switch through each scene back-to-back and measure
const times = [];
for (const k of keys) {
  const dt = await timeSwitch(k);
  times.push({ k, dt: +dt.toFixed(1) });
}
console.log('switch durations (ms):');
for (const t of times) console.log('  ' + t.k.padEnd(15) + ' ' + t.dt);
const avg = times.reduce((s, t) => s + t.dt, 0) / times.length;
const max = times.reduce((m, t) => t.dt > m.dt ? t : m);
console.log('avg', avg.toFixed(1), 'max', max.dt, '@', max.k);

await browser.close(); server.close();
