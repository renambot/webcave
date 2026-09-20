# Applications

One folder per application. A folder is an application when its `index.ts`
default-exports an `AppDefinition` (see `types.ts`). The registry in
`index.ts` discovers folders with `import.meta.glob`, so there is nothing to
register.

```
src/apps/
  types.ts        CaveApp, AppDefinition, AppSpec
  index.ts        registry: createApp(spec), appSpecFromParams(params, base)
  shapes/         basic animated shapes            (scene app)
  gltf/           glTF / GLB model loader          (scene app)
  vdb/            OpenVDB volume ray-marcher       (scene app; blosc.ts, leafValues.ts, tree.ts decode the file)
  points/         OpenVDB PointDataGrid point cloud (scene app; pointsReader.ts decodes the multi-pass buffers)
  map/            MapLibre map across a wall       (flat app; wallmap.ts = shared MapLibre machinery)
  density/        2D choropleth on MapLibre        (flat app, built on map/wallmap.ts)
  map2d/          clustered earthquakes, donut markers (flat app, built on map/wallmap.ts)
  dotdensity/     Toronto dot-density map on deck.gl with a control panel (flat app; panel.ts is the sidebar)
  aquarium/       WebGL Aquarium as a raw WebGL app (raw app; the adapted program is public/aquarium/aquarium-core.js)
  metaballs/      WebGPU Metaballs (webgpu app; vendor/ is the original project, renderer.ts feeds it the CAVE's views)
  hackernews/     Hacker News front page on a curved wall (scene app; data.ts fetches the API, cards.ts rasterizes
                                                    the cards through HTML-in-canvas or Canvas 2D, panel.ts the sidebar)
  crayoland/      Dave Pape's Crayoland, ported    (scene app; world.ts parses the original files,
                                                    creatures.ts deterministic bees and butterflies,
                                                    sound.ts Web Audio soundscape)
  <yours>/        index.ts (+ any helpers, shaders, data)
```

Four kinds of app share the folder convention:

- **Scene apps** own a `THREE.Scene`; WebCAVE renders it per screen with
  off-axis cameras, stereo and navigation. For 3D content.
- **Raw apps** draw with their own WebGL code: `render(ctx)` runs once per
  eye per screen with the context, the off-axis view / projection matrices
  and the bound eye target. For existing WebGL programs (see `aquarium/`).
- **WebGPU apps** get the same matrices and an OffscreenCanvas per eye to
  render into; WebCAVE copies the image into the eye target (see `metaballs/`).
  Mind WebGPU's 0..1 depth range against the GL projection you are given.
- **Flat apps** render themselves (2D) into a container per screen and get
  the screen's rectangle in the overall wall image. For maps, documents,
  dashboards. Stereo and navigation do not apply.

## Contract

An application owns a `THREE.Scene` and advances it from the cluster's
simulation time. WebCAVE owns cameras, stereo, screens and navigation.

```ts
// src/apps/myapp/index.ts
import * as THREE from "three";
import type { AppContext, AppDefinition, AppSpec, CaveApp } from "../types";

function create(spec: AppSpec, ctx: AppContext): CaveApp {
  // ctx.audio: this window is the cluster's speaker (config `audio: true` on the node, or ?audio=1)
  // ctx.debug: debug drawing wanted (the simulator's debug button, or ?debug=1)
  const scene = new THREE.Scene();
  // build the scene; the physical floor is y = 0, the viewer stands near the origin,
  // the front wall of the 3 m CAVE is at z = -1.5
  return {
    name: "myapp",
    scene,
    ready: Promise.resolve(),   // or a promise that resolves when assets are loaded
    status: "ready",            // shown in HUDs; update it while loading
    update(time, state) {       // seconds since cluster start; must be deterministic
      // animate from `time` only, never from Date.now() or frame deltas.
      // For anything that spins, use spinTime(state, time) from "../types":
      // it follows the shared spin clock, which Space in the simulator
      // pauses and resumes for every screen at once.
    },
    // optional: how the standard navigation moves through this world
    navigation: { flySpeed: 2, turnSpeed: 1.2, planar: false },
    // optional: live switches for the simulator's audio and debug buttons
    setAudio(on) {}, setDebug(on) {},
    dispose() {},               // optional
  };
}

export default {
  name: "myapp",                // must equal the folder name
  description: "What it shows",
  create,
} satisfies AppDefinition;
```

Rules that keep every node in step:

- Derive all motion from `time`. No `Date.now()`, no `Math.random()` at
  runtime, no per-frame deltas. For randomness use `src/core/random.ts`:
  `hash(frame, i)` for stateless per-frame jitter, `Rng(seed)` for a
  simulation stepped at a fixed rate from time 0 (a late-joining node
  fast-forwards to the current step), `noise1(t, seed)` for smooth wander.
- Do not touch cameras or the renderer. The head, the wand and the navigation
  are in `state` (`state.head`, `state.wand`, `state.navigation`, CAVE frame,
  meters); convert them to world coordinates with `caveToWorld()` from
  `src/core/navigation.ts` when the scene needs to react to where they are.
- Static assets go in `public/` and are referenced as `/path/file`, so every
  node fetches the same URL. Large assets should load asynchronously with a
  placeholder while `ready` is pending.
- Lights are yours. There is no environment map yet, so PBR materials need
  generous direct light.

## Raw WebGL app contract

```ts
import type { AppDefinition, AppSpec, RawApp, RawRenderContext } from "../types";

function create(spec: AppSpec): RawApp {
  const perContext = new Map<WebGLRenderingContext, MyResources>(); // resources belong to a context
  return {
    kind: "raw",
    name: "myraw",
    ready: Promise.resolve(),
    status: "ready",
    update(time, state) { /* advance from cluster time only */ },
    render(ctx: RawRenderContext) {
      // ctx.gl, ctx.view, ctx.viewInverse, ctx.projection (column-major, meters, world frame),
      // ctx.eyePosition, ctx.width/height; framebuffer and viewport already bound. Draw, return.
      let r = perContext.get(ctx.gl) ?? init(ctx.gl);
      r.draw(ctx.projection, ctx.view);
    },
  };
}
export default { name: "myraw", description: "…", create } satisfies AppDefinition;
```

WebCAVE resets its own GL state around `render`, so leave any state you like,
but do not swap or rebind the default framebuffer. Multisampled eye targets
are resolved for you.

## Flat app contract

```ts
// src/apps/myflat/index.ts
import type { AppDefinition, AppSpec, FlatApp, FlatView } from "../types";

function create(spec: AppSpec): FlatApp {
  return {
    kind: "flat",
    name: "myflat",
    ready: Promise.resolve(),
    status: "ready",
    createView(container, screen, layout, opts): FlatView {
      // layout.rects[screen.id] = { x, y, w, h } in wall pixels; layout.widthPx/heightPx = whole wall.
      // Show exactly that rectangle of your picture so neighbouring screens join.
      const el = document.createElement("canvas");
      container.append(el);
      return {
        canvas: el,
        render(state) {
          // Draw from state.appState (shared, Manager-owned) and state.time. Never from local input.
          // If opts.interactive, handle input here and call opts.send({ myflat: {...} }) with the new state.
        },
        resize(w, h) { /* container is now w x h CSS px; scale native-pixel offsets by w / rect.w */ },
        dispose() { el.remove(); },
      };
    },
  };
}

export default { name: "myflat", description: "…", create } satisfies AppDefinition;
```

Shared state is the whole trick. Interactive views (controllers) report
changes with `opts.send(patch)`; the Manager shallow-merges the patch into
`appState` and includes it in every frame; every view, interactive or not,
draws from `state.appState`. Guard against your own echo: ignore incoming
state for a moment after you sent one. `src/apps/map/index.ts` is a complete
example, including how MapLibre is made to render an exact sub-rectangle of
a larger view.

## MapLibre-based apps

`map/wallmap.ts` does the hard part for any MapLibre app: exact
sub-rectangles per tile, the shared camera, interaction from controllers.
An app on top of it is a `WallMapDefinition`: default `style`, `center`,
`zoom`, `pitch`, `bearing`, `autoRotate`, and a `setup(map, opts)` that adds
sources and layers when the style has loaded (read your own options from
`opts.raw`). See `density/index.ts`, thirty lines including the layer, and
`map2d/index.ts` for clustering, HTML markers and `renderWorldCopies: false`.

## Input

Never read the keyboard or gamepads yourself; every node must see the same
input. Two ways in:

- `inputOf(state)` (from `../input/actions` or `"../index"`) returns the
  replicated action state of the frame: `move`, `look`, `fly`, `dpad` axes and
  the buttons. Read it in `update(time, state)` on every node; detect a press
  by comparing with the previous frame.
- `onInput(actions, dt, state, send)` runs on input clients only (the
  simulator, and nodes with `input: true`). Use it when
  the reaction is a shared-state change (the map moves its camera with
  `send({ map: ... })`). Set `ownsNavigation: true` on a flat app to keep the
  sticks from also flying the CAVE.

Standard bindings (navigation, reset, spin) are handled for you. A scene app
can tune them with `navigation: { flySpeed, turnSpeed, planar }` (m/s, rad/s,
and whether to stay on the ground).

## The wand and user reactions

`state.wand` is the tracked hand-held controller (position and orientation,
CAVE frame). Its buttons are the ordinary actions (`primary` = Enter or
gamepad A; Crayoland also takes `tertiary`, gamepad X). The pattern Crayoland uses for everything the user does to the
world: the controller's `onInput` sees the wand, decides ("grabbed object 12
with this offset", "the bees are angry since t") and publishes a compact
record with `send`; every node's `update()` turns that record plus `time` and
the current wand into geometry (the held flower hangs off the wand matrix, a
thrown one follows its parabola from `p0, v0, t0`). Nothing accumulates on
the nodes, so any node can join at any time and agree with the others.

## Control panels

`createPanel(container, ctx)` is the app's sidebar, mounted by the simulator
(a third column) and by `panel.html` (full page, for a tablet), never on the
wall. Build controls into `container`; each one calls `ctx.send(patch)`;
return `{ update(state), dispose() }` and mirror `state.appState` into the
controls in `update`, so every open panel shows the same thing as the wall.
Wall map definitions get an `onFrame(map, state, view)` hook to rebuild
layers when that state changes. `dotdensity/panel.ts` is the example.

## Sound

Only the window with `ctx.audio` should make sound (one machine drives the
speakers). Create the `AudioContext` on the first click or key press (the
browser requires a gesture), fetch and decode your samples, and drive gains
from `update()` using the head position from the frame. Implement the optional
`setAudio(enabled)` so the simulator's audio button can switch sound at
runtime; it is called from a click, so starting the context inside it is
allowed. `crayoland/sound.ts` is a complete example with loops, random calls,
triggers and footsteps.

## Selecting an app

The app spec travels in the cluster config, so all nodes run the same one:

```sh
npm run manager -- --app myapp
npm run manager -- --model /models/Thing.glb --size 1 --spin 0.2   # gltf shorthand
```

For development, URL parameters override on the simulator or a node:
`?app=myapp`, and for gltf `model=`, `size=`, `spin=`, `mx= my= mz=`.
Crayoland: `?app=crayoland`, with `model=/other/folder/` to load another
`World` and its textures.
Extra options for your own app: read them from `spec` (add fields to
`AppSpec` in `src/core/config.ts`) and, if useful, from the URL in
`appSpecFromParams`.
