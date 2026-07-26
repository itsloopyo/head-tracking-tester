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
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('#sceneSelect option'));
const keys = await page.$$eval('#sceneSelect option', els => els.map(e => e.value));

const results = [];
for (const k of keys) {
  await page.evaluate((kk) => { const s = document.getElementById('sceneSelect'); s.value = kk; s.dispatchEvent(new Event('change')); }, k);
  // let it warm up
  await page.waitForTimeout(1500);
  // collect frame rate by counting requestAnimationFrames over 1s
  const fps = await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const start = performance.now();
    function step() {
      n++;
      if (performance.now() - start >= 1000) res(n);
      else requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }));
  results.push({ scene: k, fps });
  console.log(`${k.padEnd(15)} ${fps} fps`);
}
await browser.close(); server.close();
console.log('\nAverage:', (results.reduce((s, r) => s + r.fps, 0) / results.length).toFixed(1));
console.log('Min:', Math.min(...results.map(r => r.fps)), '— scene:', results.reduce((a, b) => a.fps < b.fps ? a : b).scene);
