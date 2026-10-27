# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A browser-side 3D Gaussian Splatting viewer. `web/index.html` loads `web/src/main.js`, which decodes and
renders 3DGS models in real time with Three.js +
[gaussian-splat-lite](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite). The camera is optional: its
feed is shown only in a small preview in the top-right corner, and clicking “Hand Sync” drives up to two
mirrored skinned hands via MediaPipe → MANO.

The repo **does not include a model-generation pipeline**. The earlier Apple SHARP single-image → 3DGS flow
has been removed (`ml-sharp/`, `output/`, `.venv/`, `build_splat.sh`, `clean_ply.py`); bring your own model
and put it under `web/public/models/`.

## Prerequisites

- **Node.js + npm**: Vite 7 requires Node 20.19+ or 22.12+ (the current dev machine runs v24). `web/` is ESM.
- **WebGL2 browser**: 3DGS rendering requires WebGL2.
- **Camera**: `getUserMedia` only works on `localhost` or HTTPS. Even though `npm run dev` passes `--host`,
  opening the page via a LAN IP makes the browser reject camera access.
- **Python is not needed to run the app.** Only these tools need it:
  - `tools/export_mano.py`: Python 3 + numpy (MANO pkl → JSON);
  - `tools/make_test_ply.py`: numpy + plyfile;
  - `tools/pw/track.js`: needs a `/tmp/hand.y4m` pre-generated with ffmpeg.
- **MANO assets**: `web/public/models/mano_{right,left}.json` are committed so hand mode works out of the
  box, but they remain subject to the MANO research license (Max Planck). Check the upstream terms before
  commercial use or public redistribution. Regenerating them requires the pkl from the
  [MANO website](https://mano.is.tue.mpg.de/).

## Commands

```bash
# One-time setup: web dependencies + MediaPipe wasm + hand_landmarker.task
scripts/setup.sh

# Development / build
cd web
npm run dev        # vite --host, http://localhost:5173 by default
npm run build      # writes web/dist (gitignored)
npm run preview

# Headless smoke tests (start the dev server first)
cd tools/pw
npm install
npx playwright install chromium
NO_PROXY=localhost,127.0.0.1,::1 node test.js "http://localhost:5173/?model=your-model.ply" /tmp/out.png
NO_PROXY=localhost,127.0.0.1,::1 node track.js /tmp/hand.y4m

# Tools (any Python with numpy; -I avoids importing same-named modules from the current directory)
python3 -I tools/export_mano.py MANO_RIGHT.pkl web/public/models/mano_right.json
python3 -I tools/export_mano.py MANO_LEFT.pkl  web/public/models/mano_left.json
python3 -I tools/make_test_ply.py web/public/models/test.ply
```

- `scripts/setup.sh` runs `npm install`, **copies** `node_modules/@mediapipe/tasks-vision/wasm/*` into
  `web/public/wasm/`, and downloads `hand_landmarker.task` if missing. Re-run it after upgrading
  `@mediapipe/tasks-vision`, otherwise the wasm and JS versions mismatch.
- It does **not** download 3DGS models and does **not** generate MANO JSON; without the MANO JSON, hand
  sync falls back to the capsule placeholder hand.
- `test.js` waits for `window.__demo.state.numSplats > 0` then takes a screenshot. `track.js` plays a y4m
  through a fake camera and waits for `window.__hand.tracker().landmarker` and
  `window.__hand.rig.lastSeen > 0`.
- Headless runs use SwiftShader software rendering; the 5–7 fps in screenshots does **not** represent real
  hardware. Use it only to verify that the app loads and renders.
- If `http_proxy` is set locally, localhost requests also go through the proxy: scripts need `NO_PROXY`,
  and the browser needs `--no-proxy-server` (the existing scripts already handle this).

## Architecture

### Page entry

- `web/index.html` → `/src/main.js`. `main.js` depends on fixed DOM ids in index.html
  (`#model-status`, `#btn-hand`, `#file-input`, etc.); check the `els` table before changing the page.
- `#canvas-host` must keep `pointer-events: auto` so `OrbitControls` receives drag and wheel events.
  `#hud` is a transparent overlay (`pointer-events: none`) whose panels opt back in with
  `pointer-events: auto`, so buttons stay clickable.
- `web/src/viewer.js` + `ply-detect.js` are a **standalone prototype** that no page imports: they support
  3DGS PLY, mesh PLY with faces, and point-cloud PLY without faces. `viewer.js` expects a DOM that
  index.html does not have (`#stats`, `#btn-open`, `#url-input`, etc.). Do not assume it runs; wiring it up
  requires a new page/CSS and a Vite multi-page entry for production builds.

### Model loading and framing (main.js)

- Scene hierarchy: `pivot` (whole-model position and spin) → `orient` (up-axis flip) → `holder` (model
  container). `GaussianSplatRenderer` is attached directly to `scene`.
- Spin: when `state.spin` is on, `pivot.quaternion` is premultiplied by a small delta around
  `camera.up`, so the turntable axis is the current **screen vertical**, not the model's local Y. Do not
  move this back to `holder.rotation.y`; after pitching or panning that axis stops matching the page.
- The renderer deliberately uses `antialias: false` (splats do not need MSAA), `preBlurAmount: 0`, and
  `blurAmount: 0.3` to avoid a white halo around Gaussian outlines.
- Loading: `new SplatMesh({ file | url })` → `await mesh.initialized`. Supports `.ply` as well as
  `.spz` / `.sog` / `.rad`. Errors mentioning compressed / packed_position / min_scale_x / chunk usually
  mean the encoding is unsupported.
- Framing: `robustFit()` samples up to ~200k centers via
  `mesh.splats.forEachCenter((index, x, y, z) => …)`, takes the 2%–98% percentiles for the subject center
  and bounding sphere, translates the model to the center, then derives the camera distance from the
  bounding sphere + FOV. **The model itself is never scaled**, preserving the reconstruction's original
  scale.
- Camera: `TrackballControls` uses left-drag free rotation and wheel dolly; right is unbound. Trackball
  (rather than `OrbitControls`) is deliberate: orbit controls clamp the polar angle at the top/bottom,
  which feels like an invisible wall when tumbling past the poles. Middle-drag pan is **not**
  TrackballControls' built-in pan (`noPan = true`, `MIDDLE = null`): that one scales by screen aspect and
  feels uneven. `main.js` implements a pointer handler that converts pixels to world units with the
  camera FOV, giving 1:1 panning. `F` re-fits the model.
  `applyFit()` sets the initial distance, target, and `camera.up`; `updateClipping()` derives `near/far`
  from the camera distance every frame, so model scales from millimeters to kilometers stay visible.
  Hand mode disables the controls, fixes the camera at the origin, and restores the saved position, up
  vector, and target on exit.
- Up axis: the default assumes OpenCV/COLMAP (+Y down) and flips 180° around X; `?up=1` skips the flip,
  and the “Flip” toolbar button toggles it manually.
- Only three URL parameters: `?model=` (a filename under `web/public/models/` or a full URL), `?hand=1`,
  and `?up=1`. `?raw` / `?fov` were removed together with SHARP.
- Debug hooks: `window.__demo` (scene/camera/state/loadSplat) and
  `window.__hand` (rigs/tracker/enable/disable).

### Hand mode (main.js + mano.js + hand.js)

- `enableHandMode()`: hides `pivot`, opens the camera, loads four rigs in parallel (2 hand slots ×
  left/right assets), and initializes `HandTracker`. If MANO assets fail, it falls back to the capsule
  hand in `hand.js`.
- `mano.js` builds `/models/mano_{right,left}.json` into a 16-bone `SkinnedMesh`, derives each bone's
  local quaternion from MediaPipe's `worldLandmarks`, and slerps for smoothing. The whole hand is mirrored
  with `scale.x = -1`, and screen positions use the mirrored coordinates too, so the main view matches the
  top-right preview.
- The hand camera is fixed at the origin, and hands sit at `HAND_Z = -0.56`. **Hand mode must explicitly
  set `camera.near = 0.01; camera.far = 20;`**; never inherit model-scale `near/far`—a large model's
  `near` can exceed the hand distance and clip the entire hand. This was a real regression after removing
  SHARP framing; verify any camera change with `track.js`.
- After 300 ms without a detected hand, all hand models are hidden. MediaPipe only runs inference when the
  video frame changes; the GPU delegate falls back to CPU.

### Assets and ignored files

- **No 3DGS sample models are bundled.** `web/public/models/` contains only the hand assets
  (`mano_{right,left}.json`, `hand_landmarker.task`, `NOTICE.md`); users bring their own models or pass a
  `?model=` URL. `loadDefaultModel()` shows “未加载模型” when no `?model=` is given.
- `web/public/models/*.ply` and `web/public/wasm/` are gitignored: the model files are large, and the wasm
  runtime is copied from `node_modules` by `scripts/setup.sh`.
- `web/public/models/mano_{right,left}.json` and `hand_landmarker.task` are committed so hand mode works
  without extra downloads; see `web/public/models/NOTICE.md` for the MANO license note.
- Vite maps `web/public` to the site root, so code hardcodes `/wasm` and `/models/...`.
- `web/dist`, `node_modules`, `.idea`, and `.DS_Store` are never committed.

## Conventions

- Source comments, README, and UI strings are in Chinese; commit messages are in English (see the
  Conventional Commits rules below). Match the surrounding comment density and tone when editing.
- When changing URL parameters, supported formats, commands, or asset paths, update both `README.md` and
  this file.
- After changing framing/camera code, verify both model mode and hand mode; `track.js` is the hand-mode
  regression test.
- Do not reintroduce SHARP-specific assumptions (camera at origin, `?raw`, `?fov`, angular FOV framing)
  into `main.js`; framing makes no assumptions about the model's source, and the only convention is the
  default up flip.
- `viewer.js` is still a prototype. If it is adopted, first decide how it relates to the `main.js` entry,
  then remove the duplicate loading logic; do not maintain two renderers that silently diverge.
- Do not commit large files, and do not use `git add -f` to bypass `.gitignore`.

## Git conventions

### What goes into a commit

- **Source, docs, config and the hand assets.** Never commit `node_modules/`, `web/dist/`,
  `web/public/models/*.ply`, `web/public/wasm/`, `.idea/`, or OS files.
- **Hand assets are committed intentionally**: `mano_{right,left}.json` and `hand_landmarker.task` ship
  with the repo so hand mode needs no extra download. Keep `web/public/models/NOTICE.md`; never add the
  raw MANO pkl.
- **No `git add -f`** to bypass `.gitignore` for generated output.
- Keep related changes together; keep pure refactors separate from behavior changes.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), in English, imperative mood:

```
<type>(<scope>): <subject>
```

- **type** (required): `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
  `chore`, `revert`.
  - `feat` — user-visible capability or behavior
  - `fix` — bug fix
  - `build` / `deps` — dependency or toolchain bumps
  - `docs` — `README.md`, `CLAUDE.md`, comments-only changes
  - `perf` — performance-only changes
  - `test` — test-only changes
  - `chore` — housekeeping that fits no other type (`.gitignore`, file moves)
- **scope** (optional): the area, e.g. `web`, `viewer`, `hand`, `mano`, `ply`, `deps`. Omit it for
  repo-wide changes.
- **subject**: lowercase after the colon, imperative, ≤ 72 characters including the prefix, no trailing
  period.
- **One line only**: no body and no footer. If the reason is not obvious, fold a short clause into the
  subject.
- **Breaking change**: add `!` before the colon
  (`feat(web)!: drop SHARP and use generic PLY auto-framing`).
- No tool/agent attribution.

Examples:

```
feat: scaffold single-image 3DGS viewer with mirrored MANO hands
fix(mano): keep the hand inside the camera near plane
docs: document the generic PLY viewer prototype
```

### When to commit and push

- Commit only when the user asks; do not commit as a side effect of another task.
- Push only when the user asks. No remote is configured.
- `main` is the default branch; develop on it directly.
- Before committing, run `cd web && npm run build`. For camera/framing or hand changes, also run
  `node tools/pw/track.js` with the dev server up.
