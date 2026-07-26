# head-tracking-tester

[![CI](https://github.com/itsloopyo/head-tracking-tester/actions/workflows/ci.yml/badge.svg)](https://github.com/itsloopyo/head-tracking-tester/actions/workflows/ci.yml)
[![Docker Hub](https://img.shields.io/docker/v/itsloopyo/head-tracking-tester?logo=docker&logoColor=white&label=docker%20hub&sort=semver)](https://hub.docker.com/r/itsloopyo/head-tracking-tester)
[![Image size](https://img.shields.io/docker/image-size/itsloopyo/head-tracking-tester/latest?logo=docker&logoColor=white&label=image)](https://hub.docker.com/r/itsloopyo/head-tracking-tester)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A browser-based 6DoF viewer for [OpenTrack](https://github.com/opentrack/opentrack) UDP output, and a bench for
judging how good a tracker actually is. Point up to four trackers at it, watch them
drive the same scene side by side, and read off rate, jitter, noise, duplicate
frames and relative lag for each one.

A small Node bridge listens for OpenTrack UDP packets and forwards parsed poses to the
page over a WebSocket. The page renders a Three.js scene per tracker. No build step, no
CDN, no telemetry leaving the machine.

## Quick start

```sh
docker run --rm --network=host itsloopyo/head-tracking-tester
```

Open <http://localhost:8080>. Listeners bind automatically — pick 1–4 players in the
toolbar and each pane takes one consecutive UDP port from `4242` up.

Host networking is the simple case because OpenTrack sends UDP to the host directly. If
it isn't available (Docker Desktop on macOS/Windows), publish the ports explicitly and
point OpenTrack at the Docker VM's address rather than `localhost`:

```sh
docker run --rm \
  -p 8080:8080 \
  -p 4242:4242/udp -p 4243:4243/udp -p 4244:4244/udp -p 4245:4245/udp \
  itsloopyo/head-tracking-tester
```

Images are published for `linux/amd64` and `linux/arm64`, and mirrored to
`ghcr.io/itsloopyo/head-tracking-tester`.

### Without Docker

```sh
npm ci --omit=dev --ignore-scripts
npm start
```

Node 20 or newer. The only runtime dependency is `ws`.

## OpenTrack setup

Set **Output** to **UDP over network** and point it at the machine running this app on
port `4242` (the second tracker uses `4243`, and so on). The wire format is OpenTrack's
default: six little-endian `float64`s per packet — `X, Y, Z, Yaw, Pitch, Roll`, with
translation in cm and rotation in degrees.

Anything that speaks that format works; nothing here is OpenTrack-specific.

## Controls

| Input | Action |
| --- | --- |
| **Space** / **R** | Recenter every pane — capture the current pose as the new zero |
| **W A S D** | Walk around the scene |
| **Shift** | Run |
| Mouse drag | Orbit the camera when a pane isn't tracking |
| Click a pane's name | Rename it (persists in `localStorage`) |
| **players 1–4** | Split the view; each pane binds the next UDP port |
| **scene** / **cycle** | Pick a scene, or rotate through all of them every N seconds |
| **smoothing** | Filter mode plus a responsive ↔ smooth dial; **advanced** exposes raw parameters |
| **compare** | Live signal-quality scoreboard across panes |
| **fx** | Bloom and tone mapping (off by default — it costs 40–50% of GPU time at four panes) |

Each pane also has its own **smooth** dropdown to pin a filter for that tracker alone.
Touching the global smoothing control resets every pane back to global, so the two
never drift out of sync silently.

## Reading the telemetry

Every pane carries a panel with the live pose and the numbers that matter when judging a
tracker:

| Field | Meaning |
| --- | --- |
| `gap` / `pk` | Mean and worst inter-packet arrival gap, in ms |
| `jit` | Standard deviation of that gap — the tracker's timing consistency |
| `σ(Δ)` | Standard deviation of per-packet rotation deltas, per axis. The noise floor |
| `pkΔ` | Largest single-packet rotation jump seen, per axis |
| `rng` | Min/max angle range covered since the last recenter |
| `rate` | Packets per second on the wire |
| `eff` | Distinct delivery moments per second. If `eff` sits well below `rate`, packets are arriving in clumps rather than at a steady cadence |
| `fps` | Render rate for that pane |

### Comparing trackers

Toggle **compare** for a scoreboard across every pane, with best and worst highlighted
per row. Run two trackers off the same head at once and the differences are immediate.

| Row | Meaning |
| --- | --- |
| `rate Hz` | Wire rate. Deliberately unranked — padding the stream with duplicates inflates it |
| `eff Hz` | Delivery cadence after collapsing clumps. The honest version of `rate` |
| `jit ms σ` | Arrival-time jitter |
| `dup %` | Share of packets identical to the previous one — a tracker padding its output rate |
| `rev %` | Share of direction changes per axis. High values mean dither rather than motion |
| `pk step °` | Largest single-packet jump. Spikes show up here before you feel them |
| `σΔ °` | Noise floor |
| `xtalk \|r\|` | Correlation between translation and rotation deltas — how much a solver leaks one into the other. Unranked, because noise dilutes the correlation and can flatter a noisy tracker |
| `lag ms` | Lag against the reference pane, from peak yaw cross-correlation. Needs real head motion; a flat signal correlates with everything and shows `—` |

The scoreboard assumes every tracker is following the same head.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `HTTP_PORT` | `8080` | Port the viewer and WebSocket are served on |
| `UDP_PORT` | `4242` | Base UDP port. Player *n* listens on `UDP_PORT + n` |

`GET /healthz` returns the listener state as JSON and backs the image's `HEALTHCHECK`.

Two tuning constants live at the top of `public/renderer.js`:

- `TRANSLATION_SCALE` — gain applied to incoming cm → scene metres.
- `INVERT_Z` — flip the Z axis if "lean forward" goes the wrong way for your filter setup.

## Scenes

Seven, all procedural, all in `public/renderer.js`:

plaza · city · forest · space · desert · volcano · aurora camp

The upcoming scene in cycle order is built and shader-compiled in the background so
switching doesn't hitch. `npm run screenshots` captures one PNG per scene into
`screenshots/` if you want to eyeball them all at once.

## Development

Everything runs in containers; [pixi](https://pixi.sh) drives it, and CI runs the same
commands you do.

```sh
pixi run test     # run the suite against the real server, inside the image
pixi run smoke    # build the image, boot it, drive HTTP + WS + a UDP pose through it
pixi run verify   # both of the above
pixi run dev      # run the image on http://localhost:9999 with UDP 4242-4245 published
```

The Dockerfile is the single build recipe: `pixi run build` and the release workflow
both go through it, so there is no second copy of the build to drift.

See [`tests/README.md`](tests/README.md) for what the suite covers and, just as usefully,
what it doesn't.

## Releasing

Push a `v*` tag. The release workflow re-runs CI, builds `linux/amd64` and `linux/arm64`,
and pushes to Docker Hub and GHCR with semver tags plus provenance and an SBOM, then
opens a GitHub release.

Docker Hub needs two repository secrets: `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
GHCR uses the workflow's own `GITHUB_TOKEN`.

## Licence

MIT — see [LICENSE](LICENSE).

Bundles [three.js](https://github.com/mrdoob/three.js) r160, also MIT; see
[`public/vendor/README.md`](public/vendor/README.md).
