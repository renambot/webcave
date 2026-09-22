# Development notes

## Technology

- **TypeScript** throughout, shared between browser and server
- **Vite** for the dev server and bundling
- **three.js** on **WebGL2** for rendering in v0; WebGPU is the target for the next version
- **WebSocket** (`ws`) for Manager to Node transport; WebTransport planned
- **zod** for validating configuration files and generating their JSON Schema
- **MapLibre GL JS** for the map applications (served unbundled in dev: Vite's pre-bundling breaks its worker URL, hence `optimizeDeps.exclude` in `vite.config.ts`)
- **openvdb** (npm) for OpenVDB topology, plus in-house decoders for leaf buffers, point-data buffers and Blosc/LZ4 (`src/apps/vdb/`, `src/apps/points/`)
- **Node.js** for the Manager server, run with `tsx`
- Off-axis projection after Kooima's generalized perspective; anaglyph after Dubois' least-squares method

## Layout

```
configs/        cluster configuration files (JSON) and their generated schema; trackers/ holds the tracking bridge configs and schema
docs/           this documentation and the specification
src/core/       config types, config file schema and loader, projection math, wall pixel layout, protocol, ClusterManager (transport-agnostic), Window Management helpers, navigation (CAVE <-> world) and deterministic random helpers
src/input/      input abstraction: action vocabulary, keyboard and gamepad devices with profiles, InputController
src/manager/    WebSocket server wrapping ClusterManager
src/tracker/    tracking bridge: DTrack, NatNet and VRPN sources, calibration, config schema, CLI
src/node/       render node page
src/launcher/   node launcher: displays of this computer, one window per screen
src/panel/      panel page: mounts an app's createPanel() as a controller, no views
src/core/base.ts  base path (Vite base) helpers: publicUrl(), defaultManagerUrl()
src/xr/         headset viewer: the app in an immersive WebXR session as a controller, headset as head and wand
src/simulator/  in-page cluster with in-memory transport, or controller of a live Manager
src/apps/       application contract and auto-discovering registry; one folder per app
src/render/     per-screen viewport renderer, stereo packer, off-axis helper, 3D overview
public/models/  sample glTF assets
public/volumes/ OpenVDB files for the vdb and points apps (not in the repository)
public/crayoland/ Crayoland's original World, Sounds, textures, ground masks, hand models, sounds as MP3
public/aquarium/  WebGL Aquarium: tdl library, adapted core, shaders, models and textures (BSD)
public/metaballs/ prebuilt web-texture-tool loader and KTX2 / Basis transcoder workers for the metaballs app (media is fetched remotely)
scripts/        launch-nodes.sh (one kiosk Chrome per display), gen-schema.ts, screenshot.mjs, fake-tracker.ts (pretend DTrack / NatNet / VRPN)
index.html, simulator.html, node.html, launcher.html, panel.html (an app's control panel alone, for a tablet), xr.html (the headset viewer)
```

## Frame protocol

The Manager owns the frame counter; simulation time is `frame / fps`, so every node computes the same poses without a shared wall clock. Per frame it sends `frame {state}` with the head and wand poses, navigation and the shared app state, waits for `ack` from every node in barrier mode (with a timeout, after which late nodes are reported), then sends `present {frame}` so all screens flip together. Loose mode skips the wait. Clients send `hello`, `ack`, `setHead`, `setWand` (absolute from a tracker, or a head-relative offset), `setNavigation` / `navigate`, `setStereo` (live stereo settings, sent on in every frame as `state.stereo`), `setAppState {patch}` and `input {actions}`. Messages are defined in `src/core/protocol.ts`; the logic is in `src/core/manager.ts`, which the WebSocket server and the in-memory simulator both wrap.

## Testing pages headlessly

`scripts/screenshot.mjs` drives a headless Chrome through the DevTools protocol, lets the page run for a few seconds of wall-clock time, and can send a drag, a timed key press and evaluate an expression before capturing:

```sh
node scripts/screenshot.mjs <url> <out.png> [seconds=10] [width=1600] [height=900]
node scripts/screenshot.mjs "http://localhost:5173/simulator.html?config=wall-3x1&app=map" out.png 12
node scripts/screenshot.mjs URL out.png --key "i,1,2" --eval "webcave.lastState().navigation"   # hold I for 2 s after 1 s
node scripts/screenshot.mjs URL out.png --drag "400,300,600,300,5"                              # drag after 5 s
```

Chrome's own `--screenshot` flag runs only a few animation frames and is not usable for pages that load asynchronously, such as the maps. The simulator and node pages expose `window.webcave` (config, app, tiles or viewport, and `lastState()` for the latest frame) for such checks.

## Building

`npm run build` produces `dist/` (with `BASE_PATH=/prefix/` for a deployment under a path) and `npm run build:manager` bundles the Manager into `dist-manager/server.mjs` with esbuild (`scripts/build-manager.mjs`); the `Dockerfile` runs both and packages them as the `web` (nginx) and `manager` images described in [deployment.md](deployment.md#docker-behind-a-reverse-proxy).

## Regenerating the config schema

```sh
npm run schema
```

Rewrites `configs/schema.json` from the zod schema in `src/core/configFile.ts` and `configs/trackers/schema.json` from `src/tracker/config.ts`, and validates every file in both folders.
