# Changelog

Notable changes per release. Versions follow [semver](https://semver.org); the
Docker Hub tags mirror them (`0.0.1`, `0.0`, `0`, `latest`).

## Unreleased

First public release. What's in it:

- **1–4 trackers side by side.** Each pane takes a consecutive UDP port from
  `UDP_PORT` up, renders its own view of the scene, and can be renamed.
- **Per-pane telemetry** — arrival gap and jitter, per-packet rotation noise,
  peak steps, angle range covered, wire rate, and effective delivery cadence
  with a gap sparkline so a stream arriving in clumps is visible rather than
  hiding behind a healthy-looking rate.
- **compare panel** — a live scoreboard ranking every pane on rate, effective
  cadence, jitter, duplicate frames, direction reversals, peak step, noise
  floor, translation/rotation cross-talk, and lag against a reference tracker
  from peak yaw cross-correlation.
- **Four smoothing modes** (off, obra-dinn exponential, 1€, accela) on a single
  responsive ↔ smooth dial, with raw parameters behind **advanced**. Any pane
  can pin its own filter; touching the global control resets them all back.
- **Seven procedural scenes** — plaza, city, forest, space, desert, volcano,
  aurora camp — with optional auto-cycling. The next scene in cycle order
  builds and shader-compiles in the background via `compileAsync`, so switching
  doesn't hitch.
- **Multi-arch image** for `linux/amd64` and `linux/arm64`, running as a
  non-root user on a digest-pinned Node 24 Alpine base, with `GET /healthz`
  behind a `HEALTHCHECK` and sub-second shutdown on `SIGTERM`.

Virtual window mode (1:1 head-coupled off-axis perspective) is implemented but
switched off — the projection isn't right yet. `WINDOW_MODE_AVAILABLE` at the
top of `public/renderer.js` is the switch.
