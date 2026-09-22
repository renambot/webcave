# Applications

An application owns a three.js scene and advances it from the cluster's simulation time. WebCAVE handles cameras, stereo and screens. Eleven are included, in `src/apps/`:

| Name | What it shows | Options |
|---|---|---|
| `shapes` (default) | Basic animated shapes in and around the CAVE, with shadows on the floor; button A (Enter on the keyboard) toggles a slow rotation of the arrangement | none |
| `gltf` | One glTF / GLB model, fitted, placed in the CAVE and slowly spinning; animations play from cluster time | `model` URL, `size` (largest dimension, m), `spin` (rad/s), position |
| `map` | MapLibre GL JS map with 3D buildings (OpenFreeMap tiles) spread across a display wall; a *flat* app, see below | `style` URL, `center` lng,lat, `zoom`, `pitch`, `bearing`, `buildings`, `autoRotate` (deg/s, default 0) |
| `vdb` | OpenVDB volume (smoke, clouds) ray-marched in the CAVE; the file is fetched and decoded in the browser | `vdb` URL, `grid`, `size`, `spin`, position, `density` (multiplier), `steps`, `color`, `maxDim`, `lightDir` |
| `points` | OpenVDB PointDataGrid (particles) as a point cloud, decoded in the browser; colours from `Cd` when present | `points` URL, `grid`, `size`, `spin`, position, `maxPoints`, `pointSize`, `colorAttribute`, `color` |
| `density` | 2D choropleth of population density from a GeoJSON (MapLibre's "visualize population density" example, Rwanda provinces); same wall and camera machinery as `map` | the `map` camera options plus `data` (GeoJSON URL with `population` and `sq-km` per feature), `opacity` |
| `map2d` | Clustered earthquakes with SVG donut-chart clusters (MapLibre's "display HTML clusters with custom properties" example) on the example's own demo-tiles basemap, the world spanning the wall once; same wall and camera machinery as `map` | the `map` camera options plus `data` (GeoJSON URL of points with a numeric `mag`), `clusterRadius` (pixels, 80) |
| `dotdensity` | Toronto 2021 dot-density map (School of Cities): 278,000 deck.gl dots, one per ten people, coloured by a census field chosen in a control panel; dark basemap, dot size and a 3D mode | the `map` camera options plus `data` (CSV URL), `labels` (place labels JSON), `summaries` (folder of legend CSVs) |
| `aquarium` | The WebGL Aquarium (Google, 2009) as a raw WebGL app: the CAVE stands in the tank and up to 30,000 fish swim through the room; fish count, options, lasers and speed in a panel | `model` (folder URL with the assets; default `/aquarium/`), option `scale` (meters per aquarium unit, 0.1) |
| `metaballs` | WebGPU Metaballs (Brandon Jones, the WebGPU Samples entry): GPU marching cubes shaded as lava, water or slime in a clustered-lit dungeon; WebCAVE's first WebGPU app, with style, resolution and stats in a panel | `model` (media folder URL; default the project's GitHub Pages), option `offset` (scene position in the CAVE frame, meters, default `[0, 0, -1.8]`) |
| `hackernews` | The Hacker News front page as a reading room: the top thirty stories from the public JSON API as cards on a curved wall around the viewer; point the wand at one and press A to open its comments on a panel in front; a mock-up of HTML content in the CAVE, rasterized through Chrome's HTML-in-canvas API when available and Canvas 2D otherwise | options `count` (stories, default 30), `tier` (`canvas2d` to force the fallback) |
| `crayoland` | Dave Pape's Crayoland (EVL, 1995): a crayon-drawn meadow with bees, butterflies, flies, and flowers and rocks to grab and throw with the wand; birds, frogs, a stream and the hive's hum on the audio node | `model` (folder URL with `World`, `Sounds`, `tex/`, `audio/`; default `/crayoland/`), options `world`, `sounds` (file names); with the simulator's debug button or `?debug=1`: pick spheres, wand point, touched object highlighted |

A deployment can leave apps out of the build with `VITE_APPS_DISABLED=map,density,...` (folder names), see [deployment.md](deployment.md#docker-behind-a-reverse-proxy); the rest of this page assumes the full build.

The application is part of the cluster config, so every Node runs the same one. Set it on the Manager:

```sh
npm run manager -- --app gltf --model /models/DamagedHelmet.glb --size 0.8 --spin 0.3
```

For development, URL parameters override it on the simulator or a Node: `?app=gltf&model=/models/DamagedHelmet.glb&size=0.8&spin=0.3&mx=0&my=1.5&mz=-1.05`. Files under `public/` are served at the root, so drop a `.glb` in `public/models/` and reference it as `/models/name.glb`. The bundled Damaged Helmet is a Khronos sample, CC BY 4.0 (see `public/models/README.md`).

There are four kinds of application. **Scene apps** (shapes, gltf, vdb, points, crayoland, hackernews) own a three.js scene that WebCAVE renders from each screen's off-axis camera, with stereo and navigation. **Raw apps** (aquarium) draw with their own WebGL code: WebCAVE binds the eye's render target and hands over the off-axis view and projection matrices, once per eye, and the app issues its own draw calls. **WebGPU apps** (metaballs) get the same matrices and an offscreen canvas per eye to render into; WebCAVE copies the image into the eye target, so stereo packing stays in WebGL. **Flat apps** (map, density, map2d, dotdensity) are 2D: they render themselves into a container per screen and receive the screen's rectangle in the overall wall image, so adjacent screens join into one picture. Stereo does not apply to flat apps.

## Adding an application

An application is a folder under `src/apps/` whose `index.ts` default-exports an app definition. The registry discovers folders at build time, so there is nothing to register, and the folder name is the app's name in configs and URLs.

**1. Create the folder and the minimal app.** A scene app owns a three.js scene and moves things as a function of the cluster time:

```ts
// src/apps/orbit/index.ts
import * as THREE from "three";
import type { AppContext, AppDefinition, AppSpec, CaveApp } from "../types";

function create(spec: AppSpec, ctx: AppContext): CaveApp {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshStandardMaterial({ color: 0xff8844 }));
  scene.add(ball);
  const radius = Number(spec.options?.radius ?? 1); // an option from the config or URL

  return {
    name: "orbit",
    scene,
    ready: Promise.resolve(),
    status: "ready",
    update(time, state) {
      // Everything from `time`: the same time gives the same scene on every node.
      ball.position.set(Math.cos(time) * radius, 1.5, Math.sin(time) * radius - 1);
    },
  };
}

export default { name: "orbit", description: "A ball orbiting in the CAVE", create } satisfies AppDefinition;
```

The CAVE frame is meters, Y up, floor at y = 0, viewer near the origin looking toward −z; the 3 m CAVE's front wall is at z = −1.5. Anything you put there appears in the room.

**2. Run it.** `npm run dev`, then <http://localhost:5173/simulator.html?config=cave-3m&app=orbit>. The simulator shows it on every tile and in the overview. On a cluster, `npm run manager -- --app orbit`, or put `"app": { "name": "orbit" }` in the config file.

**3. Add options.** Read them from `spec.options` as above; set them in the config (`"app": { "name": "orbit", "options": { "radius": 2 } }`). To make them settable from the URL for development, add a line in `appSpecFromParams` in `src/apps/index.ts`.

**4. Load assets.** Put files under `public/` and fetch them by absolute path (`/models/thing.glb`), so every node gets the same URL. Set `ready` to the loading promise and update `status` while loading; rendering starts immediately, so show a placeholder. The glTF app is the template for this.

**5. React to input.** Two ways. On every node, read the replicated action state in `update`: `inputOf(state).buttons.primary`. Or implement `onInput(actions, dt, state, send)`, which runs on the controller only, and publish the result as shared state with `send({ myKey: value })`; the Manager replicates it and every node reads `state.appState.myKey` in `update`. The shapes app toggles a shared clock with button A this way; Crayoland publishes grabs, throws and creature reactions. See "How a change reaches every node" below. Declare `navigation: { flySpeed, turnSpeed, planar }` to tune the standard bindings, or `ownsNavigation: true` (flat apps) to take the sticks over.

**6. Use the head and wand** when the world should react to where the user is: `state.head` and `state.wand` are poses in the CAVE frame; `caveToWorld(state.navigation, pose.position)` from `src/core/navigation.ts` gives world coordinates.

**7. Sound and debug drawing.** `ctx.audio` says this window is the speaker: create your `AudioContext` after the first click or key press and drive gains from the head position in `update`. `ctx.debug` asks for debug drawing. Implement `setAudio` and `setDebug` so the simulator's buttons switch them live. Crayoland's `sound.ts` and its debug spheres are complete examples.

**8. Flat (2D) apps.** For maps, documents and dashboards, export `kind: "flat"` and a `createView(container, screen, layout, opts)` that draws exactly the screen's rectangle of the shared picture (`layout.rects[screen.id]`), reading its state from `state.appState` and reporting changes with `opts.send` when `opts.interactive`. A MapLibre app is thirty lines on top of `map/wallmap.ts`; the density app shows it.

**9. Raw WebGL apps.** For an existing WebGL program, export `kind: "raw"` with `update(time, state)` and `render(ctx)`. WebCAVE calls `render` once per eye per screen with `ctx.gl`, `ctx.view`, `ctx.viewInverse` and `ctx.projection` (column-major, world frame, meters), the eye position, and the target's size; the framebuffer and viewport are already bound, so draw and return. GL resources belong to a context, and the simulator draws each screen with its own, so keep them in a `Map` keyed by `ctx.gl`. Stereo, off-axis projection, navigation and the barrier come for free. The aquarium is the example, including how a program in other units is fed matrices in meters.

**10. WebGPU apps.** Export `kind: "webgpu"` with `update` and `render(ctx)`. Instead of a GL context, `ctx.canvas` is an `OffscreenCanvas` of the eye's size: configure its `webgpu` context with your device once per canvas, render the view from `ctx.view` and `ctx.projection` (remember WebGPU's depth range is 0 to 1 where WebGL's is −1 to 1), submit, and return. WebCAVE takes the canvas image and copies it into the eye target; packing, presenting and the barrier are unchanged. One `GPUDevice` serves every canvas, so resources are shared across screens, unlike WebGL. The metaballs app is the example.

**11. A control panel.** An app whose original had a sidebar of controls implements `createPanel(container, ctx)`: build your controls into `container` with plain DOM or any framework, make every control call `ctx.send({ myKey: ... })`, and return `{ update(state), dispose() }` where `update` reflects `state.appState` back into the controls. The simulator shows the panel in a third column, and `panel.html?manager=ws://...` shows it alone for a tablet or a laptop next to the wall; the wall itself never sees it. Several panels can be open at once and always agree, because they all mirror the same state. The dot-density app is the example.

Rules that keep the cluster in step:

- Every pose is a function of the frame `time` the Manager sends. No `Date.now()`, no accumulated deltas. Randomness comes from the seeded, stateless helpers in `src/core/random.ts`, or from a simulation stepped at a fixed rate from time zero, which a late-joining node fast-forwards.
- Anything a controller changes goes through the shared app state (`send(patch)` in `onInput`), which the Manager replicates in every frame. Toggle clocks with the helpers in `src/apps/types.ts` so the animation never jumps.
- Never read the keyboard, mouse or gamepads yourself, and never touch cameras or the renderer; WebCAVE owns them.
- Assets load asynchronously per node; expose `ready` and a `status` string so the HUD can show progress.

`src/apps/README.md` has the same material next to the code with both contracts in full, and `src/apps/shapes/index.ts` is a commented tutorial.

## How a change reaches every node

An application never changes an object on the node where an event happened. Every node draws a function of the frame the Manager broadcast, so a change has to travel through the Manager to reach all screens for the same frame. The path:

1. **The event happens on a controller**: the simulator, a node with `input: true`, or the tracking bridge. The controller runs the same app instance as the render nodes, and its `onInput(actions, dt, state, send)` hook sees the buttons, the wand and the frame.
2. **The hook publishes a record** with `send(patch)`. That becomes a `setAppState` message, and the Manager shallow-merges the patch, key by key, into the shared `appState`.
3. **Every node receives the new state** in the next frame message, since the whole `appState` travels in every frame.
4. **Each node applies it in `update(time, state)`**, setting the color, texture or position from `state.appState`. The node that raised the event does exactly the same; it does not apply the change locally first.

The change reaches all nodes within one frame, and they apply it for the same frame number, inside the barrier.

**Publish state, not commands.** Say "the cube is red", not "turn the cube red". A node that joins late or reconnects gets the full `appState` in its first frame and rebuilds the same picture; a command would have been missed. For a change that unfolds over time, store the starting conditions and the cluster time it began, and let `update` compute the rest from `time`:

- Crayoland publishes a thrown flower as position, velocity and release time; every node evaluates the parabola from `time`.
- Its grab is an offset in wand coordinates, so the held object follows the wand from the frame's own wand pose.
- Toggling an animation uses the shared clock helpers in `src/apps/types.ts`, which store the elapsed time and the moment of the toggle so nothing jumps.

**Keep two things in mind.**

- The patch is a shallow merge at the top level. Sending `{ flowers: {...} }` replaces the whole `flowers` value, so send the complete sub-object, or use one key per object.
- The whole `appState` is resent every frame, so keep it compact: ids and rounded numbers rather than meshes or large arrays. Textures and models are never in the state; a node loads them from `public/` by URL, and the state only names which one is current.

The shapes app is the smallest example: `onInput` sends a clock toggle when button A is pressed, and `update` reads the clock to rotate the carousel on every node, about ten lines in all.

## Raw WebGL apps and the aquarium

Existing WebGL programs, written against the API directly or with a helper library rather than three.js, port through the **raw** contract. WebCAVE keeps everything it already does for a scene app, the per-screen off-axis cameras, the stereo eye targets and packing, navigation and the frame barrier, and replaces the scene by two calls: `update(time, state)` once per frame, and `render(ctx)` once per eye per screen with the context, the eye's view matrix and its inverse, the projection, the eye position and the target size. The eye's framebuffer is bound and sized when `render` runs; the app draws and returns, and WebCAVE resets its own GL state around the call so both can share the context. The eye targets are multisampled, and WebCAVE resolves them after the raw draw.

```
http://localhost:5173/simulator.html?config=cave-3m&app=aquarium
npm run manager -- --config cave-3m --app aquarium
```

`aquarium` is the WebGL Aquarium from WebGLSamples (Google, 2009, BSD): 2,300 lines of WebGL on the tdl helper library, with a `render` function that already took a projection and a view-inverse matrix for its VR mode. `public/aquarium/aquarium-core.js` is that program with the page, UI, network sync, WebXR and multiview removed, and one instance per WebGL context; its header lists the changes. `src/apps/aquarium/index.ts` loads tdl and the core as classic scripts, keeps an instance per context, and converts matrices: the tank is in the aquarium's own units, 74 across its radius, and at 0.1 m per unit (the `scale` option) it is a 7.4 m globe with the fish swimming 1 to 4 m above the floor, so the CAVE stands at its center and the fish pass through the room. Eye space stays rigid in the conversion: only the translations and the projection's near-times-far term are scaled.

- **Time.** The fish were pure functions of time already; the clock is now the cluster time times the speed setting. Light rays and bubble bursts, which used `Math.random` and countdowns, are hashed from time, so every screen shows the same rays and bubbles.
- **Settings.** The original settings page is a panel: fish count (1 to 30,000), the seven rendering options, lasers, speed and the fog preset, all in `appState.aquarium`; shader variants for fog, normal maps and reflection are rebuilt when those change.
- **Several contexts.** tdl keeps its program and texture caches per context, and the core wraps its texture classes so image uploads go to the context they were created in whatever context is current at load time.
- **Assets** (11 MB of models and textures) live in `public/aquarium/` with the license; each screen loads them once.

Not carried over: the orbiting camera (navigation replaces it), the FPS-based automatic quality switch, and the WebXR and multiview paths.

## WebGPU apps and the metaballs

WebGPU cannot draw into WebGL's eye targets, and the whole WebCAVE pipeline, off-axis cameras, stereo eye targets, packing and presenting, is WebGL through three.js. The **webgpu** contract bridges the two: WebCAVE gives a WebGPU app an `OffscreenCanvas` per eye per screen, sized like the eye target, together with the same view, projection, eye position and near / far a raw app gets. The app renders and submits; WebCAVE takes the canvas image with `transferToImageBitmap()`, which waits for the GPU work, and copies it into the eye target's texture. From there the frame is an ordinary WebGL frame. One copy per eye per frame is the cost.

```
http://localhost:5173/simulator.html?config=cave-3m&app=metaballs
npm run manager -- --config cave-3m --app metaballs
```

`metaballs` is Brandon Jones's webgpu-metaballs, the project behind the WebGPU Samples' "Metaballs" entry: sixteen metaballs turned into a mesh every frame by marching cubes in a compute shader, shaded as lava, water or slime, inside a dungeon lit by clustered point lights with light sprites. Its renderer already had a WebXR path that renders two views from external poses; `src/apps/metaballs/renderer.ts` is that path fed by WebCAVE, one view per eye, with the GL projection remapped to WebGPU's depth range and the scene placed 1.8 m in front of the CAVE origin (the `offset` option), so the blobs rise just behind the front wall. The project's source is vendored unchanged apart from two lines (the texture loader class is injected and the media root is a field). Time is the cluster clock; the metaball positions were already pure functions of it.

Of the original's settings pane only two options were kept, as asked: **metaball style** and **metaball resolution**, in `appState.metaballs`, plus the **stats** readout: frames per second, JavaScript frame time and GPU pass timings from WebGPU timestamp queries where the adapter has them. Rendering method, light toggles, environment and WebXR stay at their defaults.

Media, the dungeon glTF scene with KTX2 textures and the lava, water and slime textures, is fetched from the project's GitHub Pages at run time and not redistributed here, since the dungeon model is under Sketchfab's standard license; the `model` option points at a local copy for an installation without internet. The KTX2 textures are decoded by the prebuilt web-texture-tool loader and its transcoder workers in `public/metaballs/wtt/`. Needs a browser with WebGPU; the app's status says so when there is none.

## Control panels and the dot-density map

Many visualizations are a page with controls on the side and the picture in the rest. WebCAVE splits that along its own seam: the picture becomes a flat app on the wall, the sidebar becomes a **panel** on a controller. The app implements `createPanel(container, ctx)`; the simulator mounts it in a column next to the overview, and the standalone page `panel.html?manager=ws://host:8765` mounts it full width for a tablet. Every control sends a shared-state patch through `ctx.send`, the Manager replicates it, every view redraws from `state.appState`, and every open panel is updated from the same state each frame, so nothing on a panel is ever out of step with the wall.

```
http://localhost:5173/simulator.html?config=wall-3x1&app=dotdensity
http://localhost:5173/panel.html?manager=ws://localhost:8765
npm run manager -- --config wall-3x1 --app dotdensity
```

`dotdensity` is the port of the School of Cities' Toronto 2021 dot-density map, a SvelteKit page with MapLibre, deck.gl and a sidebar. What moved where:

- **The dots** (about 278,000, one per ten people, from a 23 MB CSV fetched once per view) are a deck.gl `PointCloudLayer` through deck's `MapboxOverlay`, which reads MapLibre's camera and padding, so it aligns with the wall machinery's off-center tiles without any extra work. Colours per field are precomputed once into byte arrays; the layer is rebuilt only when the state it depends on changes (the wall map definition's `onFrame` hook).
- **The sidebar** became `panel.ts`: field buttons, a legend built from the original's summary CSVs, a dot-size slider, a dark-basemap toggle and a 3D toggle, all writing `appState.dotDensity`. The 3D toggle also sets the shared camera's pitch to 54°, and the dots' heights ease in over 0.6 s from the toggle time carried in the state, so all screens animate together.
- **The dark basemap**, an inverted custom OSM style in the original, is a CSS invert filter on the MapLibre canvas here, leaving the deck canvas untouched.
- **Zoom.** The city spans about 42 km; the default zoom 13.3 spreads it over a 5760-pixel wall, where the original showed it in 540 pixels. Set `zoom` in the config for other widths. Dot size follows the original's zoom-dependent scale, floored at one pixel so scaled simulator tiles still show dots.
- **Data** stays with its authors: the point CSV is fetched from schoolofcities.github.io (set `data` to a local copy for an offline installation); the small legend summaries and place labels are in `public/data/dotdensity/` with a credits file.

Not carried over: the tweened Svelte transitions (replaced by the state-time ease), the original's custom basemap style, and its map controls, which the wall does not need. The overview's wall-texture mode shows the MapLibre canvas only, without the deck overlay or the dark filter.

## Crayoland

```
http://localhost:5173/simulator.html?config=cave-3m&app=crayoland&audio=1
npm run manager -- --app crayoland
```

Crayoland is the 1995 CAVE demo by Dave Pape at EVL, ported from its C++ source (about 2,200 lines against CAVElib, OpenGL and the Bergen sound server). The original data files load from `public/crayoland/` with only the sound and mask file names updated to the converted MP3 and PNG files: `World` lists 245 static pictures (trees, mountains, clouds, the lake, the house), 313 grabbable pictures (flowers and rocks), a hive of 64 bees with 29 flowers to visit, 6 butterflies and a cloud of flies; `Sounds` places crickets, frogs, ducks, birds, a stream and footstep sounds. Units are feet; the scene sits in a group scaled to meters, so the CAVE floor is the meadow and the 3 m CAVE is roughly the original 10 ft cube.

**What was ported and how.**

- Pictures are upright textured quads with the original rotation formula, cut out with an alpha test as in the original. Static pictures sharing a texture are merged into one mesh; grabbable ones are instances of one quad per texture, so the whole world is about thirty draw calls.
- The bees' state machine (hang out at the hive, fly to a flower, pollinate, return) and the butterflies' wandering are ported line for line into fixed-step simulations with a seeded random generator. Every node steps them itself from time zero, so all nodes agree and a node that joins late catches up in well under a second.
- Interaction runs on the controller (the simulator, or a node with input enabled) and is published as shared state: a grab stores the object's offset in wand coordinates, a release stores its rest pose and throw velocity, poking the hive stores when the bees got angry, a still hand near a butterfly stores when it started seeking. Nodes turn these records plus the current wand and time into geometry: the held flower hangs off the wand, the thrown rock follows its parabola, the bees swarm the head, the butterfly glides to the hand and folds its wings. Nothing accumulates on the nodes.
- Navigation uses the standard bindings with the app's hints: walking speed of 30 ft/s and 90°/s turning; the triggers fly up and down and the bumpers look up and down, standing in for the original's third-button flight. The original moved along the wand's direction; here it moves along the navigation heading.
- Sound is Web Audio on the window that has `audio` (config or `?audio=1`): positional loops, random calls with probability and distance attenuation, triggers, footsteps chosen by the ground masks (splashes in the lake), the hive's hum scaled by how many bees are near and tripled when angry, and a thud when the hive is hit. Browsers start audio only after a click or key press.

**Playing.** Walk with the arrow keys and `I K J L`, or a gamepad (left stick walks, right stick and bumpers look, triggers fly). Move the wand with `Shift` + `W S A D Q E` (the stick in the overview and the hand in the scene follow it); hold `Enter`, or gamepad A or X, while the hand is on a flower or rock to grab it, move the hand or walk with it, and release to drop or throw. A grabbed object keeps its position relative to the hand, as in the original, so a tap with the hand still puts it right back. Hold the wand still near a butterfly and it comes to sit on the hand. Push the wand into the hive on the tree in the flower field and the bees chase you until you are 40 ft away. The hand rests at about 3.8 ft, above a 2 ft flower, so lower it with `Shift` + `Q` or the d-pad before grabbing; the simulator's **debug** button (or `?debug=1`) draws every object's pick sphere and the wand point, turns the touched sphere yellow, and reports the nearest object in the status line.

**Not carried over.** The original navigated along the wand's pointing direction with a joystick, and flew when a third button was held; here the standard bindings apply. Bergen's networked sound server is replaced by in-browser audio on one node. Frustum culling per CAVE wall (commented out in the original too) is left to three.js. The optional "hand" configuration for a glove is not ported.

## The VDB application

```
http://localhost:5173/simulator.html?config=cave-3m&app=vdb
npm run manager -- --app vdb                        # default /volumes/smoke2.vdb
npm run manager -- --app vdb --model /volumes/other.vdb --size 2 --spin 0.1
```

OpenVDB files are decoded entirely in the browser. The `openvdb` npm package parses the file's topology (grids, transforms, tree, leaf masks); it does not read leaf values, so `src/apps/vdb/leafValues.ts` reads the leaf buffer section itself following OpenVDB's record layout, with a small Blosc + LZ4 + byte-unshuffle decoder in `src/apps/vdb/blosc.ts`. Every leaf's mask is checked against the topology, and the active voxel count must match the file's own count, so a format mismatch fails loudly instead of rendering garbage. The active bounding box is densified into an 8-bit 3D texture, normalized to the 99.5th percentile of non-empty voxels so thin smoke keeps precision, downsampled by an integer factor when the longest side exceeds `maxDim` (384). A fragment shader ray-marches the box front to back with absorption and a one-tap shadow toward the light. The box is fitted like the glTF model (`size`, position, `spin`), and stereo works per eye. Drop a `.vdb` in `public/volumes/` and pass `vdb=/volumes/name.vdb`. Float and half-float grids, blosc and uncompressed buffers are handled; zip-compressed buffers are not yet.

## The points application

```
http://localhost:5173/simulator.html?config=cave-3m&app=points
npm run manager -- --app points                      # default /volumes/waterfall_points.vdb
npm run manager -- --app points --model /volumes/other.vdb --size 2
```

PointDataGrids store particles rather than voxel values, in a layout of their own: a multi-pass buffer section with an attribute descriptor, per-leaf cumulative voxel offsets, and paged attribute payloads. `src/apps/points/pointsReader.ts` decodes it, reusing the Blosc and LZ4 code, and checks every size against the descriptor so a mismatch fails loudly. Positions use their codec (16-bit or 8-bit fixed point, half, float) relative to their voxel and the grid transform; a vec3 `Cd` attribute becomes per-point colour, otherwise a height gradient in the tint. Clouds larger than `maxPoints` (4 million) are decimated with a uniform stride. The result is a three.js point cloud fitted and placed like the model and volume apps; stereo works per eye.

## The MapLibre applications

```
http://localhost:5173/simulator.html?config=wall-3x1&app=map
http://localhost:5173/simulator.html?config=wall-3x1&app=density
http://localhost:5173/simulator.html?config=wall-3x1&app=map2d
npm run manager -- --config wall-2x2            # wall-2x2.json already selects the map
npm run manager -- --config wall-3x1 --app density
```

All three are thin definitions on a shared module, `src/apps/map/wallmap.ts`: a default camera and style plus a `setup(map)` hook that adds sources and layers once the style has loaded. A new MapLibre-based app is a folder with those two things.

`map2d` shows two more things a MapLibre app may need. It uses MapLibre's own clustering with `clusterProperties` that count earthquakes per magnitude band, and draws each cluster as an HTML marker, an SVG donut with the five counts and the total in the middle; markers are DOM elements inside the map container, which the wall machinery extends and clips like the canvas, so a donut on a bezel is drawn by both neighbouring screens at the same place. It also sets `renderWorldCopies: false` on its definition and a default zoom of 3.5, so the world spans a 5760-pixel wall exactly once instead of repeating; set `zoom` in the config for other wall widths (the world is 512 × 2^zoom pixels wide). Clustering depends on the zoom, so the simulator's small tiles, which render at a lower zoom, group the quakes differently from the full-size wall.

Every node runs its own MapLibre instance with the same camera. To show exactly its part of the wall, a tile shifts MapLibre's center point with asymmetric padding, which MapLibre turns into a proper off-center perspective, and scales its vertical field of view so its camera distance matches the wall's. MapLibre clamps the center point to the canvas, so tiles far from the wall center get a canvas that extends to the center and is clipped to the tile: the outer tiles of a 3x1 render 1.5 times their pixels, a 2x2 wall nothing extra. Because MapLibre's zoom is a pixel scale, a canvas drawn smaller than the display's native size (a simulator tile, a windowed node) uses zoom plus log2 of the scale, so it shows the same extent as the wall. A side effect: small simulator tiles render at a lower zoom level, and zoom-dependent styling such as the 3D buildings (from zoom 15) may not appear there even though the fullscreen wall shows it; zoom in on the controller to see it. Neighbouring tiles unproject to identical coordinates at their shared edge, bezels included.

**Interaction and synchronization.** The camera (center, zoom, bearing, pitch) lives in the Manager's shared application state and is broadcast in every frame. On the wall, nodes are not interactive; they apply the camera they receive. On a controller, such as the simulator connected with `?manager=` or a node with input enabled, each view takes the mouse as a normal MapLibre map: drag to pan, wheel to zoom, right-drag or Ctrl-drag to rotate and pitch; a gamepad pans with the left stick, rotates and pitches with the right, zooms with the triggers. Every move sends the camera to the Manager, which rebroadcasts it, so all screens follow within a frame. A view ignores incoming state for a quarter second after it sent one, so the drag is never fought by its own echo. Until anyone touches the map it shows the configured initial view; set `autoRotate` (degrees per second) for a slow deterministic rotation when idle. Tiles load asynchronously on each node, so a freshly panned area can pop in at slightly different moments; the camera itself never drifts.

Map data: OpenFreeMap vector tiles with OpenMapTiles building heights, no API key, attribution required (the attribution control is hidden on the wall; credit OpenFreeMap and OpenStreetMap contributors where the installation is described). Any MapLibre style URL works via `style=`, but 3D buildings need the OpenMapTiles `building` layer.

## HTML content in the CAVE: the Hacker News reading room

```
http://localhost:5173/simulator.html?config=cave-3m&app=hackernews
npm run manager -- --config cave-3m --app hackernews
```

`hackernews` is a mock-up of a text web page living inside the CAVE. The controller (the simulator, or whichever input page is connected) fetches `topstories` from the public Hacker News API, then the first thirty items, and publishes a compact snapshot in `appState.hn`: title, author, score, comment count, age and domain per story. Nothing else talks to the network, so every node shows the same front page and "3 hours ago" is computed against the snapshot time, not each node's clock. The stories become cards on a curved wall 1.35 m around the viewer, three rows high in reading order, drawn on a plane each; the wall is in the CAVE frame, so it follows you when you navigate.

Pointing is computed by every node from the frame's wand pose (a ray against the cards), so the highlighted card is the same on all screens without a message. The primary button (A, Enter on the keyboard) publishes the selection; the controller fetches the story's top-level comments and their first replies, strips the HTML and publishes them, and a larger panel appears in front with the thread. B (Backspace) closes it. The side panel lists the stories, opens one on click, and has a refresh button.

The cards are rasterized in one of two tiers, reported in the status line. With Chrome's **HTML-in-canvas** experiment (`chrome://flags/#canvas-draw-element`, or `--enable-blink-features=CanvasDrawElement`), each card is a real DOM fragment styled with CSS, laid out inside a `<canvas layoutsubtree>` and drawn with `drawElementImage()`: real text layout, wrapping and fonts for free, and the same path would take any HTML. Without it, the same cards are drawn with Canvas 2D text and a small word-wrapper. Either way the result is a `CanvasTexture` re-rendered only when a card's content or highlight changes, so the steady state costs nothing.

Data: the Hacker News API (`hacker-news.firebaseio.com/v0`), public, no key; the content belongs to its authors and Y Combinator.
