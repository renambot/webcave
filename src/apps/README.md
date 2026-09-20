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
  <yours>/        index.ts (+ any helpers, shaders, data)
```

Two kinds of app share the folder convention:

- **Scene apps** own a `THREE.Scene`; WebCAVE renders it per screen with
  off-axis cameras, stereo and navigation. For 3D content.
- **Flat apps** render themselves (2D) into a container per screen and get
  the screen's rectangle in the overall wall image. For maps, documents,
  dashboards. Stereo and navigation do not apply.

## Contract

An application owns a `THREE.Scene` and advances it from the cluster's
simulation time. WebCAVE owns cameras, stereo, screens and navigation.

```ts
// src/apps/myapp/index.ts
import * as THREE from "three";
import type { AppDefinition, AppSpec, CaveApp } from "../types";

function create(spec: AppSpec): CaveApp {
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
  runtime (seed anything random at creation), no per-frame deltas.
- Do not touch cameras or the renderer. If you need the head or navigation,
  ask; they belong in the frame state, not in the app.
- Static assets go in `public/` and are referenced as `/path/file`, so every
  node fetches the same URL. Large assets should load asynchronously with a
  placeholder while `ready` is pending.
- Lights are yours. There is no environment map yet, so PBR materials need
  generous direct light.

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
`opts.raw`). See `density/index.ts`, thirty lines including the layer.

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

Standard bindings (navigation, reset, spin) are handled for you.

## Selecting an app

The app spec travels in the cluster config, so all nodes run the same one:

```sh
npm run manager -- --app myapp
npm run manager -- --model /models/Thing.glb --size 1 --spin 0.2   # gltf shorthand
```

For development, URL parameters override on the simulator or a node:
`?app=myapp`, and for gltf `model=`, `size=`, `spin=`, `mx= my= mz=`.
Extra options for your own app: read them from `spec` (add fields to
`AppSpec` in `src/core/config.ts`) and, if useful, from the URL in
`appSpecFromParams`.
