// Pure-utility tests for public/renderer.js.
//
// These exercise the math helpers that are pinned in this repo's
// rendering pipeline. They're ports of behaviour from the obra-dinn
// / cameraunlock-core C++ reference and from OpenTrack-style angle
// handling, so a silent drift here can introduce visible artifacts in
// the live viewer (snap-back at angle wrap, deadzone leak, velocity
// runaway under low frame-rate).
//
// The functions are loaded by string-slicing the renderer source and
// evaluating the snippets in a vm sandbox — see
// tests/helpers/renderer-snippet.mjs. That keeps the tests honest
// against the production bytes without requiring a browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
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
} from '../helpers/renderer-snippet.mjs';

// Helper: assert two floats are close.
function approx(actual, expected, tol = 1e-9, msg = '') {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} expected ${expected} ± ${tol}, got ${actual}`,
  );
}

describe('obraDinnAlpha', () => {
  test('returns 1 (no smoothing) when smoothing is exactly 0', () => {
    assert.equal(obraDinnAlpha(0, 1 / 60), 1);
  });

  test('returns 1 when smoothing is below the 0.001 threshold', () => {
    assert.equal(obraDinnAlpha(0.0009, 1 / 60), 1);
    assert.equal(obraDinnAlpha(0.0001, 1 / 60), 1);
  });

  test('alpha decreases monotonically as smoothing increases', () => {
    // Higher smoothing → heavier filter → smaller alpha (less of the
    // new sample is folded in each tick).
    const dt = 1 / 60;
    const a01 = obraDinnAlpha(0.05, dt);
    const a02 = obraDinnAlpha(0.30, dt);
    const a03 = obraDinnAlpha(0.80, dt);
    assert.ok(a01 > a02, `expected ${a01} > ${a02}`);
    assert.ok(a02 > a03, `expected ${a02} > ${a03}`);
  });

  test('alpha increases monotonically with dt for a fixed smoothing', () => {
    // Slower frame rate → bigger dt → catches up faster.
    const s = 0.15;
    assert.ok(obraDinnAlpha(s, 0.005) < obraDinnAlpha(s, 0.01));
    assert.ok(obraDinnAlpha(s, 0.01) < obraDinnAlpha(s, 0.05));
  });

  test('at smoothing=0.15 (default), alpha matches the closed-form formula', () => {
    const s = 0.15, dt = 1 / 60;
    const speed = 50 + (0.1 - 50) * s; // 42.515
    const expected = 1 - Math.exp(-speed * dt);
    approx(obraDinnAlpha(s, dt), expected, 1e-12);
  });

  test('at smoothing=1.0, speed degenerates to 0.1 (heavy filter)', () => {
    const dt = 1 / 60;
    const expected = 1 - Math.exp(-0.1 * dt);
    approx(obraDinnAlpha(1.0, dt), expected, 1e-12);
    // Sanity: should be tiny (< 0.01)
    assert.ok(obraDinnAlpha(1.0, dt) < 0.01);
  });

  test('alpha is always in (0, 1] for non-zero smoothing and positive dt', () => {
    for (const s of [0.001, 0.05, 0.5, 0.99]) {
      for (const dt of [0.001, 0.016, 0.1]) {
        const a = obraDinnAlpha(s, dt);
        assert.ok(a > 0 && a <= 1, `alpha out of range for s=${s} dt=${dt}: ${a}`);
      }
    }
  });
});

describe('applyDeadzone', () => {
  test('dz <= 0 is a no-op', () => {
    assert.equal(applyDeadzone(0.5, 0), 0.5);
    assert.equal(applyDeadzone(0.5, -0.1), 0.5);
    assert.equal(applyDeadzone(-1.2, 0), -1.2);
  });

  test('values inside the deadzone collapse to exactly 0', () => {
    assert.equal(applyDeadzone(0.1, 0.3), 0);
    assert.equal(applyDeadzone(-0.2, 0.3), 0);
    assert.equal(applyDeadzone(0, 0.3), 0);
  });

  test('values exactly at the deadzone boundary collapse to 0', () => {
    // The check is `if (a <= dz) return 0`, so |v|==dz returns 0.
    assert.equal(applyDeadzone(0.3, 0.3), 0);
    assert.equal(applyDeadzone(-0.3, 0.3), 0);
  });

  test('positive values just outside the deadzone return |v|-dz', () => {
    assert.equal(applyDeadzone(0.5, 0.3), 0.2);
    approx(applyDeadzone(0.31, 0.3), 0.01, 1e-12);
  });

  test('negative values just outside the deadzone preserve sign and subtract dz', () => {
    approx(applyDeadzone(-0.5, 0.3), -0.2, 1e-12);
    approx(applyDeadzone(-0.31, 0.3), -0.01, 1e-12);
  });

  test('large values are shifted by exactly dz, not scaled', () => {
    // Important: deadzone is a translation, not a gain. A regression
    // that scales (e.g. multiplies by (a-dz)/a) would not be caught
    // by the small-value tests.
    assert.equal(applyDeadzone(100, 0.3), 99.7);
    assert.equal(applyDeadzone(-100, 0.3), -99.7);
  });
});

describe('unwrapDeg', () => {
  test('last === null returns cur unchanged (first sample)', () => {
    assert.equal(unwrapDeg(42, null), 42);
    assert.equal(unwrapDeg(-180, null), -180);
  });

  test('small deltas are returned as-is (no wrap)', () => {
    assert.equal(unwrapDeg(10, 5), 10);
    assert.equal(unwrapDeg(-10, -5), -10);
    assert.equal(unwrapDeg(180, 0), 180); // exactly 180 — strict > so no wrap
    assert.equal(unwrapDeg(-180, 0), -180); // exactly -180 — strict < so no wrap
  });

  test('wrap from 179° to -179° unwinds to 181° (continuous yaw)', () => {
    // Without unwrap, a tracker hopping 179 → -179 produces a 358°
    // jump and the camera flips. Unwrap turns it into +2°.
    assert.equal(unwrapDeg(-179, 179), 181);
  });

  test('wrap from -179° to 179° unwinds to -181°', () => {
    assert.equal(unwrapDeg(179, -179), -181);
  });

  test('large gap unwinds correctly via 360° increments', () => {
    // cur=10, last=350: delta = -340 → +360 → +20 → 370
    assert.equal(unwrapDeg(10, 350), 370);
    // cur=350, last=10: delta = 340 → -360 → -20 → -10
    assert.equal(unwrapDeg(350, 10), -10);
  });

  test('repeated unwrapping accumulates monotonically through full rotations', () => {
    // Simulate a slow continuous yaw past 360°: feed wrapped values
    // (-180, 180] and confirm the unwrapped output is monotonic.
    let last = null;
    let unwrapped = 0;
    const wrappedSeq = [0, 90, 179, -179, -90, 0, 90, 179]; // a bit more than one full revolution
    let prev = -Infinity;
    for (const cur of wrappedSeq) {
      unwrapped = unwrapDeg(cur, last);
      assert.ok(unwrapped >= prev, `non-monotonic at cur=${cur}: ${unwrapped} < ${prev}`);
      prev = unwrapped;
      last = unwrapped;
    }
    // Should have ended around 360°+179° = 539° (one full revolution
    // plus the final hop to 179).
    assert.equal(unwrapped, 539);
  });
});

describe('classify / classifyLow', () => {
  test('classify: v >= err → err (boundary inclusive)', () => {
    assert.equal(classify(10, 3, 10), 'err');
    assert.equal(classify(11, 3, 10), 'err');
  });

  test('classify: warn <= v < err → warn', () => {
    assert.equal(classify(3, 3, 10), 'warn'); // exactly at warn
    assert.equal(classify(9.99, 3, 10), 'warn');
  });

  test('classify: v < warn → ok', () => {
    assert.equal(classify(0, 3, 10), 'ok');
    assert.equal(classify(2.99, 3, 10), 'ok');
    assert.equal(classify(-100, 3, 10), 'ok');
  });

  test('classifyLow: v <= err → err (boundary inclusive)', () => {
    // Low-is-bad direction: err < warn semantically.
    assert.equal(classifyLow(3, 8, 3), 'err');
    assert.equal(classifyLow(2, 8, 3), 'err');
  });

  test('classifyLow: err < v <= warn → warn', () => {
    assert.equal(classifyLow(8, 8, 3), 'warn'); // exactly at warn
    assert.equal(classifyLow(3.01, 8, 3), 'warn');
  });

  test('classifyLow: v > warn → ok', () => {
    assert.equal(classifyLow(9, 8, 3), 'ok');
    assert.equal(classifyLow(1000, 8, 3), 'ok');
  });
});

describe('PoseInterpolator', () => {
  test('initial state has no samples and no velocity', () => {
    const pi = new PoseInterpolator();
    assert.equal(pi.hasAny, false);
    assert.equal(pi.hasV, false);
    assert.equal(pi.vY, 0);
    assert.equal(pi.vP, 0);
    assert.equal(pi.vR, 0);
    assert.equal(pi.lastY, 0);
    assert.equal(pi.timeSince, 0);
  });

  test('first isNew sample is returned unchanged and seeds lastY/lastP/lastR', () => {
    const pi = new PoseInterpolator();
    const out = pi.update(10, 20, 30, true, 1 / 60);
    assert.deepEqual(out, [10, 20, 30]);
    assert.equal(pi.lastY, 10);
    assert.equal(pi.lastP, 20);
    assert.equal(pi.lastR, 30);
    assert.equal(pi.hasAny, true);
    assert.equal(pi.hasV, false); // velocity needs two samples
  });

  test('second isNew sample computes instantaneous velocity and sets hasV', () => {
    const pi = new PoseInterpolator();
    pi.update(0, 0, 0, true, 0);
    pi.update(10, 5, -20, true, 0.1);
    assert.equal(pi.hasV, true);
    // velocity = (current - last) / (timeSince + dt) = 10 / (0 + 0.1) = 100
    approx(pi.vY, 100, 1e-12);
    approx(pi.vP, 50, 1e-12);
    approx(pi.vR, -200, 1e-12);
  });

  test('third isNew sample blends velocities 50/50 (VEL_BLEND)', () => {
    const pi = new PoseInterpolator();
    pi.update(0, 0, 0, true, 0);
    pi.update(10, 0, 0, true, 0.1);  // vY = 100
    pi.update(15, 0, 0, true, 0.1);  // instantaneous = (15-10)/0.1 = 50; blend → 100 + (50-100)*0.5 = 75
    approx(pi.vY, 75, 1e-12);
  });

  test('isNew=false before hasV is true returns the passed sample unchanged but bumps timeSince', () => {
    const pi = new PoseInterpolator();
    pi.update(5, 6, 7, true, 0);
    // Only one sample so far: hasV is still false. A non-new tick should
    // pass through the caller-supplied values and advance timeSince.
    const out = pi.update(99, 88, 77, false, 0.05);
    assert.deepEqual(out, [99, 88, 77]);
    approx(pi.timeSince, 0.05, 1e-12);
  });

  test('isNew=false after velocity is known extrapolates from last + v*t*decay', () => {
    const pi = new PoseInterpolator();
    pi.update(0, 0, 0, true, 0);
    pi.update(10, 0, 0, true, 0.1); // vY = 100, lastY = 10, timeSince = 0
    // dt=0.05: timeSince becomes 0.05; ratio=0.5; decay = 1/(1+0.25) = 0.8
    // Predicted y = 10 + 100 * 0.05 * 0.8 = 14
    const out = pi.update(0, 0, 0, false, 0.05);
    approx(out[0], 14, 1e-12);
  });

  test('extrapolation t is capped at MAX_EXT=0.1 (extrapolation freezes)', () => {
    const pi = new PoseInterpolator();
    pi.update(0, 0, 0, true, 0);
    pi.update(10, 0, 0, true, 0.1); // vY = 100
    const a = pi.update(0, 0, 0, false, 0.2); // timeSince=0.2, t clamped to 0.1
    // ratio=1, decay=0.5 → 10 + 100*0.1*0.5 = 15
    approx(a[0], 15, 1e-12);
    const b = pi.update(0, 0, 0, false, 0.5); // timeSince=0.7, t still 0.1
    approx(b[0], 15, 1e-12);
  });

  test('decay shape: extrapolation magnitude is largest at small t and falls off near MAX_EXT', () => {
    const pi = new PoseInterpolator();
    pi.update(0, 0, 0, true, 0);
    pi.update(10, 0, 0, true, 0.1); // vY = 100
    const small = pi.update(0, 0, 0, false, 0.02); // t=0.02
    // Reset timeSince by feeding an isNew, then re-measure at a larger t.
    pi.update(10, 0, 0, true, 0); // refresh lastY to 10 with vel blend (vel stays around 100)
    const large = pi.update(0, 0, 0, false, 0.08); // t=0.08
    // Per-tick offset relative to lastY:
    const offsetSmall = small[0] - 10;
    const offsetLarge = large[0] - 10;
    // Both should be positive (velocity is +100); offsetLarge > offsetSmall
    // because t is larger, but decay should keep large from being 4× small.
    assert.ok(offsetSmall > 0);
    assert.ok(offsetLarge > offsetSmall);
    assert.ok(offsetLarge < offsetSmall * 4, `decay should sub-linearize; small=${offsetSmall} large=${offsetLarge}`);
  });

  test('reset() clears all state', () => {
    const pi = new PoseInterpolator();
    pi.update(10, 20, 30, true, 0);
    pi.update(20, 30, 40, true, 0.1);
    pi.update(0, 0, 0, false, 0.05);
    pi.reset();
    assert.equal(pi.hasAny, false);
    assert.equal(pi.hasV, false);
    assert.equal(pi.vY, 0);
    assert.equal(pi.vP, 0);
    assert.equal(pi.vR, 0);
    assert.equal(pi.lastY, 0);
    assert.equal(pi.timeSince, 0);
  });

  test('non-new ticks accumulate into timeSince and widen the next velocity window', () => {
    const pi = new PoseInterpolator();
    pi.update(0, 0, 0, true, 0);    // first sample, timeSince=0
    pi.update(0, 0, 0, false, 0.05); // timeSince=0.05, no velocity yet
    // Now an isNew: sdt = timeSince + dt = 0.05 + 0.05 = 0.10
    // vY = (10 - 0) / 0.10 = 100
    pi.update(10, 0, 0, true, 0.05);
    approx(pi.vY, 100, 1e-12);
    assert.equal(pi.timeSince, 0);
  });
});

describe('oneEuroLowpassAlpha', () => {
  test('alpha rises with cutoff (higher cutoff → less smoothing)', () => {
    const dt = 1 / 60;
    assert.ok(oneEuroLowpassAlpha(1, dt) < oneEuroLowpassAlpha(5, dt));
    assert.ok(oneEuroLowpassAlpha(5, dt) < oneEuroLowpassAlpha(20, dt));
  });

  test('alpha is in (0,1) for positive cutoff/dt', () => {
    const a = oneEuroLowpassAlpha(3, 1 / 120);
    assert.ok(a > 0 && a < 1);
  });
});

describe('oneEuroStep', () => {
  const P = { minCutoff: 1, beta: 0.01, dCutoff: 1 };

  test('first call seeds state to the targets and reports has', () => {
    const st = { x: [], dx: [], has: false };
    const out = oneEuroStep(st, [5, -3], 1 / 60, P);
    assert.deepEqual(out, [5, -3]);
    assert.equal(st.has, true);
    assert.deepEqual(st.dx, [0, 0]);
  });

  test('re-seeds when the channel count changes', () => {
    const st = { x: [], dx: [], has: false };
    oneEuroStep(st, [1, 2, 3], 1 / 60, P);
    const out = oneEuroStep(st, [7, 8], 1 / 60, P);
    assert.deepEqual(out, [7, 8]);
  });

  test('output moves toward the target but lags it (low-pass)', () => {
    const st = { x: [], dx: [], has: false };
    oneEuroStep(st, [0], 1 / 60, P);
    const out = oneEuroStep(st, [10], 1 / 60, P);
    assert.ok(out[0] > 0 && out[0] < 10);
  });

  test('a held target converges monotonically to it', () => {
    const st = { x: [], dx: [], has: false };
    oneEuroStep(st, [0], 1 / 60, P);
    let prev = -Infinity;
    let v = 0;
    for (let i = 0; i < 500; i++) { v = oneEuroStep(st, [10], 1 / 60, P)[0]; assert.ok(v >= prev - 1e-9); prev = v; }
    approx(v, 10, 1e-3);
  });

  test('higher beta opens the cutoff on fast motion (less lag)', () => {
    const dt = 1 / 60;
    const run = (beta) => {
      const st = { x: [], dx: [], has: false };
      const p = { minCutoff: 1, beta, dCutoff: 1 };
      oneEuroStep(st, [0], dt, p);
      let v = 0;
      for (let i = 1; i <= 5; i++) v = oneEuroStep(st, [i * 20], dt, p)[0];
      return v;
    };
    assert.ok(run(0.1) > run(0), 'higher beta should track a fast ramp more closely');
  });
});

describe('accelaStep', () => {
  const P = { deadband: 0.3, smoothing: 10, expo: 2 };

  test('first call seeds to the targets', () => {
    const st = { x: [], has: false };
    const out = accelaStep(st, [4, -2], 1 / 60, P, [1, 1]);
    assert.deepEqual(out, [4, -2]);
    assert.equal(st.has, true);
  });

  test('holds perfectly still inside the deadband', () => {
    const st = { x: [], has: false };
    accelaStep(st, [0], 1 / 60, P, [1]);
    const out = accelaStep(st, [0.2], 1 / 60, P, [1]); // 0.2 < deadband 0.3
    assert.equal(out[0], 0);
  });

  test('moves toward the target once past the deadband, without overshoot', () => {
    const st = { x: [], has: false };
    accelaStep(st, [0], 1 / 60, P, [1]);
    const out = accelaStep(st, [10], 1 / 60, P, [1])[0];
    assert.ok(out > 0 && out < 10);
  });

  test('larger error chases faster (nonlinear response)', () => {
    const dt = 1 / 60;
    const stepFrom = (target) => {
      const st = { x: [], has: false };
      accelaStep(st, [0], dt, P, [1]);
      return accelaStep(st, [target], dt, P, [1])[0];
    };
    const near = stepFrom(2) / 2;   // fraction of a small error covered
    const far = stepFrom(20) / 20;  // fraction of a large error covered
    assert.ok(far > near, `expo response: far ${far} should exceed near ${near}`);
  });

  test('scale shrinks the effective deadband for metre channels', () => {
    const st = { x: [], has: false };
    accelaStep(st, [0], 1 / 60, P, [0.01]);
    // 0.05 m target with deadband 0.3*0.01 = 0.003 m → outside the band, should move
    const out = accelaStep(st, [0.05], 1 / 60, P, [0.01])[0];
    assert.ok(out > 0);
  });

  test('settles within one deadband of a held target (residual offset)', () => {
    // The deadband means it stops chasing once the error drops below it, so it
    // parks just short of the target rather than reaching it exactly.
    const st = { x: [], has: false };
    accelaStep(st, [0], 1 / 60, P, [1]);
    let v = 0;
    for (let i = 0; i < 5000; i++) v = accelaStep(st, [5], 1 / 60, P, [1])[0];
    assert.ok(v <= 5 && v >= 5 - P.deadband - 1e-6, `settled at ${v}`);
    assert.ok(v > 5 - P.deadband - 0.05, `should reach the deadband edge, got ${v}`);
  });
});

describe('amount → param curves', () => {
  test('euroParamsFromAmount: 0 is responsive, 1 is smooth', () => {
    const lo = euroParamsFromAmount(0);
    const hi = euroParamsFromAmount(1);
    assert.ok(lo.minCutoff > hi.minCutoff, 'responsive end has higher cutoff');
    assert.ok(lo.beta > hi.beta, 'responsive end has higher beta');
    approx(hi.beta, 0, 1e-12);
  });

  test('euroParamsFromAmount clamps out-of-range input', () => {
    assert.deepEqual(euroParamsFromAmount(-5), euroParamsFromAmount(0));
    assert.deepEqual(euroParamsFromAmount(5), euroParamsFromAmount(1));
  });

  test('accelaSmoothingFromAmount increases with the dial', () => {
    assert.ok(accelaSmoothingFromAmount(0) < accelaSmoothingFromAmount(1));
    approx(accelaSmoothingFromAmount(0), 0.5, 1e-12);
    approx(accelaSmoothingFromAmount(1), 20, 1e-12);
  });
});
