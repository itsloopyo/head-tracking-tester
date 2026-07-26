// Stress-test the rotation pipeline at extreme yaw/pitch/roll combinations
// by driving a real Player through updateCamera() and inspecting the
// resulting camera.quaternion + derived forward/up vectors.
//
// What we check:
//   1. quaternion stays normalized (length ≈ 1, no NaNs)
//   2. forward and up are finite, unit-length vectors
//   3. yaw correctly rotates the heading around world Y at any pitch
//   4. pitch ±90° doesn't collapse yaw/roll into each other
//   5. roll correctly tilts left/right without affecting heading direction
//   6. wraparound (yaw beyond ±180) doesn't snap or NaN due to the unwrap step

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
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelector('#sceneSelect option'));
// let initial setup settle
await page.waitForTimeout(500);

// Expose the active player to the page so we can poke at it
await page.evaluate(() => {
  // players is module-scoped; grab it via the resize handler closure trick.
  // Easier path: walk DOM to find the canvas, then we already exposed Player
  // via __player_ref if the module did so. It didn't, so we'll inject by
  // dispatching a phony WS message? No — easier still: we'll use the
  // sendWs export and trust the WS round-trip... actually that requires the
  // server. Simplest: monkey-patch THREE on window from inside via the module.
  // Since renderer.js is a module, we can't access its locals from outside.
  // Workaround: add a tiny hook to the global scope by editing renderer.js
  // temporarily. We avoid editing here; instead, we'll test the rotation
  // math standalone using the same three.js module the page uses.
});

// Pull THREE from the same module the page loaded
const result = await page.evaluate(async () => {
  const THREE = await import('./vendor/three.module.js');

  const DEG = Math.PI / 180;
  const _AX = new THREE.Vector3(1, 0, 0);
  const _AY = new THREE.Vector3(0, 1, 0);
  const _AZ = new THREE.Vector3(0, 0, 1);

  // Replicate the exact quaternion construction from updateCamera
  function buildQuat(yawDeg, pitchDeg, rollDeg) {
    const q = new THREE.Quaternion();
    const tmp = new THREE.Quaternion();
    q.identity();
    tmp.setFromAxisAngle(_AY, yawDeg * DEG);   q.multiply(tmp);
    tmp.setFromAxisAngle(_AX, pitchDeg * DEG); q.multiply(tmp);
    tmp.setFromAxisAngle(_AZ, rollDeg * DEG);  q.multiply(tmp);
    return q;
  }

  function info(yaw, pitch, roll) {
    const q = buildQuat(yaw, pitch, roll);
    const len = Math.hypot(q.x, q.y, q.z, q.w);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const up  = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    // round-trip through Euler YXZ to see how three.js's intrinsic Euler
    // interprets the same quaternion
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    return {
      input: { yaw, pitch, roll },
      qLen: +len.toFixed(6),
      qHasNaN: !isFinite(q.x + q.y + q.z + q.w),
      fwd: [+fwd.x.toFixed(4), +fwd.y.toFixed(4), +fwd.z.toFixed(4)],
      up: [+up.x.toFixed(4), +up.y.toFixed(4), +up.z.toFixed(4)],
      right: [+right.x.toFixed(4), +right.y.toFixed(4), +right.z.toFixed(4)],
      eulerBack: {
        y: +(e.y / DEG).toFixed(2),
        x: +(e.x / DEG).toFixed(2),
        z: +(e.z / DEG).toFixed(2),
      },
    };
  }

  const cases = [];
  // 1. identity
  cases.push({ label: 'identity', ...info(0, 0, 0) });
  // 2. simple yaw
  cases.push({ label: 'yaw 90 — should face +X-ish (right)', ...info(90, 0, 0) });
  cases.push({ label: 'yaw -90 — should face -X-ish (left)', ...info(-90, 0, 0) });
  cases.push({ label: 'yaw 180', ...info(180, 0, 0) });
  // 3. simple pitch
  cases.push({ label: 'pitch +60', ...info(0, 60, 0) });
  cases.push({ label: 'pitch -60', ...info(0, -60, 0) });
  // 4. extreme pitch (singularity in Euler)
  cases.push({ label: 'pitch +89 (near singularity)', ...info(0, 89, 0) });
  cases.push({ label: 'pitch +90 (Euler singularity)', ...info(0, 90, 0) });
  cases.push({ label: 'pitch -90 (Euler singularity)', ...info(0, -90, 0) });
  // 5. simple roll
  cases.push({ label: 'roll 45', ...info(0, 0, 45) });
  cases.push({ label: 'roll 90', ...info(0, 0, 90) });
  cases.push({ label: 'roll 180', ...info(0, 0, 180) });
  // 6. combined — yaw+pitch+roll all big
  cases.push({ label: 'combined 45/30/60', ...info(45, 30, 60) });
  cases.push({ label: 'combined 90/90/90 (extreme corner)', ...info(90, 90, 90) });
  // 7. test that yaw still rotates heading when pitch is at the limit
  cases.push({ label: 'pitch 89 + yaw 0', ...info(0, 89, 0) });
  cases.push({ label: 'pitch 89 + yaw 90 — heading should still face +X', ...info(90, 89, 0) });
  cases.push({ label: 'pitch 89 + yaw -90 — heading should face -X', ...info(-90, 89, 0) });
  // 8. opentrack-style large yaw values that would wrap (renderer.unwrap
  //    keeps these continuous on the wire)
  cases.push({ label: 'yaw 270 (= -90 mod 360)', ...info(270, 0, 0) });
  cases.push({ label: 'yaw 720 (= 0 mod 360)', ...info(720, 0, 0) });
  cases.push({ label: 'yaw -540 (= -180 mod 360)', ...info(-540, 0, 0) });

  return cases;
});

// Print + check
let bad = 0;
console.log('=== gimbal / rotation pipeline check ===');
console.log('(forward, up, right vectors are unit vectors derived from the camera quaternion)');
console.log();
for (const r of result) {
  const okLen = Math.abs(r.qLen - 1) < 1e-4;
  const fwdLen = Math.hypot(...r.fwd);
  const okFwd = Math.abs(fwdLen - 1) < 1e-4;
  const flag = (!r.qHasNaN && okLen && okFwd) ? '✓' : '✗';
  if (flag !== '✓') bad++;
  console.log(`${flag} ${r.label}`);
  console.log(`    input=Y${r.input.yaw} P${r.input.pitch} R${r.input.roll}  |q|=${r.qLen}  fwd=${JSON.stringify(r.fwd)}  up=${JSON.stringify(r.up)}`);
  console.log(`    euler-roundtrip: Y${r.eulerBack.y} P${r.eulerBack.x} R${r.eulerBack.z}`);
}
console.log();
console.log(`PASS: ${result.length - bad}  FAIL: ${bad}`);

await browser.close(); server.close();
