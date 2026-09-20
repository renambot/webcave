# Applications

An application owns a three.js scene and advances it from the cluster's simulation time. WebCAVE handles cameras, stereo and screens. Seven are included, in `src/apps/`:

| Name | What it shows | Options |
|---|---|---|
| `shapes` (default) | Basic animated shapes in and around the CAVE, with shadows on the floor; button A (Enter on the keyboard) toggles a slow rotation of the arrangement | none |
| `gltf` | One glTF / GLB model, fitted, placed in the CAVE and slowly spinning; animations play from cluster time | `model` URL, `size` (largest dimension, m), `spin` (rad/s), position |
| `map` | MapLibre GL JS map with 3D buildings (OpenFreeMap tiles) spread across a display wall; a *flat* app, see below | `style` URL, `center` lng,lat, `zoom`, `pitch`, `bearing`, `buildings`, `autoRotate` (deg/s, default 0) |
| `vdb` | OpenVDB volume (smoke, clouds) ray-marched in the CAVE; the file is fetched and decoded in the browser | `vdb` URL, `grid`, `size`, `spin`, position, `density` (multiplier), `steps`, `color`, `maxDim`, `lightDir` |
| `points` | OpenVDB PointDataGrid (particles) as a point cloud, decoded in the browser; colours from `Cd` when present | `points` URL, `grid`, `size`, `spin`, position, `maxPoints`, `pointSize`, `colorAttribute`, `color` |
| `density` | 2D choropleth of population density from a GeoJSON (MapLibre's "visualize population density" example, Rwanda provinces); same wall and camera machinery as `map` | the `map` camera options plus `data` (GeoJSON URL with `population` and `sq-km` per feature), `opacity` |
| `crayoland` | Dave Pape's Crayoland (EVL, 1995): a crayon-drawn meadow with bees, butterflies, flies, and flowers and rocks to grab and throw with the wand; birds, frogs, a stream and the hive's hum on the audio node | `model` (folder URL with `World`, `Sounds`, `tex/`, `audio/`; default `/crayoland/`), options `world`, `sounds` (file names) |

The application is part of the cluster config, so every Node runs the same one. Set it on the Manager:

```sh
npm run manager -- --app gltf --model /models/DamagedHelmet.glb --size 0.8 --spin 0.3
```

For development, URL parameters override it on the simulator or a Node: `?app=gltf&model=/models/DamagedHelmet.glb&size=0.8&spin=0.3&mx=0&my=1.5&mz=-1.05`. Files under `public/` are served at the root, so drop a `.glb` in `public/models/` and reference it as `/models/name.glb`. The bundled Damaged Helmet is a Khronos sample, CC BY 4.0 (see `public/models/README.md`).

There are two kinds of application. **Scene apps** (shapes, gltf, vdb, points, crayoland) own a three.js scene that WebCAVE renders from each screen's off-axis camera, with stereo and navigation. **Flat apps** (map, density) are 2D: they render themselves into a container per screen and receive the screen's rectangle in the overall wall image, so adjacent screens join into one picture. Stereo does not apply to flat apps.

## Writing an application

Create a folder `src/apps/<name>/` whose `index.ts` default-exports an app definition. Folders are discovered automatically; nothing to register. See `src/apps/README.md` for both contracts and templates, and `src/apps/shapes/index.ts` for a commented tutorial.

Rules that keep the cluster in step:

- Every pose is a function of the frame `time` the Manager sends. No `Date.now()`, no accumulated deltas. Randomness comes from the seeded, stateless helpers in `src/core/random.ts`, or from a simulation stepped at a fixed rate from time zero, which a late-joining node fast-forwards.
- Anything a controller changes goes through the shared app state (`send(patch)` in `onInput`), which the Manager replicates in every frame. Toggle clocks with the helpers in `src/apps/types.ts` so the animation never jumps.
- The head, the wand and the navigation are in the frame state; convert them to world coordinates with the helpers in `src/core/navigation.ts`.
- An app receives an `AppContext` telling it whether this window is the sound output; a scene app may declare `navigation` hints (speed, turn rate, planar) for the standard bindings.
- Assets load asynchronously per node; expose `ready` and a `status` string so the HUD can show progress.

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

**Playing.** Walk with the arrow keys and `I K J L`, or a gamepad (left stick walks, right stick and bumpers look, triggers fly). Move the wand with `Shift` + `W S A D Q E` (the stick in the overview and the hand in the scene follow it); press `Enter`, or gamepad A or X, while the hand is on a flower or rock to grab it, move the wand and release to throw. Hold the wand still near a butterfly and it comes to sit on the hand. Push the wand into the hive on the tree in the flower field and the bees chase you until you are 40 ft away.

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
npm run manager -- --config wall-2x2            # wall-2x2.json already selects the map
npm run manager -- --config wall-3x1 --app density
```

Both are thin definitions on a shared module, `src/apps/map/wallmap.ts`: a default camera and style plus a `setup(map)` hook that adds sources and layers once the style has loaded. A new MapLibre-based app is a folder with those two things.

Every node runs its own MapLibre instance with the same camera. To show exactly its part of the wall, a tile shifts MapLibre's center point with asymmetric padding, which MapLibre turns into a proper off-center perspective, and scales its vertical field of view so its camera distance matches the wall's. MapLibre clamps the center point to the canvas, so tiles far from the wall center get a canvas that extends to the center and is clipped to the tile: the outer tiles of a 3x1 render 1.5 times their pixels, a 2x2 wall nothing extra. Because MapLibre's zoom is a pixel scale, a canvas drawn smaller than the display's native size (a simulator tile, a windowed node) uses zoom plus log2 of the scale, so it shows the same extent as the wall. A side effect: small simulator tiles render at a lower zoom level, and zoom-dependent styling such as the 3D buildings (from zoom 15) may not appear there even though the fullscreen wall shows it; zoom in on the controller to see it. Neighbouring tiles unproject to identical coordinates at their shared edge, bezels included.

**Interaction and synchronization.** The camera (center, zoom, bearing, pitch) lives in the Manager's shared application state and is broadcast in every frame. On the wall, nodes are not interactive; they apply the camera they receive. On a controller, such as the simulator connected with `?manager=` or a node with input enabled, each view takes the mouse as a normal MapLibre map: drag to pan, wheel to zoom, right-drag or Ctrl-drag to rotate and pitch; a gamepad pans with the left stick, rotates and pitches with the right, zooms with the triggers. Every move sends the camera to the Manager, which rebroadcasts it, so all screens follow within a frame. A view ignores incoming state for a quarter second after it sent one, so the drag is never fought by its own echo. Until anyone touches the map it shows the configured initial view; set `autoRotate` (degrees per second) for a slow deterministic rotation when idle. Tiles load asynchronously on each node, so a freshly panned area can pop in at slightly different moments; the camera itself never drifts.

Map data: OpenFreeMap vector tiles with OpenMapTiles building heights, no API key, attribution required (the attribution control is hidden on the wall; credit OpenFreeMap and OpenStreetMap contributors where the installation is described). Any MapLibre style URL works via `style=`, but 3D buildings need the OpenMapTiles `building` layer.
