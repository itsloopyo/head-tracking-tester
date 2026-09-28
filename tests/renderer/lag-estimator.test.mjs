// Relative-latency estimator tests.
//
// A correlation peak always exists, even in noise, so the estimator has two
// jobs and both are tested here: find the delay when there is one to find,
// and refuse when there isn't.
//
// Model: every source watches the same head, sampling it on the same
// timeline. A source with latency L emits the head's pose from time s in a
// packet that lands at s + L, so the server stamps ct = s + L and the
// value is motion(s). Delivery jitter is noise on ct, not on the value.
//
// Functions are string-sliced out of public/renderer.js and evaluated in a
// vm sandbox. See tests/helpers/renderer-snippet.mjs.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resampleRotation,
  corrCurve,
  computeLagMs,
  LAG_STEP_MS,
  LAG_MAX_MS,
  LAG_WINDOW_MS,
  LAG_DIFF_MS,
  LAG_CHANNEL_TOL_MS,
  lagMedian,
} from '../helpers/renderer-snippet.mjs';

// Deterministic, so the tolerances below mean the same thing every run.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Band-limited head motion, distinct per channel so a test that only moves
// one axis is genuinely only moving one axis.
function headMotion(tMs) {
  const t = tMs / 1000;
  return [
    18 * Math.sin(2 * Math.PI * 0.7 * t) + 6 * Math.sin(2 * Math.PI * 1.9 * t + 1.1),
    9 * Math.sin(2 * Math.PI * 0.5 * t + 0.4) + 3 * Math.sin(2 * Math.PI * 1.3 * t),
    4 * Math.sin(2 * Math.PI * 0.9 * t + 2.2) + 2 * Math.sin(2 * Math.PI * 2.3 * t),
  ];
}

const EPOCH = 500000; // arbitrary monotonic-clock offset, as the server's is

function makeHist({
  hz = 100,
  latencyMs = 0,
  durMs = 3500,
  signs = [1, 1, 1],
  noiseDeg = 0,
  jitterMs = 0,
  seed = 12345,
  motion = headMotion,
  gap = null, // { atMs, lenMs }: a dropout in the sender's output
} = {}) {
  const rnd = lcg(seed);
  const step = 1000 / hz;
  const hist = [];
  for (let sendT = 0; sendT <= durMs; sendT += step) {
    if (gap && sendT > gap.atMs && sendT < gap.atMs + gap.lenMs) continue;
    const jitter = jitterMs ? (rnd() - 0.5) * 2 * jitterMs : 0;
    const [y, p, r] = motion(sendT);
    const n = () => (noiseDeg ? (rnd() - 0.5) * 2 * noiseDeg : 0);
    hist.push({
      ct: EPOCH + sendT + latencyMs + jitter,
      yaw: signs[0] * y + n(),
      pitch: signs[1] * p + n(),
      roll: signs[2] * r + n(),
    });
  }
  return hist;
}

function lagOf(refOpts, pOpts) {
  return computeLagMs(makeHist(refOpts), makeHist(pOpts));
}

function approxLag(res, expected, tol, msg = '') {
  assert.equal(res.status, 'ok', `${msg} expected an estimate, got status '${res.status}'`);
  assert.ok(
    Math.abs(res.lagMs - expected) <= tol,
    `${msg} expected ${expected} ± ${tol} ms, got ${res.lagMs.toFixed(2)} ms (r ${res.corr.toFixed(3)})`,
  );
}

describe('computeLagMs: recovering a known delay', () => {
  test('identical streams read as zero lag', () => {
    const res = lagOf({}, {});
    approxLag(res, 0, 0.5);
    assert.ok(res.corr > 0.999, `expected near-perfect correlation, got ${res.corr}`);
  });

  test('a 30 ms delay reads as +30 ms', () => {
    approxLag(lagOf({}, { latencyMs: 30 }), 30, 2);
  });

  test('a source ahead of the reference reads negative', () => {
    approxLag(lagOf({ latencyMs: 60 }, { latencyMs: 20 }), -40, 2);
  });

  test('recovers delays that fall between grid points', () => {
    // 37 ms is not a multiple of the 5 ms grid; without sub-grid refinement
    // the best this could return is 35 or 40.
    const res = lagOf({}, { latencyMs: 37 });
    approxLag(res, 37, 2);
    assert.notEqual(res.lagMs % LAG_STEP_MS, 0, 'expected an off-grid answer');
  });

  test('accurate across the whole search range', () => {
    let worst = 0, sum = 0, n = 0;
    for (let d = 0; d <= LAG_MAX_MS - 40; d += 7) {
      const res = lagOf({}, { latencyMs: d });
      assert.equal(res.status, 'ok', `delay ${d} returned '${res.status}'`);
      const err = Math.abs(res.lagMs - d);
      worst = Math.max(worst, err);
      sum += err; n++;
    }
    assert.ok(worst < 3, `worst error ${worst.toFixed(2)} ms across the sweep`);
    assert.ok(sum / n < 1.5, `mean error ${(sum / n).toFixed(2)} ms across the sweep`);
  });

  test('sub-grid refinement beats snapping to the grid', () => {
    // Compare the refined answer against the same peak snapped to the grid,
    // to show the refinement earns its decimal places.
    let refined = 0, snapped = 0, n = 0;
    for (let d = 0; d <= 120; d += 3) {
      const res = lagOf({}, { latencyMs: d });
      assert.equal(res.status, 'ok');
      refined += Math.abs(res.lagMs - d);
      snapped += Math.abs(Math.round(res.lagMs / LAG_STEP_MS) * LAG_STEP_MS - d);
      n++;
    }
    assert.ok(
      refined < snapped * 0.6,
      `refined mean ${(refined / n).toFixed(2)} ms vs grid-snapped ${(snapped / n).toFixed(2)} ms`,
    );
  });
});

describe('computeLagMs: sources that disagree about conventions', () => {
  test('an inverted yaw axis does not defeat it', () => {
    approxLag(lagOf({}, { latencyMs: 45, signs: [-1, 1, 1] }), 45, 2);
  });

  test('all three axes inverted', () => {
    approxLag(lagOf({}, { latencyMs: 45, signs: [-1, -1, -1] }), 45, 2);
  });

  test('a source that leaves roll at zero still gets measured', () => {
    const flatRoll = (t) => { const m = headMotion(t); return [m[0], m[1], 0]; };
    approxLag(lagOf({}, { latencyMs: 25, motion: flatRoll }), 25, 2);
  });
});

describe('computeLagMs: motion on one axis only', () => {
  const only = (i) => (t) => {
    const m = headMotion(t);
    return [i === 0 ? m[0] : 0, i === 1 ? m[1] : 0, i === 2 ? m[2] : 0];
  };

  test('pitch-only motion', () => {
    approxLag(lagOf({ motion: only(1) }, { latencyMs: 40, motion: only(1) }), 40, 2);
  });

  test('roll-only motion', () => {
    approxLag(lagOf({ motion: only(2) }, { latencyMs: 40, motion: only(2) }), 40, 2);
  });
});

describe('computeLagMs: awkward but real inputs', () => {
  test('a 20 Hz source against a 120 Hz reference', () => {
    approxLag(lagOf({ hz: 120 }, { hz: 20, latencyMs: 50 }), 50, 6);
  });

  test('delivery jitter on the arrival stamps', () => {
    approxLag(lagOf({}, { latencyMs: 50, jitterMs: 3, seed: 7 }), 50, 5);
  });

  test('heavy jitter that reorders arrivals stays roughly right', () => {
    approxLag(lagOf({}, { latencyMs: 50, jitterMs: 12, seed: 99 }), 50, 12);
  });

  test('sensor noise on top of the motion', () => {
    approxLag(lagOf({ noiseDeg: 0.4, seed: 3 }, { latencyMs: 35, noiseDeg: 0.4, seed: 4 }), 35, 3);
  });

  test('a source whose own smoothing distorts the waveform', () => {
    // Not a pure delay: an internally smoothed tracker reshapes the signal, so
    // the peak correlation drops and the group delay it reports is the filter's
    // plus the transport's. Both are real lag the user feels, and the estimator
    // has to keep measuring rather than give up on the imperfect match.
    const smoothed = (tauMs) => {
      const cache = new Map();
      const alpha = 1 - Math.exp(-1 / tauMs);
      return (t) => {
        const k = Math.round(t);
        if (cache.has(k)) return cache.get(k);
        const from = Math.max(0, k - 600);
        let st = headMotion(from);
        for (let s = from; s <= k; s++) {
          const m = headMotion(s);
          st = [
            st[0] + (m[0] - st[0]) * alpha,
            st[1] + (m[1] - st[1]) * alpha,
            st[2] + (m[2] - st[2]) * alpha,
          ];
        }
        cache.set(k, st);
        return st;
      };
    };
    // Heavier smoothing means more group delay, so these must come out ordered.
    let prev = -Infinity;
    for (const tau of [40, 120, 250]) {
      const res = lagOf({}, { latencyMs: 60, motion: smoothed(tau) });
      assert.equal(res.status, 'ok', `tau ${tau} returned '${res.status}'`);
      assert.ok(res.lagMs > 60, `tau ${tau} should lag more than the 60 ms transport, got ${res.lagMs}`);
      assert.ok(res.lagMs > prev, `tau ${tau} should lag more than the lighter filter`);
      prev = res.lagMs;
    }
  });

  test('motion that wraps through ±180°', () => {
    const spin = (t) => {
      const m = headMotion(t);
      let y = (m[0] + t * 0.09) % 360;
      if (y > 180) y -= 360;
      if (y < -180) y += 360;
      return [y, m[1], m[2]];
    };
    approxLag(lagOf({ motion: spin }, { latencyMs: 30, motion: spin }), 30, 3);
  });
});

describe('computeLagMs: refusing to answer', () => {
  test('a still head produces no estimate', () => {
    const still = () => [12, -3, 0.5];
    const res = lagOf({ motion: still }, { motion: still, latencyMs: 40 });
    assert.equal(res.status, 'weak');
    assert.equal(res.lagMs, undefined);
  });

  test('two unrelated noise streams produce no estimate', () => {
    const noise = (seed) => {
      const rnd = lcg(seed);
      const cache = new Map();
      return (t) => {
        const k = Math.round(t);
        if (!cache.has(k)) cache.set(k, [rnd() * 20, rnd() * 20, rnd() * 20]);
        return cache.get(k);
      };
    };
    const res = computeLagMs(
      makeHist({ motion: noise(11) }),
      makeHist({ motion: noise(22) }),
    );
    assert.equal(res.status, 'weak');
  });

  test('a delay past the search range reports out of range', () => {
    // Without the edge check the peak pins to the boundary at r > 0.99 and
    // the boundary is reported as if it were the measurement.
    const res = lagOf({ durMs: 5200 }, { latencyMs: LAG_MAX_MS + 20, durMs: 5200 });
    assert.equal(res.status, 'range');
    assert.equal(res.lagMs, undefined);
  });

  test('a delay just inside the search range still resolves', () => {
    approxLag(lagOf({ durMs: 5200 }, { latencyMs: LAG_MAX_MS - 30, durMs: 5200 }), LAG_MAX_MS - 30, 3);
  });

  test('metronomic motion is reported as ambiguous', () => {
    // A 2 Hz head shake correlates equally well a whole period either side of
    // the true lag, at r 0.83+, so no confidence threshold catches it.
    const shake = (t) => [
      22 * Math.sin(2 * Math.PI * 2 * t / 1000),
      2 * Math.sin(2 * Math.PI * 2 * t / 1000 + 0.3),
      0,
    ];
    for (const d of [40, 120, 250]) {
      const res = lagOf({ durMs: 5200, motion: shake }, { latencyMs: d, durMs: 5200, motion: shake });
      assert.equal(res.status, 'ambiguous', `delay ${d} returned '${res.status}'`);
      assert.equal(res.lagMs, undefined);
    }
  });

  test('ordinary broadband motion is never called ambiguous', () => {
    // The guard has to be free for real motion.
    for (const d of [0, 15, 60, 140, 260, 400]) {
      const res = lagOf({ durMs: 5200 }, { latencyMs: d, durMs: 5200 });
      assert.equal(res.status, 'ok', `delay ${d} returned '${res.status}'`);
    }
  });

  test('a partly flat window never yields a confident wrong answer', () => {
    // The dangerous case, seen live: once most of the window is a held pose,
    // the flat stretch overlaps itself at every lag and props the correlation
    // up near 0.85 everywhere, so the peak is picked out of the leftovers. The
    // estimate is then wrong by hundreds of ms while looking confident.
    const freezeAt = (tFreeze) => (t) => headMotion(Math.min(t, tFreeze));
    for (const tFreeze of [1000, 1400, 1600, 1900]) {
      for (const d of [30, 80, 200]) {
        const res = lagOf({ motion: freezeAt(tFreeze) }, { latencyMs: d, motion: freezeAt(tFreeze) });
        if (res.status !== 'ok') continue;
        assert.ok(
          Math.abs(res.lagMs - d) < 10,
          `freeze at ${tFreeze} ms, true lag ${d}: answered ${res.lagMs.toFixed(1)} ms at r ${res.corr.toFixed(2)}`,
        );
      }
    }
  });

  test('a dropout inside the window is rejected', () => {
    const res = computeLagMs(
      makeHist({}),
      makeHist({ latencyMs: 30, gap: { atMs: 2000, lenMs: 400 } }),
    );
    assert.equal(res.status, 'nodata');
  });

  test('a buffer shorter than the window produces no estimate', () => {
    const res = computeLagMs(makeHist({}), makeHist({ durMs: 1000 }));
    assert.equal(res.status, 'nodata');
  });

  test('empty buffers produce no estimate', () => {
    assert.equal(computeLagMs([], makeHist({})).status, 'nodata');
    assert.equal(computeLagMs(makeHist({}), []).status, 'nodata');
  });
});

describe('computeLagMs: sources that disagree about more than latency', () => {
  test('one axis wandering on its own cannot capture the answer', () => {
    // The channels are summed, so a big axis the two sources disagree about
    // outweighs the small ones they agree on and drags the peak to a lag
    // nothing measured. Reported as +40 truth, it came out at -125 ms r 0.90.
    const refM = (t) => {
      const s = t / 1000;
      return [4 * Math.sin(2 * Math.PI * 0.6 * s), 1.5 * Math.sin(2 * Math.PI * 0.4 * s + 1),
        25 * Math.sin(2 * Math.PI * 0.61 * s)];
    };
    const paneM = (t) => {
      const s = t / 1000;
      return [4 * Math.sin(2 * Math.PI * 0.6 * s), 1.5 * Math.sin(2 * Math.PI * 0.4 * s + 1),
        25 * Math.sin(2 * Math.PI * 0.75 * s + 2)];
    };
    const res = computeLagMs(makeHist({ motion: refM }), makeHist({ latencyMs: 40, motion: paneM }));
    if (res.status === 'ok') {
      assert.ok(Math.abs(res.lagMs - 40) < 12,
        `answered ${res.lagMs.toFixed(1)} ms at r ${res.corr.toFixed(2)} for a true 40 ms`);
    }
  });

  test('axes carrying only dither do not veto a reading', () => {
    // Turning the head on one axis leaves the other two at their noise floor,
    // where each peaks wherever its noise happens to. They must not get a vote
    // on whether the axes agree, or an ordinary horizontal turn never reads.
    const yawOnly = (t) => [headMotion(t)[0], 0, 0];
    for (let seed = 1; seed <= 5; seed++) {
      const res = computeLagMs(
        makeHist({ motion: yawOnly, noiseDeg: 0.15, seed: seed * 13 }),
        makeHist({ latencyMs: 45, motion: yawOnly, noiseDeg: 0.15, seed: seed * 977 }),
      );
      approxLag(res, 45, 4, `seed ${seed}:`);
    }
  });

  test('a disagreeing axis cannot pull a window past the agreement tolerance', () => {
    // Yaw and pitch agree at +40 ms; roll is a component the two sources map to
    // different phases. Unchecked it dragged the answer to -16 ms, reporting a
    // pane 40 ms behind as being ahead of the reference. A single window can
    // still be pulled by an axis sitting inside LAG_CHANNEL_TOL_MS, which is the
    // price of a tolerance loose enough for a smoothed tracker's honest
    // per-axis spread; the displayed figure is a median over many windows.
    const withRoll = (phase) => (t) => {
      const s = t / 1000;
      const m = headMotion(t);
      return [m[0], m[1], 3 * Math.sin(2 * Math.PI * 2.0 * s + phase)];
    };
    for (const phase of [2.0, 3.5, 5.0]) {
      const res = computeLagMs(
        makeHist({ durMs: 5200, motion: withRoll(0) }),
        makeHist({ latencyMs: 40, durMs: 5200, motion: withRoll(phase) }),
      );
      if (res.status === 'ok') {
        assert.ok(Math.abs(res.lagMs - 40) < LAG_CHANNEL_TOL_MS,
          `roll phase ${phase} answered ${res.lagMs.toFixed(1)} ms at r ${res.corr.toFixed(2)}`);
      }
    }
  });

  test('a swapped axis pair is not blended into a plausible number', () => {
    const swap = (i, j) => (t) => {
      const m = headMotion(t);
      const out = [m[0], m[1], m[2]];
      out[i] = m[j]; out[j] = m[i];
      return out;
    };
    for (const [i, j] of [[1, 2], [0, 1]]) {
      const res = computeLagMs(makeHist({}), makeHist({ latencyMs: 40, motion: swap(i, j) }));
      if (res.status === 'ok') {
        assert.ok(Math.abs(res.lagMs - 40) < 12,
          `axes ${i}/${j} swapped answered ${res.lagMs.toFixed(1)} ms at r ${res.corr.toFixed(2)}`);
      }
    }
  });
});

describe('computeLagMs: delays far past the search range', () => {
  test('never answers confidently once the peak can no longer be seen', () => {
    // Past the range the peak stops pinning to the edge and locks onto a
    // sidelobe inside it, which is an answer that looks entirely healthy.
    for (const d of [560, 600, 700, 800, 1000, 1200]) {
      const res = computeLagMs(
        makeHist({ durMs: 5200 }),
        makeHist({ latencyMs: d, durMs: 5200 }),
      );
      assert.notEqual(res.status, 'ok',
        `a ${d} ms delay answered ${res.status === 'ok' ? res.lagMs.toFixed(1) : ''} ms`);
    }
  });

  test('the same, on band-limited random-walk motion', () => {
    const walk = (seed) => {
      let s = seed >>> 0;
      const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
      const cache = new Map();
      const v = [0, 0, 0], x = [0, 0, 0];
      let last = -1;
      return (t) => {
        const k = Math.max(0, Math.round(t / 10));
        for (let i = last + 1; i <= k; i++) {
          for (let c = 0; c < 3; c++) {
            v[c] = v[c] * 0.93 + (rnd() - 0.5) * (c === 0 ? 3.0 : 1.6);
            x[c] = x[c] * 0.998 + v[c] * 0.1;
          }
          cache.set(i, [x[0], x[1], x[2]]);
        }
        last = Math.max(last, k);
        return cache.get(k);
      };
    };
    for (const seed of [1, 2, 3]) {
      for (const d of [700, 1000]) {
        const m = walk(seed);
        const res = computeLagMs(
          makeHist({ durMs: 5200, motion: m }),
          makeHist({ latencyMs: d, durMs: 5200, motion: m }),
        );
        assert.notEqual(res.status, 'ok',
          `seed ${seed} at ${d} ms answered ${res.status === 'ok' ? res.lagMs.toFixed(1) : ''} ms`);
      }
    }
  });
});

describe('computeLagMs: slow gentle motion', () => {
  test('a peak too broad to localise is refused rather than guessed at', () => {
    // A quarter-hertz sway barely turns over inside the search range, so the
    // correlation sits near 1.0 across all of it and the argmax is picked by
    // sensor noise: repeated ticks swing over tens of ms at r 1.00.
    const slow = (t) => {
      const s = t / 1000;
      return [10 * Math.sin(2 * Math.PI * 0.25 * s), 4 * Math.sin(2 * Math.PI * 0.2 * s + 0.7),
        1.5 * Math.sin(2 * Math.PI * 0.3 * s + 2)];
    };
    for (const noiseDeg of [0.1, 0.3]) {
      for (let seed = 1; seed <= 6; seed++) {
        const res = computeLagMs(
          makeHist({ motion: slow, noiseDeg, seed: seed * 13 }),
          makeHist({ latencyMs: 40, motion: slow, noiseDeg, seed: seed * 977 }),
        );
        if (res.status === 'ok') {
          assert.ok(Math.abs(res.lagMs - 40) < 12,
            `noise ${noiseDeg} seed ${seed} answered ${res.lagMs.toFixed(1)} ms at r ${res.corr.toFixed(2)}`);
        }
      }
    }
  });
});

describe('computeLagMs: the two-of-the-same-source check', () => {
  test('one source split across two panes reads as no lag', () => {
    // The acceptance test for the live app: feed one tracker's stream to two
    // ports and the panes must agree. Same values, independent jitter.
    const shared = { hz: 60, jitterMs: 1.5 };
    const res = computeLagMs(
      makeHist({ ...shared, seed: 101 }),
      makeHist({ ...shared, seed: 202 }),
    );
    approxLag(res, 0, 2);
  });
});

describe('resampleRotation', () => {
  const t1 = EPOCH + 3500;
  const t0 = t1 - LAG_WINDOW_MS;

  test('returns mean-removed channels on the requested grid', () => {
    const out = resampleRotation(makeHist({}), t0, t1, LAG_STEP_MS);
    const expected = LAG_WINDOW_MS / LAG_STEP_MS + 1 - LAG_DIFF_MS / LAG_STEP_MS;
    for (let c = 0; c < 3; c++) {
      assert.equal(out.ch[c].length, expected);
      const mean = out.ch[c].reduce((a, b) => a + b, 0) / expected;
      assert.ok(Math.abs(mean) < 1e-9, `channel ${c} mean ${mean}`);
      assert.ok(out.sd[c] > 0);
    }
  });

  test('channels carry change across the differencing span, not absolute angle', () => {
    // A constant rate of turn differences to a constant, so a channel that
    // still carried absolute angle would show a large spread here.
    const ramp = (t) => [t * 0.02, 0, 0];
    const out = resampleRotation(makeHist({ motion: ramp }), t0, t1, LAG_STEP_MS);
    assert.ok(out.sd[0] < 1e-9, `expected a flat differenced channel, got sd ${out.sd[0]}`);
  });

  test('rejects a buffer that starts after the window does', () => {
    assert.equal(resampleRotation(makeHist({ durMs: 1000 }), t0, t1, LAG_STEP_MS), null);
  });

  test('rejects a buffer that ends before the window does', () => {
    const h = makeHist({});
    h.length = h.length - 60;
    assert.equal(resampleRotation(h, t0, t1, LAG_STEP_MS), null);
  });

  test('rejects a hole big enough to invent motion across', () => {
    const h = makeHist({ gap: { atMs: 2000, lenMs: 400 } });
    assert.equal(resampleRotation(h, t0, t1, LAG_STEP_MS), null);
  });

  test('tolerates a gap smaller than the hole limit', () => {
    const h = makeHist({ gap: { atMs: 2000, lenMs: 120 } });
    assert.notEqual(resampleRotation(h, t0, t1, LAG_STEP_MS), null);
  });
});

describe('corrCurve', () => {
  const maxK = 20;

  test('a signal against itself peaks at zero lag with r = 1', () => {
    const n = 400;
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.11) + 0.4 * Math.sin(i * 0.37);
    const curve = corrCurve(a, a, maxK);
    let bestI = 0;
    for (let i = 0; i < curve.length; i++) if (curve[i] > curve[bestI]) bestI = i;
    assert.equal(bestI - maxK, 0);
    assert.ok(Math.abs(curve[bestI] - 1) < 1e-9, `peak r ${curve[bestI]}`);
  });

  test('peaks at the shift actually applied', () => {
    const n = 400, shift = 7;
    const a = new Float64Array(n), b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = Math.sin(i * 0.09) + 0.5 * Math.sin(i * 0.31 + 1);
      b[i] = Math.sin((i - shift) * 0.09) + 0.5 * Math.sin((i - shift) * 0.31 + 1);
    }
    const curve = corrCurve(a, b, maxK);
    let bestI = 0;
    for (let i = 0; i < curve.length; i++) if (curve[i] > curve[bestI]) bestI = i;
    assert.equal(bestI - maxK, shift);
  });

  test('a flat comparison signal correlates with nothing', () => {
    const n = 400;
    const a = new Float64Array(n), b = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.1);
    const curve = corrCurve(a, b, maxK);
    for (const v of curve) assert.equal(v, 0);
  });
});

describe('lagMedian', () => {
  test('no readings yet has no answer', () => {
    assert.equal(lagMedian([]), null);
  });

  test('odd and even counts', () => {
    assert.equal(lagMedian([30]), 30);
    assert.equal(lagMedian([10, 30, 20]), 20);
    assert.equal(lagMedian([10, 20, 30, 40]), 25);
  });

  test('sorts numerically, not as strings', () => {
    // Array.prototype.sort would order these 100, 30, 9.
    assert.equal(lagMedian([9, 100, 30]), 30);
  });

  test('handles negatives, so a pane ahead of the reference averages correctly', () => {
    assert.equal(lagMedian([-40, -20, -30]), -30);
  });

  test('a minority of bad windows cannot move it', () => {
    // The reason for a median: a handful of dragged windows among good ones
    // must not shift the headline figure the way a mean would.
    const good = Array.from({ length: 20 }, (_, i) => 40 + (i % 5) - 2);
    const withOutliers = good.concat([-300, -260, -180]);
    assert.ok(Math.abs(lagMedian(withOutliers) - 40) <= 1,
      `median came out at ${lagMedian(withOutliers)}`);
    const mean = withOutliers.reduce((a, b) => a + b, 0) / withOutliers.length;
    assert.ok(Math.abs(mean - 40) > 5, 'the mean should be visibly dragged, or this proves nothing');
  });
});
