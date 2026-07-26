# Test suite

Black-box integration tests for `server.js` and pure-math tests for the
`public/renderer.js` utilities. No new dependencies — uses Node's
built-in `node:test` runner and the `ws` package already in the project.

## Running

```sh
pixi run test
```

That builds the Dockerfile's `test` stage, so the suite runs against the same
Node and the same dependency tree the published image ships. CI runs exactly
this command.

To run on the host instead:

```sh
npm test          # or: node --test --test-reporter=spec
```

The runner auto-discovers `*.test.mjs` files under `tests/`. Each test
file runs in its own subprocess, so port allocations and server
fixtures are isolated.

Full suite runs in ~4 seconds on a modern laptop.

## Layout

```
tests/
├── helpers/
│   ├── free-ports.mjs         pick ephemeral TCP/UDP ports; find N consecutive UDP ports
│   ├── server-harness.mjs     spawn the real server.js, wait for ready, clean SIGINT shutdown
│   ├── ws-client.mjs          buffering WebSocket client with waitFor(predicate, timeout)
│   └── renderer-snippet.mjs   slice pure-utility functions out of renderer.js and eval them
├── server/
│   ├── http.test.mjs          static file serving, MIME, 404, path-traversal
│   ├── health.test.mjs        /healthz shape and listener state
│   ├── websocket.test.mjs     connect-time status, broadcast fan-out, malformed input handling
│   ├── udp-pose.test.mjs      OpenTrack packet parsing and per-player tagging
│   └── player-management.test.mjs  setPlayers / stop semantics, clamping, bind errors
└── renderer/
    └── pure-utils.test.mjs    obraDinnAlpha, applyDeadzone, unwrapDeg, classify, PoseInterpolator
```

## What is and isn't tested

### Covered

- **HTTP server**: GET /, /index.html, /renderer.js; 404 on missing
  files; 403 on `..` path traversal, including an escape into a sibling
  directory that shares the `public` prefix; query-string stripping; MIME
  assignment per known extension; octet-stream fallback for unknown
  extensions.
- **Health endpoint**: `/healthz` returns 200 JSON while idle; query
  strings ignored; `listening` / `basePort` / `players` track what the
  WebSocket control channel actually bound and released. This is what the
  image's `HEALTHCHECK` polls.
- **WebSocket protocol**: initial status broadcast on connect (both
  `stopped` and `listening`); broadcasts reach every connected client;
  malformed JSON tolerated; unknown actions ignored; disconnects don't
  break broadcasts to remaining clients.
- **UDP pose parsing**: valid 48-byte OpenTrack packets are forwarded
  with correct little-endian float64 values across all six fields;
  packets <48 bytes are dropped; oversize packets parse just the first
  48 bytes; multi-player port→player tagging.
- **Player management**: `setPlayers` count clamping to `[1, 4]`
  (including fractional truncation via `|0` and non-numeric →1);
  `basePort` fallback to default for 0/negative/non-numeric, and for an
  omitted `basePort` — which is what the page sends, so this is the path
  that makes `UDP_PORT` mean anything;
  describePlayers payload is sorted; `stop` releases the ports;
  `setPlayers` replaces existing listeners; bind error on a busy port
  broadcasts `status: error` and then `stopped`.
- **Renderer pure utilities**: `obraDinnAlpha` monotonicity in both
  smoothing and dt, closed-form match at the default, threshold gating;
  `applyDeadzone` boundary behavior, sign preservation, translation
  vs scaling; `unwrapDeg` at ±180° wrap and multi-revolution
  monotonicity; `classify` / `classifyLow` boundary inclusivity;
  `PoseInterpolator` first-sample / second-sample / blend / extrapolation
  / MAX_EXT cap / reset / accumulated timeSince.

### Explicitly NOT covered

- **WebGL scene builders in renderer.js** (~99% of that file). These
  require a browser, depend on `THREE.*` and the DOM, and produce
  visual output rather than asserts-friendly state. The existing
  `scripts/screenshot-scenes.mjs` is the project's visual smoke test
  for these — keep that as the gate for regressions in scene content.
- **UI behavior** (toolbar, player toggles, keyboard, sparklines,
  smoothing toggle, FX toggle, cycle timer). Browser-only. See above.
- **OpenTrack input over the real network**: tests bind to `127.0.0.1`
  only; cross-host UDP behavior is delegated to the OS.
- **The image itself**: not covered here, but not untested either —
  `pixi run smoke` (`scripts/smoke.mjs`) boots the built container and
  drives `/healthz`, the viewer page, the WebSocket control channel and a
  real OpenTrack datagram through it. CI runs it alongside this suite.

## Notable behaviors captured as characterization tests

A few server behaviors that aren't obviously specified but that the
tests now pin down — if you change these, expect tests to break and
update them deliberately:

- **Percent-encoded slashes are not decoded.** A request for
  `/..%2F..%2Fserver.js` is treated as a single literal filename under
  `public/` and produces a 404, not a 403. The path-traversal guard
  only protects against raw `..` segments. This is still safe (the OS
  doesn't treat `%2F` as a separator) but is worth pinning so a future
  "let's decode URLs" change doesn't silently bypass the guard.
- **`setPlayers` count clamp uses `| 0`.** Fractional counts are
  truncated (2.9 → 2); `NaN` becomes 0 and is then clamped up to 1.
- **`basePort` fallback uses `Number(x) > 0`.** 0, negatives, and
  anything non-numeric all fall back to the configured default port.
- **`stopped` broadcast omits the `players` field but still carries
  `basePort`** (the listening broadcast has both). The page has no port
  control, so the connect-time greeting is where it learns which port to
  label its panes with. Tests rely on this shape.
- **Bind failure emits two broadcasts in sequence**: first
  `{state:'error', player, port, message}`, then `{state:'stopped'}`
  (since no socket bound successfully so `sockets.size === 0` when
  `broadcastStatus()` runs).

## Assumptions

- Tests bind to `127.0.0.1` and assume the loopback interface works.
- `freeConsecutiveUdpPorts(n)` finds N free consecutive UDP ports by
  trial-bind; there's a tiny race window between probing and the
  server grabbing them. In practice this hasn't been flaky on
  localhost, but it's not formally race-free.
- The renderer pure-utility tests rely on source-file markers
  (`function obraDinnAlpha`, `const DEG = Math.PI`, `function unwrapDeg`,
  `function setColor`) to slice the snippets. If those names change in
  `public/renderer.js`, the helper will throw with a clear "marker not
  found" message and the tests will fail loudly.

## Possible follow-ups

- A Playwright-based smoke test of the live page (the `scripts/check-perf.mjs`
  and `scripts/screenshot-scenes.mjs` already do this informally; could
  be wrapped into the test suite as an opt-in `npm run test:e2e`).
- Coverage instrumentation via `node --test --experimental-test-coverage`
  to find uncovered branches in `server.js`.
- A long-soak test that sends a high-rate UDP stream for ~30s and
  asserts the rate observed at the WebSocket matches what was sent
  (catches dropped or queued messages under load).
