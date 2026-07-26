// Loads the dependency-free utility functions out of public/renderer.js.
//
// renderer.js can't be `import`-ed from Node because line 1 pulls in
// `three` (resolved by the browser importmap, not Node) and module
// initialization touches `document.createElement`. The utilities we
// want to test (`obraDinnAlpha`, `applyDeadzone`, `PoseInterpolator`,
// `unwrapDeg`, `classify`, `classifyLow`) are pure JS though, so we
// slice them out by source markers and evaluate them in a vm sandbox.
//
// This means the tests still exercise the actual production bytes — if
// the renderer source drifts, the tests drift with it (and break loudly
// if the markers can't be found).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_PATH = path.resolve(__dirname, '..', '..', 'public', 'renderer.js');

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`renderer-snippet: start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end < 0) throw new Error(`renderer-snippet: end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

function load() {
  const src = fs.readFileSync(RENDERER_PATH, 'utf8');

  // Block 1: obraDinnAlpha, applyDeadzone, PoseInterpolator. Stops just
  // before the line that constructs a THREE.Vector3.
  const block1 = slice(src, 'function obraDinnAlpha', 'const DEG = Math.PI');
  // Block 2: unwrapDeg, classify, classifyLow. Stops before setColor,
  // which touches the DOM.
  const block2 = slice(src, 'function unwrapDeg', 'function setColor');

  // We use vm.runInThisContext (not a fresh context) so that arrays /
  // objects created inside the snippet share Array.prototype with the
  // test realm. That lets assert.deepEqual on a returned [y, p, r]
  // succeed without falling foul of the cross-realm constructor check.
  // The snippet is wrapped in an IIFE so its declarations don't leak
  // into globalThis.
  const code = `(function () {
    ${block1}
    ${block2}
    return {
      obraDinnAlpha, applyDeadzone, PoseInterpolator,
      oneEuroLowpassAlpha, oneEuroStep, accelaStep,
      euroParamsFromAmount, accelaSmoothingFromAmount,
      unwrapDeg, classify, classifyLow,
    };
  })()`;

  return vm.runInThisContext(code, { filename: 'renderer-extracted-utils.js' });
}

export const {
  obraDinnAlpha,
  applyDeadzone,
  PoseInterpolator,
  oneEuroLowpassAlpha,
  oneEuroStep,
  accelaStep,
  euroParamsFromAmount,
  accelaSmoothingFromAmount,
  unwrapDeg,
  classify,
  classifyLow,
} = load();
