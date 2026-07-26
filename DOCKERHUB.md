# head-tracking-tester

A browser-based 6DoF viewer for [OpenTrack](https://github.com/opentrack/opentrack) UDP
output, and a bench for judging how good a tracker actually is. Point up to four trackers
at it, watch them drive the same scene side by side, and read off rate, jitter, noise,
duplicate frames and relative lag for each one.

A small Node bridge listens for OpenTrack UDP packets and forwards parsed poses to the
page over a WebSocket. The page renders a Three.js scene per tracker. No build step, no
CDN, no telemetry leaving your machine.

**Source:** <https://github.com/itsloopyo/head-tracking-tester>
**Licence:** MIT

## Quick start

Works the same on Windows, macOS and Linux:

```sh
docker run --rm --name htt \
  -p 8080:8080 \
  -p 4242:4242/udp -p 4243:4243/udp -p 4244:4244/udp -p 4245:4245/udp \
  itsloopyo/head-tracking-tester
```

Open <http://localhost:8080>. Listeners bind automatically. Pick 1 to 4 players in the
toolbar and each pane takes one consecutive UDP port from 4242 up. Point OpenTrack at
UDP 4242.

If the run fails with `address already in use`, something else on your machine has port
8080. Change the number on the left of the colon and use that instead, for example
`-p 9999:8080`, then open <http://localhost:9999>.

### On a Linux host

Host networking saves you publishing each UDP port, because OpenTrack can then reach the
container directly:

```sh
docker run --rm --network=host itsloopyo/head-tracking-tester
```

This only works on a real Linux host. On Docker Desktop for Windows or macOS,
`--network=host` puts the container in the Linux VM's network namespace, so
`localhost:8080` on your machine will not reach it. Use the published-ports command
above instead.

## Tags

| Tag | Meaning |
| --- | --- |
| `latest` | Most recent release |
| `0.0.1` | Exact version |
| `0.0` | Latest patch of that minor |
| `0` | Latest minor of that major |

Built for `linux/amd64` and `linux/arm64`, and published with build provenance and an
SBOM. The same images are mirrored to `ghcr.io/itsloopyo/head-tracking-tester`.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `HTTP_PORT` | `8080` | Port the viewer and WebSocket are served on |
| `UDP_PORT` | `4242` | Base UDP port. Player *n* listens on `UDP_PORT + n` |

Exposed ports: `8080/tcp`, and `4242/udp` through `4245/udp` for the four players.

`GET /healthz` returns listener state as JSON and backs the image's `HEALTHCHECK`, so
`docker ps` and any orchestrator will show the container as healthy only once it is
actually serving.

## OpenTrack setup

Set **Output** to **UDP over network** and point it at the machine running this container
on port 4242. The second tracker uses 4243, and so on.

The wire format is OpenTrack's default: six little-endian `float64`s per packet, ordered
`X, Y, Z, Yaw, Pitch, Roll`, with translation in cm and rotation in degrees. Anything that
speaks that format works, so nothing here is OpenTrack-specific.

## What you get

**Up to four trackers at once.** Each pane takes its own UDP port, renders its own view of
the scene, and can be renamed.

**Per-pane telemetry.** Arrival gap and jitter, per-packet rotation noise, peak steps,
angle range covered, wire rate, and effective delivery cadence with a gap sparkline. That
last one matters: if effective cadence sits well below the wire rate, packets are arriving
in clumps rather than at a steady rate, and no amount of smoothing will hide it.

**A compare panel.** A live scoreboard ranking every pane, with best and worst highlighted
per row:

| Row | Meaning |
| --- | --- |
| `rate Hz` | Wire rate. Deliberately unranked, because padding the stream with duplicates inflates it |
| `eff Hz` | Delivery cadence after collapsing clumps. The honest version of `rate` |
| `jit ms` | Arrival-time jitter |
| `dup %` | Share of packets identical to the previous one, which is a tracker padding its output rate |
| `rev %` | Share of direction changes per axis. High values mean dither rather than motion |
| `pk step` | Largest single-packet jump. Spikes show up here before you feel them |
| `sigma` | Noise floor |
| `xtalk` | Correlation between translation and rotation deltas, so how much a solver leaks one into the other |
| `lag ms` | Lag against the reference pane, from peak yaw cross-correlation |

Run two trackers off the same head at once and the differences are immediate.

**Four smoothing modes.** Off, obra-dinn exponential, 1 euro, and accela, all on a single
responsive to smooth dial, with raw parameters behind an advanced toggle. Any pane can pin
its own filter so you can compare filters as well as trackers.

**Seven procedural scenes:** plaza, city, forest, space, desert, volcano and aurora camp,
with optional auto-cycling.

## Controls

| Input | Action |
| --- | --- |
| **Space** or **R** | Recenter every pane, capturing the current pose as the new zero |
| **W A S D** | Walk around the scene |
| **Shift** | Run |
| Mouse drag | Orbit the camera when a pane is not tracking |
| Click a pane's name | Rename it |

## Image details

Runs as a non-root user on a digest-pinned Node 24 Alpine base. Only the server, the
static viewer and the production dependency tree are in the image, with no tests, tooling
or build scripts. It handles `SIGTERM`, so `docker stop` returns in well under a second
rather than waiting out the kill timeout.

The one runtime dependency is `ws`.

## Full documentation

See the [README on GitHub](https://github.com/itsloopyo/head-tracking-tester#readme) for
the complete telemetry reference, development setup and release process. Issues and pull
requests are welcome at
<https://github.com/itsloopyo/head-tracking-tester/issues>.
