import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// =================================================================
// CONSTANTS / SHARED HELPERS
// =================================================================
const TRANSLATION_SCALE = 0.02;
const INVERT_X = true;
const INVERT_Z = false;

// =================================================================
// QUALITY / PERF DIAL
// =================================================================
// Defaults are tuned for smooth 60fps split-screen on integrated GPUs
// (e.g. MacBook Air). Bumping these back up costs fillrate fast — especially
// on Retina, where DPR=2 = 4x pixels — so the safe default is the cheap one.
// Toolbar "fx" toggle flips bloom + render scale together for a one-click
// "make it pretty" / "make it fast" choice.
const QUALITY = {
  bloom: false,        // UnrealBloomPass: ~40-50% of GPU time at 4-player split.
  antialias: false,    // MSAA on the default framebuffer; off because we run at native DPR.
  renderScale: 1.0,    // Multiplier on top of pixelRatio. Drop below 1 to internally render smaller.
  pixelRatio: 1,       // Hard cap. 1 = native logical pixels (no Retina super-sampling).
  particleScale: 1.0,  // Scales per-scene particle counts. Drop below 1 for very weak GPUs.
};
// Auto-downshift trips once we measure sustained low FPS.
const PERF = {
  target: 55,          // Auto-downshift if we sit below this for ~2s.
  downshifted: false,  // Latches true after the first cut so we don't oscillate.
};

// Smoothing is OFF by default so the viewer shows raw tracker output. The
// toolbar picks one of several filters; when a filter is active we run the
// shared front-end (raw → unwrap → interpolator → recenter) and hand the
// recentered channels to that filter. 'off' just unwraps and snaps, so
// jitter/noise stays visible.
//   classic  – obra-dinn per-axis exponential (deadzone → EMA)
//   oneeuro  – 1€ speed-adaptive low-pass
//   accela   – deadband + nonlinear chase
const FILTER_KEY = 'htt:filter';
const filterState = {
  mode: 'off',
  advanced: false,
  amount: { classic: 0.15, oneeuro: 0.5, accela: 0.5 },
  classicDeadzone: 0.3,
  oneeuro: { minCutoff: 3.0, beta: 0.04, dCutoff: 1.0 },
  accela: { deadband: 0.3, smoothing: 10.0, expo: 2.0 },
};
// Seed the derived params from the default dials so the raw values shown in the
// advanced panel match what the primary slider would produce.
Object.assign(filterState.oneeuro, euroParamsFromAmount(filterState.amount.oneeuro));
filterState.accela.smoothing = accelaSmoothingFromAmount(filterState.amount.accela);
try {
  const rawFilter = localStorage.getItem(FILTER_KEY);
  if (rawFilter) {
    const parsed = JSON.parse(rawFilter);
    filterState.mode = parsed.mode ?? filterState.mode;
    filterState.advanced = parsed.advanced ?? filterState.advanced;
    Object.assign(filterState.amount, parsed.amount);
    if (typeof parsed.classicDeadzone === 'number') filterState.classicDeadzone = parsed.classicDeadzone;
    Object.assign(filterState.oneeuro, parsed.oneeuro);
    Object.assign(filterState.accela, parsed.accela);
  }
} catch {}
function saveFilterState() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filterState)); } catch {}
}

// "Virtual window" (head-coupled off-axis perspective). When ON and exactly
// one player is active, the screen becomes a fixed rectangle in the world and
// only the eye-point moves — the frustum shears instead of the camera rotating,
// so the world looks like it sits behind a sheet of glass. Head rotation is
// ignored; head *position* is everything.
let windowEnabled = false;
// Parked: the off-axis projection isn't right yet. The implementation below is
// left intact — this only removes the way in. Flip to true to get it back.
const WINDOW_MODE_AVAILABLE = false;

// All measurements in cm. screenWidthCm is the physical width of the rendered
// viewport on the monitor (height is derived from the canvas aspect so the 1:1
// mapping never stretches). distanceCm is the resting eye-to-screen distance —
// there is no way to read this absolutely from OpenTrack (its Z is relative to
// the recenter point, not to your monitor), so it's calibrated by hand and
// nudged live with the [ ] / - = keys.
const WINDOW_CAL_KEY = 'htt:windowCal';
// signX/Y/Z map raw tracker translation → world eye offset. They depend on
// your OpenTrack axis config and can't be known ahead of time, so they're
// flippable live with the x/y/z keys. Defaults match the bolted-camera mode's
// translation sense (head-right → eye-right, etc.).
const windowCal = { screenWidthCm: 60, distanceCm: 60, signX: -1, signY: 1, signZ: 1 };
try {
  const raw = localStorage.getItem(WINDOW_CAL_KEY);
  if (raw) Object.assign(windowCal, JSON.parse(raw));
} catch {}
function saveWindowCal() {
  try { localStorage.setItem(WINDOW_CAL_KEY, JSON.stringify(windowCal)); } catch {}
}
// True 1:1 cm → m (vs TRANSLATION_SCALE's 0.02 "gain" feel): 1 cm of head
// travel moves the eye 1 cm relative to a real-size screen at a real distance.
const WINDOW_TRANSLATION_SCALE = 0.01;

// obra-dinn "classic" filter: its [0,1] smoothing knob and the recenter
// deadzone now live in filterState (amount.classic / classicDeadzone).

function obraDinnAlpha(smoothing, dt) {
  if (smoothing < 0.001) return 1;
  const speed = 50 + (0.1 - 50) * smoothing; // lerp(50, 0.1, smoothing)
  return 1 - Math.exp(-speed * dt);
}

function applyDeadzone(v, dz) {
  if (dz <= 0) return v;
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return (v >= 0 ? 1 : -1) * (a - dz);
}

// ---- 1€ (One Euro) filter ----
// Classic Casiez et al. low-pass whose cutoff rises with signal speed: near
// still it clamps to minCutoff (kills jitter), on fast motion the cutoff opens
// up so lag stays low. Applied per channel over a shared state object.
function oneEuroLowpassAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

// state: { x:number[], dx:number[], has:boolean }. Seeds on first call (or when
// the channel count changes) and returns the same array it mutates in place.
function oneEuroStep(state, targets, dt, p) {
  const n = targets.length;
  if (!state.has || state.x.length !== n) {
    state.x = targets.slice();
    state.dx = new Array(n).fill(0);
    state.has = true;
    return state.x;
  }
  const aD = oneEuroLowpassAlpha(p.dCutoff, dt);
  for (let i = 0; i < n; i++) {
    const rate = (targets[i] - state.x[i]) / dt;
    state.dx[i] += aD * (rate - state.dx[i]);
    const cutoff = p.minCutoff + p.beta * Math.abs(state.dx[i]);
    const a = oneEuroLowpassAlpha(cutoff, dt);
    state.x[i] += a * (targets[i] - state.x[i]);
  }
  return state.x;
}

// ---- Accela filter ----
// Deadband + nonlinear chase: inside the deadband it holds perfectly still (no
// micro-jitter), and beyond it the approach rate grows with the error so small
// corrections stay soft while large moves snap. `scale[i]` bridges the degree-
// denominated params to metre channels (translation) so one param set drives
// both. Frame-rate independent via the exponential per-step alpha.
const ACCELA_BASE_RATE = 60;
const ACCELA_POS_UNIT = 0.01; // metres per degree, for the shared param scale

function accelaStep(state, targets, dt, p, scale) {
  const n = targets.length;
  if (!state.has || state.x.length !== n) {
    state.x = targets.slice();
    state.has = true;
    return state.x;
  }
  for (let i = 0; i < n; i++) {
    const s = scale ? scale[i] : 1;
    const dead = p.deadband * s;
    const delta = targets[i] - state.x[i];
    const ad = Math.abs(delta);
    if (ad <= dead) continue;
    const e = (ad - dead) / (p.smoothing * s);
    const rate = ACCELA_BASE_RATE * Math.pow(e, p.expo - 1);
    let alpha = 1 - Math.exp(-rate * dt);
    if (alpha > 1) alpha = 1;
    state.x[i] += delta * alpha;
  }
  return state.x;
}

// A single [0,1] "smoothness" dial expands into each filter's raw params along
// a hand-tuned curve, so the common case needs one slider and the advanced
// panel only exists to override the derived values.
function euroParamsFromAmount(s) {
  const t = 1 - Math.max(0, Math.min(1, s));
  return { minCutoff: 0.2 + 5.8 * t * t, beta: 0.08 * t };
}
function accelaSmoothingFromAmount(s) {
  return 0.5 + 19.5 * Math.max(0, Math.min(1, s));
}

// Per-channel unit scale for accela: rotation channels stay in degrees, the
// three translation channels convert to metres.
const POSE_CH_SCALE = [1, 1, 1, ACCELA_POS_UNIT, ACCELA_POS_UNIT, ACCELA_POS_UNIT];
const WINDOW_CH_SCALE = [ACCELA_POS_UNIT, ACCELA_POS_UNIT, ACCELA_POS_UNIT];

// Ported from cameraunlock-core/cpp/include/cameraunlock/processing/pose_interpolator.h
class PoseInterpolator {
  constructor() { this.reset(); }
  reset() {
    this.lastY = 0; this.lastP = 0; this.lastR = 0;
    this.vY = 0; this.vP = 0; this.vR = 0;
    this.hasV = false;
    this.timeSince = 0;
    this.hasAny = false;
  }
  update(y, p, r, isNew, dt) {
    const MAX_EXT = 0.1, VEL_BLEND = 0.5;
    if (isNew) {
      if (this.hasAny) {
        const sdt = this.timeSince + dt;
        if (sdt > 0) {
          const iy = (y - this.lastY) / sdt;
          const ip = (p - this.lastP) / sdt;
          const ir = (r - this.lastR) / sdt;
          if (this.hasV) {
            this.vY += (iy - this.vY) * VEL_BLEND;
            this.vP += (ip - this.vP) * VEL_BLEND;
            this.vR += (ir - this.vR) * VEL_BLEND;
          } else {
            this.vY = iy; this.vP = ip; this.vR = ir; this.hasV = true;
          }
        }
      }
      this.lastY = y; this.lastP = p; this.lastR = r;
      this.timeSince = 0; this.hasAny = true;
      return [y, p, r];
    }
    this.timeSince += dt;
    if (!this.hasV) return [y, p, r];
    let t = this.timeSince;
    if (t > MAX_EXT) t = MAX_EXT;
    const ratio = t / MAX_EXT;
    const decay = 1 / (1 + ratio * ratio);
    return [
      this.lastY + this.vY * t * decay,
      this.lastP + this.vP * t * decay,
      this.lastR + this.vR * t * decay,
    ];
  }
}
const DEG = Math.PI / 180;
const BASE_EYE = new THREE.Vector3(0, 1.65, -10);

// Shared soft circular sprite texture for smoke / steam / particle clouds.
// PointsMaterial without a map renders as opaque squares — applying this
// gradient texture (white center fading to alpha=0 at the edges) makes the
// sprites read as soft round puffs instead of blocky cubes.
const SOFT_PARTICLE_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.00, 'rgba(255,255,255,1.00)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
})();

// WASD walking — accumulates over time, added on top of BASE_EYE.
// Direction is derived from player 0's current camera quaternion projected
// to the ground plane, so motion follows your gaze.
const WALK_SPEED = 3.2;       // m/s when one direction key is held
const WALK_RUN_MULT = 2.4;    // hold Shift to run
const walkOffset = new THREE.Vector3();
const heldKeys = new Set();
const _walkFwd = new THREE.Vector3();
const _walkRight = new THREE.Vector3();
const _walkUp = new THREE.Vector3(0, 1, 0);
const _walkMove = new THREE.Vector3();

function applyWalking(dt) {
  let fwd = 0, right = 0;
  if (heldKeys.has('KeyW') || heldKeys.has('ArrowUp'))    fwd  -= 1;
  if (heldKeys.has('KeyS') || heldKeys.has('ArrowDown'))  fwd  += 1;
  if (heldKeys.has('KeyA') || heldKeys.has('ArrowLeft'))  right -= 1;
  if (heldKeys.has('KeyD') || heldKeys.has('ArrowRight')) right += 1;
  if (fwd === 0 && right === 0) return;
  // normalize so diagonals aren't faster
  const inv = 1 / Math.hypot(fwd, right);
  fwd *= inv; right *= inv;

  const p0 = players[0];
  if (!p0) return;
  _walkFwd.set(0, 0, -1).applyQuaternion(p0.camera.quaternion);
  _walkFwd.y = 0;
  if (_walkFwd.lengthSq() < 1e-4) return; // looking straight up/down — no ground direction
  _walkFwd.normalize();
  _walkRight.crossVectors(_walkFwd, _walkUp).normalize();

  const speed = WALK_SPEED * ((heldKeys.has('ShiftLeft') || heldKeys.has('ShiftRight')) ? WALK_RUN_MULT : 1);
  _walkMove.set(0, 0, 0);
  _walkMove.addScaledVector(_walkFwd,  -fwd  * speed * dt);
  _walkMove.addScaledVector(_walkRight, right * speed * dt);
  walkOffset.add(_walkMove);
}
// Display only. The server owns the real base port (its UDP_PORT) and reports
// it in every status message; until the first one lands this is the documented
// default so the pane labels aren't blank.
let basePort = 4242;
const MAX_PLAYERS = 4;

const PLAYER_NAMES_KEY = 'htt:playerNames';
const DEFAULT_PLAYER_NAME = (i) => `Player ${i + 1}`;
function loadPlayerNames() {
  try {
    const raw = localStorage.getItem(PLAYER_NAMES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((s) => (typeof s === 'string' ? s : '')) : [];
  } catch { return []; }
}
function savePlayerNames(names) {
  try { localStorage.setItem(PLAYER_NAMES_KEY, JSON.stringify(names)); } catch {}
}
const playerNames = loadPlayerNames();
function getPlayerName(i) {
  const v = playerNames[i];
  return (v && v.trim()) ? v : DEFAULT_PLAYER_NAME(i);
}
function setPlayerName(i, name) {
  const trimmed = (name || '').trim();
  playerNames[i] = trimmed || DEFAULT_PLAYER_NAME(i);
  savePlayerNames(playerNames);
}

// ---- per-pane smoothing overrides ----
// A pane can pin its own filter; touching any global smoothing control clears
// every override so global always wins. Stored per pane as {mode, amount}.
const FILTER_OVERRIDES_KEY = 'htt:filterOverrides';
const FILTER_MODES = ['off', 'classic', 'oneeuro', 'accela'];
function loadFilterOverrides() {
  try {
    const arr = JSON.parse(localStorage.getItem(FILTER_OVERRIDES_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
const playerFilterOverrides = loadFilterOverrides();
function saveFilterOverrides() {
  try { localStorage.setItem(FILTER_OVERRIDES_KEY, JSON.stringify(playerFilterOverrides)); } catch {}
}

// Built to mirror the slice of filterState the pose path reads, so
// `this.filterOverride || filterState` swaps in transparently. Non-derived
// params (deadzone, dCutoff, expo …) are snapshotted from the global state;
// stale snapshots can't linger because global changes drop all overrides.
function buildFilterOverride(mode, amount) {
  return {
    mode,
    amount: { classic: amount, oneeuro: amount, accela: amount },
    classicDeadzone: filterState.classicDeadzone,
    oneeuro: { ...filterState.oneeuro, ...euroParamsFromAmount(amount) },
    accela: { ...filterState.accela, smoothing: accelaSmoothingFromAmount(amount) },
  };
}

const _AX = new THREE.Vector3(1, 0, 0);
const _AY = new THREE.Vector3(0, 1, 0);
const _AZ = new THREE.Vector3(0, 0, 1);

function unwrapDeg(cur, last) {
  if (last === null) return cur;
  let d = cur - last;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return last + d;
}

function classify(v, warn, err) {
  if (v >= err) return 'err';
  if (v >= warn) return 'warn';
  return 'ok';
}
function classifyLow(v, warn, err) {
  if (v <= err) return 'err';
  if (v <= warn) return 'warn';
  return 'ok';
}
function setColor(el, cls) {
  if (!el) return;
  el.classList.remove('ok', 'warn', 'err');
  if (cls) el.classList.add(cls);
}

// =================================================================
// SPARKLINE
// =================================================================
class Sparkline {
  constructor(canvas, { samples = 180, min = null, max = null, color = '#79e08a', warnAt = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.buf = new Float32Array(samples);
    this.cursor = 0; this.filled = 0;
    this.fixedMin = min; this.fixedMax = max;
    this.color = color; this.warnAt = warnAt;
    this._dirty = false;
    this.W = 0; this.H = 0;
    this.resize();
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 120;
    const cssH = this.canvas.clientHeight || 18;
    if (cssW === this.W && cssH === this.H) return;
    this.canvas.width = Math.max(1, Math.floor(cssW * dpr));
    this.canvas.height = Math.max(1, Math.floor(cssH * dpr));
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.W = cssW; this.H = cssH;
    this._dirty = true;
  }
  push(v) {
    if (!Number.isFinite(v)) v = 0;
    this.buf[this.cursor] = v;
    this.cursor = (this.cursor + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
    this._dirty = true;
  }
  draw() {
    if (!this._dirty) return;
    this._dirty = false;
    const { ctx, W, H, buf, filled, cursor, fixedMin, fixedMax } = this;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0e15';
    ctx.fillRect(0, 0, W, H);
    if (filled < 2) return;
    let lo = fixedMin, hi = fixedMax;
    if (lo === null || hi === null) {
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < filled; i++) {
        const v = buf[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (lo === null) lo = Math.min(0, mn);
      if (hi === null) hi = Math.max(mx, lo + 1);
    }
    if (hi - lo < 1e-3) hi = lo + 1;
    if (this.warnAt !== null) {
      const wy = H - ((this.warnAt - lo) / (hi - lo)) * (H - 2) - 1;
      if (wy >= 0 && wy <= H) {
        ctx.strokeStyle = '#e0c879';
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, wy); ctx.lineTo(W, wy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    const step = W / Math.max(1, filled - 1);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < filled; i++) {
      const idx = filled < buf.length ? i : (cursor + i) % buf.length;
      const v = buf[idx];
      const x = i * step;
      const y = H - ((v - lo) / (hi - lo)) * (H - 2) - 1;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// =================================================================
// SCENES
// =================================================================
// Each scene builder returns { scene, update(t) }. Scenes are built once
// on demand and cached; switching just rebinds each Player's RenderPass to
// the new scene, so prior GPU resources stay warm and switching is instant.

function buildPlazaScene() {
  // Moonlit Andalusian courtyard: a mirror-still reflecting pool flanked by
  // horseshoe-arch arcades, lantern-lit walkways, and a domed pavilion at the
  // far end of the axis. Repeated arch bays every 4m give the head-tracking
  // parallax a clean depth ladder.
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0c1e, 0.009);

  const FOG = new THREE.Color(0x0a0c1e);

  const anim = {
    skyUniforms: null,
    floorUniforms: null,
    waterUniforms: null,
    lanternMats: [],
    lanterns: [],
    candles: [],
    petals: null,
    fireflies: [],
    doorLight: null,
  };

  const NOISE_GLSL = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
  `;
  const WORLDPOS_VERT = `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `;

  // ---------- night sky: stars, milky way, moon, clouds, shooting stars ----------
  {
    const skyUniforms = {
      time: { value: 0 },
      moonDir: { value: new THREE.Vector3(-0.10, 0.40, -0.91).normalize() },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(380, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: skyUniforms,
        vertexShader: WORLDPOS_VERT,
        fragmentShader: `
          varying vec3 vWorldPos;
          uniform float time;
          uniform vec3 moonDir;
          ${NOISE_GLSL}
          void main() {
            vec3 dir = normalize(vWorldPos);
            float h = dir.y;
            vec3 col = mix(vec3(0.150, 0.095, 0.190), vec3(0.048, 0.058, 0.135), smoothstep(-0.05, 0.28, h));
            col = mix(col, vec3(0.010, 0.014, 0.042), smoothstep(0.22, 0.85, h));

            float band = exp(-pow(dot(dir, normalize(vec3(0.75, 0.30, -0.45))) * 2.6, 2.0));
            col += vec3(0.045, 0.055, 0.095) * band * (0.5 + 0.8 * fbm(dir.xy * 7.0 + dir.zx * 3.0));

            // warm city glow on the horizon ahead
            col += vec3(0.14, 0.085, 0.05) * exp(-pow(max(h, 0.0) * 9.0, 2.0)) * (0.35 + 0.65 * max(-dir.z, 0.0));

            vec2 suv = vec2(atan(dir.z, dir.x), asin(clamp(h, -1.0, 1.0)));
            for (int L = 0; L < 2; L++) {
              float sc = L == 0 ? 28.0 : 60.0;
              vec2 cell = floor(suv * sc);
              vec2 f = fract(suv * sc);
              float rnd = hash(cell + float(L) * 17.0);
              if (rnd > 0.82) {
                vec2 sp = vec2(hash(cell + 3.1), hash(cell + 5.7));
                float d = length(f - sp);
                float tw = 0.55 + 0.45 * sin(time * (0.8 + rnd * 2.5) + rnd * 40.0);
                col += vec3(0.85, 0.90, 1.0) * exp(-d * d * 220.0) * tw * smoothstep(0.82, 1.0, rnd) * smoothstep(0.0, 0.15, h);
              }
            }

            float md = max(dot(dir, moonDir), 0.0);
            float disc = smoothstep(0.99940, 0.99972, md);
            float limb = fbm(dir.xz * 220.0 + 31.0);
            col += vec3(0.98, 0.93, 0.80) * disc * (2.4 - limb * 0.7);
            col += vec3(0.55, 0.52, 0.46) * pow(md, 900.0) * 0.9;
            col += vec3(0.30, 0.30, 0.34) * pow(md, 50.0) * 0.16;

            if (h > 0.02) {
              vec2 cuv = dir.xz / max(h, 0.06) * 0.40 + vec2(time * 0.0050, time * 0.0023);
              float c = fbm(cuv * vec2(1.6, 0.55));
              float strato = smoothstep(0.52, 0.78, c) * smoothstep(0.02, 0.10, h) * (1.0 - smoothstep(0.30, 0.55, h));
              col = mix(col, vec3(0.085, 0.085, 0.135), strato * 0.65);
              col += vec3(0.55, 0.50, 0.42) * strato * pow(md, 6.0) * 0.35;
            }

            float cyc = floor(time / 9.0);
            float ph = fract(time / 9.0) * 9.0;
            float r1 = hash(vec2(cyc, 3.7));
            float r2 = hash(vec2(cyc, 8.9));
            if (ph < 1.1 && r1 > 0.25) {
              vec2 p0 = vec2((r1 - 0.5) * 4.0, 0.55 + r2 * 0.30);
              vec2 vel = vec2(0.9 + r2 * 0.5, -0.45) * 1.1;
              vec2 head = p0 + vel * ph;
              vec2 ab = suv - head;
              vec2 vn = normalize(vel);
              float along = dot(ab, vn);
              float perp = abs(dot(ab, vec2(-vn.y, vn.x)));
              float trail = (along < 0.0 && along > -0.16) ? exp(along * 18.0) : 0.0;
              float streak = trail * exp(-perp * perp * 9000.0) + exp(-dot(ab, ab) * 6000.0);
              col += vec3(0.85, 0.92, 1.0) * streak * (1.0 - ph / 1.1) * 2.2;
            }

            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    scene.add(sky);
    anim.skyUniforms = skyUniforms;
  }

  // ---------- stone court: marble tiles, zellige pool border, entry medallion ----------
  {
    const floorUniforms = {
      time: { value: 0 },
      fogColor: { value: FOG },
    };
    const floorMat = new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: WORLDPOS_VERT,
      fragmentShader: `
        varying vec3 vWorldPos;
        uniform float time;
        uniform vec3 fogColor;
        ${NOISE_GLSL}
        void main() {
          vec2 p = vWorldPos.xz;

          vec2 tid = floor(p / 1.15);
          vec2 tuv = fract(p / 1.15);
          float tr = hash(tid);
          vec2 gd = min(tuv, 1.0 - tuv);
          float grout = smoothstep(0.008, 0.035, min(gd.x, gd.y));
          float vein = fbm(p * 0.85 + tr * 9.0);
          vec3 col = vec3(0.078, 0.088, 0.118) * (0.82 + tr * 0.36);
          col += vec3(0.045, 0.050, 0.062) * smoothstep(0.52, 0.86, vein);
          col *= mix(0.45, 1.0, grout);
          col *= 0.80 + 0.30 * (1.0 - smoothstep(0.0, 70.0, abs(p.y + 28.0)));

          // dark gardens beyond the arcades and behind the pavilion
          vec3 soil = vec3(0.022, 0.030, 0.024) * (0.7 + 0.6 * fbm(p * 0.5));
          soil += vec3(0.012, 0.016, 0.020) * smoothstep(0.55, 0.9, fbm(p * 0.8 + 3.0));
          float court = (1.0 - smoothstep(5.3, 6.4, abs(p.x))) * smoothstep(-57.0, -53.0, p.y);
          col = mix(soil, col, court);

          vec2 prel = abs(p - vec2(0.0, -26.0)) - vec2(2.2, 12.0);
          float dpool = max(prel.x, prel.y);
          float bandM = smoothstep(0.18, 0.30, dpool) * (1.0 - smoothstep(1.05, 1.20, dpool));
          vec2 q = p * 2.1;
          vec2 q2 = mat2(0.70710678, -0.70710678, 0.70710678, 0.70710678) * q;
          float c1 = max(abs(fract(q.x) - 0.5), abs(fract(q.y) - 0.5));
          float c2 = max(abs(fract(q2.x) - 0.5), abs(fract(q2.y) - 0.5));
          float star = smoothstep(0.30, 0.36, min(c1, c2));
          float mortar = smoothstep(0.40, 0.47, max(c1, c2));
          vec3 mosaic = mix(vec3(0.018, 0.155, 0.150), vec3(0.235, 0.150, 0.045), star) * (1.0 - mortar * 0.55);
          col = mix(col, mosaic, bandM);

          float mr = length(p - vec2(0.0, -11.7));
          if (mr < 2.4) {
            float ring = exp(-pow((mr - 2.00) * 11.0, 2.0)) + exp(-pow((mr - 1.15) * 13.0, 2.0)) * 0.7;
            float ang = atan(p.x, p.y + 11.7);
            float petal = exp(-pow((mr - 1.55) * 8.0, 2.0)) * pow(abs(sin(ang * 4.0 + time * 0.15)), 6.0);
            float heart = exp(-mr * mr * 2.4) * (0.55 + 0.20 * sin(time * 1.1));
            col += vec3(0.10, 0.62, 0.55) * (ring * 0.30 + heart * 0.35);
            col += vec3(0.95, 0.62, 0.22) * petal * 0.22;
          }

          float k = clamp(floor((-15.0 - p.y) / 4.0 + 0.5), 0.0, 8.0);
          float zk = -15.0 - 4.0 * k;
          float every = mod(k, 2.0);
          float dz = p.y - zk;
          float dl = (p.x + 4.6) * (p.x + 4.6) + dz * dz;
          float dr = (p.x - 4.6) * (p.x - 4.6) + dz * dz;
          float fl = 0.88 + 0.12 * sin(time * 2.1 + k * 1.9);
          float fr = 0.88 + 0.12 * sin(time * 2.4 + k * 1.3 + 2.0);
          col += vec3(1.0, 0.60, 0.26) * (exp(-dl * 0.55) * fl + exp(-dr * 0.55) * fr) * 0.34 * (1.0 - every);

          float poolGlow = exp(-max(dpool, 0.0) * max(dpool, 0.0) * 1.4);
          col += vec3(0.05, 0.30, 0.28) * poolGlow * (0.5 + 0.10 * sin(time * 0.9)) * 0.5;

          col = mix(vec3(0.004, 0.010, 0.014), col, smoothstep(-0.05, 0.05, dpool));

          float dist = length(p - vec2(0.0, -10.0));
          col = mix(col, fogColor, smoothstep(45.0, 150.0, dist));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    anim.floorUniforms = floorUniforms;
  }

  // ---------- reflecting pool ----------
  {
    const waterUniforms = {
      time: { value: 0 },
      fogColor: { value: FOG },
    };
    const waterMat = new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      vertexShader: WORLDPOS_VERT,
      fragmentShader: `
        varying vec3 vWorldPos;
        uniform float time;
        uniform vec3 fogColor;
        ${NOISE_GLSL}
        void main() {
          vec2 p = vWorldPos.xz;
          float rip = fbm(p * 1.7 + vec2(time * 0.07, time * 0.05))
                    + fbm(p * 2.6 - vec2(time * 0.06, time * 0.09)) - 1.0;

          float far = 1.0 - smoothstep(-38.0, -14.0, p.y);
          vec3 col = mix(vec3(0.014, 0.022, 0.052), vec3(0.075, 0.060, 0.125), far * 0.9);
          col += rip * vec3(0.035, 0.050, 0.080);

          float lane = exp(-pow((p.x - (p.y + 10.0) * 0.065 - rip * 0.9) * 1.6, 2.0));
          float spark = pow(noise(vec2(p.x * 7.0 + rip * 3.0, p.y * 2.4 - time * 1.3)), 5.0);
          col += vec3(0.95, 0.88, 0.68) * lane * spark * (1.1 + 0.5 * far);

          float w = 1.0 - smoothstep(-38.0, -24.0, p.y);
          float streak = exp(-pow((p.x + rip * 0.55) * 1.05, 2.0)) * w;
          col += vec3(1.0, 0.55, 0.24) * streak * (0.58 + 0.10 * sin(time * 1.8 + p.y * 1.5));

          float edge = exp(-pow((2.2 - abs(p.x)) * 2.0, 2.0));
          col += vec3(0.06, 0.42, 0.38) * edge * (0.40 + 0.08 * sin(time * 0.8 + p.y * 0.6));

          float sr = hash(floor(p * vec2(3.0, 1.5)));
          float tw = step(0.93, sr) * (0.5 + 0.5 * sin(time * 2.2 + sr * 50.0));
          col += vec3(0.40, 0.48, 0.62) * tw * 0.10 * (1.0 - lane) * (1.0 - streak);

          col = mix(col, fogColor, smoothstep(25.0, 70.0, length(p - vec2(0.0, -10.0))));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const water = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 24), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 0.07, -26);
    scene.add(water);
    anim.waterUniforms = waterUniforms;

    const curbMat = new THREE.MeshStandardMaterial({ color: 0x2a3148, roughness: 0.55, metalness: 0.1 });
    const mkCurb = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), curbMat);
      m.position.set(x, 0.11, z);
      scene.add(m);
    };
    mkCurb(0.4, 24.8, -2.4, -26);
    mkCurb(0.4, 24.8, 2.4, -26);
    mkCurb(5.2, 0.4, 0, -13.8);
    mkCurb(5.2, 0.4, 0, -38.2);

    const postMat = new THREE.MeshStandardMaterial({ color: 0x1c2336, roughness: 0.4, metalness: 0.6 });
    const orbMat = new THREE.MeshStandardMaterial({ color: 0xeafffb, emissive: 0x2fd4c4, emissiveIntensity: 2.2 });
    for (const [x, z] of [[-2.4, -13.8], [2.4, -13.8], [-2.4, -38.2], [2.4, -38.2]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.10, 0.85, 10), postMat);
      post.position.set(x, 0.42, z);
      scene.add(post);
      const orb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), orbMat);
      orb.position.set(x, 0.95, z);
      scene.add(orb);
    }

    const poolLightA = new THREE.PointLight(0x2fd4c4, 2.2, 9, 1.8);
    poolLightA.position.set(0, 0.8, -18);
    scene.add(poolLightA);
    const poolLightB = new THREE.PointLight(0x2fd4c4, 2.2, 9, 1.8);
    poolLightB.position.set(0, 0.8, -33);
    scene.add(poolLightB);
  }

  // ---------- shared materials ----------
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x252c42, roughness: 0.85, metalness: 0.05 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0x6b4a1e, roughness: 0.35, metalness: 0.9 });
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0x3a4a6a, roughness: 0.3, metalness: 0.85, emissive: 0x1c2c50, emissiveIntensity: 0.9,
  });

  // ---------- horseshoe-arch arcades ----------
  {
    const panel = new THREE.Shape();
    panel.moveTo(0, 0);
    panel.lineTo(36, 0);
    panel.lineTo(36, 4.6);
    panel.lineTo(0, 4.6);
    panel.closePath();
    const R = 1.45, HALF = 1.30, CY = 2.45;
    const a0 = Math.acos(HALF / R);
    const y0 = CY - R * Math.sin(a0);
    for (let k = 0; k < 9; k++) {
      const cx = 2 + 4 * k;
      const hole = new THREE.Path();
      hole.moveTo(cx - HALF, 0);
      hole.lineTo(cx - HALF, y0);
      hole.absarc(cx, CY, R, Math.PI + a0, -a0, true);
      hole.lineTo(cx + HALF, 0);
      hole.closePath();
      panel.holes.push(hole);
    }
    const arcadeGeo = new THREE.ExtrudeGeometry(panel, { depth: 0.42, bevelEnabled: false });
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(arcadeGeo, stoneMat);
      m.rotation.y = Math.PI / 2;
      // sunk below grade: the extruded arch holes have a bottom lip at local
      // y=0 that z-fights with the floor plane if left coplanar
      m.position.set(side * 5.05 - 0.21, -0.04, -13);
      scene.add(m);
    }

    const colGeo = new THREE.CylinderGeometry(0.11, 0.13, 2.30, 12);
    const colMat = new THREE.MeshStandardMaterial({ color: 0x3a4260, roughness: 0.6, metalness: 0.15 });
    const capGeo = new THREE.BoxGeometry(0.34, 0.16, 0.34);
    const colInst = new THREE.InstancedMesh(colGeo, colMat, 16);
    const capInst = new THREE.InstancedMesh(capGeo, colMat, 16);
    const m4 = new THREE.Matrix4();
    let ci = 0;
    for (const side of [-1, 1]) {
      for (let j = 1; j <= 8; j++) {
        const z = -13 - 4 * j, x = side * 4.72;
        m4.makeTranslation(x, 1.15, z);
        colInst.setMatrixAt(ci, m4);
        m4.makeTranslation(x, 2.38, z);
        capInst.setMatrixAt(ci, m4);
        ci++;
      }
    }
    scene.add(colInst);
    scene.add(capInst);
  }

  // ---------- brass lanterns swaying in the arch openings ----------
  {
    const chainMat = new THREE.MeshStandardMaterial({ color: 0x4a3a20, roughness: 0.5, metalness: 0.8 });
    for (let g = 0; g < 3; g++) {
      anim.lanternMats.push(new THREE.MeshStandardMaterial({
        color: 0xffe6b8, emissive: 0xffa540, emissiveIntensity: 2.6,
      }));
    }
    const bodyGeo = new THREE.OctahedronGeometry(0.20, 0);
    const capGeo = new THREE.ConeGeometry(0.13, 0.14, 8);
    const chainGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.75, 6);
    let li = 0;
    for (const side of [-1, 1]) {
      for (let k = 0; k < 9; k += 2) {
        const grp = new THREE.Group();
        grp.position.set(side * 5.05, 3.86, -15 - 4 * k);
        const chain = new THREE.Mesh(chainGeo, chainMat);
        chain.position.y = -0.375;
        grp.add(chain);
        const body = new THREE.Mesh(bodyGeo, anim.lanternMats[li % 3]);
        body.scale.set(0.8, 1.45, 0.8);
        body.position.y = -0.98;
        grp.add(body);
        const cap = new THREE.Mesh(capGeo, brassMat);
        cap.position.y = -0.62;
        grp.add(cap);
        grp.userData.phase = li * 1.31;
        scene.add(grp);
        anim.lanterns.push(grp);
        li++;
      }
    }
    for (const [x, z] of [[-4.6, -15], [4.6, -15], [-4.6, -23], [4.6, -23]]) {
      const l = new THREE.PointLight(0xffb35c, 2.6, 8, 1.9);
      l.position.set(x, 2.9, z);
      scene.add(l);
    }
  }

  // ---------- domed pavilion ----------
  {
    const plat = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 7), stoneMat);
    plat.position.set(0, 0.25, -50.5);
    scene.add(plat);
    const stepA = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.34, 0.9), stoneMat);
    stepA.position.set(0, 0.17, -46.85);
    scene.add(stepA);
    const stepB = new THREE.Mesh(new THREE.BoxGeometry(10.5, 0.17, 0.9), stoneMat);
    stepB.position.set(0, 0.085, -46.25);
    scene.add(stepB);

    const wallShape = new THREE.Shape();
    wallShape.moveTo(-4, 0);
    wallShape.lineTo(4, 0);
    wallShape.lineTo(4, 5.2);
    wallShape.lineTo(-4, 5.2);
    wallShape.closePath();
    const R2 = 1.75, HALF2 = 1.55, CY2 = 2.7;
    const b0 = Math.acos(HALF2 / R2);
    const yy0 = CY2 - R2 * Math.sin(b0);
    const door = new THREE.Path();
    door.moveTo(-HALF2, 0);
    door.lineTo(-HALF2, yy0);
    door.absarc(0, CY2, R2, Math.PI + b0, -b0, true);
    door.lineTo(HALF2, 0);
    door.closePath();
    wallShape.holes.push(door);
    const wall = new THREE.Mesh(
      new THREE.ExtrudeGeometry(wallShape, { depth: 0.45, bevelEnabled: false }),
      stoneMat
    );
    // sunk into the platform so the doorway's bottom lip doesn't z-fight its top face
    wall.position.set(0, 0.46, -48.4);
    scene.add(wall);

    const doorGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 4.6),
      new THREE.MeshBasicMaterial({ color: 0xffc080 })
    );
    doorGlow.position.set(0, 2.8, -49.2);
    scene.add(doorGlow);

    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(1.82, 0.05, 8, 48, Math.PI + 2 * b0),
      new THREE.MeshStandardMaterial({ color: 0xffe0a8, emissive: 0xff9a3c, emissiveIntensity: 1.8 })
    );
    trim.position.set(0, 3.2, -47.92);
    trim.rotation.z = -b0;
    scene.add(trim);

    for (const s of [-1, 1]) {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(0.45, 5.2, 5.4), stoneMat);
      sw.position.set(s * 3.78, 3.1, -50.9);
      scene.add(sw);
      const win = new THREE.Mesh(
        new THREE.PlaneGeometry(0.6, 1.1),
        new THREE.MeshBasicMaterial({ color: 0x2f9c8e })
      );
      win.position.set(s * 2.7, 3.0, -47.93);
      scene.add(win);
    }
    const rear = new THREE.Mesh(new THREE.BoxGeometry(8, 5.2, 0.45), stoneMat);
    rear.position.set(0, 3.1, -53.4);
    scene.add(rear);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.4, 6.2), stoneMat);
    roof.position.set(0, 5.9, -50.7);
    scene.add(roof);

    const drum = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.35, 1.1, 24), stoneMat);
    drum.position.set(0, 6.55, -50.7);
    scene.add(drum);
    const drumRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.42, 0.05, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0xffe0a8, emissive: 0xff9a3c, emissiveIntensity: 1.2 })
    );
    drumRing.rotation.x = Math.PI / 2;
    drumRing.position.set(0, 7.05, -50.7);
    scene.add(drumRing);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(2.5, 32, 18, 0, Math.PI * 2, 0, Math.PI / 2),
      domeMat
    );
    dome.scale.y = 1.3;
    dome.position.set(0, 7.1, -50.7);
    scene.add(dome);
    const finial = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.2, 8), brassMat);
    finial.position.set(0, 10.9, -50.7);
    scene.add(finial);
    const finOrb = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xfff2cf, emissive: 0xffc860, emissiveIntensity: 2.5 })
    );
    finOrb.position.set(0, 11.55, -50.7);
    scene.add(finOrb);

    const doorLight = new THREE.PointLight(0xffa050, 9, 30, 1.6);
    doorLight.position.set(0, 2.6, -49.3);
    scene.add(doorLight);
    anim.doorLight = doorLight;
  }

  // ---------- minaret towers ----------
  {
    const towerGeo = new THREE.CylinderGeometry(0.55, 0.70, 10, 14);
    const tDomeGeo = new THREE.SphereGeometry(0.72, 16, 12);
    const ringGeo = new THREE.TorusGeometry(0.78, 0.055, 8, 24);
    const winGeo = new THREE.PlaneGeometry(0.16, 0.34);
    const winMat = new THREE.MeshBasicMaterial({ color: 0xffc984 });
    const ringMat = new THREE.MeshStandardMaterial({ color: 0xffe0a8, emissive: 0xff9a3c, emissiveIntensity: 1.4 });
    for (const s of [-1, 1]) {
      const x = s * 7.6, z = -53.5;
      const t = new THREE.Mesh(towerGeo, stoneMat);
      t.position.set(x, 5, z);
      scene.add(t);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(x, 8.6, z);
      scene.add(ring);
      const d = new THREE.Mesh(tDomeGeo, domeMat);
      d.scale.y = 1.25;
      d.position.set(x, 10.4, z);
      scene.add(d);
      for (let i = 0; i < 3; i++) {
        const w = new THREE.Mesh(winGeo, winMat);
        w.position.set(x, 3.2 + i * 2.0, z + 0.72);
        scene.add(w);
      }
    }
  }

  // ---------- distant city silhouette ----------
  {
    const silMat = new THREE.MeshBasicMaterial({ color: 0x131726 });
    const silDome = new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    const silTower = new THREE.CylinderGeometry(0.8, 1.1, 1, 8);
    const skyline = [
      [-58, -118, 9, 'd'], [-34, -108, 6, 'd'], [-16, -122, 11, 'd'], [14, -112, 7, 'd'],
      [38, -118, 10, 'd'], [60, -106, 5, 'd'],
      [-46, -112, 16, 't'], [-24, -116, 13, 't'], [4, -106, 14, 't'], [26, -120, 18, 't'], [50, -112, 12, 't'],
    ];
    for (const [x, z, s, kind] of skyline) {
      if (kind === 'd') {
        const base = new THREE.Mesh(silTower, silMat);
        base.scale.set(s * 1.1, s * 0.9, s * 1.1);
        base.position.set(x, s * 0.45, z);
        scene.add(base);
        const d = new THREE.Mesh(silDome, silMat);
        d.scale.setScalar(s);
        d.position.set(x, s * 0.9, z);
        scene.add(d);
      } else {
        const t = new THREE.Mesh(silTower, silMat);
        t.scale.set(2.6, s, 2.6);
        t.position.set(x, s / 2, z);
        scene.add(t);
        const tip = new THREE.Mesh(silDome, silMat);
        tip.scale.setScalar(2.8);
        tip.position.set(x, s, z);
        scene.add(tip);
      }
    }
  }

  // ---------- cypress garden silhouettes ----------
  {
    const cypMat = new THREE.MeshStandardMaterial({ color: 0x10281c, roughness: 1 });
    const cypGeo = new THREE.ConeGeometry(0.65, 6, 10);
    const spots = [
      [-7.2, -15.5], [7.4, -16.5], [-8.5, -17], [8.0, -20], [-9.5, -26],
      [9.5, -29], [-8.0, -35], [8.8, -39], [-10.5, -44], [10.0, -46],
      [-5.6, -56.5], [5.6, -56.5], [-11.5, -52], [11.8, -50],
      [-13.0, -21], [13.5, -33],
    ];
    let i = 0;
    for (const [x, z] of spots) {
      const c = new THREE.Mesh(cypGeo, cypMat);
      const s = 1.0 + ((i * 37) % 10) / 16;
      c.scale.set(s, s * (1 + ((i * 53) % 7) / 10), s);
      c.position.set(x, 3 * c.scale.y, z);
      scene.add(c);
      i++;
    }
  }

  // ---------- potted orange trees by the entrance ----------
  {
    const potMat = new THREE.MeshStandardMaterial({ color: 0x274a52, roughness: 0.35, metalness: 0.2 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x241a10, roughness: 0.95 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x12301c, roughness: 0.9 });
    const fruitMat = new THREE.MeshStandardMaterial({
      color: 0xff8c1f, emissive: 0xc25a00, emissiveIntensity: 0.55, roughness: 0.5,
    });
    for (const s of [-1, 1]) {
      const x = s * 4.0, z = -13.2;
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.30, 0.55, 8), potMat);
      pot.position.set(x, 0.275, z);
      scene.add(pot);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.9, 8), trunkMat);
      trunk.position.set(x, 0.95, z);
      scene.add(trunk);
      for (const [ox, oy, oz, r] of [[0, 1.75, 0, 0.62], [-0.38, 1.5, 0.15, 0.40], [0.36, 1.55, -0.12, 0.42]]) {
        const blob = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), leafMat);
        blob.position.set(x + ox, oy, z + oz);
        scene.add(blob);
      }
      for (let i = 0; i < 7; i++) {
        const a = i * 0.9 + s;
        const fr = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), fruitMat);
        fr.position.set(x + Math.cos(a) * 0.55, 1.45 + Math.sin(i * 2.1) * 0.35, z + Math.sin(a) * 0.45);
        scene.add(fr);
      }
    }
  }

  // ---------- floating candle rafts ----------
  {
    const raftMat = new THREE.MeshStandardMaterial({ color: 0x1b1208, roughness: 0.9 });
    const waxMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.8 });
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff9c40, transparent: true, opacity: 0.30,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < 6; i++) {
      const grp = new THREE.Group();
      const raft = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.045, 10), raftMat);
      grp.add(raft);
      const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 8), waxMat);
      candle.position.y = 0.06;
      grp.add(candle);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.10, 7), flameMat);
      flame.position.y = 0.16;
      grp.add(flame);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), glowMat);
      glow.position.y = 0.14;
      grp.add(glow);
      grp.userData = {
        cx: (i % 2 ? 1 : -1) * (0.3 + (i * 0.23) % 0.7),
        cz: -16.5 - i * 3.6,
        rad: 0.4 + (i * 0.37) % 0.6,
        speed: 0.10 + (i * 0.13) % 0.12,
        phase: i * 1.7,
        flame,
      };
      scene.add(grp);
      anim.candles.push(grp);
    }
  }

  // ---------- drifting petals ----------
  {
    const N = 130;
    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 0] = (Math.random() - 0.5) * 13;
      pos[i * 3 + 1] = 0.3 + Math.random() * 7;
      pos[i * 3 + 2] = -8 - Math.random() * 42;
      vel[i * 2 + 0] = 0.10 + Math.random() * 0.16;
      vel[i * 2 + 1] = Math.random() * Math.PI * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const petals = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xf6ecf2, size: 0.055, sizeAttenuation: true,
      transparent: true, opacity: 0.85, depthWrite: false,
    }));
    petals.userData.vel = vel;
    scene.add(petals);
    anim.petals = petals;
  }

  // ---------- fireflies in the gardens beyond the arcades ----------
  for (const s of [-1, 1]) {
    const N = 40;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 0] = s * (7 + Math.random() * 7);
      pos[i * 3 + 1] = 0.4 + Math.random() * 3.2;
      pos[i * 3 + 2] = -14 - Math.random() * 40;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xffd27a, size: 0.075, sizeAttenuation: true,
      transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    pts.userData.basePos = pos.slice();
    pts.userData.phase = s * 1.3;
    scene.add(pts);
    anim.fireflies.push(pts);
  }

  // ---------- lighting ----------
  scene.add(new THREE.HemisphereLight(0x33406b, 0x0b0a16, 0.55));
  const moonLight = new THREE.DirectionalLight(0xa8c0e8, 0.9);
  moonLight.position.set(-12, 26, -52);
  scene.add(moonLight);

  function update(t) {
    anim.skyUniforms.time.value = t;
    anim.floorUniforms.time.value = t;
    anim.waterUniforms.time.value = t;

    for (let i = 0; i < anim.lanternMats.length; i++) {
      anim.lanternMats[i].emissiveIntensity =
        2.5 + Math.sin(t * 5.1 + i * 2.7) * 0.18 + Math.sin(t * 13.7 + i * 5.1) * 0.10;
    }
    for (const grp of anim.lanterns) {
      const ph = grp.userData.phase;
      grp.rotation.z = Math.sin(t * 0.62 + ph) * 0.055;
      grp.rotation.x = Math.sin(t * 0.47 + ph * 1.4) * 0.045;
    }

    anim.doorLight.intensity = 8.4 + Math.sin(t * 6.3) * 0.5 + Math.sin(t * 17.1) * 0.3;

    for (const c of anim.candles) {
      const u = c.userData;
      const a = t * u.speed + u.phase;
      c.position.set(
        u.cx + Math.cos(a) * u.rad,
        0.085 + Math.sin(t * 1.1 + u.phase) * 0.012,
        u.cz + Math.sin(a * 0.8) * u.rad * 0.8
      );
      const f = 1.0 + Math.sin(t * 11 + u.phase * 3.0) * 0.22 + Math.sin(t * 23 + u.phase) * 0.12;
      u.flame.scale.set(f, 0.8 + f * 0.4, f);
    }

    {
      const arr = anim.petals.geometry.attributes.position.array;
      const vel = anim.petals.userData.vel;
      for (let i = 0; i < arr.length / 3; i++) {
        arr[i * 3 + 1] -= vel[i * 2] * 0.016;
        arr[i * 3 + 0] += Math.sin(t * 0.8 + vel[i * 2 + 1]) * 0.004;
        arr[i * 3 + 2] += Math.cos(t * 0.6 + vel[i * 2 + 1] * 1.7) * 0.003;
        if (arr[i * 3 + 1] < 0.12) {
          arr[i * 3 + 0] = (Math.random() - 0.5) * 13;
          arr[i * 3 + 1] = 6 + Math.random() * 3;
          arr[i * 3 + 2] = -8 - Math.random() * 42;
        }
      }
      anim.petals.geometry.attributes.position.needsUpdate = true;
    }

    for (const pts of anim.fireflies) {
      const base = pts.userData.basePos;
      const arr = pts.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 0] = base[i + 0] + Math.sin(t * 0.5 + i * 0.9) * 0.5;
        arr[i + 1] = base[i + 1] + Math.sin(t * 0.7 + i * 1.7) * 0.35;
        arr[i + 2] = base[i + 2] + Math.cos(t * 0.4 + i * 1.3) * 0.5;
      }
      pts.geometry.attributes.position.needsUpdate = true;
      pts.material.opacity = 0.55 + 0.40 * Math.sin(t * 1.6 + pts.userData.phase);
    }
  }

  return { scene, update };
}

function buildForestScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9ab0bc, 0.016);

  // Shrine + pond live deeper in the clearing so the player walks toward them.
  // Trees, bushes, and flowers all carve out the pond disc.
  const POND_X = 0, POND_Z = -16, POND_R = 4.2;
  const SHRINE_RING_R = 2.4;
  const CLEARING_X = 0, CLEARING_Z = -10, CLEARING_R = 12.5;

  const anim = {
    skyUniforms: null,
    beams: [],
    butterflies: [],
    pollen: null,
    fireflyMat: null,
    foliage: [],          // { mesh, bx, by, bz, swayAmp, swayPhase }
    shrineCrystal: null,
    shrineCrystalY: 0,
    shrineRing: null,
    shrineLight: null,
    shrineHalo: null,
    waterMat: null,
    glowCaps: [],         // { mat, base, amp, phase }
    birds: [],            // { group, rWing, lWing, cx, cz, cy, radius, speed, phase, flapSpeed }
  };

  // ---------- sky (gradient + clouds + sun disc) ----------
  {
    const skyUniforms = {
      time: { value: 0 },
      sunDir: { value: new THREE.Vector3(0.45, 0.65, 0.60).normalize() },
      topColor: { value: new THREE.Color(0x3a7ed0) },
      horizonColor: { value: new THREE.Color(0xdde9f2) },
      sunColor: { value: new THREE.Color(0xfff0c8) },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(380, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: skyUniforms,
        vertexShader: `
          varying vec3 vWorldPos;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          varying vec3 vWorldPos;
          uniform float time;
          uniform vec3 sunDir;
          uniform vec3 topColor;
          uniform vec3 horizonColor;
          uniform vec3 sunColor;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
          }
          float fbm(vec2 p) {
            float v = 0.0, a = 0.5;
            for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
            return v;
          }
          void main() {
            vec3 dir = normalize(vWorldPos);
            float h = clamp(dir.y, 0.0, 1.0);
            vec3 col = mix(horizonColor, topColor, smoothstep(0.0, 0.65, h));
            // soft drifting clouds
            if (dir.y > 0.02) {
              vec2 cuv = dir.xz / max(dir.y, 0.08) * 0.45 + vec2(time * 0.006, time * 0.003);
              float c = fbm(cuv);
              c = smoothstep(0.45, 0.78, c) * smoothstep(0.0, 0.20, h);
              col = mix(col, vec3(1.0, 0.98, 0.94), c * 0.55);
            }
            // sun disc + halo
            float sd = max(0.0, dot(dir, sunDir));
            float sun  = smoothstep(0.9988, 0.9999, sd);
            float halo = pow(sd, 90.0) * 0.55 + pow(sd, 14.0) * 0.10;
            col += sunColor * (sun * 2.4 + halo);
            // warm wash near the sun's azimuth at the horizon
            vec3 sunHorizDir = normalize(vec3(sunDir.x, 0.0, sunDir.z));
            vec3 dirHoriz = normalize(vec3(dir.x, 0.0, dir.z));
            col += sunColor * pow(max(0.0, dot(dirHoriz, sunHorizDir)), 8.0) * 0.05 * (1.0 - h);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    scene.add(sky);
    anim.skyUniforms = skyUniforms;
  }

  // ---------- ground (gently undulating grass with color variance) ----------
  {
    const groundGeo = new THREE.PlaneGeometry(400, 400, 80, 80);
    const gpos = groundGeo.attributes.position;
    const gcols = new Float32Array(gpos.count * 3);
    let s = 23;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    for (let i = 0; i < gpos.count; i++) {
      const x = gpos.getX(i), y = gpos.getY(i);
      gpos.setZ(i, Math.sin(x * 0.1) * 0.07 + Math.cos(y * 0.13) * 0.06);
      const variance = r();
      gcols[i * 3 + 0] = 0.18 + variance * 0.10;
      gcols[i * 3 + 1] = 0.42 + variance * 0.20;
      gcols[i * 3 + 2] = 0.16 + variance * 0.08;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(gcols, 3));
    groundGeo.computeVertexNormals();
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0.0,
    }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
  }

  // ---------- trees ----------
  {
    let s = 11;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3527, roughness: 0.95 });
    const foliageMats = [
      new THREE.MeshStandardMaterial({ color: 0x3f9046, roughness: 0.85, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x4faa55, roughness: 0.85, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x68b56e, roughness: 0.85, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x2e7a38, roughness: 0.85, flatShading: true }),
    ];

    function placeTree(x, z, scale = 1) {
      const trunkH = (3.6 + r() * 2.6) * scale;
      const trunkR = (0.18 + r() * 0.14) * scale;
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(trunkR * 0.65, trunkR, trunkH, 8),
        trunkMat
      );
      trunk.position.set(x, trunkH / 2, z);
      scene.add(trunk);

      const fmat = foliageMats[Math.floor(r() * foliageMats.length)];
      const cy = trunkH + 0.4;
      const fr = (1.2 + r() * 1.0) * scale;
      const treePhase = r() * Math.PI * 2;
      const treeSway = (0.05 + r() * 0.05) * scale;
      const mk = (size, dx, dy, dz) => {
        const bx = x + dx, by = cy + dy, bz = z + dz;
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 1), fmat);
        m.position.set(bx, by, bz);
        scene.add(m);
        anim.foliage.push({ mesh: m, bx, by, bz, swayAmp: treeSway, swayPhase: treePhase + r() * 0.6 });
      };
      mk(fr, 0, 0, 0);
      mk(fr * 0.72, (r() - 0.5) * 1.5, 0.5 + r() * 0.6, (r() - 0.5) * 1.5);
      mk(fr * 0.6,  (r() - 0.5) * 1.4, -0.15, (r() - 0.5) * 1.4);
    }

    function treeBlocked(x, z) {
      const dcx = x - CLEARING_X, dcz = z - CLEARING_Z;
      if (Math.sqrt(dcx * dcx + dcz * dcz) < CLEARING_R) return true;
      const dpx = x - POND_X, dpz = z - POND_Z;
      if (Math.sqrt(dpx * dpx + dpz * dpz) < POND_R + 1.5) return true;
      return false;
    }

    // ring of trees around the clearing (pond carve-out via treeBlocked)
    for (let i = 0; i < 110; i++) {
      const x = (r() - 0.5) * 80;
      const z = -10 + (r() - 0.5) * 70;
      if (treeBlocked(x, z)) continue;
      placeTree(x, z);
    }
    // taller back-wall of trees in the distance
    for (let i = 0; i < 32; i++) {
      const x = (r() - 0.5) * 140;
      const z = -55 - r() * 30;
      placeTree(x, z, 1.0 + r() * 0.7);
    }
  }

  // ---------- bushes and flowers around the clearing ----------
  {
    let s = 71;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);

    function inPond(x, z, pad) {
      const dx = x - POND_X, dz = z - POND_Z;
      return Math.sqrt(dx * dx + dz * dz) < POND_R + pad;
    }

    // bushes ringing the clearing — skip the pond and the immediate camera disc
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x3a8c43, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 36; i++) {
      const a = r() * Math.PI * 2;
      const rad = 7 + r() * 14;
      const x = Math.cos(a) * rad;
      const z = -10 + Math.sin(a) * rad;
      if (inPond(x, z, 0.6)) continue;
      const sc = 0.55 + r() * 0.75;
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6 * sc, 1), bushMat);
      b.position.set(x, 0.32 * sc, z);
      scene.add(b);
    }

    // flowers scattered through the clearing and beyond (skip right under the camera + pond)
    const flowerColors = [0xffffff, 0xffd0c0, 0xffe5a0, 0xffb8d8, 0xc8b8ff, 0xfff5e0];
    for (let i = 0; i < 180; i++) {
      const x = (r() - 0.5) * 60;
      const z = -10 + (r() - 0.5) * 60;
      const dx = x, dz = z + 10;
      if (Math.sqrt(dx * dx + dz * dz) < 1.8) continue;
      if (inPond(x, z, 0.2)) continue;
      const c = flowerColors[Math.floor(r() * flowerColors.length)];
      const fl = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.22),
        new THREE.MeshBasicMaterial({ color: c })
      );
      fl.rotation.x = -Math.PI / 2;
      fl.position.set(x, 0.04, z);
      scene.add(fl);
    }
  }

  // ---------- shimmering pond (deep at center, sparkle highlights, soft rim) ----------
  {
    const waterMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        time: { value: 0 },
        deepColor: { value: new THREE.Color(0x081a20) },
        shallowColor: { value: new THREE.Color(0x356a64) },
        skyTint: { value: new THREE.Color(0x9bc0e8) },
        sparkColor: { value: new THREE.Color(0xfff5c8) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float time;
        uniform vec3 deepColor;
        uniform vec3 shallowColor;
        uniform vec3 skyTint;
        uniform vec3 sparkColor;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        void main() {
          vec2 cp = vUv - 0.5;
          float r = length(cp) * 2.0;
          if (r > 1.0) discard;
          vec2 p = vUv * 6.0;
          float n  = noise(p + vec2(time * 0.18, 0.0));
          float n2 = noise(p * 1.7 + vec2(0.0, time * -0.13));
          float ripple = (n + n2) * 0.5;
          vec3 col = mix(deepColor, shallowColor, smoothstep(0.30, 0.85, ripple));
          col = mix(col, skyTint, 0.22);
          float spark = smoothstep(0.82, 0.97, ripple);
          col += sparkColor * spark * 0.70;
          float edge = 1.0 - smoothstep(0.86, 1.00, r);
          gl_FragColor = vec4(col, edge * 0.92);
        }
      `,
    });
    const water = new THREE.Mesh(new THREE.CircleGeometry(POND_R, 64), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(POND_X, 0.018, POND_Z);
    scene.add(water);

    // pebbled stone border so the edge doesn't look glued to the grass
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x444a40, roughness: 0.92, flatShading: true });
    let bs = 311;
    const br = () => ((bs = (bs * 9301 + 49297) % 233280), bs / 233280);
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2 + br() * 0.16;
      const rad = POND_R + 0.08 + br() * 0.30;
      const x = POND_X + Math.cos(a) * rad;
      const z = POND_Z + Math.sin(a) * rad;
      const sc = 0.16 + br() * 0.22;
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(sc, 0), stoneMat);
      m.position.set(x, sc * 0.45, z);
      m.rotation.set(br() * Math.PI, br() * Math.PI, br() * Math.PI);
      scene.add(m);
    }
    anim.waterMat = waterMat;
  }

  // ---------- forest shrine: ring of standing stones + hovering crystal ----------
  {
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.95, flatShading: true });
    const mossMat  = new THREE.MeshStandardMaterial({ color: 0x3a7038, roughness: 0.9,  flatShading: true });
    const STONES = 6, STONE_R = 3.6;
    for (let i = 0; i < STONES; i++) {
      const a = (i / STONES) * Math.PI * 2 + Math.PI / 12;
      const x = POND_X + Math.cos(a) * STONE_R;
      const z = POND_Z + Math.sin(a) * STONE_R;
      const h = 2.4 + (i % 2) * 0.5;
      const stone = new THREE.Mesh(new THREE.BoxGeometry(0.85, h, 0.55), stoneMat);
      stone.position.set(x, h / 2 - 0.05, z);
      stone.lookAt(POND_X, h / 2, POND_Z);
      scene.add(stone);
      const moss = new THREE.Mesh(new THREE.IcosahedronGeometry(0.40, 0), mossMat);
      moss.scale.set(1.05, 0.32, 0.72);
      moss.position.set(x, h - 0.05, z);
      scene.add(moss);
    }

    // hovering crystal (octahedron) — pulses + emits a colored light
    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0xeaf6ff, emissive: 0x70d4ff, emissiveIntensity: 2.8,
      roughness: 0.18, metalness: 0.35,
    });
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), crystalMat);
    crystal.position.set(POND_X, 1.9, POND_Z);
    scene.add(crystal);
    anim.shrineCrystal = crystal;
    anim.shrineCrystalY = 1.9;

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0x90daff, transparent: true, opacity: 0.20,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    halo.position.copy(crystal.position);
    scene.add(halo);
    anim.shrineHalo = halo;

    // rune ring lying just above the water, slowly rotating
    const runeRing = new THREE.Mesh(
      new THREE.TorusGeometry(SHRINE_RING_R, 0.06, 14, 96),
      new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0x80e4ff, emissiveIntensity: 3.0,
      })
    );
    runeRing.rotation.x = Math.PI / 2;
    runeRing.position.set(POND_X, 0.08, POND_Z);
    scene.add(runeRing);
    anim.shrineRing = runeRing;

    const shrineLight = new THREE.PointLight(0x90e6ff, 6.0, 22, 1.8);
    shrineLight.position.copy(crystal.position);
    scene.add(shrineLight);
    anim.shrineLight = shrineLight;
  }

  // ---------- glowing mushrooms (toadstools + bioluminescent clusters) ----------
  {
    let s = 53;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const stemMat = new THREE.MeshStandardMaterial({ color: 0xe7d4b1, roughness: 0.85 });
    const redCap  = new THREE.MeshStandardMaterial({ color: 0xb02828, roughness: 0.7, flatShading: true });

    function inPondOrCamera(x, z) {
      const dx = x - POND_X, dz = z - POND_Z;
      if (Math.sqrt(dx * dx + dz * dz) < POND_R + 0.6) return true;
      if (Math.sqrt(x * x + (z + 10) ** 2) < 1.6) return true;
      return false;
    }

    function placeMushroom(x, z, variant) {
      const sc = 0.7 + r() * 0.7;
      const stemH = 0.20 * sc;
      const capR  = 0.18 * sc;
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045 * sc, 0.065 * sc, stemH, 8),
        stemMat
      );
      stem.position.set(x, stemH / 2, z);
      scene.add(stem);

      let capMat;
      if (variant === 'cyan') {
        capMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x40d0ff, emissiveIntensity: 2.2, roughness: 0.5 });
      } else if (variant === 'violet') {
        capMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xc080ff, emissiveIntensity: 2.2, roughness: 0.5 });
      } else {
        capMat = redCap;
      }
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(capR, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        capMat
      );
      cap.position.set(x, stemH, z);
      scene.add(cap);

      if (variant === null) {
        for (let k = 0; k < 4; k++) {
          const ang = r() * Math.PI * 2;
          const rr  = capR * (0.4 + r() * 0.45);
          const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.022 * sc, 6, 5),
            new THREE.MeshBasicMaterial({ color: 0xffffff })
          );
          dot.position.set(x + Math.cos(ang) * rr * 0.6, stemH + capR * 0.85, z + Math.sin(ang) * rr * 0.6);
          scene.add(dot);
        }
      } else {
        const lampCol = variant === 'cyan' ? 0x60e0ff : 0xc090ff;
        const lamp = new THREE.PointLight(lampCol, 0.65 * sc, 1.7, 2.0);
        lamp.position.set(x, stemH + capR * 0.4, z);
        scene.add(lamp);
        anim.glowCaps.push({ mat: capMat, base: 2.0, amp: 0.7, phase: r() * Math.PI * 2 });
      }
    }

    // 10 mushroom clusters across the meadow + understory; ~half are glowing
    for (let c = 0; c < 10; c++) {
      const cx = (r() - 0.5) * 44;
      const cz = -8 + (r() - 0.5) * 42;
      const n  = 3 + Math.floor(r() * 5);
      const v  = r();
      const variant = v < 0.42 ? null : (v < 0.74 ? 'cyan' : 'violet');
      for (let i = 0; i < n; i++) {
        const ang = r() * Math.PI * 2;
        const rad = r() * 1.0;
        const x = cx + Math.cos(ang) * rad;
        const z = cz + Math.sin(ang) * rad;
        if (inPondOrCamera(x, z)) continue;
        placeMushroom(x, z, variant);
      }
    }
  }

  // ---------- god rays (additive cylinders simulating sunbeams through canopy) ----------
  {
    let s = 41;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const beamColor = 0xfff2c8;
    for (let i = 0; i < 14; i++) {
      const rad = 5 + r() * 14;
      const a = r() * Math.PI * 2;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5 + r() * 0.4, 0.08, 18, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: beamColor, transparent: true, opacity: 0.10,
          depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        })
      );
      beam.position.set(Math.cos(a) * rad, 9, -12 + Math.sin(a) * rad);
      // tilt to match the sun direction (positive X, slight Z)
      beam.rotation.z = -0.30 + r() * 0.08;
      beam.rotation.x = -0.10 + r() * 0.08;
      beam.userData.basePhase = r() * Math.PI * 2;
      scene.add(beam);
      anim.beams.push(beam);
    }
  }

  // ---------- pollen / dust motes ----------
  {
    const N = 280;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 0] = (Math.random() - 0.5) * 36;
      pos[i * 3 + 1] = 0.3 + Math.random() * 6;
      pos[i * 3 + 2] = 4 - Math.random() * 50;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pollen = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xfff5c8, size: 0.08, sizeAttenuation: true,
      transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    pollen.userData.basePos = pos.slice();
    scene.add(pollen);
    anim.pollen = pollen;
  }

  // ---------- butterflies ----------
  {
    const colors = [0xffcc44, 0xff7088, 0x66ccff, 0xc088ff, 0xfff066, 0xffa040];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 6),
        new THREE.MeshBasicMaterial({ color: colors[i % colors.length] })
      );
      const cx = (Math.random() - 0.5) * 14;
      const cz = -8 + (Math.random() - 0.5) * 14;
      m.position.set(cx, 1.4 + Math.random() * 2.0, cz);
      m.userData.cx = cx;
      m.userData.cz = cz;
      m.userData.cy = 1.4 + Math.random() * 2.0;
      m.userData.radius = 2.0 + Math.random() * 3.0;
      m.userData.speed = 0.4 + Math.random() * 0.5;
      m.userData.phase = Math.random() * Math.PI * 2;
      scene.add(m);
      anim.butterflies.push(m);
    }
  }

  // ---------- fireflies (custom-shader points; per-firefly twinkle + drift) ----------
  {
    const N = 160;
    const pos = new Float32Array(N * 3);
    const phases = new Float32Array(N);
    const drifts = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      // bias placement around the clearing so they're visible from the camera
      const r = 2 + Math.random() * 14;
      const a = Math.random() * Math.PI * 2;
      pos[i * 3 + 0] = Math.cos(a) * r;
      pos[i * 3 + 1] = 0.4 + Math.random() * 4.0;
      pos[i * 3 + 2] = -10 + Math.sin(a) * r;
      phases[i] = Math.random() * Math.PI * 2;
      drifts[i * 3 + 0] = 0.30 + Math.random() * 0.50;
      drifts[i * 3 + 1] = 0.18 + Math.random() * 0.32;
      drifts[i * 3 + 2] = 0.30 + Math.random() * 0.50;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
    g.setAttribute('drift', new THREE.BufferAttribute(drifts, 3));

    const fireflyMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        time: { value: 0 },
        pixelRatio: { value: window.devicePixelRatio || 1 },
      },
      vertexShader: `
        attribute float phase;
        attribute vec3 drift;
        uniform float time;
        uniform float pixelRatio;
        varying float vTwinkle;
        varying float vTint;
        void main() {
          vec3 p = position;
          p.x += sin(time * 0.6  + phase)         * drift.x;
          p.y += sin(time * 0.45 + phase * 1.7)   * drift.y;
          p.z += cos(time * 0.55 + phase * 0.9)   * drift.z;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float fast = sin(time * 2.4 + phase * 3.1) * 0.5 + 0.5;
          float slow = sin(time * 0.6 + phase * 5.0) * 0.5 + 0.5;
          vTwinkle = (0.30 + 0.70 * fast) * (0.55 + 0.45 * slow);
          vTint = sin(phase * 2.3) * 0.5 + 0.5;
          gl_PointSize = pixelRatio * (4.0 + vTwinkle * 7.0) * (55.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying float vTwinkle;
        varying float vTint;
        void main() {
          vec2 cp = gl_PointCoord - 0.5;
          float d = length(cp);
          if (d > 0.5) discard;
          float core = smoothstep(0.5, 0.0, d);
          float halo = smoothstep(0.5, 0.18, d) * 0.45;
          vec3 warm = vec3(1.00, 0.93, 0.45);
          vec3 cool = vec3(0.55, 1.00, 0.75);
          vec3 col = mix(warm, cool, vTint);
          float a = (core + halo) * vTwinkle;
          gl_FragColor = vec4(col * a, a);
        }
      `,
    });
    const fireflies = new THREE.Points(g, fireflyMat);
    scene.add(fireflies);
    anim.fireflyMat = fireflyMat;
  }

  // ---------- birds (V-shape silhouettes circling overhead with wing flap) ----------
  {
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x141820, side: THREE.DoubleSide });
    // single wing triangle pointing +x; body axis along +z (mirror this for the other wing)
    const wingGeo = new THREE.BufferGeometry();
    wingGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0.0, 0.00,  0.00,
      1.0, 0.05,  0.05,
      0.3, 0.00, -0.55,
    ]), 3));
    wingGeo.computeVertexNormals();

    for (let i = 0; i < 5; i++) {
      const group = new THREE.Group();
      const rWing = new THREE.Mesh(wingGeo, birdMat);
      const lWing = new THREE.Mesh(wingGeo, birdMat);
      lWing.scale.x = -1;
      group.add(rWing);
      group.add(lWing);
      const cx = (Math.random() - 0.5) * 40;
      const cz = -30 + (Math.random() - 0.5) * 30;
      const cy = 15 + Math.random() * 10;
      const radius = 14 + Math.random() * 12;
      const speed = 0.10 + Math.random() * 0.10;
      const phase = Math.random() * Math.PI * 2;
      const flapSpeed = 3.0 + Math.random() * 2.0;
      group.position.set(cx + Math.cos(phase) * radius, cy, cz + Math.sin(phase) * radius);
      scene.add(group);
      anim.birds.push({ group, rWing, lWing, cx, cz, cy, radius, speed, phase, flapSpeed });
    }
  }

  // ---------- lighting ----------
  scene.add(new THREE.HemisphereLight(0x8aa6bc, 0x2e4220, 0.42));
  const sunLight = new THREE.DirectionalLight(0xffe8c0, 1.15);
  sunLight.position.set(20, 32, 18);
  scene.add(sunLight);
  const fill = new THREE.DirectionalLight(0xd8b088, 0.18);
  fill.position.set(-12, 10, -10);
  scene.add(fill);

  function update(t) {
    if (anim.skyUniforms) anim.skyUniforms.time.value = t;
    if (anim.waterMat) anim.waterMat.uniforms.time.value = t;
    if (anim.fireflyMat) anim.fireflyMat.uniforms.time.value = t;

    if (anim.pollen) {
      const base = anim.pollen.userData.basePos;
      const arr = anim.pollen.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 0] = base[i + 0] + Math.sin(t * 0.35 + i) * 0.30;
        arr[i + 1] = base[i + 1] + (Math.sin(t * 0.22 + i * 1.7) + 1.0) * 0.35;
        arr[i + 2] = base[i + 2] + Math.cos(t * 0.30 + i * 0.5) * 0.25;
      }
      anim.pollen.geometry.attributes.position.needsUpdate = true;
    }

    for (const b of anim.butterflies) {
      const ph = t * b.userData.speed + b.userData.phase;
      b.position.x = b.userData.cx + Math.cos(ph) * b.userData.radius;
      b.position.y = b.userData.cy + Math.sin(ph * 2.7) * 0.55;
      b.position.z = b.userData.cz + Math.sin(ph) * b.userData.radius;
      b.rotation.y = -ph;
    }

    for (let i = 0; i < anim.beams.length; i++) {
      const b = anim.beams[i];
      b.material.opacity = 0.08 + Math.sin(t * 0.4 + b.userData.basePhase) * 0.05;
    }

    // foliage wind sway around each blob's base position
    for (const f of anim.foliage) {
      const sx = Math.sin(t * 0.55 + f.swayPhase) * f.swayAmp;
      const sz = Math.cos(t * 0.50 + f.swayPhase * 1.3) * f.swayAmp * 0.7;
      const sy = Math.sin(t * 0.38 + f.swayPhase * 1.7) * f.swayAmp * 0.30;
      f.mesh.position.set(f.bx + sx, f.by + sy, f.bz + sz);
    }

    // shrine crystal — bob, spin, pulse, with halo + light tracking
    if (anim.shrineCrystal) {
      const c = anim.shrineCrystal;
      c.position.y = anim.shrineCrystalY + Math.sin(t * 0.9) * 0.18;
      c.rotation.y = t * 0.7;
      c.rotation.x = Math.sin(t * 0.3) * 0.25;
      c.material.emissiveIntensity = 2.5 + Math.sin(t * 1.7) * 0.75;
      if (anim.shrineLight) anim.shrineLight.intensity = 5.0 + Math.sin(t * 1.7) * 1.7;
      if (anim.shrineHalo) {
        anim.shrineHalo.position.y = c.position.y;
        anim.shrineHalo.scale.setScalar(1.0 + Math.sin(t * 1.4) * 0.12);
      }
    }
    if (anim.shrineRing) anim.shrineRing.rotation.z = t * 0.18;

    // glowing mushroom caps breathe
    for (const m of anim.glowCaps) {
      m.mat.emissiveIntensity = m.base + Math.sin(t * 0.9 + m.phase) * m.amp;
    }

    // birds — slow circular flight, sinusoidal wing flap (mirrored wing → mirrored flap)
    for (const b of anim.birds) {
      const a = b.phase + t * b.speed;
      b.group.position.set(
        b.cx + Math.cos(a) * b.radius,
        b.cy + Math.sin(a * 0.7) * 0.8,
        b.cz + Math.sin(a) * b.radius
      );
      b.group.rotation.y = -a;
      const flap = Math.sin(t * b.flapSpeed + b.phase);
      b.rWing.rotation.z =  flap * 0.85;
      b.lWing.rotation.z = -flap * 0.85;
    }
  }

  return { scene, update };
}

function buildSpaceScene() {
  const scene = new THREE.Scene();
  // no fog — vacuum, so far-depth parallax stays sharp

  const anim = {
    nebulaMat: null,
    planet: null,
    planetMat: null,
    planetGroup: null,
    auroraMat: null,
    ringMat: null,
    debris: [],
  };

  // shared sun/planet geometry — referenced by mesh, lights, and shaders
  const PLANET_R = 28;
  const PLANET_POS = new THREE.Vector3(0, 14, -140);
  const PLANET_TILT = 26.7 * Math.PI / 180; // Saturn's axial tilt
  const SUN_POS = new THREE.Vector3(220, 42, -180);
  const SUN_DIR = new THREE.Vector3().subVectors(SUN_POS, PLANET_POS).normalize();

  // ---------- nebula sky (volumetric-feeling backdrop) ----------
  {
    const nebulaMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        time: { value: 0 },
        colorA: { value: new THREE.Color(0x6a2dc0) },  // violet
        colorB: { value: new THREE.Color(0x1e8aa0) },  // teal
        colorC: { value: new THREE.Color(0xc02860) },  // magenta
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldPos;
        uniform float time;
        uniform vec3 colorA;
        uniform vec3 colorB;
        uniform vec3 colorC;
        float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float noise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec3(1.0, 0.0, 0.0));
          float c = hash(i + vec3(0.0, 1.0, 0.0));
          float d = hash(i + vec3(1.0, 1.0, 0.0));
          float e = hash(i + vec3(0.0, 0.0, 1.0));
          float fa = hash(i + vec3(1.0, 0.0, 1.0));
          float g = hash(i + vec3(0.0, 1.0, 1.0));
          float h = hash(i + vec3(1.0, 1.0, 1.0));
          return mix(
            mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
            mix(mix(e, fa, f.x), mix(g, h, f.x), f.y),
            f.z
          );
        }
        float fbm(vec3 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.04; a *= 0.5; }
          return v;
        }
        void main() {
          vec3 dir = normalize(vWorldPos);
          float n  = fbm(dir * 2.4 + vec3(time * 0.010));
          float n2 = fbm(dir * 5.0 + vec3(time * 0.005, 0.0, time * 0.008));
          vec3 col = vec3(0.012, 0.008, 0.020); // near-black baseline
          col += colorA * smoothstep(0.45, 0.85, n) * 0.55;
          col += colorB * smoothstep(0.55, 0.92, n2) * 0.45;
          col += colorC * smoothstep(0.42, 0.78, n * n2) * 0.35;
          // dust band concentrated near the galactic plane
          float band = pow(1.0 - clamp(abs(dir.y) * 1.3, 0.0, 1.0), 4.0);
          col += colorA * band * 0.10;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const nebula = new THREE.Mesh(new THREE.SphereGeometry(360, 32, 16), nebulaMat);
    scene.add(nebula);
    anim.nebulaMat = nebulaMat;
  }

  // ---------- dense starfield (vertex colors for tinted stars) ----------
  {
    const N = 3500;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 320;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      pos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const t = Math.random();
      col[i * 3 + 0] = 0.85 + t * 0.15;
      col[i * 3 + 1] = 0.85 + t * 0.10;
      col[i * 3 + 2] = 0.90 + (1 - t) * 0.10;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.7, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: 0.95, depthWrite: false,
    })));
  }

  // ---------- distant sun (drives lighting, also visible) ----------
  {
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(3.8, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff4d0 })
    );
    sun.position.copy(SUN_POS);
    scene.add(sun);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(8.2, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0xffd890, transparent: true, opacity: 0.32, depthWrite: false })
    );
    halo.position.copy(SUN_POS);
    scene.add(halo);
    const flare = new THREE.Mesh(
      new THREE.SphereGeometry(16, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    flare.position.copy(SUN_POS);
    scene.add(flare);
  }

  // ---------- central planet (gas giant + aurora + saturnian rings) ----------
  {
    // tilt + position carry the planet, aurora, and rings together
    const planetGroup = new THREE.Group();
    planetGroup.position.copy(PLANET_POS);
    planetGroup.rotation.z = PLANET_TILT;
    scene.add(planetGroup);
    anim.planetGroup = planetGroup;

    // ---- planet surface: procedural banded gas giant w/ a long-lived storm ----
    const planetMat = new THREE.ShaderMaterial({
      uniforms: {
        time:       { value: 0 },
        sunDir:     { value: SUN_DIR.clone() },
        baseLight:  { value: new THREE.Color(0xe8c898) }, // warm cream
        baseDark:   { value: new THREE.Color(0x6f4326) }, // deep amber
        bandTint:   { value: new THREE.Color(0xa86a3c) }, // rust accent on darker bands
        stormColor: { value: new THREE.Color(0xd07050) }, // salmon vortex
        nightColor: { value: new THREE.Color(0x05080f) },
      },
      vertexShader: `
        varying vec3 vWorldN;
        varying vec3 vLocalN;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vWorldN = normalize(mat3(modelMatrix) * normal);
          vLocalN = normalize(normal);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldN;
        varying vec3 vLocalN;
        uniform float time;
        uniform vec3 sunDir;
        uniform vec3 baseLight;
        uniform vec3 baseDark;
        uniform vec3 bandTint;
        uniform vec3 stormColor;
        uniform vec3 nightColor;

        float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float noise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec3(1.0, 0.0, 0.0));
          float c = hash(i + vec3(0.0, 1.0, 0.0));
          float d = hash(i + vec3(1.0, 1.0, 0.0));
          float e = hash(i + vec3(0.0, 0.0, 1.0));
          float f2 = hash(i + vec3(1.0, 0.0, 1.0));
          float g = hash(i + vec3(0.0, 1.0, 1.0));
          float h = hash(i + vec3(1.0, 1.0, 1.0));
          return mix(
            mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
            mix(mix(e, f2, f.x), mix(g, h, f.x), f.y),
            f.z
          );
        }
        float fbm(vec3 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.04; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 n = normalize(vLocalN);
          float lat = n.y;                   // -1..1, ±1 at poles
          float lon = atan(n.z, n.x);        // -pi..pi

          // turbulent jet streams: streaked along longitude, banded by latitude
          vec3 turbP = vec3(lon * 1.8 + time * 0.05, lat * 5.5, time * 0.025);
          float turb = fbm(turbP) - 0.5;
          // primary bands (jets)
          float bands = sin(lat * 11.0 + turb * 1.6) * 0.5 + 0.5;
          bands = smoothstep(0.10, 0.95, bands);
          // mid-detail eddies riding on top of the bands
          float eddy = fbm(vec3(lon * 4.0 + time * 0.03, lat * 14.0, 1.7));
          bands = mix(bands, eddy, 0.30);
          // fine detail filaments
          float fine = fbm(vec3(lon * 12.0, lat * 28.0, time * 0.04));
          bands = clamp(bands + (fine - 0.5) * 0.15, 0.0, 1.0);

          vec3 surf = mix(baseDark, baseLight, bands);
          // give darker bands a rust tint
          surf = mix(surf, bandTint * 0.9, (1.0 - bands) * 0.45);
          // brighter polar haze (smaller scale, just a slight wash)
          surf = mix(surf, baseLight * 1.08, smoothstep(0.78, 0.97, abs(lat)) * 0.25);

          // long-lived oval storm (Great-Red-Spot-style), fixed in planet-local frame
          vec2 stormCenter = vec2(2.20, -0.32); // (lon, lat)
          vec2 sUv = vec2(lon, lat) - stormCenter;
          sUv.x = mod(sUv.x + 3.14159, 6.28318) - 3.14159;
          float sd = length(vec2(sUv.x * 0.75, sUv.y * 2.0));
          float stormMask = smoothstep(0.46, 0.08, sd);
          float swirlAng = atan(sUv.y, sUv.x) - time * 0.30 - sd * 9.0;
          float swirl = sin(swirlAng * 3.0) * 0.5 + 0.5;
          surf = mix(surf, stormColor * (0.65 + swirl * 0.50), stormMask * 0.92);

          // lighting: wrapped Lambert against world-space sun direction
          float ndl = dot(normalize(vWorldN), normalize(sunDir));
          float lit = pow(max(0.0, ndl) * 0.5 + 0.5, 1.6);
          // terminator softening — gently push night side toward nightColor
          float dayMix = smoothstep(-0.15, 0.20, ndl);
          vec3 lightCol = vec3(1.00, 0.94, 0.82);
          vec3 day = surf * lightCol * lit;
          vec3 night = mix(nightColor, surf * 0.05, 0.5);
          vec3 col = mix(night, day, dayMix);
          // a hair of ambient so the terminator never fully blacks out
          col += surf * 0.025;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_R, 128, 96),
      planetMat
    );
    planetGroup.add(planet);
    anim.planet = planet;
    anim.planetMat = planetMat;

    // ---- atmospheric rim glow (Fresnel halo on the lit limb) ----
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_R * 1.045, 96, 64),
      new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        uniforms: {
          color:  { value: new THREE.Color(0x6cb4ff) },
          sunDir: { value: SUN_DIR.clone() },
        },
        vertexShader: `
          varying vec3 vWorldN; varying vec3 vView;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vWorldN = normalize(mat3(modelMatrix) * normal);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform vec3 sunDir;
          varying vec3 vWorldN; varying vec3 vView;
          void main() {
            // Fresnel for thickness through the limb
            float f = pow(1.0 - max(0.0, dot(normalize(vWorldN), normalize(vView))), 3.2);
            // limb brighter on the sun-lit side, dim on the night side
            float lit = clamp(dot(normalize(-vWorldN), normalize(sunDir)) * 0.5 + 0.5, 0.0, 1.0);
            gl_FragColor = vec4(color, f * (0.25 + lit * 0.80));
          }
        `,
      })
    );
    planetGroup.add(rim);

    // ---- polar aurora: spherical cap with animated curtains ----
    const auroraMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        time:   { value: 0 },
        colorA: { value: new THREE.Color(0x6effa8) }, // auroral green
        colorB: { value: new THREE.Color(0x70a8ff) }, // ionised blue
        colorC: { value: new THREE.Color(0xff80c8) }, // high-altitude pink
      },
      vertexShader: `
        varying vec3 vLocal;
        void main() {
          vLocal = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vLocal;
        uniform float time;
        uniform vec3 colorA;
        uniform vec3 colorB;
        uniform vec3 colorC;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.04; a *= 0.5; }
          return v;
        }
        void main() {
          float lat = vLocal.y;                 // ~0.5..1 across the polar cap
          float lon = atan(vLocal.z, vLocal.x);
          // ring of latitude around the pole, fading inside and outside
          float band = smoothstep(0.74, 0.86, lat) * (1.0 - smoothstep(0.94, 1.00, lat));
          // ribbons varying with longitude, drifting over time
          vec2 uv = vec2(lon * 2.8 + time * 0.18, (1.0 - lat) * 24.0 - time * 0.07);
          float n  = fbm(uv);
          float n2 = fbm(uv * vec2(2.7, 1.3) + 7.0);
          float curtain = pow(smoothstep(0.34, 0.82, n) * smoothstep(0.30, 0.80, n2), 1.15);
          // a fainter outer halo of aurora
          float outerBand = smoothstep(0.62, 0.74, lat) * (1.0 - smoothstep(0.84, 0.92, lat)) * 0.55;
          float intensity = curtain * (band + outerBand);
          vec3 col = mix(colorA, colorB, smoothstep(0.0, 1.0, n));
          col = mix(col, colorC, smoothstep(0.60, 1.0, n2) * 0.55);
          gl_FragColor = vec4(col, intensity * 1.05);
        }
      `,
    });
    const auroraGeo = new THREE.SphereGeometry(
      PLANET_R * 1.015, 96, 64, 0, Math.PI * 2, 0, Math.PI * 0.42
    );
    const aurora = new THREE.Mesh(auroraGeo, auroraMat);
    planetGroup.add(aurora);
    anim.auroraMat = auroraMat;

    // ---- saturnian rings: shader annulus with banding, gaps, and planet shadow ----
    const ringInner = PLANET_R * 1.22;
    const ringOuter = PLANET_R * 2.35;
    const ringMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        time:         { value: 0 },
        innerR:       { value: ringInner },
        outerR:       { value: ringOuter },
        sunDir:       { value: SUN_DIR.clone() },
        planetCenter: { value: PLANET_POS.clone() },
        planetR:      { value: PLANET_R },
      },
      vertexShader: `
        varying vec3 vWorld;
        varying vec2 vLocalXY;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vLocalXY = position.xy; // RingGeometry vertices lie in the local XY plane
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        varying vec3 vWorld;
        varying vec2 vLocalXY;
        uniform float time;
        uniform float innerR;
        uniform float outerR;
        uniform vec3 sunDir;
        uniform vec3 planetCenter;
        uniform float planetR;

        float hash(float x) { return fract(sin(x * 127.1) * 43758.5); }
        float noise1(float x) {
          float i = floor(x), f = fract(x);
          float a = hash(i), b = hash(i + 1.0);
          f = f * f * (3.0 - 2.0 * f);
          return mix(a, b, f);
        }
        float fbm1(float x) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 6; i++) { v += a * noise1(x); x *= 2.04; a *= 0.5; }
          return v;
        }
        // notch function: returns ~0 inside a small radius-band gap
        float gap(float t, float center, float halfWidth) {
          return smoothstep(0.0, halfWidth, abs(t - center));
        }

        void main() {
          float r = length(vLocalXY);
          if (r < innerR || r > outerR) discard;
          float t = (r - innerR) / (outerR - innerR);

          // ring density — three octaves of radial noise stacked
          float dens = fbm1(t * 80.0) * 0.60
                     + fbm1(t * 220.0) * 0.30
                     + fbm1(t * 14.0) * 0.45;
          dens = clamp(dens, 0.0, 1.2);

          // C ring (faint inner): low overall density 0..0.22
          // B ring (brightest): 0.22..0.42
          // Cassini Division at ~0.44
          // A ring: 0.50..0.85
          // Encke gap at ~0.78
          // F ring (narrow outer): ~0.95
          float profile = 0.0;
          profile += smoothstep(0.00, 0.04, t) * (1.0 - smoothstep(0.18, 0.24, t)) * 0.40; // C
          profile += smoothstep(0.20, 0.26, t) * (1.0 - smoothstep(0.40, 0.46, t)) * 1.10; // B (brightest)
          profile += smoothstep(0.50, 0.55, t) * (1.0 - smoothstep(0.82, 0.88, t)) * 0.85; // A
          profile += exp(-pow((t - 0.955) / 0.012, 2.0)) * 0.95;                            // F (narrow)

          // hard gaps
          float gCassini = smoothstep(0.005, 0.018, abs(t - 0.45));
          float gEncke   = smoothstep(0.001, 0.004, abs(t - 0.78));
          profile *= gCassini * gEncke;

          float alpha = clamp(dens * profile, 0.0, 0.95);

          // colour: warm tan with mild variation across the rings
          vec3 colA = vec3(0.90, 0.78, 0.58);
          vec3 colB = vec3(0.62, 0.46, 0.30);
          vec3 col = mix(colB, colA, dens);
          col = mix(col, col * vec3(0.95, 0.97, 1.04), smoothstep(0.85, 1.00, t)); // outer F slightly cooler
          col = mix(col, col * vec3(1.05, 0.97, 0.85), smoothstep(0.00, 0.20, t) * 0.5); // inner C warmer

          // planet shadow: project ring point along sun direction; in-shadow if it
          // is on the far side from the sun and within the planet's projected disc
          vec3 rel = vWorld - planetCenter;
          vec3 toSun = normalize(sunDir);
          float d = dot(rel, toSun);
          vec3 perp = rel - toSun * d;
          float pd = length(perp);
          float shadow = 1.0;
          if (d < 0.0 && pd < planetR * 1.05) {
            // soft penumbra near the planet's silhouette
            shadow = mix(0.22, 1.0, smoothstep(planetR * 0.85, planetR * 1.10, pd));
          }
          col *= shadow;

          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    const rings = new THREE.Mesh(
      new THREE.RingGeometry(ringInner, ringOuter, 256, 4),
      ringMat
    );
    rings.rotation.x = -Math.PI / 2; // lie in the equatorial plane of the (tilted) group
    planetGroup.add(rings);
    anim.ringMat = ringMat;
  }

  // ---------- distant moon (a small companion past the planet) ----------
  {
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0xc4cbd4, roughness: 0.95, metalness: 0 })
    );
    moon.position.set(PLANET_POS.x - 62, PLANET_POS.y - 4, PLANET_POS.z + 38);
    scene.add(moon);
  }

  // ---------- foreground debris (parallax cues at near distances) ----------
  {
    const debrisMat = new THREE.MeshStandardMaterial({
      color: 0x6b7480, roughness: 0.65, metalness: 0.45, flatShading: true,
    });
    const positions = [
      [-2.2, 1.5, -8.5],  [2.8, 0.5, -9.2],  [-2.6, 2.2, -12.5], [2.4, 1.0, -13.8],
      [-3.2, 0.8, -17.5], [3.4, 2.5, -19.2], [-1.6, 1.6, -23.0], [2.0, 0.4, -25.5],
      [-3.6, 2.8, -29.0], [3.0, 3.2, -31.5],
    ];
    let k = 0;
    for (const [x, y, z] of positions) {
      // minimum asteroid complexity: icosa-detail-1 (80 faces). No tetrahedra/cubes.
      const types = [
        new THREE.IcosahedronGeometry(0.42, 1),
        new THREE.IcosahedronGeometry(0.55, 2),
        new THREE.DodecahedronGeometry(0.50, 1),
        new THREE.IcosahedronGeometry(0.48, 1),
      ];
      const g = types[k++ % types.length];
      const m = new THREE.Mesh(g, debrisMat);
      m.position.set(x, y, z);
      m.userData.basePos = [x, y, z];
      m.userData.phase = Math.random() * Math.PI * 2;
      m.userData.rs = [
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.5,
      ];
      scene.add(m);
      anim.debris.push(m);
    }
  }

  // ---------- lighting ----------
  scene.add(new THREE.AmbientLight(0x1a2238, 0.28));
  // sun as the key light — placed at the sun mesh's position so the planet's
  // standard materials (debris, moon) match the planet shader's terminator
  const sunLight = new THREE.DirectionalLight(0xfff0d0, 1.35);
  sunLight.position.copy(SUN_POS);
  scene.add(sunLight);
  // very soft cool fill from the nebula side, so the night side isn't pitch black
  const fill = new THREE.DirectionalLight(0x4060a0, 0.18);
  fill.position.set(-80, 30, 40);
  scene.add(fill);

  function update(t) {
    if (anim.nebulaMat) anim.nebulaMat.uniforms.time.value = t;
    if (anim.planetMat) anim.planetMat.uniforms.time.value = t;
    if (anim.auroraMat) anim.auroraMat.uniforms.time.value = t;
    if (anim.ringMat)   anim.ringMat.uniforms.time.value   = t;
    // planet rotates around its own (tilted) Y axis at a stately gas-giant pace
    if (anim.planet)    anim.planet.rotation.y = t * 0.025;
    for (const d of anim.debris) {
      const ph = t * 0.5 + d.userData.phase;
      d.position.y = d.userData.basePos[1] + Math.sin(ph) * 0.15;
      d.rotation.x += d.userData.rs[0] * 0.01;
      d.rotation.y += d.userData.rs[1] * 0.01;
      d.rotation.z += d.userData.rs[2] * 0.01;
    }
  }

  return { scene, update };
}

function buildDesertScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd87858, 0.011); // warm dusty haze

  const anim = {
    skyUniforms: null,
    tumbleweeds: [],
    dust: null,
  };

  // ---------- sunset sky (banded gradient + sun + faint stars overhead) ----------
  {
    const skyUniforms = {
      time: { value: 0 },
      sunDir: { value: new THREE.Vector3(0.25, 0.08, -1.0).normalize() },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(380, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: skyUniforms,
        vertexShader: `
          varying vec3 vWorldPos;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          varying vec3 vWorldPos;
          uniform float time;
          uniform vec3 sunDir;
          // simple hash for sparse stars in the upper sky
          float hash3(vec3 p) { return fract(sin(dot(p, vec3(91.0, 173.0, 33.0))) * 9876.0); }
          void main() {
            vec3 dir = normalize(vWorldPos);
            float h = dir.y;
            // stratified sunset gradient
            vec3 horizonCol = vec3(1.00, 0.62, 0.30);
            vec3 lowCol     = vec3(0.92, 0.42, 0.26);
            vec3 midCol     = vec3(0.55, 0.22, 0.34);
            vec3 highCol    = vec3(0.16, 0.10, 0.30);
            vec3 zenithCol  = vec3(0.03, 0.03, 0.10);
            vec3 col = horizonCol;
            col = mix(col, lowCol,    smoothstep(0.00, 0.12, h));
            col = mix(col, midCol,    smoothstep(0.12, 0.32, h));
            col = mix(col, highCol,   smoothstep(0.32, 0.62, h));
            col = mix(col, zenithCol, smoothstep(0.62, 1.00, h));
            // sun disc + halo (low to the horizon)
            float sd = max(0.0, dot(dir, sunDir));
            float sun  = smoothstep(0.9989, 0.9999, sd);
            float halo = pow(sd, 110.0) * 1.10
                       + pow(sd,  22.0) * 0.35
                       + pow(sd,   5.0) * 0.10;
            col += vec3(1.00, 0.85, 0.62) * (sun * 4.5 + halo);
            // sparse stars in the high purple zenith
            if (h > 0.50) {
              vec3 q = floor(dir * 220.0);
              float s = hash3(q);
              if (s > 0.9975) {
                col += vec3(1.0, 0.95, 0.85) * (s - 0.9975) * 280.0 * smoothstep(0.50, 0.85, h);
              }
            }
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    scene.add(sky);
    anim.skyUniforms = skyUniforms;
  }

  // ---------- sandy dunes (vertex-displaced + warm vertex tint) ----------
  {
    const geo = new THREE.PlaneGeometry(500, 500, 100, 100);
    const pos = geo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    let s = 23;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i,
        Math.sin(x * 0.05) * 0.80
        + Math.cos(y * 0.07) * 0.65
        + Math.sin(x * 0.18 + y * 0.13) * 0.18
      );
      const variance = r();
      cols[i * 3 + 0] = 0.88 + variance * 0.10;
      cols[i * 3 + 1] = 0.66 + variance * 0.10;
      cols[i * 3 + 2] = 0.42 + variance * 0.08;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    const sand = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })
    );
    sand.rotation.x = -Math.PI / 2;
    scene.add(sand);
  }

  // ---------- mesa silhouettes against the sun ----------
  {
    let s = 11;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const mesaMat = new THREE.MeshStandardMaterial({
      color: 0x2a0e16, emissive: 0x1a0810, emissiveIntensity: 0.25,
      roughness: 1.0, flatShading: true,
    });
    for (let i = 0; i < 9; i++) {
      const x = (i - 4) * 22 + (r() - 0.5) * 8;
      const h = 7 + r() * 14;
      const w = 12 + r() * 16;
      const d = 6 + r() * 10;
      const z = -90 - r() * 35;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mesaMat);
      m.position.set(x, h / 2 - 0.5, z);
      m.rotation.y = (r() - 0.5) * 0.30;
      scene.add(m);

      // smaller tier on top of some mesas
      if (r() > 0.55) {
        const h2 = h * 0.35;
        const w2 = w * 0.55;
        const top = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, d * 0.6), mesaMat);
        top.position.set(
          m.position.x + (r() - 0.5) * (w - w2) * 0.5,
          h + h2 / 2 - 0.5,
          m.position.z
        );
        top.rotation.y = m.rotation.y;
        scene.add(top);
      }
    }
  }

  // ---------- cacti (saguaro-style: trunk + 0–2 arms) ----------
  {
    let s = 31;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const cactusMat = new THREE.MeshStandardMaterial({
      color: 0x3b6244, roughness: 0.85, metalness: 0,
    });
    function placeCactus(x, z, scale) {
      const trunkH = (2.6 + r() * 1.6) * scale;
      const trunkR = 0.22 * scale;
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(trunkR, trunkR * 1.15, trunkH, 14),
        cactusMat
      );
      trunk.position.set(x, trunkH / 2, z);
      scene.add(trunk);
      // 0–2 arms with horizontal connector + vertical section
      const armCount = Math.floor(r() * 3);
      for (let a = 0; a < armCount; a++) {
        const side = a % 2 === 0 ? -1 : 1;
        const armY = trunkH * (0.45 + r() * 0.25);
        const armH = trunkH * (0.35 + r() * 0.20);
        const conn = new THREE.Mesh(
          new THREE.CylinderGeometry(trunkR * 0.65, trunkR * 0.65, trunkR * 2.0, 8),
          cactusMat
        );
        conn.position.set(x + side * trunkR * 1.0, armY, z);
        conn.rotation.z = Math.PI / 2;
        scene.add(conn);
        const arm = new THREE.Mesh(
          new THREE.CylinderGeometry(trunkR * 0.70, trunkR * 0.78, armH, 12),
          cactusMat
        );
        arm.position.set(x + side * trunkR * 2.0, armY + armH / 2 - trunkR * 0.4, z);
        scene.add(arm);
      }
    }
    for (let i = 0; i < 22; i++) {
      const x = (r() - 0.5) * 56;
      const z = -8 - r() * 56;
      const dx = x, dz = z + 10;
      if (Math.sqrt(dx * dx + dz * dz) < 4) continue; // clear around camera (z=-10)
      placeCactus(x, z, 0.7 + r() * 0.7);
    }
  }

  // ---------- scattered rocks (foreground parallax) ----------
  {
    let s = 47;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x7a4a32, roughness: 0.95, metalness: 0.05, flatShading: true,
    });
    for (let i = 0; i < 36; i++) {
      const x = (r() - 0.5) * 46;
      const z = -8 - r() * 48;
      const dx = x, dz = z + 10;
      if (Math.sqrt(dx * dx + dz * dz) < 2) continue;
      const size = 0.30 + r() * 0.85;
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), rockMat);
      rock.position.set(x, size * 0.55, z);
      rock.rotation.set(r() * Math.PI, r() * Math.PI, r() * Math.PI);
      scene.add(rock);
    }
  }

  // ---------- distant mountain range (low silhouette under the mesas) ----------
  {
    let s = 67;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const rangeMat = new THREE.MeshStandardMaterial({
      color: 0x1c0a14, emissive: 0x12060c, emissiveIntensity: 0.25,
      roughness: 1.0, flatShading: true,
    });
    for (let i = -10; i <= 10; i++) {
      const h = 2.5 + r() * 3.5;
      const m = new THREE.Mesh(new THREE.ConeGeometry(4.5 + r() * 2.0, h, 4), rangeMat);
      m.position.set(i * 8.5 + (r() - 0.5) * 3, h / 2 - 0.2, -55 - r() * 12);
      m.rotation.y = r() * Math.PI;
      scene.add(m);
    }
  }

  // ---------- tumbleweeds rolling across the scene ----------
  {
    const tumbleMat = new THREE.MeshStandardMaterial({
      color: 0x705038, roughness: 1.0, flatShading: true,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x8a6a4a });
    for (let i = 0; i < 6; i++) {
      const size = 0.35 + Math.random() * 0.25;
      const geo = new THREE.IcosahedronGeometry(size, 1);
      const m = new THREE.Mesh(geo, tumbleMat);
      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      const x = (Math.random() - 0.5) * 30;
      const z = -10 - Math.random() * 38;
      const ground = size * 0.8;
      m.position.set(x, ground, z);
      wire.position.copy(m.position);
      m.userData.wire = wire;
      m.userData.size = size;
      m.userData.z = z;
      m.userData.ground = ground;
      m.userData.speed = 0.35 + Math.random() * 0.45;
      m.userData.hopFreq = 1.6 + Math.random() * 1.4;
      m.userData.hopPhase = Math.random() * Math.PI * 2;
      m.userData.hopHeight = size * (0.6 + Math.random() * 0.7);
      m.userData.wobblePhase = Math.random() * Math.PI * 2;
      m.userData.startX = x;
      scene.add(m);
      scene.add(wire);
      anim.tumbleweeds.push(m);
    }
  }

  // ---------- drifting dust particles ----------
  {
    const N = 200;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 0] = (Math.random() - 0.5) * 40;
      pos[i * 3 + 1] = 0.3 + Math.random() * 3.5;
      pos[i * 3 + 2] = -2 - Math.random() * 50;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xffd098, size: 0.08, sizeAttenuation: true,
      transparent: true, opacity: 0.70, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    dust.userData.basePos = pos.slice();
    scene.add(dust);
    anim.dust = dust;
  }

  // ---------- lighting: low warm sun + cool sky fill ----------
  scene.add(new THREE.HemisphereLight(0xffa070, 0x301018, 0.45));
  const sunLight = new THREE.DirectionalLight(0xffb070, 1.85);
  sunLight.position.set(8, 3, -15);
  scene.add(sunLight);
  const fillCool = new THREE.DirectionalLight(0x6e88b0, 0.22);
  fillCool.position.set(-10, 8, 6);
  scene.add(fillCool);

  function update(t) {
    if (anim.skyUniforms) anim.skyUniforms.time.value = t;

    // tumbleweeds bounce left → right across the scene and recycle
    for (const tw of anim.tumbleweeds) {
      const ud = tw.userData;
      tw.position.x += ud.speed * 0.016;

      // irregular hop: abs(sine) gives a ground bounce, modulated by a slower
      // incommensurate wave so successive hops vary in height
      const hop = Math.abs(Math.sin(t * ud.hopFreq + ud.hopPhase));
      const vary = 0.55 + 0.45 * Math.sin(t * 0.9 + ud.wobblePhase);
      tw.position.y = ud.ground + hop * ud.hopHeight * vary;
      tw.position.z = ud.z + Math.sin(t * 0.7 + ud.wobblePhase) * 0.15;

      const roll = ud.speed * 0.05;
      tw.rotation.z -= roll;
      tw.rotation.x += roll * 0.4 + hop * 0.02;
      tw.rotation.y += Math.sin(t * 1.3 + ud.hopPhase) * 0.01;

      if (tw.position.x > 22) {
        tw.position.x = -22;
        ud.z = -10 - Math.random() * 38;
        tw.position.z = ud.z;
      }
      if (ud.wire) {
        ud.wire.position.copy(tw.position);
        ud.wire.rotation.copy(tw.rotation);
      }
    }

    if (anim.dust) {
      const base = anim.dust.userData.basePos;
      const arr = anim.dust.geometry.attributes.position.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 0] = base[i + 0] + Math.sin(t * 0.30 + i) * 0.20 + t * 0.06; // gentle drift in wind direction
        arr[i + 1] = base[i + 1] + Math.sin(t * 0.22 + i * 1.5) * 0.10;
        arr[i + 2] = base[i + 2] + Math.cos(t * 0.20 + i * 0.7) * 0.18;
        // wrap around so dust doesn't blow off to infinity
        if (arr[i + 0] > 25) arr[i + 0] -= 50;
      }
      anim.dust.geometry.attributes.position.needsUpdate = true;
    }
  }

  return { scene, update };
}

function buildVolcanoScene() {
  const scene = new THREE.Scene();
  // less dense fog so the lava streams + crater glow can read
  scene.fog = new THREE.FogExp2(0x3a1408, 0.012);

  const anim = {
    skyUniforms: null,
    lavaMat: null,
    embers: null,
    embersBase: null,
    eruptParticles: null,
    eruptBase: null,
    eruptLight: null,
    spireLight: null,
    splash: null,
    splashVel: null,
    splashLife: null,
    splashLifeMax: null,
    splashLaunch: null,
    craterPulse: null,
  };

  // ---------- ash-clouded sky with red horizon glow ----------
  {
    const skyUniforms = { time: { value: 0 } };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(380, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: skyUniforms,
        vertexShader: `
          varying vec3 vWorldPos;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          varying vec3 vWorldPos;
          uniform float time;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
          }
          float fbm(vec2 p) {
            float v = 0.0, a = 0.5;
            for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.04; a *= 0.5; }
            return v;
          }
          void main() {
            vec3 dir = normalize(vWorldPos);
            float h = dir.y;
            vec3 horizonCol = vec3(0.65, 0.18, 0.06);
            vec3 lowCol     = vec3(0.30, 0.08, 0.04);
            vec3 midCol     = vec3(0.10, 0.04, 0.03);
            vec3 zenithCol  = vec3(0.02, 0.01, 0.01);
            vec3 col = horizonCol;
            col = mix(col, lowCol,    smoothstep(0.00, 0.10, h));
            col = mix(col, midCol,    smoothstep(0.10, 0.30, h));
            col = mix(col, zenithCol, smoothstep(0.30, 0.65, h));
            // drifting ash clouds in the upper half
            if (h > 0.02) {
              vec2 uv = dir.xz / max(dir.y, 0.08) * 0.40 + vec2(time * 0.010, time * 0.006);
              float c1 = fbm(uv);
              float cloud = smoothstep(0.42, 0.82, c1);
              col = mix(col, vec3(0.06, 0.03, 0.02), cloud * 0.72);
            }
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    scene.add(sky);
    anim.skyUniforms = skyUniforms;
  }

  // ---------- lava pool (huge emissive plane just below camera, animated) ----------
  {
    const lavaMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float time;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.05; a *= 0.5; }
          return v;
        }
        // bubble layer: SPARSE bubble sites with short visible windows. Most cells
        // are empty most of the time — only ~35% have an active bubble, and even
        // those are visible for ~25% of their cycle.
        float bubbleLayer(vec2 p, float t, float scale, float offset) {
          vec2 pp = p * scale + offset;
          vec2 cell = floor(pp);
          vec2 frac = fract(pp);
          // gate: only some cells host bubbles
          if (hash(cell + offset * 7.7) < 0.65) return 0.0;
          float h    = hash(cell + offset * 13.0);
          float life = 0.5 + h * 0.6;                  // 0.5..1.1 cycles/sec
          float ph   = fract(t * life + h * 23.0);     // 0..1 lifecycle phase
          // only show during the second half of the lifecycle
          if (ph < 0.55) return 0.0;
          float localPh = (ph - 0.55) / 0.45;          // 0..1 over visible portion
          vec2 ctr = vec2(0.30 + hash(cell + 1.7) * 0.40,
                          0.30 + hash(cell + 4.3) * 0.40);
          float d = length(frac - ctr);
          float radius = mix(0.04, 0.28, smoothstep(0.0, 0.7, localPh));
          float disk   = smoothstep(radius, radius * 0.5, d);
          // smooth swell + sharp pop at ~85% then quick fade
          float swell = smoothstep(0.0, 0.30, localPh);
          float fade  = smoothstep(1.0, 0.85, localPh);
          float pop   = smoothstep(0.78, 0.88, localPh) * smoothstep(0.96, 0.88, localPh);
          return disk * (swell * fade * 0.6 + pop * 1.4);
        }
        void main() {
          // fast-flowing magma drift
          vec2 uv = vUv * 12.0;
          float n  = fbm(uv + vec2(time * 0.18, time * 0.11));
          float n2 = fbm(uv * 2.3 + vec2(-time * 0.22, time * 0.14));
          // cooling crust covers maybe half the surface; the rest is glowing magma
          float crust = smoothstep(0.30, 0.65, n);
          vec3 hot     = vec3(1.20, 0.42, 0.10);
          vec3 white   = vec3(1.50, 0.95, 0.40);
          vec3 dark    = vec3(0.08,  0.025, 0.015);
          vec3 col = mix(hot, white, n2 * (1.0 - crust));
          col = mix(col, dark, crust * 0.92);
          // bright fissures cutting through the crust (narrow + brighter, but rarer)
          float fis = pow(1.0 - abs(n - 0.55), 36.0);
          col += vec3(1.4, 0.55, 0.15) * fis * 0.9;
          // BUBBLES — pop bright through the crust
          float b1 = bubbleLayer(vUv, time, 18.0, 0.0);
          float b2 = bubbleLayer(vUv, time, 32.0, 5.3);
          float b3 = bubbleLayer(vUv, time, 9.0,  17.9);   // mega-bubbles
          float bubbles = b1 * 0.5 + b2 * 0.35 + b3 * 0.8;
          // bright bubble core: orange→white as intensity peaks
          vec3 bCol = mix(vec3(1.0, 0.40, 0.08), vec3(1.6, 1.0, 0.45), smoothstep(0.4, 1.5, bubbles));
          col += bCol * bubbles;
          // hot ring around active bubbles — molten edge melting the crust away
          float ringMask = smoothstep(0.05, 0.35, bubbles) * smoothstep(1.2, 0.5, bubbles);
          col = mix(col, vec3(1.4, 0.55, 0.10), ringMask * 0.55);
          // subtle pool-wide throb, applied only to the bright channel
          float pulse = 1.0 + 0.08 * sin(time * 1.8) + 0.04 * sin(time * 5.3);
          col.r *= pulse;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const lava = new THREE.Mesh(new THREE.PlaneGeometry(220, 220, 1, 1), lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.y = -1.8;
    scene.add(lava);
    anim.lavaMat = lavaMat;
  }

  // ---------- lava splash droplets bursting up from the pool ----------
  // Each particle has its own ballistic trajectory: launched from a random
  // surface point, arcs up under "gravity", then is recycled. Additive
  // orange-white so they read as molten droplets, not just sparks.
  {
    const N = 200;
    const pos  = new Float32Array(N * 3);
    const vel  = new Float32Array(N * 3);
    const life = new Float32Array(N);
    const lifeMax = new Float32Array(N);
    function launch(i) {
      // launch from anywhere on the pool, but mostly in the foreground
      const r  = Math.sqrt(Math.random()) * 22 + 2;
      const a  = Math.random() * Math.PI * 2;
      const sx = Math.cos(a) * r;
      const sz = -10 + Math.sin(a) * r;
      pos[i * 3 + 0] = sx;
      pos[i * 3 + 1] = -1.78;
      pos[i * 3 + 2] = sz;
      // upward velocity 4-9 m/s, slight outward tilt
      const upV = 4.0 + Math.random() * 5.0;
      const outV = (Math.random() - 0.5) * 1.6;
      const sideA = Math.random() * Math.PI * 2;
      vel[i * 3 + 0] = Math.cos(sideA) * outV;
      vel[i * 3 + 1] = upV;
      vel[i * 3 + 2] = Math.sin(sideA) * outV;
      lifeMax[i] = 0.7 + Math.random() * 1.4;
      life[i] = lifeMax[i];
    }
    for (let i = 0; i < N; i++) {
      launch(i);
      // stagger initial ages so they don't all pop at the same time
      life[i] = Math.random() * lifeMax[i];
      // pre-advance position by random progress
      const prog = (lifeMax[i] - life[i]);
      pos[i * 3 + 0] += vel[i * 3 + 0] * prog;
      pos[i * 3 + 1] += vel[i * 3 + 1] * prog - 0.5 * 9.8 * prog * prog;
      pos[i * 3 + 2] += vel[i * 3 + 2] * prog;
      vel[i * 3 + 1] -= 9.8 * prog;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const splash = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xffa050, size: 0.10, sizeAttenuation: true,
      transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    scene.add(splash);
    anim.splash = splash;
    anim.splashVel = vel;
    anim.splashLife = life;
    anim.splashLifeMax = lifeMax;
    anim.splashLaunch = launch;
  }

  // ---------- dark basalt platform under the camera (so we're not standing in lava) ----------
  {
    // brighter basalt so the dim volcano lights actually read on the standard
    // material — pure ~black albedo (0x1a1414) used to render essentially
    // invisible from above.
    const basaltMat = new THREE.MeshStandardMaterial({
      color: 0x4a3328, roughness: 0.92, metalness: 0.05, flatShading: true,
      emissive: 0x2a0c04, emissiveIntensity: 0.55, // catches the lava uplight
    });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.4, 1.6, 12), basaltMat);
    disc.position.set(0, -1.0, -10);
    scene.add(disc);

    // jagged rocks around the platform edge
    let s = 19;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + r() * 0.3;
      const rad = 2.4 + r() * 1.4;
      const x = Math.cos(a) * rad;
      const z = -10 + Math.sin(a) * rad;
      const size = 0.4 + r() * 0.7;
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), basaltMat);
      rock.position.set(x, -0.35 + r() * 0.3, z);
      rock.rotation.set(r() * Math.PI, r() * Math.PI, r() * Math.PI);
      scene.add(rock);
    }
  }

  // ---------- central volcanic spire (organic vertex-displaced cone + lava flows) ----------
  // Builds a high-segment cone, then warps each vertex outward by a per-vertex
  // noise so the silhouette reads as a craggy stratovolcano rather than a
  // 7-sided party hat. Lava streams glow down the flanks.
  {
    const spireMat = new THREE.MeshStandardMaterial({
      color: 0x3a261e, roughness: 0.92, metalness: 0.05, flatShading: true,
      emissive: 0x3a1004, emissiveIntensity: 0.70, // glows from internal heat
    });
    const SPIRE_BASE_Y = -1.8;
    const SPIRE_H      = 5.6;
    const SPIRE_R      = 2.6;
    const spireGeo = new THREE.ConeGeometry(SPIRE_R, SPIRE_H, 26, 14, false);
    const sp = spireGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i), y = sp.getY(i), z = sp.getZ(i);
      // ratio from base (-H/2) to tip (+H/2)
      const tip = (y + SPIRE_H / 2) / SPIRE_H; // 0 at base, 1 at tip
      // craggy radial noise — keep tip near center, base wide and lumpy
      const ang = Math.atan2(z, x);
      const rOrig = Math.sqrt(x * x + z * z);
      const noise =
        Math.sin(ang * 6 + tip * 3) * 0.18 +
        Math.sin(ang * 13 + tip * 7) * 0.10 +
        Math.cos(ang * 3 + tip * 9) * 0.14;
      const sag = Math.sin(ang * 2 + 1.2) * 0.25 * (1 - tip);
      const rNew = rOrig * (1 + noise + sag) * (1 - tip * 0.05);
      sp.setX(i, Math.cos(ang) * rNew);
      sp.setZ(i, Math.sin(ang) * rNew);
      // sag the base, raise the shoulder, leave tip alone
      sp.setY(i, y - Math.max(0, 0.3 - tip) * 0.25 + Math.sin(ang * 4) * (1 - tip) * 0.10);
    }
    spireGeo.computeVertexNormals();
    const spire = new THREE.Mesh(spireGeo, spireMat);
    spire.position.set(0, SPIRE_BASE_Y + SPIRE_H / 2, -22);
    spire.rotation.y = 0.4;
    scene.add(spire);

    // 3 lava streams glowing down the flanks (extruded thin strips)
    // DoubleSide so we can see them no matter which side of the spire faces us
    const lavaStreamMat = new THREE.MeshBasicMaterial({
      color: 0xff8030, fog: true, side: THREE.DoubleSide,
    });
    for (let k = 0; k < 3; k++) {
      const angle = (k / 3) * Math.PI * 2 + 0.3;
      const segs = 18;
      const verts = [], idx = [];
      for (let i = 0; i <= segs; i++) {
        const tip = 1 - i / segs;            // 1 at top, 0 at base
        const y   = SPIRE_BASE_Y + tip * SPIRE_H;
        // mild wandering azimuth so the stream isn't a straight line
        const wob = Math.sin(i * 0.7 + k) * 0.10;
        const a   = angle + wob;
        const r   = SPIRE_R * (1 - tip) * 0.95;
        const x   = Math.cos(a) * r;
        const z   = -22 + Math.sin(a) * r;
        // tangent to the spire surface (perpendicular to radial direction in xz)
        const tx  = -Math.sin(a);
        const tz  =  Math.cos(a);
        const w   = 0.08 + (1 - tip) * 0.22;  // stream widens as it descends
        verts.push(x + tx * w, y, z + tz * w,
                   x - tx * w, y, z - tz * w);
      }
      for (let i = 0; i < segs; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      g.setIndex(idx);
      const stream = new THREE.Mesh(g, lavaStreamMat);
      scene.add(stream);
    }

    // glowing crater rim at the displaced tip
    const craterMat = new THREE.MeshBasicMaterial({ color: 0xffae40 });
    const crater = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.20, 10, 28), craterMat);
    crater.position.set(0, SPIRE_BASE_Y + SPIRE_H - 0.10, -22);
    crater.rotation.x = Math.PI / 2;
    scene.add(crater);

    // bright crater pool filling the ring (pulses + erupts)
    const craterPoolMat = new THREE.MeshBasicMaterial({ color: 0xffd060 });
    const craterPool = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 24),
      craterPoolMat
    );
    craterPool.rotation.x = -Math.PI / 2;
    craterPool.position.set(0, SPIRE_BASE_Y + SPIRE_H - 0.05, -22);
    scene.add(craterPool);
    anim.craterPulse = { mesh: craterPool, mat: craterPoolMat };

    const spireLight = new THREE.PointLight(0xff8030, 7, 28, 1.5);
    spireLight.position.set(0, SPIRE_BASE_Y + SPIRE_H, -22);
    scene.add(spireLight);
    anim.spireLight = spireLight;
  }

  // ---------- distant erupting volcano + plume ----------
  {
    const distantMat = new THREE.MeshStandardMaterial({
      color: 0x0c0808, roughness: 1.0, flatShading: true,
      emissive: 0x180a04, emissiveIntensity: 0.35,
    });
    // same craggy displacement trick as the central spire but at scale
    const eruptGeo = new THREE.ConeGeometry(22, 36, 36, 16, false);
    const ep = eruptGeo.attributes.position;
    for (let i = 0; i < ep.count; i++) {
      const x = ep.getX(i), y = ep.getY(i), z = ep.getZ(i);
      const tip = (y + 36 / 2) / 36;
      const ang = Math.atan2(z, x);
      const r0  = Math.sqrt(x * x + z * z);
      const n   = Math.sin(ang * 5 + tip * 3.4) * 0.20 +
                  Math.sin(ang * 11 + tip * 6) * 0.10 +
                  Math.cos(ang * 2 + tip * 8) * 0.18;
      const rN  = r0 * (1 + n);
      ep.setX(i, Math.cos(ang) * rN);
      ep.setZ(i, Math.sin(ang) * rN);
      ep.setY(i, y + Math.sin(ang * 3) * (1 - tip) * 0.8);
    }
    eruptGeo.computeVertexNormals();
    const eruptVolcano = new THREE.Mesh(eruptGeo, distantMat);
    eruptVolcano.position.set(38, -1.8 + 18, -90);
    eruptVolcano.rotation.y = 0.7;
    scene.add(eruptVolcano);

    // a long glowing lava flow streaming down the side toward the camera
    {
      const lavaFlowMat = new THREE.MeshBasicMaterial({ color: 0xff7a28, fog: true });
      const segs = 28;
      const verts = [], idx = [];
      for (let i = 0; i <= segs; i++) {
        const tip = 1 - i / segs;
        const y   = -1.8 + tip * 36;
        const wob = Math.sin(i * 0.5) * 1.6;
        const r   = 22 * (1 - tip) * 0.92;
        const ang = 0.7 + wob * 0.04; // generally toward +x
        const cx  = 38 + Math.cos(ang) * r;
        const cz  = -90 + Math.sin(ang) * r;
        const w   = 0.4 + (1 - tip) * 1.1;
        verts.push(cx - w, y, cz, cx + w, y, cz);
      }
      for (let i = 0; i < segs; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      g.setIndex(idx);
      scene.add(new THREE.Mesh(g, lavaFlowMat));
    }

    // hot crater pool at its summit
    const eruptCore = new THREE.Mesh(
      new THREE.CircleGeometry(3.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xffc060 })
    );
    eruptCore.position.set(38, -1.8 + 36, -90);
    eruptCore.rotation.x = -Math.PI / 2;
    scene.add(eruptCore);

    // strong warm light pooling at the eruption
    const eruptLight = new THREE.PointLight(0xff5020, 50, 110, 1.4);
    eruptLight.position.set(38, -1.8 + 36, -90);
    scene.add(eruptLight);
    anim.eruptLight = eruptLight;

    // ash plume (additive point cloud rising above the eruption)
    const N = 180;
    const pos = new Float32Array(N * 3);
    const base = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = Math.random() * 4.5;
      const a = Math.random() * Math.PI * 2;
      const y = Math.random() * 50;
      pos[i * 3 + 0] = 38 + Math.cos(a) * r * (1 + y * 0.08);
      pos[i * 3 + 1] = -1.8 + 36 + y;
      pos[i * 3 + 2] = -90 + Math.sin(a) * r * (1 + y * 0.08);
      base[i * 3 + 0] = pos[i * 3 + 0];
      base[i * 3 + 1] = pos[i * 3 + 1];
      base[i * 3 + 2] = pos[i * 3 + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const plume = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xff8040, size: 1.2, sizeAttenuation: true,
      transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    scene.add(plume);
    anim.eruptParticles = plume;
    anim.eruptBase = base;
  }

  // ---------- distant volcanic ridges (smooth rolling silhouette + emissive lava cracks) ----------
  // Two overlapping curved silhouette bands replace the obvious row of 5-sided
  // cones. The top edge is a 1D fbm profile so the horizon reads as broken
  // volcanic terrain rather than party hats. Bottom of the closer band glows
  // faintly so the silhouette ties into the lava pool light.
  {
    function hashX(x, seed) {
      const v = Math.sin(x * 127.1 + seed * 311.7) * 43758.5453;
      return v - Math.floor(v);
    }
    function noise1(x, seed) {
      const ix = Math.floor(x);
      const fx = x - ix;
      const a = hashX(ix, seed), b = hashX(ix + 1, seed);
      const u = fx * fx * (3 - 2 * fx);
      return a + (b - a) * u;
    }
    function ridgeProfile(x, seed) {
      let v = 0, amp = 0.5, f = 1.0;
      for (let i = 0; i < 4; i++) {
        v += amp * noise1(x * 0.08 * f + seed, seed * 1.7 + i);
        f *= 2.05;
        amp *= 0.55;
      }
      return v;
    }
    function buildRidgeBand(z, peakH, breadth, segs, topColor, baseColor, seed) {
      const verts = [], cols = [], idx = [];
      for (let i = 0; i <= segs; i++) {
        const x = -breadth / 2 + (i / segs) * breadth;
        const top = -1.8 + peakH * (0.40 + ridgeProfile(x, seed) * 1.0);
        verts.push(x, top, z);
        verts.push(x, -1.8, z);
        cols.push(topColor[0], topColor[1], topColor[2]);
        cols.push(baseColor[0], baseColor[1], baseColor[2]);
      }
      for (let i = 0; i < segs; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 3);
        idx.push(a, a + 3, a + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cols), 3));
      g.setIndex(idx);
      return new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, fog: true,
      }));
    }
    // far band — almost flat, dark, fading into ash
    scene.add(buildRidgeBand(-90, 12, 480, 90,
      [0.04, 0.02, 0.02], [0.10, 0.04, 0.03], 17));
    // middle band — taller, with a hint of warm lava glow at the base
    scene.add(buildRidgeBand(-65, 16, 360, 80,
      [0.05, 0.025, 0.020], [0.32, 0.10, 0.05], 41));
  }

  // ---------- rising ember particles (additive orange) ----------
  {
    const N = 260;
    const pos = new Float32Array(N * 3);
    const base = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 0] = (Math.random() - 0.5) * 36;
      pos[i * 3 + 1] = -1.5 + Math.random() * 14;
      pos[i * 3 + 2] = -10 + (Math.random() - 0.5) * 40;
      base[i * 3 + 0] = pos[i * 3 + 0];
      base[i * 3 + 1] = pos[i * 3 + 1];
      base[i * 3 + 2] = pos[i * 3 + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const embers = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xff8030, size: 0.12, sizeAttenuation: true,
      transparent: true, opacity: 0.90, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    scene.add(embers);
    anim.embers = embers;
    anim.embersBase = base;
  }

  // ---------- lighting: warm orange uplight from the lava + minimal ambient ----------
  scene.add(new THREE.AmbientLight(0x2a1208, 0.55));
  // hemisphere: smoky red overhead, fierce orange from below (the lava pool)
  scene.add(new THREE.HemisphereLight(0x802018, 0xff6020, 1.10));
  // local uplight near the camera so the platform/rocks read warm
  const localUplight = new THREE.PointLight(0xff7028, 5.0, 18, 1.6);
  localUplight.position.set(0, -1.0, -10);
  scene.add(localUplight);
  // a second uplight further out so the foreground rocks have a sharper key
  const fwdUplight = new THREE.PointLight(0xff8038, 4.0, 22, 1.6);
  fwdUplight.position.set(0, -1.4, -20);
  scene.add(fwdUplight);

  function update(t) {
    if (anim.skyUniforms) anim.skyUniforms.time.value = t;
    if (anim.lavaMat) anim.lavaMat.uniforms.time.value = t;

    // spire and eruption flicker subtly
    if (anim.spireLight) {
      // violent flicker baseline + sharp eruption spikes every ~3-5 s
      const burst = Math.max(0.0, Math.sin(t * 0.6) + Math.sin(t * 0.91 + 1.3) - 1.4) * 8.0;
      anim.spireLight.intensity = 6.0 + Math.sin(t * 5.5) * 1.8 + Math.sin(t * 13.0) * 1.0 + burst;
    }
    // crater pool throbs in lockstep with the spire light + scales on eruption
    if (anim.craterPulse) {
      const burst = Math.max(0.0, Math.sin(t * 0.6) + Math.sin(t * 0.91 + 1.3) - 1.4);
      const k = 1.0 + Math.sin(t * 5.5) * 0.15 + burst * 0.9;
      anim.craterPulse.mesh.scale.setScalar(k);
      const bright = 0.85 + Math.sin(t * 5.5) * 0.10 + burst * 0.6;
      anim.craterPulse.mat.color.setRGB(1.0 * bright, 0.82 * bright, 0.38 * bright);
    }
    if (anim.eruptLight) anim.eruptLight.intensity = 50 + Math.sin(t * 1.8) * 8 + Math.sin(t * 5.4) * 4;

    // embers rise from the lava + flicker laterally, recycle at the top
    if (anim.embers) {
      const arr = anim.embers.geometry.attributes.position.array;
      const base = anim.embersBase;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1] += 0.85 * 0.016;
        arr[i + 0] = base[i + 0] + Math.sin(t * 1.2 + i) * 0.30;
        arr[i + 2] = base[i + 2] + Math.cos(t * 1.0 + i * 0.7) * 0.22;
        if (arr[i + 1] > 14) {
          arr[i + 1] = -1.5;
          arr[i + 0] = (Math.random() - 0.5) * 36;
          arr[i + 2] = -10 + (Math.random() - 0.5) * 40;
          base[i + 0] = arr[i + 0];
          base[i + 2] = arr[i + 2];
        }
      }
      anim.embers.geometry.attributes.position.needsUpdate = true;
    }

    // lava splash droplets — ballistic; gravity pulls them back into the pool
    if (anim.splash) {
      const arr = anim.splash.geometry.attributes.position.array;
      const vel = anim.splashVel;
      const life = anim.splashLife;
      const lifeMax = anim.splashLifeMax;
      const dt = 0.016;
      const N = life.length;
      for (let i = 0; i < N; i++) {
        life[i] -= dt;
        if (life[i] <= 0 || arr[i * 3 + 1] < -1.78) {
          anim.splashLaunch(i);
          continue;
        }
        arr[i * 3 + 0] += vel[i * 3 + 0] * dt;
        arr[i * 3 + 1] += vel[i * 3 + 1] * dt;
        arr[i * 3 + 2] += vel[i * 3 + 2] * dt;
        vel[i * 3 + 1] -= 9.8 * dt;
      }
      anim.splash.geometry.attributes.position.needsUpdate = true;
    }

    // distant eruption plume churns upward and outward
    if (anim.eruptParticles) {
      const arr = anim.eruptParticles.geometry.attributes.position.array;
      const base = anim.eruptBase;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1] += 0.45 * 0.016;
        arr[i + 0] = base[i + 0] + Math.sin(t * 0.6 + i) * 0.50;
        arr[i + 2] = base[i + 2] + Math.cos(t * 0.5 + i * 0.6) * 0.50;
        if (arr[i + 1] > -1.8 + 36 + 55) {
          const r = Math.random() * 4.5;
          const a = Math.random() * Math.PI * 2;
          arr[i + 0] = 38 + Math.cos(a) * r;
          arr[i + 1] = -1.8 + 36;
          arr[i + 2] = -90 + Math.sin(a) * r;
          base[i + 0] = arr[i + 0];
          base[i + 1] = arr[i + 1];
          base[i + 2] = arr[i + 2];
        }
      }
      anim.eruptParticles.geometry.attributes.position.needsUpdate = true;
    }
  }

  return { scene, update };
}

function buildCityScene() {
  // Rain-washed midnight metropolis: a broad avenue canyon graded teal/amber
  // with one rose accent. Facades are shader-lit (tiny clustered windows, fog
  // baked in), the street is wet asphalt with lamp-anchored reflections, and
  // life comes from ground traffic, two monorail lines, steam, and rain.
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0d1624, 0.007);

  const anim = {
    skyU: null, streetU: null,
    facadeMats: [],
    spireU: null, beaconCore: null, beaconGlow: null,
    panelMats: [],
    flickerSigns: [],
    trains: [],
    traffic: null,
    aircraft: null,
    blinkers: null,
    holoA: null, holoB: null,
    steam: null, steamAges: null, steamOrigins: null,
    rain: null, rainSpeed: null,
    shelterAd: null,
  };

  // Shared GLSL: hash/noise + the exponential fog every custom shader applies
  // manually (ShaderMaterial ignores scene.fog, which is why the old scene's
  // skyline never faded with distance).
  const NOISE_GLSL = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float a = hash(i), b = hash(i + vec2(1,0)), c = hash(i + vec2(0,1)), d = hash(i + vec2(1,1));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }`;
  const FOG_GLSL = `
    const vec3 FOGC = vec3(0.051, 0.086, 0.141);
    float fogAmt(vec3 wp) {
      float d = distance(wp, cameraPosition);
      return 1.0 - exp(-4.9e-5 * d * d);
    }`;
  const WP_VERT = `
    varying vec3 vWP;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWP = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

  // ============ SKY — gradient night, low cloud deck lit by the city, moon ============
  {
    const skyU = { time: { value: 0 } };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(420, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, uniforms: skyU,
        vertexShader: WP_VERT,
        fragmentShader: `
          varying vec3 vWP;
          uniform float time;
          ${NOISE_GLSL}
          float fbm(vec2 p) {
            float v = 0.0, a = 0.5;
            for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
            return v;
          }
          void main() {
            vec3 dir = normalize(vWP);
            float h = dir.y;
            float ang = atan(dir.z, dir.x);

            vec3 zen = vec3(0.010, 0.020, 0.042);
            vec3 mid = vec3(0.034, 0.058, 0.100);
            vec3 hor = vec3(0.066, 0.098, 0.150);
            vec3 col = mix(hor, mid, smoothstep(0.0, 0.22, h));
            col = mix(col, zen, smoothstep(0.18, 0.70, h));

            // city light pollution hugging the horizon — amber with teal seams
            float glow = pow(1.0 - clamp(abs(h) * 1.45, 0.0, 1.0), 5.0);
            vec3 glowC = mix(vec3(1.0, 0.56, 0.28), vec3(0.30, 0.72, 0.76), 0.5 + 0.5 * sin(ang * 2.0 + 1.3));
            col += glowC * glow * 0.22;
            float fwd = pow(max(0.0, -dir.z), 3.0) * pow(1.0 - clamp(abs(h) * 1.8, 0.0, 1.0), 3.0);
            col += vec3(0.95, 0.55, 0.42) * fwd * 0.18;

            // drifting low cloud deck, underlit near the horizon
            vec2 cuv = dir.xz / (abs(h) + 0.20);
            float cl = fbm(cuv * 0.38 + vec2(time * 0.006, time * 0.0023));
            float cloudAmt = smoothstep(0.42, 0.72, cl) * smoothstep(0.62, 0.16, h) * step(0.0, h);
            vec3 cloudC = mix(vec3(0.075, 0.085, 0.115), vec3(0.30, 0.19, 0.13), pow(1.0 - clamp(h * 2.2, 0.0, 1.0), 2.0));
            col = mix(col, cloudC, cloudAmt * 0.95);

            // stars above the deck, gentle twinkle
            float st = hash(floor(dir.xz * 260.0) + floor(dir.y * 130.0));
            float stars = step(0.9966, st) * smoothstep(0.30, 0.75, h) * (1.0 - cloudAmt);
            col += vec3(0.80, 0.85, 1.0) * stars * (0.45 + 0.40 * sin(time * 1.7 + st * 40.0));

            // moon — soft disc with a wide cool halo, dimmed through cloud
            vec3 moonDir = normalize(vec3(0.34, 0.46, -0.62));
            float md = dot(dir, moonDir);
            float disc = smoothstep(0.99955, 0.99985, md);
            float halo = pow(smoothstep(0.9860, 1.0, md), 2.2);
            float thin = 1.0 - cloudAmt * 0.85;
            col += vec3(0.92, 0.94, 1.0) * disc * 0.85 * thin;
            col += vec3(0.55, 0.68, 0.88) * halo * 0.22 * thin;

            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    );
    scene.add(sky);
    anim.skyU = skyU;
  }

  // ============ STREET — wet asphalt, anchored lamp reflections, rain rings ============
  {
    const streetU = { time: { value: 0 } };
    const street = new THREE.Mesh(
      new THREE.PlaneGeometry(420, 460),
      new THREE.ShaderMaterial({
        uniforms: streetU,
        vertexShader: WP_VERT,
        fragmentShader: `
          varying vec3 vWP;
          uniform float time;
          ${NOISE_GLSL}
          ${FOG_GLSL}
          void main() {
            vec2 p = vWP.xz;
            float ax = abs(p.x);
            float gr = noise(p * 6.0);

            vec3 col = vec3(0.026, 0.030, 0.042) * (0.80 + 0.50 * gr);
            // tyre-polished tracks per lane
            float wheel = exp(-pow((ax - 0.6) / 0.40, 2.0)) + exp(-pow((ax - 2.0) / 0.45, 2.0))
                        + exp(-pow((ax - 2.9) / 0.45, 2.0)) + exp(-pow((ax - 4.2) / 0.40, 2.0));
            col *= 1.0 - 0.25 * clamp(wheel, 0.0, 1.0) * step(ax, 5.0);

            // worn paint: edge lines, lane dashes, centre line, crosswalk
            float wear = 0.45 + 0.40 * noise(p * vec2(0.7, 0.25));
            vec3 paint = vec3(0.75, 0.72, 0.62);
            float laneEdge = exp(-pow((ax - 4.80) / 0.05, 2.0));
            float dashes   = exp(-pow((ax - 2.45) / 0.045, 2.0)) * step(0.55, fract(p.y * 0.12 + 0.3));
            float ctr      = exp(-pow(ax / 0.05, 2.0));
            col += paint * (laneEdge * 0.45 + dashes * 0.50 + ctr * 0.30) * wear * step(ax, 5.0);
            float cw = step(abs(p.y + 9.0), 1.4) * step(0.42, fract(p.x * 0.62 + 0.31)) * step(ax, 4.7);
            col += paint * cw * 0.26 * wear;

            // sidewalk with paving joints + painted curb
            float sw = step(5.15, ax) * step(ax, 7.7);
            vec3 pave = vec3(0.040, 0.046, 0.058) * (0.75 + 0.50 * noise(p * 3.0));
            float joints = max(step(0.93, fract(p.y * 0.55)), step(0.96, fract(ax * 0.9)));
            pave *= 1.0 - 0.35 * joints;
            col = mix(col, pave, sw);
            col += vec3(0.30) * exp(-pow((ax - 5.05) / 0.06, 2.0)) * 0.5 * wear;
            col = mix(col, vec3(0.016, 0.019, 0.028), step(7.7, ax));

            // wet sheen: puddle distribution gates every reflection
            float wet = 0.55 + 0.45 * smoothstep(0.35, 0.80, noise(p * 0.22 + vec2(0.0, time * 0.01)));
            float shimmer = 0.55 + 0.45 * noise(vec2(p.x * 7.0, p.y * 1.6 - time * 0.5));

            // amber streaks under each street lamp (lamps at x=±4.85, z=-2-9.5k)
            float kz = clamp(floor((-p.y - 2.0) / 9.5 + 0.5), 0.0, 9.0);
            float lz = -2.0 - 9.5 * kz;
            float szz = exp(-pow((p.y - lz) / 3.4, 2.0));
            float sxl = exp(-pow((p.x + 4.85) / 0.34, 2.0));
            float sxr = exp(-pow((p.x - 4.85) / 0.34, 2.0));
            col += vec3(1.0, 0.62, 0.30) * (sxl + sxr) * szz * wet * shimmer * 0.65;
            // soft amber pool on the tarmac around each lamp
            float pool = exp(-pow((p.y - lz), 2.0) / 16.0 - pow(abs(p.x) - 4.85, 2.0) / 4.0);
            col += vec3(1.0, 0.66, 0.34) * pool * 0.10;

            // warm storefront wash across the sidewalks
            float washz = step(p.y, 16.0) * step(-104.0, p.y);
            float wash = exp(-pow((ax - 6.6) / 1.7, 2.0)) * washz;
            col += vec3(1.0, 0.66, 0.38) * wash * wet * 0.14 * (0.8 + 0.2 * noise(vec2(p.y * 0.5, time * 0.2)));

            // the spire's light column smeared down the centre of the avenue
            float spz = smoothstep(-25.0, -100.0, p.y);
            float spx = exp(-p.x * p.x * 0.06);
            vec3 spc = mix(vec3(0.35, 0.95, 0.88), vec3(1.0, 0.36, 0.55), 0.5 + 0.5 * sin(time * 0.25));
            col += spc * spz * spx * wet * shimmer * 0.10;

            // cool skylight sheen everywhere wet
            col += vec3(0.06, 0.10, 0.16) * wet * 0.06;

            // scattered glints of window light caught in the puddles — near field only
            float near = (1.0 - smoothstep(12.0, 36.0, distance(vWP, cameraPosition))) * step(ax, 9.0);
            float gl1 = pow(noise(p * 4.2 + 3.7), 22.0);
            float gl2 = pow(noise(p * 5.4 + 9.1), 22.0);
            col += vec3(1.0, 0.74, 0.46) * gl1 * wet * near * 0.55;
            col += vec3(0.55, 0.74, 0.95) * gl2 * wet * near * 0.28;

            // rain impact rings
            vec2 rc = floor(p * 0.85);
            vec2 rf = fract(p * 0.85) - 0.5;
            float rt = fract(time * 0.8 + hash(rc) * 9.0);
            float ring = smoothstep(0.045, 0.0, abs(length(rf) - rt * 0.42)) * (1.0 - rt) * step(hash(rc + 7.7), 0.45);
            col += vec3(0.55, 0.70, 0.85) * ring * 0.08;

            col = mix(col, FOGC, fogAmt(vWP));
            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    );
    street.rotation.x = -Math.PI / 2;
    street.position.z = -60;
    scene.add(street);
    anim.streetU = streetU;
  }

  // ============ FACADES — world-space window grid, clustered floors, baked fog ============
  function makeFacadeMat(seed, hgt, shop, parapet, accentHex) {
    return new THREE.ShaderMaterial({
      uniforms: {
        time:    { value: 0 },
        seed:    { value: seed },
        hgt:     { value: hgt },
        shop:    { value: shop },
        parapet: { value: parapet },
        accent:  { value: new THREE.Color(accentHex) },
      },
      vertexShader: `
        varying vec3 vWP;
        varying vec3 vN;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWP = wp.xyz;
          vN = mat3(modelMatrix) * normal;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        varying vec3 vWP;
        varying vec3 vN;
        uniform float time, seed, hgt, shop, parapet;
        uniform vec3 accent;
        ${NOISE_GLSL}
        ${FOG_GLSL}
        void main() {
          vec3 n = normalize(vN);
          float fogA = fogAmt(vWP);
          if (abs(n.y) > 0.5) {
            vec3 roof = vec3(0.018, 0.022, 0.032) * (0.7 + 0.6 * hash(floor(vWP.xz * 2.0) + seed));
            gl_FragColor = vec4(mix(roof, FOGC, fogA), 1.0);
            return;
          }
          float u = ((abs(n.x) > abs(n.z)) ? vWP.z : vWP.x) + seed * 7.31;
          float v = vWP.y;

          // per-tower character: grid pitch, lit density, masonry warmth
          float colW = 0.40 + 0.16 * fract(seed * 0.731);
          float rowH = 0.52 + 0.14 * fract(seed * 0.413);
          float litMul = 0.5 + 1.0 * fract(seed * 0.177);
          float warmth = fract(seed * 0.519);
          vec2 cell = floor(vec2(u / colW, v / rowH));
          vec2 fc   = fract(vec2(u / colW, v / rowH));
          float pane = step(0.16, fc.x) * step(fc.x, 0.86) * step(0.18, fc.y) * step(fc.y, 0.78);

          float mull = 0.018 + 0.008 * hash(cell + seed + 31.0);
          vec3 col = mix(vec3(mull * 0.9, mull, mull * 1.3), vec3(mull * 1.4, mull * 1.1, mull * 0.85), warmth);

          // unlit glass — cold, brightening toward the sky it reflects
          float skyRef = smoothstep(0.0, max(hgt, 1.0), v);
          vec3 glass = vec3(0.018, 0.027, 0.048) + vec3(0.012, 0.022, 0.038) * skyRef;
          col = mix(col, glass, pane);

          // lit windows cluster by floor: dark floors vs busy floors
          float floorAct = hash(vec2(cell.y, seed * 3.7));
          float litP = (floorAct < 0.42) ? 0.04 : mix(0.18, 0.62, hash(vec2(cell.y, seed + 9.0)));
          litP = clamp(litP * litMul, 0.0, 0.85);
          float lit = step(1.0 - litP, hash(cell + seed));
          float ctp = hash(cell + seed + 11.0);
          vec3 winC = (ctp < 0.60) ? vec3(1.0, 0.76, 0.48)
                    : (ctp < 0.90) ? vec3(0.70, 0.84, 1.0)
                                   : vec3(0.55, 0.92, 0.82);
          float br = 0.50 + 0.90 * hash(cell + seed + 5.0);
          br *= 0.93 + 0.07 * sin(time * (0.25 + 0.5 * hash(cell + seed + 2.0)) + 6.28 * hash(cell + seed + 3.0));
          float hasBlind = step(0.72, hash(cell + seed + 13.0));
          float blindH = mix(0.40, 0.72, hash(cell + seed + 17.0));
          br *= mix(1.0, 0.22, hasBlind * step(blindH, fc.y));
          col = mix(col, winC * br, pane * lit);

          if (shop > 0.5) {
            // street level: individual bays — shuttered, dim, bright, rare teal
            float bay = floor(u / 2.4);
            float bu = fract(u / 2.4);
            float roll = hash(vec2(bay, seed + 71.0));
            float open = step(0.40, roll);
            vec3 shopC = (roll < 0.62) ? vec3(1.0, 0.72, 0.42) * 0.40
                       : (roll < 0.86) ? vec3(1.0, 0.66, 0.36) * 0.80
                                       : vec3(0.50, 0.88, 0.80) * 0.45;
            float band = step(0.12, v) * step(v, 2.9);
            float sPane = step(0.06, bu) * step(bu, 0.94) * step(0.45, v) * step(v, 2.55);
            // shopfront mullions + transom split the glass into door/window panes
            sPane *= step(0.10, fract(bu * 3.0)) * step(0.06, fract(v * 0.55 + 0.2));
            // interiors fade toward the ceiling
            float depth = 1.0 - 0.55 * smoothstep(0.9, 2.4, v);
            col = mix(col, vec3(0.012, 0.013, 0.018), band);
            col = mix(col, shopC * depth * (0.6 + 0.4 * noise(vec2(bu * 9.0, v * 2.0))), band * sPane * open);
            col += vec3(0.020) * band * (1.0 - open) * (0.5 + 0.5 * sin(v * 40.0));
            float strip = step(2.62, v) * step(v, 2.86) * step(0.10, bu) * step(bu, 0.90);
            col += vec3(1.0, 0.62, 0.30) * strip * open * (0.6 + 0.4 * hash(vec2(bay, seed)));
            col = mix(col, vec3(0.010, 0.010, 0.014), step(2.9, v) * step(v, 3.06));
          }
          col *= 0.45 + 0.55 * smoothstep(0.0, 0.9, v);
          col += accent * parapet * smoothstep(hgt - 0.30, hgt - 0.16, v) * smoothstep(hgt, hgt - 0.05, v) * 0.9;

          gl_FragColor = vec4(mix(col, FOGC, fogA), 1.0);
        }`,
    });
  }

  // distant towers share one cheap world-grid material — fog does the talking
  const farMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vWP;
      varying vec3 vN;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        vN = mat3(modelMatrix) * normal;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying vec3 vWP;
      varying vec3 vN;
      ${NOISE_GLSL}
      ${FOG_GLSL}
      void main() {
        vec3 n = normalize(vN);
        float fogA = fogAmt(vWP);
        if (abs(n.y) > 0.5) {
          gl_FragColor = vec4(mix(vec3(0.016, 0.020, 0.030), FOGC, fogA), 1.0);
          return;
        }
        float u = (abs(n.x) > abs(n.z)) ? vWP.z : vWP.x;
        float v = vWP.y;
        vec2 cell = floor(vec2(u / 0.46, v / 0.60));
        vec2 fc   = fract(vec2(u / 0.46, v / 0.60));
        float pane = step(0.20, fc.x) * step(fc.x, 0.82) * step(0.22, fc.y) * step(fc.y, 0.74);
        vec3 col = vec3(0.014, 0.018, 0.030);
        float lit = step(0.84, hash(cell));
        vec3 winC = mix(vec3(1.0, 0.76, 0.48), vec3(0.70, 0.84, 1.0), step(0.62, hash(cell + 11.0)));
        col = mix(col, winC * (0.35 + 0.55 * hash(cell + 5.0)), pane * lit);
        col *= 0.5 + 0.5 * smoothstep(0.0, 6.0, v);
        gl_FragColor = vec4(mix(col, FOGC, fogA), 1.0);
      }`,
  });

  const capMat = new THREE.MeshStandardMaterial({ color: 0x070910, roughness: 0.55, metalness: 0.6 });
  const clutterMat = new THREE.MeshStandardMaterial({ color: 0x0b0e16, roughness: 0.7, metalness: 0.4 });
  const ACCENTS = [0x46e0d4, 0xff5e8a, 0xffb46b];
  const blinkerData = [];

  {
    let s = 17;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);

    function tower(cx, cz, w, d, h, opts = {}) {
      let tiers;
      if (opts.tiered && h > 28) {
        tiers = [
          { w, d, y0: 0, th: h * 0.55 },
          { w: w * 0.80, d: d * 0.80, y0: h * 0.55, th: h * 0.30 },
          { w: w * 0.60, d: d * 0.60, y0: h * 0.85, th: h * 0.15 },
        ];
      } else {
        tiers = [{ w, d, y0: 0, th: h }];
      }
      let mat;
      if (opts.far) {
        mat = farMat;
      } else {
        const seed = r() * 100;
        const accent = ACCENTS[Math.floor(r() * ACCENTS.length)];
        const parapet = r() > 0.62 ? 1 : 0;
        mat = makeFacadeMat(seed, h, opts.shop ? 1 : 0, parapet, accent);
        anim.facadeMats.push(mat);
      }
      for (const tr of tiers) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(tr.w, tr.th, tr.d), mat);
        m.position.set(cx, tr.y0 + tr.th / 2, cz);
        scene.add(m);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(tr.w * 1.03, 0.18, tr.d * 1.03), capMat);
        cap.position.set(cx, tr.y0 + tr.th + 0.07, cz);
        scene.add(cap);
      }
      if (opts.clutter) {
        const top = tiers[tiers.length - 1];
        const tx = cx + (r() - 0.5) * top.w * 0.4;
        const tz = cz + (r() - 0.5) * top.d * 0.4;
        if (r() > 0.5) {
          const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.50, 0.55, 1.0, 10), clutterMat);
          tank.position.set(tx, h + 0.66, tz);
          scene.add(tank);
          const lid = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.30, 10), clutterMat);
          lid.position.set(tx, h + 1.30, tz);
          scene.add(lid);
        } else {
          const ac = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.7), clutterMat);
          ac.position.set(tx, h + 0.41, tz);
          scene.add(ac);
        }
        if (h > 26 && r() > 0.45) {
          const ah = 1.6 + r() * 3.0;
          const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, ah, 6), clutterMat);
          const axp = cx + (r() - 0.5) * top.w * 0.5;
          const azp = cz + (r() - 0.5) * top.d * 0.5;
          ant.position.set(axp, h + ah / 2 + 0.16, azp);
          scene.add(ant);
          blinkerData.push({ x: axp, y: h + ah + 0.22, z: azp, phase: r() * Math.PI * 2 });
        }
      }
    }

    // canyon flanks lining the avenue (extends behind the camera);
    // two slots are skipped to open lantern-lit alleys into the block
    const alleys = [];
    for (let i = -2; i < 20; i++) {
      const z = 14 - i * 5.9;
      for (const side of [-1, 1]) {
        if ((side < 0 && i === 6) || (side > 0 && i === 11)) {
          alleys.push({ side, z });
          continue;
        }
        const w = 4.5 + r() * 2.6;
        const d = 4.6 + r() * 2.0;
        const h = (r() < 0.14) ? 8 + r() * 6 : 15 + r() * 30;
        const x = side * (7.7 + w / 2 + r() * 1.6);
        tower(x, z, w, d, h, { shop: true, clutter: z > -70, tiered: r() > 0.72 });
      }
    }
    for (const al of alleys) {
      for (let k = 0; k < 5; k++) {
        const lx = al.side * (9.0 + k * 2.6);
        const ly = 3.0 + Math.sin(k * 1.7) * 0.4;
        const lamp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: SOFT_PARTICLE_TEX, color: 0xffb46b, transparent: true,
          opacity: 0.40 - k * 0.05, blending: THREE.AdditiveBlending,
          depthWrite: false, fog: false,
        }));
        lamp.position.set(lx, ly, al.z + (k % 2 ? 0.8 : -0.8));
        lamp.scale.set(0.9, 0.9, 1);
        scene.add(lamp);
      }
    }
    // second row poking between gaps
    for (let i = -1; i < 14; i++) {
      const z = 8 - i * 8.3;
      for (const side of [-1, 1]) {
        const w = 5 + r() * 3;
        const h = 28 + r() * 36;
        const x = side * (15.5 + r() * 5.5);
        tower(x, z, w, 5 + r() * 3, h, { clutter: z > -50, tiered: r() > 0.6 });
      }
    }
    // third-row silhouettes filling the side horizon
    for (let i = 0; i < 12; i++) {
      const z = 6 - i * 9.0;
      for (const side of [-1, 1]) {
        tower(side * (27 + r() * 9), z, 5 + r() * 4, 5 + r() * 4, 26 + r() * 34, { far: true });
      }
    }
    // downtown cluster around the spire
    for (let i = 0; i < 18; i++) {
      const x = (r() - 0.5) * 100;
      if (Math.abs(x) < 8) continue;
      const z = -104 - r() * 48;
      tower(x, z, 6 + r() * 6, 6 + r() * 5, 34 + r() * 52, { far: true });
    }
  }

  // ============ HERO SPIRE — slender diamond tower at the vanishing point ============
  {
    const spireU = { time: { value: 0 } };
    const geo = new THREE.CylinderGeometry(3.0, 6.2, 122, 4, 1);
    const spire = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: spireU,
        vertexShader: `
          varying vec3 vWP;
          varying vec3 vLocal;
          void main() {
            vLocal = position;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWP = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          varying vec3 vWP;
          varying vec3 vLocal;
          uniform float time;
          ${NOISE_GLSL}
          ${FOG_GLSL}
          void main() {
            float ang = atan(vLocal.x, vLocal.z);
            float v = vLocal.y + 61.0;
            vec3 col = vec3(0.014, 0.022, 0.040);

            // sparse cool windows
            vec2 cell = floor(vec2(ang * 9.0, v / 0.6));
            vec2 fc   = fract(vec2(ang * 9.0, v / 0.6));
            float pane = step(0.2, fc.x) * step(fc.x, 0.8) * step(0.2, fc.y) * step(fc.y, 0.75);
            float lit = step(0.76, hash(cell + 4.2));
            col = mix(col, vec3(0.66, 0.82, 1.0) * (0.45 + 0.55 * hash(cell)), pane * lit);

            // corner light seams, teal at the base shading to rose at the crown
            float seam = pow(abs(cos(2.0 * ang)), 40.0);
            vec3 seamC = mix(vec3(0.30, 0.92, 0.85), vec3(1.0, 0.36, 0.55), smoothstep(0.0, 122.0, v));
            col += seamC * seam * (1.10 + 0.30 * sin(time * 0.8 + v * 0.08));

            // a quiet scanner band rising the full height
            float sc = fract(v / 122.0 - time * 0.03);
            col += seamC * smoothstep(0.045, 0.0, abs(sc - 0.5)) * 0.55;

            gl_FragColor = vec4(mix(col, FOGC, fogAmt(vWP)), 1.0);
          }`,
      })
    );
    spire.position.set(0, 61, -128);
    scene.add(spire);
    anim.spireU = spireU;

    const crown = new THREE.Mesh(
      new THREE.TorusGeometry(3.6, 0.10, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0x46e0d4, transparent: true, opacity: 0.85, fog: false })
    );
    crown.position.set(0, 118, -128);
    crown.rotation.x = Math.PI / 2;
    scene.add(crown);

    const beaconCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xff5e8a, fog: false })
    );
    beaconCore.position.set(0, 123.5, -128);
    scene.add(beaconCore);
    const beaconGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: SOFT_PARTICLE_TEX, color: 0xff5e8a, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    beaconGlow.position.set(0, 123.5, -128);
    beaconGlow.scale.set(7, 7, 1);
    scene.add(beaconGlow);
    anim.beaconCore = beaconCore;
    anim.beaconGlow = beaconGlow;
  }

  // ============ STREET LAMPS — amber sodium, glow sprites, rain cones ============
  {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x080a10, roughness: 0.5, metalness: 0.8 });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffc27a });
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xffb46b, transparent: true, opacity: 0.06,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    const coneGeo = new THREE.ConeGeometry(1.5, 5.2, 20, 1, true);
    coneGeo.translate(0, -2.6, 0);
    for (let i = 0; i < 10; i++) {
      const z = -2 - i * 9.5;
      for (const side of [-1, 1]) {
        const px = side * 5.55;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 5.8, 8), poleMat);
        pole.position.set(px, 2.9, z);
        scene.add(pole);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.07, 0.07), poleMat);
        arm.position.set(px - side * 0.5, 5.68, z);
        scene.add(arm);
        const hx = side * 4.85;
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.10, 0.18), poleMat);
        head.position.set(hx, 5.62, z);
        scene.add(head);
        const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.04, 0.12), bulbMat);
        bulb.position.set(hx, 5.55, z);
        scene.add(bulb);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: SOFT_PARTICLE_TEX, color: 0xffb46b, transparent: true, opacity: 0.38,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        }));
        glow.position.set(hx, 5.55, z);
        glow.scale.set(1.7, 1.7, 1);
        scene.add(glow);
        if (i < 5) {
          const cone = new THREE.Mesh(coneGeo, coneMat);
          cone.position.set(hx, 5.55, z);
          scene.add(cone);
        }
      }
    }
    for (let i = 0; i < 4; i++) {
      const z = -2 - i * 9.5;
      const left = new THREE.PointLight(0xffb46b, 2.4, 10, 1.8);
      left.position.set(-4.85, 5.4, z);
      scene.add(left);
      const right = new THREE.PointLight(0xffb46b, 2.4, 10, 1.8);
      right.position.set(4.85, 5.4, z);
      scene.add(right);
    }
  }

  // ============ NEAR-FIELD STREET FURNITURE — bollards + bus shelter ============
  {
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.5, metalness: 0.7 });
    const bollardGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.85, 10);
    const ringGeo = new THREE.CylinderGeometry(0.072, 0.072, 0.035, 10);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffb46b });
    for (let i = 0; i < 4; i++) {
      const z = -4 - i * 6;
      for (const side of [-1, 1]) {
        const b = new THREE.Mesh(bollardGeo, darkMat);
        b.position.set(side * 5.35, 0.43, z);
        scene.add(b);
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(side * 5.35, 0.78, z);
        scene.add(ring);
      }
    }

    const sx = 6.5, sz = -24;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.06, 3.4), darkMat);
    roof.position.set(sx, 2.5, sz);
    scene.add(roof);
    for (const dz of [-1.55, 1.55]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.5, 8), darkMat);
      post.position.set(sx + 0.45, 1.25, sz + dz);
      scene.add(post);
    }
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(3.3, 2.2),
      new THREE.MeshStandardMaterial({
        color: 0x88aacc, roughness: 0.05, metalness: 0.9,
        transparent: true, opacity: 0.10, side: THREE.DoubleSide,
      })
    );
    glass.position.set(sx + 0.55, 1.32, sz);
    glass.rotation.y = -Math.PI / 2;
    scene.add(glass);
    const adMat = new THREE.MeshBasicMaterial({ color: 0xffeed8 });
    const ad = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 1.7), adMat);
    ad.position.set(sx, 1.35, sz - 1.62);
    scene.add(ad);
    anim.shelterAd = adMat;
    const bench = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.08, 2.4), darkMat);
    bench.position.set(sx + 0.3, 0.55, sz);
    scene.add(bench);
    const shelterLight = new THREE.PointLight(0xffe0b0, 1.5, 6, 1.8);
    shelterLight.position.set(sx, 2.3, sz);
    scene.add(shelterLight);
  }

  // ============ MONORAIL — two elevated lines with passing lit trains ============
  {
    const beamMat = new THREE.MeshStandardMaterial({ color: 0x0c1016, roughness: 0.5, metalness: 0.85 });
    const glowLineMat = new THREE.MeshBasicMaterial({ color: 0x1d6e68 });
    const tracks = [
      { z: -40, y: 12.0, dir: 1, speed: 11, offset: 0 },
      { z: -78, y: 16.5, dir: -1, speed: 9.5, offset: 9 },
    ];
    for (const tk of tracks) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(96, 0.5, 2.1), beamMat);
      beam.position.set(0, tk.y - 0.45, tk.z);
      scene.add(beam);
      const guide = new THREE.Mesh(new THREE.BoxGeometry(96, 0.22, 0.5), beamMat);
      guide.position.set(0, tk.y - 0.10, tk.z);
      scene.add(guide);
      const line = new THREE.Mesh(new THREE.BoxGeometry(95, 0.05, 0.10), glowLineMat);
      line.position.set(0, tk.y - 0.72, tk.z);
      scene.add(line);
      for (const px of [-27, -8.2, 8.2, 27]) {
        const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.7, tk.y - 0.7, 0.9), beamMat);
        pylon.position.set(px, (tk.y - 0.7) / 2, tk.z);
        scene.add(pylon);
      }

      const train = new THREE.Group();
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.35, metalness: 0.8 });
      const winMat = new THREE.MeshBasicMaterial({ color: 0xffe2bb });
      for (let c = 0; c < 4; c++) {
        const cx = (c - 1.5) * 3.35;
        const body = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.72, 0.92), bodyMat);
        body.position.set(cx, 0.36, 0);
        train.add(body);
        for (const zs of [-0.465, 0.465]) {
          const win = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 0.26), winMat);
          win.position.set(cx, 0.46, zs);
          win.rotation.y = zs > 0 ? 0 : Math.PI;
          train.add(win);
        }
      }
      const headX = tk.dir > 0 ? 6.6 : -6.6;
      const headlight = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      headlight.position.set(headX, 0.36, 0);
      train.add(headlight);
      const headGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: SOFT_PARTICLE_TEX, color: 0xcfe4ff, transparent: true, opacity: 0.45,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      headGlow.position.set(headX, 0.36, 0);
      headGlow.scale.set(1.6, 1.6, 1);
      train.add(headGlow);
      const tail = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff4040 }));
      tail.position.set(-headX, 0.36, 0);
      train.add(tail);
      train.position.set(-tk.dir * 70, tk.y + 0.05, tk.z);
      scene.add(train);
      anim.trains.push({ grp: train, ...tk });
    }
  }

  // ============ GROUND TRAFFIC — instanced cars, light pools on the wet road ============
  {
    const N = 12;
    const bodyInst = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.6, 0.50, 3.6),
      new THREE.MeshStandardMaterial({
        color: 0x1a2230, roughness: 0.25, metalness: 0.85,
        emissive: 0x0a0e16, emissiveIntensity: 0.7,
      }),
      N
    );
    scene.add(bodyInst);
    const cabInst = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.30, 0.36, 1.7),
      new THREE.MeshStandardMaterial({
        color: 0x141a26, roughness: 0.12, metalness: 0.9,
        emissive: 0x1c2a40, emissiveIntensity: 0.55,
      }),
      N
    );
    scene.add(cabInst);
    const lightGeo = new THREE.SphereGeometry(0.085, 8, 6);
    const headInst = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xfff4da }), N * 2);
    scene.add(headInst);
    const tailInst = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xff3a3a }), N * 2);
    scene.add(tailInst);
    const poolGeo = new THREE.PlaneGeometry(2.0, 6.0);
    poolGeo.rotateX(-Math.PI / 2);
    const poolInst = new THREE.InstancedMesh(
      poolGeo,
      new THREE.MeshBasicMaterial({
        map: SOFT_PARTICLE_TEX, color: 0xffd9a0, transparent: true, opacity: 0.20,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }),
      N
    );
    scene.add(poolInst);

    let s = 13;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const lanes = [-3.5, -1.3, 1.3, 3.5];
    const data = [];
    for (let i = 0; i < N; i++) {
      const lane = lanes[i % 4];
      const dir = lane < 0 ? 1 : -1;
      data.push({
        x: lane, dir,
        speed: 7 + r() * 4.5,
        z: 26 - r() * 166,
      });
    }
    anim.traffic = { bodyInst, cabInst, headInst, tailInst, poolInst, data, N };
  }

  // ============ AIRCRAFT — distant drifting nav lights ============
  {
    const N = 8;
    const navInst = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.14, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xfff0d0 }), N
    );
    scene.add(navInst);
    const strobeInst = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.11, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4040 }), N
    );
    scene.add(strobeInst);
    let s = 37;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const data = [];
    for (let i = 0; i < N; i++) {
      data.push({
        dir: r() < 0.5 ? 1 : -1,
        speed: 2.5 + r() * 4,
        y: 38 + r() * 36,
        z: -70 - r() * 90,
        x: (r() - 0.5) * 160,
        phase: r() * Math.PI * 2,
      });
    }
    anim.aircraft = { navInst, strobeInst, data, N };
  }

  // ============ ROOF BLINKERS ============
  if (blinkerData.length) {
    const inst = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.10, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3838 }),
      blinkerData.length
    );
    scene.add(inst);
    anim.blinkers = { inst, data: blinkerData };
  }

  // ============ SIGNAGE — blade signs, two calm shader panels, holo rings ============
  {
    let s = 91;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    const signColors = [0x46e0d4, 0x46e0d4, 0x46e0d4, 0xff5e8a, 0xff5e8a, 0xffb46b, 0xffb46b, 0xffb46b];
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x0a0c12, roughness: 0.5, metalness: 0.8 });
    function makeBladeMat(cHex, seed) {
      return new THREE.ShaderMaterial({
        uniforms: {
          colorU: { value: new THREE.Color(cHex) },
          seedU:  { value: seed },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec2 vUv;
          uniform vec3 colorU;
          uniform float seedU;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          void main() {
            float row = floor(vUv.y * 7.0);
            float on = step(0.22, hash(vec2(row, seedU)));
            vec2 f = vec2(vUv.x, fract(vUv.y * 7.0));
            float blk = step(0.16, f.x) * step(f.x, 0.84) * step(0.16, f.y) * step(f.y, 0.84);
            // notch a corner out of each block so rows read as glyphs
            float nx = step(0.5, hash(vec2(row, seedU + 3.0)));
            float notch = step(mix(0.16, 0.45, nx), f.x) * step(f.x, mix(0.55, 0.84, nx))
                        * step(0.40, f.y) * step(f.y, 0.84) * step(0.6, hash(vec2(row, seedU + 7.0)));
            vec3 col = colorU * (0.08 + 1.25 * blk * on * (1.0 - notch * 0.85));
            gl_FragColor = vec4(col, 1.0);
          }`,
      });
    }
    for (let i = 0; i < 12; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = -6 - r() * 78;
      const y = 4.5 + r() * 8;
      const h = 2.2 + r() * 1.8;
      const cHex = signColors[Math.floor(r() * signColors.length)];
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.55, h, 0.14), frameMat);
      frame.position.set(side * 7.15, y, z);
      scene.add(frame);
      const faceMat = makeBladeMat(cHex, r() * 50);
      for (const fz of [-0.075, 0.075]) {
        const face = new THREE.Mesh(new THREE.PlaneGeometry(0.42, h - 0.25), faceMat);
        face.position.set(side * 7.15, y, z + fz);
        face.rotation.y = fz > 0 ? 0 : Math.PI;
        scene.add(face);
      }
      const glowMat = new THREE.SpriteMaterial({
        map: SOFT_PARTICLE_TEX, color: cHex, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.position.set(side * 7.15, y, z);
      glow.scale.set(1.6, h * 1.1, 1);
      scene.add(glow);
      if (i === 3 || i === 8) {
        anim.flickerSigns.push({
          u: faceMat.uniforms.colorU.value, base: new THREE.Color(cHex),
          glowMat, phase: r() * 10, speed: 7 + r() * 6,
        });
      }
    }

    function makePanelMat() {
      const u = { time: { value: 0 } };
      const mat = new THREE.ShaderMaterial({
        uniforms: u,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec2 vUv;
          uniform float time;
          void main() {
            float g = 0.5 + 0.5 * sin(vUv.x * 2.2 - vUv.y * 1.3 + time * 0.35);
            vec3 col = mix(vec3(0.30, 0.92, 0.85), vec3(1.0, 0.36, 0.55), g);
            col *= 0.50 + 0.10 * sin(vUv.y * 90.0 + time * 3.0);
            float frame = smoothstep(0.0, 0.05, vUv.x) * smoothstep(0.0, 0.05, 1.0 - vUv.x)
                        * smoothstep(0.0, 0.07, vUv.y) * smoothstep(0.0, 0.07, 1.0 - vUv.y);
            col *= 0.15 + 0.85 * frame;
            gl_FragColor = vec4(col, 1.0);
          }`,
      });
      anim.panelMats.push(u);
      return mat;
    }
    const panelDefs = [
      { side: -1, z: -27, y: 10.5 },
      { side: 1, z: -49, y: 8.5 },
    ];
    for (const pd of panelDefs) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 5.2), makePanelMat());
      panel.position.set(pd.side * 7.55, pd.y, pd.z);
      panel.rotation.y = pd.side < 0 ? Math.PI / 2 : -Math.PI / 2;
      scene.add(panel);
    }

    const holoMatA = new THREE.MeshBasicMaterial({
      color: 0x46e0d4, transparent: true, opacity: 0.80,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const holoA = new THREE.Mesh(new THREE.TorusGeometry(7.0, 0.07, 8, 64, Math.PI * 1.35), holoMatA);
    holoA.position.set(0, 26, -80);
    holoA.rotation.x = 0.15;
    scene.add(holoA);
    const holoMatB = new THREE.MeshBasicMaterial({
      color: 0xff5e8a, transparent: true, opacity: 0.65,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const holoB = new THREE.Mesh(new THREE.TorusGeometry(5.6, 0.055, 8, 64, Math.PI * 0.9), holoMatB);
    holoB.position.set(0, 26, -80);
    holoB.rotation.x = 0.15;
    scene.add(holoB);
    anim.holoA = holoA;
    anim.holoB = holoB;
  }

  // ============ GLASS SKYWALKS ============
  {
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x0b0e16, roughness: 0.4, metalness: 0.85 });
    const winCanvas = document.createElement('canvas');
    winCanvas.width = 512; winCanvas.height = 32;
    {
      const ctx = winCanvas.getContext('2d');
      ctx.fillStyle = '#07090e';
      ctx.fillRect(0, 0, 512, 32);
      let ws = 5;
      const wr = () => ((ws = (ws * 9301 + 49297) % 233280), ws / 233280);
      for (let i = 0; i < 32; i++) {
        if (wr() < 0.30) continue;
        const warm = wr() < 0.7;
        const a = 0.35 + wr() * 0.6;
        ctx.fillStyle = warm ? `rgba(255, 208, 150, ${a})` : `rgba(170, 205, 235, ${a})`;
        ctx.fillRect(i * 16 + 3, 6, 10, 20);
      }
    }
    const winTex = new THREE.CanvasTexture(winCanvas);
    winTex.minFilter = THREE.LinearFilter;
    winTex.magFilter = THREE.LinearFilter;
    const winMat = new THREE.MeshBasicMaterial({ map: winTex });
    const underMat = new THREE.MeshBasicMaterial({ color: 0x2a8c82 });
    for (const sk of [{ z: -33, y: 8.5 }, { z: -64, y: 14 }]) {
      const shell = new THREE.Mesh(new THREE.BoxGeometry(15.5, 2.2, 2.6), shellMat);
      shell.position.set(0, sk.y, sk.z);
      scene.add(shell);
      for (const zs of [-1.31, 1.31]) {
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(15.0, 0.9), winMat);
        strip.position.set(0, sk.y + 0.15, sk.z + zs);
        strip.rotation.y = zs > 0 ? 0 : Math.PI;
        scene.add(strip);
      }
      const under = new THREE.Mesh(new THREE.BoxGeometry(15.2, 0.04, 0.10), underMat);
      under.position.set(0, sk.y - 1.14, sk.z);
      scene.add(under);
    }
  }

  // ============ STEAM VENTS ============
  {
    const origins = [[1.9, 0, -16], [-2.4, 0, -30], [3.1, 0, -52]];
    const N = 240;
    const pos = new Float32Array(N * 3);
    const ages = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const o = origins[i % origins.length];
      pos[i * 3 + 0] = o[0] + (Math.random() - 0.5) * 0.4;
      pos[i * 3 + 1] = Math.random() * 3.2;
      pos[i * 3 + 2] = o[2] + (Math.random() - 0.5) * 0.4;
      ages[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const steam = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0xc8b49a, size: 0.45, sizeAttenuation: true, map: SOFT_PARTICLE_TEX,
        transparent: true, opacity: 0.07, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      })
    );
    scene.add(steam);
    anim.steam = steam;
    anim.steamAges = ages;
    anim.steamOrigins = origins;
  }

  // ============ RAIN ============
  {
    const N = 1600;
    const pos = new Float32Array(N * 3);
    const speed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 0] = (Math.random() - 0.5) * 110;
      pos[i * 3 + 1] = Math.random() * 32;
      pos[i * 3 + 2] = 20 - Math.random() * 140;
      speed[i] = 17 + Math.random() * 13;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const rain = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0x8fa8c8, size: 0.05, sizeAttenuation: true,
        transparent: true, opacity: 0.45, depthWrite: false,
      })
    );
    scene.add(rain);
    anim.rain = rain;
    anim.rainSpeed = speed;
  }

  // ============ LIGHTING ============
  scene.add(new THREE.HemisphereLight(0x24405a, 0x100c08, 0.62));
  const moonLight = new THREE.DirectionalLight(0x9fc4e8, 0.18);
  moonLight.position.set(40, 80, -60);
  scene.add(moonLight);

  // ============ UPDATE ============
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  const _sZero = new THREE.Vector3(0, 0, 0);

  function update(t) {
    anim.skyU.time.value = t;
    anim.streetU.time.value = t;
    anim.spireU.time.value = t;
    for (const m of anim.facadeMats) m.uniforms.time.value = t;
    for (const u of anim.panelMats) u.time.value = t;

    const bk = 0.75 + 0.25 * Math.sin(t * 1.1);
    anim.beaconGlow.material.opacity = 0.30 + 0.35 * bk;
    anim.beaconGlow.scale.setScalar(5.5 + 3.0 * bk);
    anim.beaconCore.scale.setScalar(0.85 + 0.3 * bk);

    for (const f of anim.flickerSigns) {
      const flick = Math.sin(t * f.speed + f.phase) > -0.2 ? 1.0 : 0.15;
      const k = flick * (0.9 + 0.1 * Math.sin(t * 31 + f.phase));
      f.u.copy(f.base).multiplyScalar(k);
      f.glowMat.opacity = 0.22 * k;
    }

    anim.holoA.rotation.z = t * 0.22;
    anim.holoB.rotation.z = -t * 0.31;

    anim.shelterAd.color.setScalar(0.92 + 0.08 * Math.sin(t * 0.7));

    for (const tr of anim.trains) {
      const span = 140;
      const x = ((t * tr.speed + tr.offset * tr.speed) % span) - span / 2;
      tr.grp.position.x = tr.dir > 0 ? x : -x;
    }

    if (anim.traffic) {
      const { bodyInst, cabInst, headInst, tailInst, poolInst, data, N } = anim.traffic;
      _q.identity();
      for (let i = 0; i < N; i++) {
        const c = data[i];
        c.z += c.dir * c.speed * 0.016;
        if (c.dir > 0 && c.z > 28) c.z = -140;
        if (c.dir < 0 && c.z < -140) c.z = 28;
        _p.set(c.x, 0.31, c.z);
        _m.compose(_p, _q, _s);
        bodyInst.setMatrixAt(i, _m);
        _p.set(c.x, 0.72, c.z - c.dir * 0.45);
        _m.compose(_p, _q, _s);
        cabInst.setMatrixAt(i, _m);
        const fz = c.z + c.dir * 1.82;
        const rz = c.z - c.dir * 1.82;
        for (const off of [-0.55, 0.55]) {
          _p.set(c.x + off, 0.42, fz);
          _m.compose(_p, _q, _s);
          headInst.setMatrixAt(i * 2 + (off > 0 ? 1 : 0), _m);
          _p.set(c.x + off, 0.45, rz);
          _m.compose(_p, _q, _s);
          tailInst.setMatrixAt(i * 2 + (off > 0 ? 1 : 0), _m);
        }
        _p.set(c.x, 0.02, c.z + c.dir * 2.6);
        _m.compose(_p, _q, _s);
        poolInst.setMatrixAt(i, _m);
      }
      bodyInst.instanceMatrix.needsUpdate = true;
      cabInst.instanceMatrix.needsUpdate = true;
      headInst.instanceMatrix.needsUpdate = true;
      tailInst.instanceMatrix.needsUpdate = true;
      poolInst.instanceMatrix.needsUpdate = true;
    }

    if (anim.aircraft) {
      const { navInst, strobeInst, data, N } = anim.aircraft;
      _q.identity();
      for (let i = 0; i < N; i++) {
        const a = data[i];
        a.x += a.dir * a.speed * 0.016;
        if (a.dir > 0 && a.x > 90) a.x = -90;
        if (a.dir < 0 && a.x < -90) a.x = 90;
        _p.set(a.x, a.y, a.z);
        _m.compose(_p, _q, _s);
        navInst.setMatrixAt(i, _m);
        const on = (t * 0.9 + a.phase) % Math.PI > Math.PI - 0.35;
        _p.set(a.x + a.dir * 0.6, a.y, a.z);
        _m.compose(_p, _q, on ? _s : _sZero);
        strobeInst.setMatrixAt(i, _m);
      }
      navInst.instanceMatrix.needsUpdate = true;
      strobeInst.instanceMatrix.needsUpdate = true;
    }

    if (anim.blinkers) {
      const { inst, data } = anim.blinkers;
      _q.identity();
      for (let i = 0; i < data.length; i++) {
        const b = data[i];
        const on = (t * 0.6 + b.phase) % Math.PI > Math.PI - 0.5;
        _p.set(b.x, b.y, b.z);
        _m.compose(_p, _q, on ? _s : _sZero);
        inst.setMatrixAt(i, _m);
      }
      inst.instanceMatrix.needsUpdate = true;
    }

    {
      const arr = anim.steam.geometry.attributes.position.array;
      const ages = anim.steamAges;
      const origins = anim.steamOrigins;
      for (let i = 0; i < ages.length; i++) {
        ages[i] += 0.005;
        if (ages[i] > 1) {
          ages[i] = 0;
          const o = origins[i % origins.length];
          arr[i * 3 + 0] = o[0] + (Math.random() - 0.5) * 0.4;
          arr[i * 3 + 1] = 0;
          arr[i * 3 + 2] = o[2] + (Math.random() - 0.5) * 0.4;
        } else {
          arr[i * 3 + 0] += Math.sin(t * 0.7 + i) * 0.004;
          arr[i * 3 + 1] += 0.020;
          arr[i * 3 + 2] += Math.cos(t * 0.5 + i) * 0.003;
        }
      }
      anim.steam.geometry.attributes.position.needsUpdate = true;
    }

    {
      const arr = anim.rain.geometry.attributes.position.array;
      const sp = anim.rainSpeed;
      for (let i = 0; i < sp.length; i++) {
        arr[i * 3 + 0] += 0.35 * 0.016;
        arr[i * 3 + 1] -= sp[i] * 0.016;
        if (arr[i * 3 + 1] < 0) {
          arr[i * 3 + 0] = (Math.random() - 0.5) * 110;
          arr[i * 3 + 1] = 26 + Math.random() * 8;
          arr[i * 3 + 2] = 20 - Math.random() * 140;
        }
      }
      anim.rain.geometry.attributes.position.needsUpdate = true;
    }
  }

  return { scene, update };
}

// ====================================================================
// AURORA CAMP — cozy night with tent, campfire, pines, aurora overhead
// ====================================================================
function buildAuroraCampScene() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x080820, 0.018);
  scene.background = new THREE.Color(0x08081a);

  const anim = { skyUniforms: null, fireFlames: [], fireLights: [], smoke: null, smokeAge: null };

  // sky with aurora curtains
  {
    const skyU = { time: { value: 0 } };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(380, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, uniforms: skyU,
        vertexShader: `varying vec3 vP; void main(){vec4 wp=modelMatrix*vec4(position,1.);vP=wp.xyz;gl_Position=projectionMatrix*viewMatrix*wp;}`,
        fragmentShader: `
          varying vec3 vP; uniform float time;
          float h2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
          float n2(vec2 p){vec2 i=floor(p),f=fract(p);float a=h2(i),b=h2(i+vec2(1.,0.)),c=h2(i+vec2(0.,1.)),d=h2(i+vec2(1.,1.));vec2 u=f*f*(3.-2.*f);return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;}
          float fbm(vec2 p){float v=0.,a=0.5;for(int i=0;i<4;i++){v+=a*n2(p);p*=2.05;a*=0.5;}return v;}
          void main(){
            vec3 d=normalize(vP); float h=d.y;
            vec3 lo=vec3(0.04,0.06,0.14); vec3 zen=vec3(0.005,0.005,0.04);
            vec3 col=mix(lo,zen,smoothstep(0.0,0.85,h));
            // aurora curtains
            if (h > -0.05 && h < 0.85) {
              float ang = atan(d.z, d.x);
              float aurora = 0.0; float hueAcc = 0.0;
              for (int i = 0; i < 3; i++) {
                float fi = float(i);
                float fr = 2.5 + fi * 1.7;
                float ph = time * (0.07 + fi * 0.03) + fi * 1.4;
                float warp = fbm(vec2(ang * 1.1, fi * 3.0 + time * 0.02)) * 0.8;
                float c = sin(ang * fr + ph + warp * 2.0);
                float curtain = pow(max(c, 0.), 5.0);
                float vy = h * (16.0 + fi * 6.0) - time * (0.6 + fi * 0.2);
                curtain *= 0.55 + 0.45 * sin(vy + fbm(vec2(ang * 8.0, fi * 7.0)) * 6.0);
                float band = smoothstep(-0.02 + fi * 0.015, 0.10 + fi * 0.015, h) *
                             (1.0 - smoothstep(0.40 + fi * 0.10, 0.55 + fi * 0.10, h));
                aurora += curtain * band;
                hueAcc += curtain * band * fi;
              }
              vec3 green = vec3(0.20, 1.0, 0.55);
              vec3 teal  = vec3(0.30, 0.95, 1.0);
              vec3 purple = vec3(0.70, 0.40, 1.0);
              vec3 ac = mix(green, teal, smoothstep(0.05, 0.30, h));
              ac = mix(ac, purple, smoothstep(0.30, 0.65, h));
              col += ac * aurora * 2.20;
            }
            // sparse stars
            float st = step(0.997, h2(floor(d.xz * 240.0))) * smoothstep(0.20, 0.6, h);
            col += vec3(0.85, 0.92, 1.0) * st * 0.6;
            gl_FragColor=vec4(col,1.0);
          }`,
      })
    );
    scene.add(sky);
    anim.skyUniforms = skyU;
  }

  // snow ground
  {
    const geo = new THREE.PlaneGeometry(200, 200, 50, 50);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, Math.sin(x * 0.05) * 0.30 + Math.cos(y * 0.05) * 0.25 + (Math.random() - 0.5) * 0.10);
    }
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0xe8eef8, roughness: 0.95,
    }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
  }

  // tent: triangular prism in red
  {
    const tentMat = new THREE.MeshStandardMaterial({ color: 0xc04030, roughness: 0.85, side: THREE.DoubleSide, flatShading: true });
    // build a triangular prism from a custom geometry
    const tentGeo = new THREE.BufferGeometry();
    tentGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      // base rectangle
      -1.2, 0, -1.5,  1.2, 0, -1.5,  1.2, 0, 1.5,  -1.2, 0, 1.5,
      // ridge line
      0, 1.5, -1.5,   0, 1.5, 1.5,
    ]), 3));
    tentGeo.setIndex([
      // back triangle
      0, 1, 4,
      // front triangle
      3, 5, 2,
      // left slope
      0, 4, 5, 0, 5, 3,
      // right slope
      1, 2, 5, 1, 5, 4,
      // bottom (closes it)
      0, 3, 2, 0, 2, 1,
    ]);
    tentGeo.computeVertexNormals();
    const tent = new THREE.Mesh(tentGeo, tentMat);
    tent.position.set(-3, 0, -16);
    tent.rotation.y = 0.4;
    scene.add(tent);
    // door flap
    const flap = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 1.2),
      new THREE.MeshBasicMaterial({ color: 0x1a0a08, side: THREE.DoubleSide })
    );
    flap.position.set(-3 + Math.cos(0.4) * 1.5, 0.6, -16 + Math.sin(0.4) * 1.5);
    flap.rotation.y = 0.4 + Math.PI / 2;
    scene.add(flap);
  }

  // campfire
  {
    const grp = new THREE.Group();
    grp.position.set(2, 0, -14);
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x5a504a, roughness: 0.95, flatShading: true });
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.20 + Math.random() * 0.08, 0), stoneMat);
      stone.position.set(Math.cos(a) * 0.7, 0.12, Math.sin(a) * 0.7);
      stone.rotation.set(Math.random(), Math.random() * Math.PI * 2, Math.random());
      grp.add(stone);
    }
    const logMat = new THREE.MeshStandardMaterial({ color: 0x2a1810, roughness: 1 });
    for (let i = 0; i < 3; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8), logMat);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = (i / 3) * Math.PI;
      log.position.y = 0.18 + i * 0.04;
      grp.add(log);
    }
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xff9a30 });
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.20 + Math.random() * 0.08, 1), flameMat);
      f.position.set((Math.random() - 0.5) * 0.4, 0.40 + i * 0.10, (Math.random() - 0.5) * 0.4);
      f.scale.set(0.8, 1.4 + i * 0.1, 0.8);
      grp.add(f);
      anim.fireFlames.push({ mesh: f, phase: Math.random() * Math.PI * 2 });
    }
    // tripod over fire with kettle
    const tripodMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), tripodMat);
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos(a) * 0.3, 0.8, Math.sin(a) * 0.3);
      leg.rotation.x = Math.sin(a) * 0.25;
      leg.rotation.z = -Math.cos(a) * 0.25;
      grp.add(leg);
    }
    const kettle = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), tripodMat);
    kettle.position.y = 0.95;
    kettle.scale.y = 0.8;
    grp.add(kettle);
    // fire light
    const fireLight = new THREE.PointLight(0xff7028, 3.5, 12, 1.7);
    fireLight.position.y = 0.7;
    grp.add(fireLight);
    anim.fireLights.push({ light: fireLight, base: 3.5 });

    scene.add(grp);
  }

  // pine trees scattered around
  {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 0.95 });
    const pineMat = new THREE.MeshStandardMaterial({ color: 0x163018, roughness: 1.0, flatShading: true });
    let s = 91;
    const r = () => ((s = (s * 9301 + 49297) % 233280), s / 233280);
    for (let i = 0; i < 12; i++) {
      const a = r() * Math.PI * 2;
      const rad = 9 + r() * 25;
      const px = Math.cos(a) * rad;
      const pz = -10 + Math.sin(a) * rad;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.14, 1.4, 6), trunkMat);
      trunk.position.set(px, 0.7, pz);
      scene.add(trunk);
      // stacked cones for pine foliage (3 tiers reads as a pine without the
      // mesh cost of 4)
      for (let k = 0; k < 3; k++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(1.1 - k * 0.20, 1.5, 8), pineMat);
        cone.position.set(px, 1.4 + k * 1.0, pz);
        scene.add(cone);
      }
    }
  }

  // wooden logs to sit on
  {
    const logMat = new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 0.95 });
    for (const [x, z, ry] of [[1.0, -12.5, 0.2], [3.5, -15, -0.4], [2.5, -16, 0.3]]) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.4, 10), logMat);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = ry;
      log.position.set(x, 0.22, z);
      scene.add(log);
    }
  }

  // backpack near tent
  {
    const grp = new THREE.Group();
    grp.position.set(-2, 0, -14);
    grp.rotation.y = 0.7;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.65, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x6a8a3a, roughness: 0.85 }));
    body.position.y = 0.32;
    grp.add(body);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.20, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x4a6a28, roughness: 0.85 }));
    top.position.y = 0.75;
    grp.add(top);
    scene.add(grp);
  }

  // smoke rising from fire
  {
    const N = 80;
    const pos = new Float32Array(N * 3);
    const age = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3 + 0] = 2 + (Math.random() - 0.5) * 0.3;
      pos[i * 3 + 1] = 1.0 + Math.random() * 4;
      pos[i * 3 + 2] = -14 + (Math.random() - 0.5) * 0.3;
      age[i] = Math.random() * 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    anim.smoke = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x80707a, size: 0.7, sizeAttenuation: true,
      map: SOFT_PARTICLE_TEX, alphaTest: 0.02,
      transparent: true, opacity: 0.30, depthWrite: false,
    }));
    anim.smokeAge = age;
    scene.add(anim.smoke);
  }

  scene.add(new THREE.HemisphereLight(0x4060a0, 0x1a1820, 0.40));

  function update(t) {
    if (anim.skyUniforms) anim.skyUniforms.time.value = t;
    for (const f of anim.fireFlames) {
      f.mesh.scale.y = 1.2 * (0.85 + Math.sin(t * 14 + f.phase) * 0.15);
    }
    for (const fl of anim.fireLights) {
      fl.light.intensity = fl.base + Math.sin(t * 9) * 0.8 + (Math.random() - 0.5) * 0.3;
    }
    if (anim.smoke) {
      const arr = anim.smoke.geometry.attributes.position.array;
      for (let i = 0; i < anim.smokeAge.length; i++) {
        anim.smokeAge[i] += 0.020;
        if (anim.smokeAge[i] > 4) {
          anim.smokeAge[i] = 0;
          arr[i * 3 + 0] = 2 + (Math.random() - 0.5) * 0.3;
          arr[i * 3 + 1] = 1.0;
          arr[i * 3 + 2] = -14 + (Math.random() - 0.5) * 0.3;
        } else {
          arr[i * 3 + 0] += 0.005;
          arr[i * 3 + 1] += 0.035;
          arr[i * 3 + 2] += -0.003;
        }
      }
      anim.smoke.geometry.attributes.position.needsUpdate = true;
    }
  }
  return { scene, update };
}

// Scene registry. Scenes are built lazily and cached so switching is instant
// after the first visit.
const SCENES = {
  plaza:      { label: 'plaza',       build: buildPlazaScene },
  city:       { label: 'city',        build: buildCityScene },
  forest:     { label: 'forest',      build: buildForestScene },
  space:      { label: 'space',       build: buildSpaceScene },
  desert:     { label: 'desert',      build: buildDesertScene },
  volcano:    { label: 'volcano',     build: buildVolcanoScene },
  auroracamp: { label: 'aurora camp', build: buildAuroraCampScene },
};
const SCENE_KEYS = Object.keys(SCENES);
const sceneCache = {};
function getScene(key) {
  if (!sceneCache[key]) sceneCache[key] = SCENES[key].build();
  return sceneCache[key];
}

// ---- background scene prefetch ----
// Only the upcoming scene in cycle order is prepared ahead of time: its
// geometry builds during one delayed step and its shaders compile through
// compileAsync, which never blocks the main thread. Every other scene builds
// on first switch — a one-time hitch, cached afterwards. Preparing all 27 up
// front used to saturate the first ~5-10s of page life with build + sync
// compile stalls.
//
// `playersGen` bumps every time setPlayerCount rebuilds the renderers, so
// a scene must be re-compiled against the new WebGLRenderers even if it's
// still cached.
const PREFETCH_DELAY_MS = 3000;
const prebuiltGen = new Map(); // sceneKey -> playersGen at which it was compiled
let playersGen = 0;
let prefetchHandle = null;

function compileSceneForAllPlayersAsync(sceneObj) {
  const jobs = [];
  for (const p of players) {
    if (p && p.renderer && p.camera && p.renderer.compileAsync) {
      jobs.push(p.renderer.compileAsync(sceneObj.scene, p.camera).catch(() => {}));
    }
  }
  return Promise.all(jobs);
}

async function backgroundPrefetchStep() {
  prefetchHandle = null;
  const idx = SCENE_KEYS.indexOf(currentSceneKey);
  const key = SCENE_KEYS[(idx + 1) % SCENE_KEYS.length];
  if (prebuiltGen.get(key) === playersGen) return;
  const sceneObj = getScene(key);
  await compileSceneForAllPlayersAsync(sceneObj);
  prebuiltGen.set(key, playersGen);
  console.log(`[prefetch] ${key} ready at ${Math.round(performance.now())}ms`);
}

function scheduleBackgroundPrefetch() {
  if (prefetchHandle != null) return;
  // delayed so boot (and every scene/player change) settles before the next
  // scene's build takes its one frame of main-thread time
  prefetchHandle = setTimeout(backgroundPrefetchStep, PREFETCH_DELAY_MS);
}

let currentSceneKey = 'plaza';
let currentScene = getScene(currentSceneKey);

function switchScene(key) {
  if (!SCENES[key] || key === currentSceneKey) return;
  currentSceneKey = key;
  currentScene = getScene(key);
  for (const p of players) p.setScene(currentScene.scene);
  const sel = document.getElementById('sceneSelect');
  if (sel && sel.value !== key) sel.value = key;
  // any scene change (manual or auto) resets the cycle countdown
  restartCycleTimer();
  // and re-arms the prefetch for the scene now next in cycle order
  scheduleBackgroundPrefetch();
}

// ---- scene auto-cycle ----
let cycleEnabled = false;
let cycleSeconds = 20;
let cycleTimer = null;
function restartCycleTimer() {
  if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
  if (!cycleEnabled) return;
  cycleTimer = setTimeout(() => {
    const idx = SCENE_KEYS.indexOf(currentSceneKey);
    const next = SCENE_KEYS[(idx + 1) % SCENE_KEYS.length];
    switchScene(next); // re-arms the timer via the restart call above
  }, Math.max(1, cycleSeconds) * 1000);
}

// =================================================================
// PLAYER
// =================================================================
class Player {
  constructor(index, port, viewportEl, sceneObj) {
    this.index = index;
    this.el = viewportEl;
    this.canvas = viewportEl.querySelector('canvas.scene');

    // DOM refs (per-player)
    const q = (sel) => viewportEl.querySelector(sel);
    this.ui = {
      title: q('.ptitle'), pport: q('.pport'), status: q('.pStatus'),
      recenter: q('.recenter'), centerPrompt: q('.centerPrompt'),
      pname: q('.pname'),
      pfilter: q('.pfilter'), pfilterAmt: q('.pfilterAmt'),
      tPos: q('.tPos'), tRot: q('.tRot'), tDelta: q('.tDelta'),
      tVel: q('.tVel'), tCam: q('.tCam'), tZero: q('.tZero'),
      tRate: q('.tRate'), tGap: q('.tGap'), tPeakGap: q('.tPeakGap'), tEff: q('.tEff'),
      tJit: q('.tJit'), tSig: q('.tSig'), tPeak: q('.tPeak'), tRange: q('.tRange'),
      tFps: q('.tFps'), tFrame: q('.tFrame'),
      gPkt: q('.gPkt'), gFps: q('.gFps'), gGap: q('.gGap'),
    };
    this.ui.title.textContent = `P${index + 1}`;
    this.setPort(port);

    const initialName = getPlayerName(index);
    this.ui.pname.textContent = initialName;
    this.ui.title.textContent = initialName;
    this._wireNameEditing();

    const savedOv = playerFilterOverrides[index];
    this.filterOverrideSpec = (savedOv && FILTER_MODES.includes(savedOv.mode))
      ? { mode: savedOv.mode, amount: Number(savedOv.amount) || 0 }
      : null;
    this.filterOverride = this.filterOverrideSpec
      ? buildFilterOverride(this.filterOverrideSpec.mode, this.filterOverrideSpec.amount)
      : null;
    this._wireFilterOverride();
    this.syncFilterOverrideUI();

    // renderer + (optional) composer + bloom
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: QUALITY.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 800);
    this.camera.position.copy(BASE_EYE);
    this.camera.rotation.order = 'YXZ';

    // The composer chain is only built when bloom is enabled. With bloom off,
    // we call renderer.render() directly — avoids RenderPass→OutputPass ping-pong
    // (2 extra full-screen blits per player per frame) and frees the FX render
    // targets entirely.
    this.scene = sceneObj;
    this.composer = null;
    this.renderPass = null;
    this.bloom = null;
    if (QUALITY.bloom) this._enableBloom();

    // pose state
    this.latestPose = null;
    this.zeroPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    this.tracking = false;
    this.pendingRecenter = false;
    this.hasRecentered = false;
    this._windowProjActive = false;

    this.targetQuat = new THREE.Quaternion();
    this.targetPos = new THREE.Vector3();
    this._qTmp = new THREE.Quaternion();
    this._lastDYaw = 0; this._lastDPitch = 0; this._lastDRoll = 0;

    // raw-wire unwrap state (continuous across ±180 wraps in the tracker output)
    this.rawUnwrapY = null; this.rawUnwrapP = null; this.rawUnwrapR = null;

    // smoothing pipeline state (shared front-end + per-filter buffers)
    this.interp = new PoseInterpolator();
    this.newSample = false;
    this.ema = null; this.emaHas = false;              // classic EMA
    this.euro = { x: [], dx: [], has: false };         // 1€
    this.accela = { x: [], has: false };               // accela

    // mouse orbit (per-canvas)
    this.mouseYaw = 0; this.mousePitch = 0;
    this.dragging = false; this.lastMouse = { x: 0, y: 0 };
    this._onMouseDown = (e) => {
      this.dragging = true; this.lastMouse = { x: e.clientX, y: e.clientY };
    };
    this._onMouseUp = () => { this.dragging = false; };
    this._onMouseMove = (e) => {
      if (!this.dragging || this.tracking) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.mouseYaw -= dx * 0.005;
      this.mousePitch -= dy * 0.005;
      this.mousePitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.mousePitch));
    };
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);

    // recenter button
    this._onRecenterClick = () => this.recenter();
    this.ui.recenter.addEventListener('click', this._onRecenterClick);

    // stats buffers
    this.packetTs = [];
    this.poseHist = [];
    this.peakDy = this.peakDp = this.peakDr = 0;
    this.peakGap = 0;
    this.prevPose = null;
    this.rangeYMin = this.rangePMin = this.rangeRMin = Infinity;
    this.rangeYMax = this.rangePMax = this.rangeRMax = -Infinity;
    this.frameMaxMs = 0;

    // sparklines
    this.spPkt = new Sparkline(this.ui.gPkt, { samples: 180, min: 0, max: 240, color: '#79e08a', warnAt: 30 });
    this.spFps = new Sparkline(this.ui.gFps, { samples: 240, min: 0, max: 120, color: '#79c8e0', warnAt: 30 });
    this.spGap = new Sparkline(this.ui.gGap, { samples: 240, min: 0, max: null, color: '#e0a879', warnAt: 33.3 });

    this._flashTimer = null;

    this.updateStatusUI();
    this.resize();
  }

  setScene(sceneObj) {
    this.scene = sceneObj;
    if (this.renderPass) this.renderPass.scene = sceneObj;
  }

  _enableBloom() {
    if (this.composer) return;
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // size up to current viewport
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w > 0 && h > 0) { this.composer.setSize(w, h); this.bloom.setSize(w, h); }
  }

  _disableBloom() {
    if (!this.composer) return;
    try { this.composer.dispose && this.composer.dispose(); } catch (_) { /* ignore */ }
    try { this.bloom.dispose && this.bloom.dispose(); } catch (_) { /* ignore */ }
    this.composer = null;
    this.renderPass = null;
    this.bloom = null;
  }

  dispose() {
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.ui.recenter.removeEventListener('click', this._onRecenterClick);
    this._disableBloom();
    try { this.renderer.dispose(); } catch (_) { /* ignore */ }
    try { this.renderer.forceContextLoss(); } catch (_) { /* ignore */ }
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    if (this.composer) this.composer.setSize(w, h);
    if (this.bloom) this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.spPkt.resize();
    this.spFps.resize();
    this.spGap.resize();
  }

  setTracking(isLive) {
    this.tracking = isLive;
    if (isLive) {
      this.hasRecentered = false;
      this.pendingRecenter = false;
      this.latestPose = null;
      this.mouseYaw = 0; this.mousePitch = 0;
      this.resetPoseFilter();
      this.resetStats();
    }
    this.updateStatusUI();
    this.updateCenterPrompt();
  }

  resetPoseFilter() {
    this.rawUnwrapY = this.rawUnwrapP = this.rawUnwrapR = null;
    this.interp.reset();
    this.newSample = false;
    this.emaHas = false;
    this.euro.has = false;
    this.accela.has = false;
  }

  // Smooth a set of recentered channels through the active filter. `scale`
  // carries the per-channel unit bridge used by accela (1 for degrees, small
  // for metre translation); the other filters ignore it.
  filterChannels(targets, dt, scale) {
    const fs = this.filterOverride || filterState;
    const mode = fs.mode;
    if (mode === 'oneeuro') return oneEuroStep(this.euro, targets, dt, fs.oneeuro);
    if (mode === 'accela') return accelaStep(this.accela, targets, dt, fs.accela, scale);
    // classic: per-channel exponential moving average
    const alpha = obraDinnAlpha(fs.amount.classic, dt);
    if (!this.emaHas || this.ema.length !== targets.length) {
      this.ema = targets.slice();
      this.emaHas = true;
    } else {
      for (let i = 0; i < targets.length; i++) this.ema[i] += (targets[i] - this.ema[i]) * alpha;
    }
    return this.ema;
  }

  resetStats() {
    this.packetTs.length = 0;
    this.poseHist.length = 0;
    this.peakDy = this.peakDp = this.peakDr = 0;
    this.peakGap = 0;
    this.prevPose = null;
    this.rangeYMin = this.rangePMin = this.rangeRMin = Infinity;
    this.rangeYMax = this.rangePMax = this.rangeRMax = -Infinity;
    this.frameMaxMs = 0;
  }

  recenter() {
    if (!this.tracking) {
      this.mouseYaw = 0; this.mousePitch = 0;
      this.flashCentered();
      return;
    }
    // Zero against the latest pose right away. Deferring to the next packet
    // silently strands panes whose tracker is idle at the moment Space is
    // pressed. Only stay pending when no pose has ever arrived — there's
    // nothing to zero against yet.
    if (this.latestPose) {
      this._applyRecenter(this.latestPose);
    } else {
      this.pendingRecenter = true;
      this.flashCentered();
    }
  }

  _applyRecenter(m) {
    this.zeroPose = { x: m.x, y: m.y, z: m.z, yaw: m.yaw, pitch: m.pitch, roll: m.roll };
    this.pendingRecenter = false;
    this.hasRecentered = true;
    this.resetPoseFilter();
    this.rangeYMin = this.rangePMin = this.rangeRMin = Infinity;
    this.rangeYMax = this.rangePMax = this.rangeRMax = -Infinity;
    this.flashCentered();
    this.updateCenterPrompt();
  }

  flashCentered() {
    const btn = this.ui.recenter;
    btn.style.boxShadow = '0 0 0 2px #79e08a, 0 0 18px rgba(121, 224, 138, 0.6)';
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { btn.style.boxShadow = ''; }, 350);
  }

  updateCenterPrompt() {
    this.ui.centerPrompt.style.display = (this.tracking && !this.hasRecentered) ? 'flex' : 'none';
  }

  updateStatusUI() {
    const el = this.ui.status;
    el.classList.remove('live', 'err');
    if (this.tracking) { el.textContent = 'live'; el.classList.add('live'); }
    else { el.textContent = 'idle'; }
  }

  ingestPose(m) {
    this.latestPose = m;
    this.newSample = true;
    if (this.pendingRecenter) {
      this._applyRecenter(m);
    }

    const now = performance.now();
    if (this.packetTs.length) this.spGap.push(now - this.packetTs[this.packetTs.length - 1]);
    this.packetTs.push(now);
    if (this.packetTs.length > 240) this.packetTs.shift();

    if (this.prevPose) {
      const ady = Math.abs(m.yaw - this.prevPose.yaw);
      const adp = Math.abs(m.pitch - this.prevPose.pitch);
      const adr = Math.abs(m.roll - this.prevPose.roll);
      if (ady > this.peakDy) this.peakDy = ady;
      if (adp > this.peakDp) this.peakDp = adp;
      if (adr > this.peakDr) this.peakDr = adr;
    }
    this.prevPose = { yaw: m.yaw, pitch: m.pitch, roll: m.roll };

    if (this.hasRecentered) {
      const ry = m.yaw - this.zeroPose.yaw;
      const rp = m.pitch - this.zeroPose.pitch;
      const rr = m.roll - this.zeroPose.roll;
      if (ry < this.rangeYMin) this.rangeYMin = ry; if (ry > this.rangeYMax) this.rangeYMax = ry;
      if (rp < this.rangePMin) this.rangePMin = rp; if (rp > this.rangePMax) this.rangePMax = rp;
      if (rr < this.rangeRMin) this.rangeRMin = rr; if (rr > this.rangeRMax) this.rangeRMax = rr;
    }

    // Time-based window so per-tracker stats cover the same wall-clock span
    // regardless of packet rate; the count cap only guards runaway senders.
    this.poseHist.push({ t: now, yaw: m.yaw, pitch: m.pitch, roll: m.roll, x: m.x, y: m.y, z: m.z });
    while (this.poseHist.length > 800 || (this.poseHist.length > 2 && now - this.poseHist[0].t > 3000)) {
      this.poseHist.shift();
    }
    // tPos/tRot/tZero are refreshed at 10Hz in refreshMetrics — writing them
    // here would slam the DOM at packet rate (up to 240 Hz × 4 players).
  }

  updateCamera(dt) {
    let dYaw = 0, dPitch = 0, dRoll = 0;
    let appliedWindow = false;
    const windowMode = windowEnabled && currentCount === 1;
    const fs = this.filterOverride || filterState;

    if (windowMode && this.tracking && this.latestPose && this.hasRecentered) {
      const lp = this.latestPose;
      // True 1:1 head→eye offset in metres. Rotation is intentionally ignored:
      // in window mode the eye moves, the screen stays put, the frustum shears.
      const dxRaw = (lp.x - this.zeroPose.x) * WINDOW_TRANSLATION_SCALE;
      const dyRaw = (lp.y - this.zeroPose.y) * WINDOW_TRANSLATION_SCALE;
      const dzRaw = (lp.z - this.zeroPose.z) * WINDOW_TRANSLATION_SCALE;
      let offX = windowCal.signX * dxRaw;
      let offY = windowCal.signY * dyRaw;
      let offZ = windowCal.signZ * dzRaw;

      this.newSample = false;
      if (fs.mode !== 'off') {
        const out = this.filterChannels([offX, offY, offZ], dt, WINDOW_CH_SCALE);
        offX = out[0]; offY = out[1]; offZ = out[2];
      }
      this._applyWindowProjection(offX, offY, offZ);
      appliedWindow = true;
    } else if (this.tracking && this.latestPose && this.hasRecentered) {
      const lp = this.latestPose;

      // Unwrap raw rotation onto a continuous line BEFORE any further processing,
      // so a ±180 wrap on the wire doesn't trigger a huge interpolator velocity
      // or break smoothing continuity.
      const rawY = unwrapDeg(lp.yaw,   this.rawUnwrapY);
      const rawP = unwrapDeg(lp.pitch, this.rawUnwrapP);
      const rawR = unwrapDeg(lp.roll,  this.rawUnwrapR);
      this.rawUnwrapY = rawY; this.rawUnwrapP = rawP; this.rawUnwrapR = rawR;

      // raw position deltas (with our X/Z inversions)
      const dxRaw = (lp.x - this.zeroPose.x) * TRANSLATION_SCALE;
      const dyP   = (lp.y - this.zeroPose.y) * TRANSLATION_SCALE;
      const dzRaw = (lp.z - this.zeroPose.z) * TRANSLATION_SCALE;
      const tdx = INVERT_X ? -dxRaw : dxRaw;
      const tdz = INVERT_Z ? -dzRaw : dzRaw;

      if (fs.mode !== 'off') {
        // ---- shared front-end: interpolator → recenter → filter ----
        const isNew = this.newSample;
        this.newSample = false;
        const [iy, ip, ir] = this.interp.update(rawY, rawP, rawR, isNew, dt);

        // recenter (yaw axis inverted to match our world convention)
        let cy = -(iy - this.zeroPose.yaw);
        let cp =  (ip - this.zeroPose.pitch);
        let cr =  (ir - this.zeroPose.roll);

        // classic keeps its front-end deadzone; the other filters reject
        // sub-threshold jitter with their own mechanism (1€ cutoff / accela band).
        if (fs.mode === 'classic') {
          cy = applyDeadzone(cy, fs.classicDeadzone);
          cp = applyDeadzone(cp, fs.classicDeadzone);
          cr = applyDeadzone(cr, fs.classicDeadzone);
        }

        const out = this.filterChannels([cy, cp, cr, tdx, dyP, tdz], dt, POSE_CH_SCALE);
        dYaw = out[0]; dPitch = out[1]; dRoll = out[2];

        this.targetQuat.identity();
        this._qTmp.setFromAxisAngle(_AY, dYaw   * DEG); this.targetQuat.multiply(this._qTmp);
        this._qTmp.setFromAxisAngle(_AX, dPitch * DEG); this.targetQuat.multiply(this._qTmp);
        this._qTmp.setFromAxisAngle(_AZ, dRoll  * DEG); this.targetQuat.multiply(this._qTmp);
        this.camera.quaternion.copy(this.targetQuat);
        this.camera.position.set(
          BASE_EYE.x + walkOffset.x + out[3],
          BASE_EYE.y + walkOffset.y + out[4],
          BASE_EYE.z + walkOffset.z + out[5],
        );
      } else {
        // ---- raw mode: snap, no interpolator/deadzone/EMA ----
        this.newSample = false;
        dYaw   = -(rawY - this.zeroPose.yaw);
        dPitch =  (rawP - this.zeroPose.pitch);
        dRoll  =  (rawR - this.zeroPose.roll);

        this.targetQuat.identity();
        this._qTmp.setFromAxisAngle(_AY, dYaw   * DEG); this.targetQuat.multiply(this._qTmp);
        this._qTmp.setFromAxisAngle(_AX, dPitch * DEG); this.targetQuat.multiply(this._qTmp);
        this._qTmp.setFromAxisAngle(_AZ, dRoll  * DEG); this.targetQuat.multiply(this._qTmp);
        this.camera.quaternion.copy(this.targetQuat);
        this.camera.position.set(BASE_EYE.x + walkOffset.x + tdx, BASE_EYE.y + walkOffset.y + dyP, BASE_EYE.z + walkOffset.z + tdz);
      }
    } else {
      this.camera.position.copy(BASE_EYE).add(walkOffset);
      this.camera.rotation.set(this.mousePitch, this.mouseYaw, 0, 'YXZ');
      this.resetPoseFilter();
    }
    // Leaving window mode (toggled off, lost tracking, or >1 player): restore the
    // symmetric projection the off-axis matrix replaced.
    if (!appliedWindow && this._windowProjActive) {
      this.camera.updateProjectionMatrix();
      this._windowProjActive = false;
    }
    // tDelta/tCam are refreshed at 10Hz in refreshMetrics — stash the values.
    this._lastDYaw = dYaw; this._lastDPitch = dPitch; this._lastDRoll = dRoll;
  }

  // Head-coupled off-axis (Kooima generalized perspective) projection. The
  // screen is a fixed rectangle in the world centred on the camera's resting
  // forward (−Z) at the calibrated distance; offX/offY/offZ is the live head
  // displacement in metres. The camera doesn't rotate — the frustum shears so
  // the near plane always frames the physical screen corners from the eye.
  _applyWindowProjection(offX, offY, offZ) {
    const cam = this.camera;
    const Dw = windowCal.distanceCm * 0.01;          // resting eye→screen distance (m)
    const hw = (windowCal.screenWidthCm * 0.01) / 2; // screen half-width (m)
    const hh = hw / cam.aspect;                       // height from canvas aspect → no stretch

    // Screen + eye both ride on BASE_EYE + walkOffset so WASD still carries the
    // whole window with you. Screen axes are world axes (right +X, up +Y).
    const bx = BASE_EYE.x + walkOffset.x;
    const by = BASE_EYE.y + walkOffset.y;
    const bz = BASE_EYE.z + walkOffset.z;
    const cx = bx, cy = by, cz = bz - Dw;
    const ex = bx + offX, ey = by + offY, ez = bz + offZ;

    const near = cam.near, far = cam.far;
    // Eye→screen-plane distance. Clamp so leaning onto/through the glass can't
    // invert or blow up the frustum.
    const d = Math.max(ez - cz, near * 2);
    const s = near / d;
    const left   = (cx - hw - ex) * s;
    const right  = (cx + hw - ex) * s;
    const top    = (cy + hh - ey) * s;
    const bottom = (cy - hh - ey) * s;

    cam.position.set(ex, ey, ez);
    cam.quaternion.identity();
    cam.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this._windowProjActive = true;
  }

  render(dt) {
    const ms = dt * 1000;
    if (ms > this.frameMaxMs) this.frameMaxMs = ms;
    if (dt > 0) this.spFps.push(1 / dt);
    if (this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  refreshMetrics(now) {
    let hz = 0, meanGap = 0, jitter = 0, peakRecent = 0, effHz = 0;
    const tslp = this.packetTs.length ? (now - this.packetTs[this.packetTs.length - 1]) : Infinity;
    if (this.packetTs.length >= 2) {
      let sum = 0;
      for (let i = 1; i < this.packetTs.length; i++) {
        const g = this.packetTs[i] - this.packetTs[i - 1];
        sum += g;
        if (g > peakRecent) peakRecent = g;
      }
      meanGap = sum / (this.packetTs.length - 1);
      hz = meanGap > 0 ? 1000 / meanGap : 0;
      let varSum = 0;
      // Arrivals closer than a quarter of the mean gap are one delivery burst
      // (packets the network held back and released together). Counting bursts
      // instead of packets gives the cadence the eye actually sees.
      const clumpGap = meanGap * 0.25;
      let deliveries = 1;
      for (let i = 1; i < this.packetTs.length; i++) {
        const g = this.packetTs[i] - this.packetTs[i - 1];
        varSum += (g - meanGap) ** 2;
        if (g > clumpGap) deliveries++;
      }
      jitter = Math.sqrt(varSum / (this.packetTs.length - 1));
      const span = this.packetTs[this.packetTs.length - 1] - this.packetTs[0];
      effHz = span > 0 ? ((deliveries - 1) / span) * 1000 : 0;
    }
    if (peakRecent > this.peakGap) this.peakGap = peakRecent;

    let sigY = 0, sigP = 0, sigR = 0;
    let velY = 0, velP = 0, velR = 0;
    if (this.poseHist.length >= 4) {
      let dy = 0, dp = 0, dr = 0, dy2 = 0, dp2 = 0, dr2 = 0;
      const n = this.poseHist.length - 1;
      for (let i = 1; i < this.poseHist.length; i++) {
        const a = this.poseHist[i - 1], b = this.poseHist[i];
        const ddy = b.yaw - a.yaw, ddp = b.pitch - a.pitch, ddr = b.roll - a.roll;
        dy += ddy; dp += ddp; dr += ddr;
        dy2 += ddy * ddy; dp2 += ddp * ddp; dr2 += ddr * ddr;
      }
      sigY = Math.sqrt(Math.max(0, dy2 / n - (dy / n) ** 2));
      sigP = Math.sqrt(Math.max(0, dp2 / n - (dp / n) ** 2));
      sigR = Math.sqrt(Math.max(0, dr2 / n - (dr / n) ** 2));

      const K = Math.min(8, this.poseHist.length - 1);
      const newest = this.poseHist[this.poseHist.length - 1];
      const oldest = this.poseHist[this.poseHist.length - 1 - K];
      const dtSec = (newest.t - oldest.t) / 1000;
      if (dtSec > 0) {
        velY = (newest.yaw - oldest.yaw) / dtSec;
        velP = (newest.pitch - oldest.pitch) / dtSec;
        velR = (newest.roll - oldest.roll) / dtSec;
      }
    }

    this.peakDy *= 0.94; this.peakDp *= 0.94; this.peakDr *= 0.94;
    this.peakGap *= 0.94;
    this.frameMaxMs *= 0.94;

    const fl = this.spFps.filled;
    let fpsAvg = 0;
    if (fl > 0) {
      const b = this.spFps.buf;
      let s = 0;
      for (let i = 0; i < fl; i++) s += b[i];
      fpsAvg = s / fl;
    }

    const u = this.ui;
    u.tFps.textContent = fpsAvg.toFixed(0);
    setColor(u.tFps, classifyLow(fpsAvg, 50, 30));
    u.tFrame.textContent = (fpsAvg > 0 ? (1000 / fpsAvg).toFixed(1) : '—') + 'ms · pk ' + this.frameMaxMs.toFixed(0);

    // Pose-text DOM updates batched here at 10Hz instead of in ingestPose
    // (packet rate) and updateCamera (frame rate).
    const m = this.latestPose;
    if (m) {
      u.tPos.textContent = `${m.x.toFixed(2)}, ${m.y.toFixed(2)}, ${m.z.toFixed(2)}`;
      u.tRot.textContent = `${m.yaw.toFixed(2)}, ${m.pitch.toFixed(2)}, ${m.roll.toFixed(2)}°`;
    }
    u.tZero.textContent = this.hasRecentered
      ? `${this.zeroPose.yaw.toFixed(1)}, ${this.zeroPose.pitch.toFixed(1)}, ${this.zeroPose.roll.toFixed(1)}`
      : '— (Space)';
    u.tDelta.textContent = `${this._lastDYaw.toFixed(2)}, ${this._lastDPitch.toFixed(2)}, ${this._lastDRoll.toFixed(2)}°`;
    u.tCam.textContent =
      `y${(this.camera.rotation.y / DEG).toFixed(1)} p${(this.camera.rotation.x / DEG).toFixed(1)} r${(this.camera.rotation.z / DEG).toFixed(1)}`;

    const hasPackets = this.packetTs.length >= 2 && tslp < 2000;
    this.cmp = { live: hasPackets, hz, effHz, jitter, sig: Math.max(sigY, sigP, sigR) };
    if (hasPackets) {
      u.tRate.textContent = hz.toFixed(1);
      setColor(u.tRate, classifyLow(hz, 30, 15));
      u.tGap.textContent = `${meanGap.toFixed(1)} ms`;
      u.tPeakGap.textContent = `${this.peakGap.toFixed(0)} ms`;
      setColor(u.tPeakGap, classify(this.peakGap, 50, 150));
      u.tJit.textContent = `±${jitter.toFixed(2)} ms σ`;
      setColor(u.tJit, classify(jitter, 3, 10));
      u.tEff.textContent = effHz.toFixed(1);
      const effRatio = hz > 0 ? effHz / hz : 1;
      setColor(u.tEff, effRatio < 0.55 ? 'err' : effRatio < 0.8 ? 'warn' : 'ok');
      u.tSig.textContent = `y${sigY.toFixed(3)} p${sigP.toFixed(3)} r${sigR.toFixed(3)}`;
      setColor(u.tSig, classify(Math.max(sigY, sigP, sigR), 0.08, 0.25));
      u.tPeak.textContent = `y${this.peakDy.toFixed(2)} p${this.peakDp.toFixed(2)} r${this.peakDr.toFixed(2)}`;
      u.tVel.textContent = `${velY.toFixed(0)}, ${velP.toFixed(0)}, ${velR.toFixed(0)} °/s`;
      if (this.rangeYMin !== Infinity) {
        u.tRange.textContent =
          `y[${this.rangeYMin.toFixed(0)}..${this.rangeYMax.toFixed(0)}] ` +
          `p[${this.rangePMin.toFixed(0)}..${this.rangePMax.toFixed(0)}] ` +
          `r[${this.rangeRMin.toFixed(0)}..${this.rangeRMax.toFixed(0)}]`;
      } else {
        u.tRange.textContent = '—';
      }
    } else {
      u.tRate.textContent = '0'; setColor(u.tRate, this.tracking ? 'err' : null);
      u.tGap.textContent = '—'; u.tPeakGap.textContent = '—'; setColor(u.tPeakGap, null);
      u.tJit.textContent = '—'; setColor(u.tJit, null);
      u.tEff.textContent = '0'; setColor(u.tEff, null);
      u.tSig.textContent = '—'; setColor(u.tSig, null);
      u.tPeak.textContent = '—';
      u.tVel.textContent = '0, 0, 0 °/s';
      u.tRange.textContent = '—';
    }

    this.spPkt.push(hz);
    this.spPkt.draw();
    this.spFps.draw();
    this.spGap.draw();
  }

  setPort(port) {
    this.port = port;
    this.ui.pport.textContent = `:${port}`;
  }

  applyFilterOverride(spec) {
    const prevMode = this.filterOverrideSpec ? this.filterOverrideSpec.mode : 'global';
    const nextMode = spec ? spec.mode : 'global';
    this.filterOverrideSpec = spec;
    this.filterOverride = spec ? buildFilterOverride(spec.mode, spec.amount) : null;
    playerFilterOverrides[this.index] = spec;
    saveFilterOverrides();
    if (nextMode !== prevMode) this.resetPoseFilter();
    this.syncFilterOverrideUI();
  }

  syncFilterOverrideUI() {
    const spec = this.filterOverrideSpec;
    this.ui.pfilter.value = spec ? spec.mode : 'global';
    this.ui.pfilter.classList.toggle('overridden', !!spec);
    const hasAmount = !!spec && spec.mode !== 'off';
    this.ui.pfilterAmt.disabled = !hasAmount;
    if (hasAmount) this.ui.pfilterAmt.value = spec.amount;
  }

  _wireFilterOverride() {
    const sel = this.ui.pfilter;
    const amt = this.ui.pfilterAmt;
    sel.addEventListener('change', () => {
      const mode = sel.value;
      if (mode === 'global') {
        this.applyFilterOverride(null);
      } else {
        const amount = this.filterOverrideSpec
          ? this.filterOverrideSpec.amount
          : (filterState.amount[mode] ?? 0.5);
        this.applyFilterOverride({ mode, amount });
      }
      sel.blur();
    });
    amt.addEventListener('input', () => {
      const spec = this.filterOverrideSpec;
      if (!spec || spec.mode === 'off') return;
      this.applyFilterOverride({ mode: spec.mode, amount: Number(amt.value) });
    });
    // The pane also captures WASD/Space/R; keep control interaction local.
    sel.addEventListener('pointerdown', (e) => e.stopPropagation());
    amt.addEventListener('pointerdown', (e) => e.stopPropagation());
    sel.addEventListener('keydown', (e) => e.stopPropagation());
  }

  _wireNameEditing() {
    const el = this.ui.pname;
    const commit = () => {
      const next = (el.textContent || '').replace(/\s+/g, ' ').trim();
      setPlayerName(this.index, next);
      const stored = getPlayerName(this.index);
      el.textContent = stored;
      this.ui.title.textContent = stored;
      const sel = window.getSelection();
      if (sel && el.contains(sel.anchorNode)) sel.removeAllRanges();
    };
    el.addEventListener('keydown', (e) => {
      // Names live inside the canvas pane, which also captures WASD/Space/R.
      // Stop key events from bubbling so typing doesn't move the camera.
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); el.textContent = getPlayerName(this.index); el.blur(); }
    });
    el.addEventListener('blur', commit);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }
}

// =================================================================
// PLAYER MANAGEMENT
// =================================================================
const gridEl = document.getElementById('grid');
const playerTemplate = document.getElementById('playerTemplate');
const players = [];
let currentCount = 0;

function setPlayerCount(n) {
  n = Math.max(1, Math.min(MAX_PLAYERS, n));
  if (n === currentCount) return;
  currentCount = n;

  // tear down
  for (const p of players) p.dispose();
  players.length = 0;
  gridEl.innerHTML = '';
  gridEl.className = `g${n}`;

  // build
  for (let i = 0; i < n; i++) {
    const node = playerTemplate.content.firstElementChild.cloneNode(true);
    gridEl.appendChild(node);
    const p = new Player(i, basePort + i, node, currentScene.scene);
    players.push(p);
  }

  // highlight selected button
  document.querySelectorAll('.pcount').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.n) === n);
  });
  updateWindowHud(); // refresh the "needs 1 player" note for the new count
  applyWindowUI();   // hide the window frame when not single-player

  // ensure sparkline canvases have laid-out size now that they're in DOM
  requestAnimationFrame(() => { for (const p of players) p.resize(); });

  // tell server (no basePort: it keeps using whatever UDP_PORT configured)
  sendWs({ action: 'setPlayers', count: n });

  // the renderers we just built are brand new — every cached scene needs to
  // be re-compiled against them. The current scene compiles on its next
  // render; the upcoming one re-preps in the background.
  playersGen++;
  scheduleBackgroundPrefetch();
}

// =================================================================
// ANIMATION LOOP
// =================================================================
const clock = new THREE.Clock();
let lastT = 0;
let perfWindowStart = 0;
let perfWindowFrames = 0;
let perfWindowSumDt = 0;

const FPS_CAP = 120;
const FRAME_MIN_MS = 1000 / FPS_CAP - 0.5;
let lastFrameMs = -Infinity;

function tick() {
  requestAnimationFrame(tick);
  const nowMs = performance.now();
  if (nowMs - lastFrameMs < FRAME_MIN_MS) return;
  lastFrameMs = nowMs;

  const t = clock.getElapsedTime();
  const dt = Math.min(0.1, t - lastT);
  lastT = t;

  // tick the active scene's animation (other cached scenes don't tick)
  currentScene.update(t);

  // WASD walking — reads previous frame's quaternion to choose direction
  applyWalking(dt);

  // per-player update + render
  for (const p of players) {
    p.updateCamera(dt);
    p.render(dt);
  }

  // Auto-downshift safety net: if we hold sub-target FPS for ~2s, drop the
  // internal framebuffer scale (and force bloom off) once. One-shot latch —
  // we don't oscillate, and the user can recover by toggling fx off and on.
  if (!PERF.downshifted) {
    perfWindowFrames++;
    perfWindowSumDt += dt;
    if (perfWindowSumDt >= 2.0) {
      const avgFps = perfWindowFrames / perfWindowSumDt;
      if (avgFps < PERF.target && players.length > 0) {
        PERF.downshifted = true;
        QUALITY.pixelRatio = 0.75;
        QUALITY.bloom = false;
        for (const p of players) {
          p._disableBloom();
          p.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.pixelRatio));
          p.resize();
        }
        applyFxUI();
        console.log(`[perf] avg ${avgFps.toFixed(1)} fps < target ${PERF.target} — dropped pixelRatio to ${QUALITY.pixelRatio}`);
      }
      perfWindowStart = t;
      perfWindowFrames = 0;
      perfWindowSumDt = 0;
    }
  }

}
tick();

// 10Hz metrics refresh for all players
setInterval(() => {
  const now = performance.now();
  for (const p of players) p.refreshMetrics(now);
  updateComparePanel(now);
}, 100);

// =================================================================
// RESIZE
// =================================================================
window.addEventListener('resize', () => {
  for (const p of players) p.resize();
});

// =================================================================
// WEBSOCKET
// =================================================================
let ws = null;
function sendWs(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

const masterStatusEl = document.getElementById('masterStatus');
function setMasterStatus(state, detail) {
  masterStatusEl.classList.remove('live', 'err');
  if (state === 'listening') {
    masterStatusEl.classList.add('live');
    masterStatusEl.textContent = detail || 'listening';
  } else if (state === 'error') {
    masterStatusEl.classList.add('err');
    masterStatusEl.textContent = 'error: ' + (detail || '');
  } else {
    masterStatusEl.textContent = state;
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    sendWs({ action: 'setPlayers', count: currentCount });
  };
  ws.onclose = () => { setMasterStatus('disconnected'); setTimeout(connect, 1000); };
  ws.onmessage = (evt) => {
    let m; try { m = JSON.parse(evt.data); } catch (_) { return; }
    if (m.type === 'pose') {
      const p = players[m.player ?? 0];
      if (p) p.ingestPose(m);
    } else if (m.type === 'status') {
      if (m.basePort > 0 && m.basePort !== basePort) {
        basePort = m.basePort;
        for (const p of players) p.setPort(basePort + p.index);
      }
      if (m.state === 'listening') {
        const live = m.players || [];
        setMasterStatus('listening', `${live.length} on :${basePort}+`);
        for (let i = 0; i < players.length; i++) {
          const ok = live.some((info) => info.player === i && info.ok !== false);
          players[i].setTracking(ok);
        }
      } else if (m.state === 'stopped') {
        setMasterStatus('stopped');
        for (const p of players) p.setTracking(false);
      } else if (m.state === 'error') {
        setMasterStatus('error', m.message || '');
        if (m.player != null && players[m.player]) players[m.player].setTracking(false);
      }
    }
  };
}

// =================================================================
// INPUT — buttons + keyboard
// =================================================================
document.querySelectorAll('.pcount').forEach((b) => {
  b.addEventListener('click', () => setPlayerCount(Number(b.dataset.n)));
});

// populate scene dropdown from the registry, set current selection, wire change
{
  const sel = document.getElementById('sceneSelect');
  for (const key of SCENE_KEYS) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = SCENES[key].label;
    sel.appendChild(opt);
  }
  sel.value = currentSceneKey;
  sel.addEventListener('change', (e) => {
    switchScene(e.target.value);
    // blur so Space/R go to the recenter handler instead of toggling the dropdown
    e.target.blur();
  });
}

// ---- smoothing filter: mode picker + one "smoothness" dial + advanced panel ----
const filterModeEl = document.getElementById('filterMode');
const filterAmountEl = document.getElementById('filterAmount');
const filterAdvBtnEl = document.getElementById('filterAdvBtn');
const filterAdvancedEl = document.getElementById('filterAdvanced');

// Advanced raw params per mode. `target` overrides where the value is stored
// (default: filterState[mode][key]).
const FILTER_PARAMS = {
  classic: [
    { key: 'classicDeadzone', label: 'deadzone', min: 0, max: 2, step: 0.05, target: 'classicDeadzone', hint: '° · drop sub-threshold jitter' },
  ],
  oneeuro: [
    { key: 'minCutoff', label: 'min-cutoff', min: 0.1, max: 8, step: 0.05, hint: 'Hz · lower = smoother when still' },
    { key: 'beta', label: 'beta', min: 0, max: 0.15, step: 0.001, hint: 'higher = less lag on fast motion' },
    { key: 'dCutoff', label: 'd-cutoff', min: 0.1, max: 5, step: 0.1, hint: 'Hz · speed-estimate cutoff' },
  ],
  accela: [
    { key: 'deadband', label: 'deadband', min: 0, max: 3, step: 0.05, hint: '° · hold-still zone' },
    { key: 'smoothing', label: 'smoothing', min: 0.5, max: 25, step: 0.1, hint: '° · error scale to reach full speed' },
    { key: 'expo', label: 'expo', min: 1, max: 3, step: 0.05, hint: 'nonlinearity · higher = snappier far, softer near' },
  ],
  off: [],
};

// Touching any global smoothing control (mode, dial, or a raw param) drops
// every per-pane override — including saved ones for panes not on screen.
function clearAllFilterOverrides() {
  for (const p of players) {
    if (p.filterOverrideSpec) p.applyFilterOverride(null);
  }
  playerFilterOverrides.length = 0;
  saveFilterOverrides();
}

function readFilterParam(spec) {
  return spec.target ? filterState[spec.target] : filterState[filterState.mode][spec.key];
}
function writeFilterParam(spec, v) {
  if (spec.target) filterState[spec.target] = v;
  else filterState[filterState.mode][spec.key] = v;
}

// When the primary dial moves it re-derives the raw params from the curve.
function deriveFromAmount() {
  const mode = filterState.mode;
  const s = filterState.amount[mode];
  if (mode === 'oneeuro') Object.assign(filterState.oneeuro, euroParamsFromAmount(s));
  else if (mode === 'accela') filterState.accela.smoothing = accelaSmoothingFromAmount(s);
}

function buildFilterAdvanced() {
  filterAdvancedEl.innerHTML = '';
  const specs = FILTER_PARAMS[filterState.mode];
  if (!specs.length) {
    filterAdvancedEl.innerHTML = '<div class="frow"><span class="fk">no parameters</span></div>';
    return;
  }
  for (const spec of specs) {
    const row = document.createElement('div');
    row.className = 'frow';
    row.title = spec.hint;
    const label = document.createElement('span');
    label.className = 'fk';
    label.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'frange';
    input.min = spec.min; input.max = spec.max; input.step = spec.step;
    input.value = readFilterParam(spec);
    const val = document.createElement('span');
    val.className = 'fv';
    val.textContent = Number(input.value).toFixed(spec.step < 0.01 ? 3 : 2);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      writeFilterParam(spec, v);
      val.textContent = v.toFixed(spec.step < 0.01 ? 3 : 2);
      saveFilterState();
      clearAllFilterOverrides();
    });
    row.append(label, input, val);
    filterAdvancedEl.appendChild(row);
  }
}

function applyFilterUI() {
  filterModeEl.value = filterState.mode;
  const isOff = filterState.mode === 'off';
  filterAmountEl.disabled = isOff;
  filterAmountEl.value = isOff ? 0.5 : filterState.amount[filterState.mode];
  filterAdvBtnEl.classList.toggle('on', filterState.advanced);
  filterAdvBtnEl.disabled = isOff;
  filterAdvancedEl.style.display = (filterState.advanced && !isOff) ? 'block' : 'none';
  buildFilterAdvanced();
}

filterModeEl.addEventListener('change', () => {
  filterState.mode = filterModeEl.value;
  applyFilterUI();
  saveFilterState();
  clearAllFilterOverrides();
  for (const p of players) p.resetPoseFilter();
  filterModeEl.blur();
});
filterAmountEl.addEventListener('input', () => {
  if (filterState.mode === 'off') return;
  filterState.amount[filterState.mode] = Number(filterAmountEl.value);
  deriveFromAmount();
  buildFilterAdvanced();
  saveFilterState();
  clearAllFilterOverrides();
});
filterAdvBtnEl.addEventListener('click', () => {
  filterState.advanced = !filterState.advanced;
  applyFilterUI();
  saveFilterState();
});
applyFilterUI();

// ---- live tracker comparison scoreboard ----
// One column per pane, one row per signal-quality metric, computed over each
// pane's rolling packet buffers. Assumes every tracker is watching the same
// head, so motion-dependent rows (rev, pk step, σΔ, xtalk) compare fairly.
const compareToggleEl = document.getElementById('compareToggle');
const comparePanelEl = document.getElementById('comparePanel');
let compareEnabled = false;

compareToggleEl.addEventListener('click', () => {
  compareEnabled = !compareEnabled;
  compareToggleEl.classList.toggle('on', compareEnabled);
  comparePanelEl.style.display = compareEnabled ? 'block' : 'none';
});

function wrapDeg180(d) {
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const va = a[i] - ma, vb = b[i] - mb;
    num += va * vb; da += va * va; db += vb * vb;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

// Wire-signal quality over the pose buffer. Duplicate packets (some senders
// double every pose for UDP redundancy) are excluded from the motion stats so
// they don't dilute reversal/step numbers.
function poseSignalStats(p) {
  const h = p.poseHist;
  if (h.length < 16) return null;
  let dups = 0, revs = 0, revPairs = 0, maxStep = 0, travel = 0;
  const dX = [], dYt = [], dZt = [], dYaw = [], dPitch = [];
  const prevSign = [0, 0, 0];
  for (let i = 1; i < h.length; i++) {
    const a = h[i - 1], b = h[i];
    const dy = wrapDeg180(b.yaw - a.yaw);
    const dp = wrapDeg180(b.pitch - a.pitch);
    const dr = wrapDeg180(b.roll - a.roll);
    const dx = b.x - a.x, dyt = b.y - a.y, dzt = b.z - a.z;
    if (dy === 0 && dp === 0 && dr === 0 && dx === 0 && dyt === 0 && dzt === 0) { dups++; continue; }
    dX.push(dx); dYt.push(dyt); dZt.push(dzt); dYaw.push(dy); dPitch.push(dp);
    travel += Math.abs(dy) + Math.abs(dp);
    const rot = [dy, dp, dr];
    for (let c = 0; c < 3; c++) {
      const s = Math.sign(rot[c]);
      if (s !== 0) {
        if (prevSign[c] !== 0) { revPairs++; if (s !== prevSign[c]) revs++; }
        prevSign[c] = s;
      }
      const ad = Math.abs(rot[c]);
      if (ad > maxStep) maxStep = ad;
    }
  }
  const n = h.length - 1;
  let xtalk = null;
  if (travel > 5 && dX.length >= 16) {
    xtalk = Math.max(
      Math.abs(pearson(dX, dYaw)),
      Math.abs(pearson(dYt, dPitch)),
      Math.abs(pearson(dZt, dPitch)),
    );
  }
  return {
    dupPct: (dups / n) * 100,
    revPct: revPairs ? (revs / revPairs) * 100 : 0,
    maxStep,
    xtalk,
  };
}

// Resample a pane's unwrapped yaw onto a uniform grid for cross-correlation.
function sampleYaw(p, t0, t1, stepMs) {
  const h = p.poseHist;
  if (h.length < 8 || h[0].t > t0 + 200 || h[h.length - 1].t < t1 - 200) return null;
  const unwrapped = new Array(h.length);
  unwrapped[0] = h[0].yaw;
  for (let i = 1; i < h.length; i++) unwrapped[i] = unwrapped[i - 1] + wrapDeg180(h[i].yaw - h[i - 1].yaw);
  const out = [];
  let j = 0;
  for (let t = t0; t <= t1; t += stepMs) {
    while (j < h.length - 2 && h[j + 1].t < t) j++;
    const a = h[j], b = h[Math.min(j + 1, h.length - 1)];
    const span = b.t - a.t;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    out.push(unwrapped[j] + (unwrapped[Math.min(j + 1, h.length - 1)] - unwrapped[j]) * f);
  }
  return out;
}

// Relative latency vs the reference pane: the lag (+ = behind) that maximizes
// yaw cross-correlation over the last ~2.5s. Needs real motion — flat signals
// correlate with everything, so weak peaks return null and display as '—'.
function computeLagMs(ref, p, now) {
  const STEP = 5, MAXLAG = 300;
  if (!ref.poseHist.length || !p.poseHist.length) return null;
  const t0 = Math.max(now - 2500, ref.poseHist[0].t, p.poseHist[0].t);
  if (now - t0 < 1200) return null;
  const a = sampleYaw(ref, t0, now, STEP);
  const b = sampleYaw(p, t0, now, STEP);
  if (!a || !b) return null;
  const n = Math.min(a.length, b.length);
  const maxK = Math.floor(MAXLAG / STEP);
  let bestCorr = -2, bestK = 0;
  for (let k = -maxK; k <= maxK; k++) {
    const lo = Math.max(0, k), hi = Math.min(n, n + k);
    if (hi - lo < 100) continue;
    const sa = [], sb = [];
    for (let i = lo; i < hi; i++) { sa.push(a[i - k]); sb.push(b[i]); }
    const c = pearson(sa, sb);
    if (c > bestCorr) { bestCorr = c; bestK = k; }
  }
  if (bestCorr < 0.7) return null;
  return bestK * STEP;
}

const CMP_ROWS = [
  // no ranking: duplicate-padding inflates wire rate; eff is the honest cadence
  { key: 'hz',      label: 'rate Hz',   better: null,   eps: 1,    fmt: (v) => v.toFixed(1) },
  { key: 'effHz',   label: 'eff Hz',    better: 'high', eps: 1,    fmt: (v) => v.toFixed(1) },
  { key: 'jitter',  label: 'jit ms σ',  better: 'low',  eps: 0.5,  fmt: (v) => v.toFixed(2) },
  { key: 'dupPct',  label: 'dup %',     better: 'low',  eps: 2,    fmt: (v) => v.toFixed(0) },
  { key: 'revPct',  label: 'rev %',     better: 'low',  eps: 2,    fmt: (v) => v.toFixed(0) },
  { key: 'maxStep', label: 'pk step °', better: 'low',  eps: 0.5,  fmt: (v) => v.toFixed(2) },
  { key: 'sig',     label: 'σΔ °',      better: 'low',  eps: 0.02, fmt: (v) => v.toFixed(3) },
  // no best/worst ranking: noise dilutes delta correlation, so a noisy tracker
  // can score "better" xtalk than a clean one following the same head
  { key: 'xtalk',   label: 'xtalk |r|', better: null,   eps: 0.1,  fmt: (v) => v.toFixed(2) },
  { key: 'lagMs',   label: 'lag ms',    better: 'low',  eps: 5,    fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(0) },
];

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let cmpTick = 0;
function updateComparePanel(now) {
  if (!compareEnabled || !players.length) return;
  if (++cmpTick % 3) return;

  const cols = players.map((p) => {
    const live = !!(p.cmp && p.cmp.live);
    const stats = live ? poseSignalStats(p) : null;
    return {
      p, live,
      name: getPlayerName(p.index),
      vals: live ? {
        hz: p.cmp.hz, effHz: p.cmp.effHz, jitter: p.cmp.jitter, sig: p.cmp.sig,
        dupPct: stats ? stats.dupPct : null,
        revPct: stats ? stats.revPct : null,
        maxStep: stats ? stats.maxStep : null,
        xtalk: stats ? stats.xtalk : null,
        lagMs: null,
      } : null,
    };
  });

  const ref = cols.find((c) => c.live);
  if (ref) {
    for (const c of cols) {
      if (!c.live) continue;
      c.vals.lagMs = c === ref ? 'ref' : computeLagMs(ref.p, c.p, now);
    }
  }

  let html = '<table><tr><th>vs</th>';
  for (const c of cols) {
    html += `<th${c.live ? '' : ' class="idlecol"'}>${escapeHtml(c.name)}</th>`;
  }
  html += '</tr>';

  for (const row of CMP_ROWS) {
    const nums = cols
      .map((c) => (c.vals && typeof c.vals[row.key] === 'number' ? c.vals[row.key] : null))
      .filter((v) => v !== null);
    let best = null, worst = null;
    if (nums.length >= 2 && row.better) {
      const mn = Math.min(...nums), mx = Math.max(...nums);
      if (mx - mn > row.eps) {
        best = row.better === 'low' ? mn : mx;
        worst = row.better === 'low' ? mx : mn;
      }
    }
    html += `<tr><td>${row.label}</td>`;
    for (const c of cols) {
      const v = c.vals ? c.vals[row.key] : null;
      if (v === null || v === undefined) {
        html += `<td${c.live ? '' : ' class="idlecol"'}>—</td>`;
      } else if (v === 'ref') {
        html += '<td>ref</td>';
      } else {
        const cls = v === best ? ' class="best"' : v === worst ? ' class="worst"' : '';
        html += `<td${cls}>${row.fmt(v)}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</table>';
  html += `<div class="note">rolling window · lag vs ${ref ? escapeHtml(ref.name) : '—'} needs head motion · same head assumed for all trackers</div>`;
  comparePanelEl.innerHTML = html;
}

const fxToggleEl = document.getElementById('fxToggle');
function applyFxUI() { fxToggleEl.classList.toggle('on', QUALITY.bloom); }
fxToggleEl.addEventListener('click', () => {
  QUALITY.bloom = !QUALITY.bloom;
  applyFxUI();
  for (const p of players) {
    if (QUALITY.bloom) p._enableBloom(); else p._disableBloom();
  }
});
applyFxUI();

// ---- virtual-window toggle + live calibration HUD ----
const windowToggleEl = document.getElementById('windowToggle');
const windowHudEl = document.getElementById('windowHud');
const windowFrameEl = document.getElementById('windowFrame');
function updateWindowHud() {
  const note = currentCount === 1
    ? ''
    : ' · <span class="warn">needs 1 player</span>';
  const sign = (s) => (s < 0 ? '−' : '+');
  windowHudEl.innerHTML =
    `window · eye <b>${windowCal.distanceCm}cm</b> back ` +
    `<span style="opacity:.6">[ ]</span> · ` +
    `screen <b>${windowCal.screenWidthCm}cm</b> wide ` +
    `<span style="opacity:.6">- =</span> · ` +
    `flip <b>x${sign(windowCal.signX)} y${sign(windowCal.signY)} z${sign(windowCal.signZ)}</b>${note}`;
}
function applyWindowUI() {
  windowToggleEl.classList.toggle('on', windowEnabled);
  windowHudEl.style.display = windowEnabled ? 'block' : 'none';
  // The frame only makes sense for the single full-screen window.
  windowFrameEl.style.display = (windowEnabled && currentCount === 1) ? 'block' : 'none';
}
if (WINDOW_MODE_AVAILABLE) {
  windowToggleEl.addEventListener('click', () => {
    windowEnabled = !windowEnabled;
    applyWindowUI();
    updateWindowHud();
    for (const p of players) p.resetPoseFilter();
  });
} else {
  windowToggleEl.remove();
}
updateWindowHud();
applyWindowUI();

// ---- toolbar height → CSS var, so the top-row stats cards clear the pill ----
{
  const toolbarEl = document.getElementById('toolbar');
  const publish = () => document.documentElement.style.setProperty(
    '--toolbar-bottom', `${toolbarEl.offsetTop + toolbarEl.offsetHeight}px`,
  );
  new ResizeObserver(publish).observe(toolbarEl);
  publish();
}

// ---- cycle toggle + seconds input ----
const cycleToggleEl = document.getElementById('cycleToggle');
const cycleSecsEl   = document.getElementById('cycleSecs');
function applyCycleUI() { cycleToggleEl.classList.toggle('on', cycleEnabled); }
cycleToggleEl.addEventListener('click', () => {
  cycleEnabled = !cycleEnabled;
  applyCycleUI();
  restartCycleTimer();
});
cycleSecsEl.addEventListener('input', () => {
  const v = Math.max(1, Math.min(3600, Number(cycleSecsEl.value) || 1));
  cycleSeconds = v;
  // don't normalize the value while the user is mid-edit; only reset the timer
  restartCycleTimer();
});
cycleSecsEl.addEventListener('blur', () => { cycleSecsEl.value = String(cycleSeconds); });
applyCycleUI();

const WALK_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight',
]);

window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
  if (e.target && e.target.isContentEditable) return;
  if (WALK_KEYS.has(e.code)) {
    heldKeys.add(e.code);
    if (e.code.startsWith('Arrow')) e.preventDefault(); // stop arrow keys from scrolling
    return;
  }
  // Live virtual-window calibration: [ ] nudge resting distance, - = nudge
  // screen width. Shift = coarse (5cm) steps. Only active in window mode.
  if (windowEnabled &&
      (e.code === 'BracketLeft' || e.code === 'BracketRight' ||
       e.code === 'Minus' || e.code === 'Equal')) {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    const clamp = (v) => Math.max(10, Math.min(300, v));
    if (e.code === 'BracketLeft')  windowCal.distanceCm    = clamp(windowCal.distanceCm - step);
    if (e.code === 'BracketRight') windowCal.distanceCm    = clamp(windowCal.distanceCm + step);
    if (e.code === 'Minus')        windowCal.screenWidthCm = clamp(windowCal.screenWidthCm - step);
    if (e.code === 'Equal')        windowCal.screenWidthCm = clamp(windowCal.screenWidthCm + step);
    saveWindowCal();
    updateWindowHud();
    return;
  }
  // Flip a parallax axis if it moves the wrong way (e.g. lean-left swings the
  // view left instead of revealing the right side). Only active in window mode.
  if (windowEnabled && (e.code === 'KeyX' || e.code === 'KeyY' || e.code === 'KeyZ')) {
    e.preventDefault();
    if (e.code === 'KeyX') windowCal.signX *= -1;
    if (e.code === 'KeyY') windowCal.signY *= -1;
    if (e.code === 'KeyZ') windowCal.signZ *= -1;
    saveWindowCal();
    updateWindowHud();
    return;
  }
  if (e.code === 'Space' || e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    for (const p of players) p.recenter();
  }
});

window.addEventListener('keyup', (e) => {
  if (WALK_KEYS.has(e.code)) heldKeys.delete(e.code);
});

// drop held keys if the window loses focus (otherwise they'd "stick" pressed)
window.addEventListener('blur', () => heldKeys.clear());

// click anywhere outside an editable player name → blur it
window.addEventListener('pointerdown', (e) => {
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('pname') && !ae.contains(e.target)) {
    ae.blur();
  }
}, true);

// =================================================================
// BOOT
// =================================================================
setPlayerCount(1);
connect();
