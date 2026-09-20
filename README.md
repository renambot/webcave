# WebCAVE

Browser-based cluster rendering for CAVEs, tiled display walls and other multi-screen immersive environments.

A **Manager** owns the clock, the frame counter, the tracked head pose and the navigation. Each display is driven by a **Node**, a browser window that receives the frame state, renders its screen with an off-axis (head-tracked) projection and acknowledges. A **Simulator** runs the whole cluster in one page on a laptop, or connects to a live Manager as a controller that mirrors and drives the real cluster. The same code runs in all of them.

The full design, research notes and roadmap are in [SPECIFICATION.md](SPECIFICATION.md).

## Status

Early prototype (v0). Working today:

- CAVE (4 screens, on 4 nodes or on 1 node) and tiled wall (3x1) presets described by screen corners in meters
- Multi-screen nodes: one window per display, placed via the Window Management API (launcher page) or kiosk Chrome (script)
- Off-axis projection per screen from a head position
- Navigation transform (position, yaw, pitch) moving the CAVE through the virtual world, driven from the Manager
- Frame barrier synchronization between Manager and Nodes, with a loose mode fallback
- Stereo output packing: mono, side-by-side (full and half), top-bottom (full and half), row, column and checkerboard interleaved, red-cyan anaglyph (Dubois colour and black-and-white), frame-sequential (experimental)
- Six applications behind a minimal interface: animated basic shapes, a glTF model loader (Khronos Damaged Helmet included), an OpenVDB volume renderer and an OpenVDB point-cloud renderer both decoding the file in the browser, and two MapLibre maps spread across a wall with a shared, interactive camera (3D buildings, and a 2D population-density choropleth)
- Shared application state in the frame protocol: controllers patch it, the Manager replicates it to every node
- Simulator with live stereo controls and a 3D overview of screens, head and frusta, with wall textures or the scene drawn in space

Not yet: tracking input (OptiTrack, Vicon, ART, VRPN), WebGPU renderer, warp and blend, adapters for existing three.js or WebXR apps, other 2D libraries (deck.gl, Leaflet, plain DOM).

## Run

Requires Node.js 20 or newer.

```sh
npm install
npm run dev        # Vite dev server on http://localhost:5173
```

**Simulator** (no server needed): open <http://localhost:5173/simulator.html?config=cave-3m> or `?config=wall-3x1`. The config dropdown lists every file in `configs/`.
Toolbar controls stereo mode, anaglyph scheme, IPD, eye swap, sync tier and head motion.

| Keys | Action |
|---|---|
| Arrow keys | Navigation look: yaw left/right, pitch up/down |
| `I` `K` / `J` `L` / `U` `O` | Fly forward/back, strafe left/right, down/up |
| `R` | Reset navigation and the head pose (position and orientation) |
| `Space` | Pause or resume the application's rotation on every screen (through the shared app state) |
| Gamepad | Left stick move, right stick look, triggers up/down, Y toggles rotation, Back resets; see Input devices |
| `Enter` / `Backspace` | Application buttons primary / secondary, same as gamepad A / B |
| `W` `S` / `A` `D` / `Q` `E` | Move the head: forward/back, left/right, down/up (with "auto head" off) |
| `Shift` or `Alt` + the same keys | Rotate the head: pitch, yaw, roll |
| Mouse on a tile (3D apps) | Drag to look, right-drag to pan, wheel to fly, double-click to reset |
| Mouse drag on overview | Orbit the 3D overview |
| `H` or `?` | Toggle the keyboard help overlay (`Esc` closes; `?help=1` opens it at load) |

The head moves the viewer inside the physical CAVE and changes each screen's off-axis frustum. Navigation moves the whole CAVE through the virtual world, which is how you look up, down or turn. URL parameters set the initial navigation: `?yaw=30&pitch=20&x=0&y=0&z=-2` (degrees and meters).

The **Overview** panel shows the physical installation: screens, frusta, and the head as a sphere with a cone whose tip points in the viewing direction. Its content mode is selectable in the toolbar or with `?overview=`:

- `none`: geometry only
- `walls`: each screen shows a mono render of what that wall displays, a "virtual CAVE" preview. The tiles show the actual stereo-packed output.
- `world`: the virtual scene is drawn in space around the CAVE, placed by the navigation transform, useful when debugging interaction with objects

"View from head" moves the overview camera to the eye position, where the wall images should join seamlessly.

**Cluster mode**: start the Manager, then open one Node page per display.

```sh
npm run manager                       # ws://localhost:8765, default CAVE config
npm run manager -- --config wall-3x1 --sync loose --port 8765
npm run manager -- --config path/to/my-cave.json
npm run manager -- --list-configs
```

```
http://<dev-host>:5173/node.html?node=front&manager=ws://<manager-host>:8765
http://<dev-host>:5173/node.html?node=left
http://<dev-host>:5173/node.html?node=right&stereo=anaglyph
```

Click a Node, or press `f`, `Enter` or `Space`, to go fullscreen; press `h` to hide the HUD. Parameters: `node` (node id), `view` (which of the node's screens, for multi-screen nodes), `screen` (display index for fullscreen), `stereo` (override the output mode), `manager`, `input=1` (take input on this window, see Input devices).

**Fullscreen nodes without clicking.** A page cannot put itself fullscreen: browsers only honour `requestFullscreen` inside a user gesture, so there is no URL parameter for it. For an installation, start the browser itself in kiosk mode. The launcher opens one independent kiosk Chrome per node, each with its own profile, positioned on its display:

```sh
npm run nodes                                                  # front, left, right, floor, laid out left to right
npm run nodes -- --nodes tile0,tile1,tile2 --positions "0,0 1920,0 3840,0"
npm run nodes -- --nodes left --server http://192.168.1.10:5173 --manager ws://192.168.1.10:8765
npm run nodes -- --stereo anaglyph --width 2560 --height 1440
npm run nodes -- --kill                                        # stop them all
```

Positions are the top-left pixel of each display in the OS's virtual desktop, as shown in the display settings. Run `scripts/launch-nodes.sh --help` for all options, including `--chrome PATH` when the browser is not found. The script is bash and works on macOS and Linux; on Windows use the same flags on `chrome.exe`:

```
chrome.exe --kiosk --user-data-dir=%TEMP%\webcave-front --window-position=0,0 --window-size=1920,1080 --app="http://host:5173/node.html?node=front&manager=ws://host:8765"
```

Kiosk Chrome also needs no gesture for WebGL, but it must be able to reach the page server and the Manager, so on a multi-machine cluster pass their addresses rather than `localhost`.

**One computer, several displays.** A node in the config can list several screens, for example `configs/cave-3m-1pc.json` has one node `pc` driving front, left, right and floor. Each screen is still one browser window, opened on its display with `node=pc&view=front`, `node=pc&view=left` and so on. Three ways to place them:

1. **Launcher page** (Chrome or Edge): `http://localhost:5173/launcher.html?node=pc`. It reads the config from the Manager, enumerates the displays with the Window Management API, lets you map each screen to a display, and opens all windows in one click. With the window-management permission granted, the windows open directly fullscreen on their display. It also prints the equivalent kiosk command with the detected display positions filled in.
2. **Kiosk script** with `node:view` ids: `npm run nodes -- --nodes pc:front,pc:left,pc:right,pc:floor --positions "0,0 1920,0 3840,0 5760,0"`.
3. **By hand**: open each node URL, add `&screen=N` to name the display, and click once. The node page uses the Window Management API to go fullscreen on display N, and shows which display it landed on in its HUD.

The Window Management API only exists in secure contexts and prompts once for permission. `http://localhost` qualifies. Nodes on other machines must load the pages over https, or Chrome must be started with `--unsafely-treat-insecure-origin-as-secure=http://server:5173`. The kiosk script needs none of this.

**Simulator as controller**: point the simulator at the running Manager and it stops running its own. It receives the same frames as the Nodes, mirrors the wall in its tiles and overview, and its keyboard and toolbar drive the cluster's head and navigation.

```
http://localhost:5173/simulator.html?manager=ws://localhost:8765
```

The config and sync tier then come from the server and are shown disabled in the toolbar. The controller never acks frames, so it cannot hold the cluster barrier.

Other scripts: `npm run build`, `npm run preview`, `npm run typecheck`, `npm run nodes` (kiosk launcher, see above).

## Configuration files

An installation is a JSON file in `configs/`. The Manager loads it by name (`--config cave-3m`) or by path, the simulator lists the bundled ones in its dropdown, and every file carries `"$schema": "./schema.json"` so VS Code and other editors autocomplete and validate it. Copy one and edit it.

| File | What it describes |
|---|---|
| `cave-3m.json` | 3 m CAVE, four screens, one computer per screen |
| `cave-3m-1pc.json` | The same CAVE from one computer with four displays |
| `wall-3x1.json` | Three 16:9 tiles side by side |
| `wall-2x2.json` | Four 16:9 tiles with 2 cm bezels, runs the map app by default |
| `example-measured.json` | Template using measured corners and a per-screen stereo override |
| `schema.json` | Generated JSON Schema; regenerate with `npm run schema` after changing the types |

A screen can be written two ways. By placement, for quick descriptions:

```json
{ "id": "left", "center": [-1.5, 1.5, 0], "width": 3, "height": 3, "yaw": 90, "widthPx": 1920, "heightPx": 1920 }
```

The screen starts facing the viewer at +z, centered at `center`. `yaw` turns it about the vertical axis in degrees (90 makes a left wall facing +x, -90 a right wall), `pitch` tilts it (-90 for a floor), `roll` turns it about its normal. Or by three measured corners in meters, lower-left `pa`, lower-right `pb`, upper-left `pc`:

```json
{ "id": "front", "pa": [-1.5, 0, -1.5], "pb": [1.5, 0, -1.5], "pc": [-1.5, 3, -1.5], "widthPx": 1920, "heightPx": 1920 }
```

Units are meters and degrees in a Y-up, right-handed frame with the physical floor at y = 0 and the viewer near the origin. Everything except `name`, `screens` and `nodes` has a default: `fps` 60, `sync` barrier, `defaultHead` at (0, 1.6, 0), mono stereo, the shapes app. A screen may override stereo settings, for instance a passive wall whose odd column needs `"firstEye": "right"`. Validation errors name the field: `npm run schema` checks all files, and the Manager refuses to start on an invalid one and prints why.

The file format lives in `src/core/configFile.ts` as a zod schema; the runtime types are in `src/core/config.ts`.

## Input devices

Input goes through an abstraction layer in `src/input/`, so applications and the navigation never see a device:

1. **Devices produce an action state.** Keyboard and gamepads today; a tracked wand or a phone later. The vocabulary is small: `move` and `look` as 2D axes, `fly`, a `dpad`, and buttons `primary`, `secondary`, `tertiary`, `quaternary`, `prev`, `next`, `reset`, `menu`, `spin`. Axes are normalized with dead zones applied. Several devices are merged (largest axis wins, buttons OR).
2. **A controller binds standard actions to cluster behaviour.** `move`, `look` and `fly` become navigation increments, `reset` resets, `spin` pauses the rotation clock. Each input client also reports its action state to the Manager, which merges all of them (largest axis wins, buttons OR) and replicates the result to every node in the frame, so a wall node sees exactly what the sticks do. The same `InputController` class in `src/input/controller.ts` runs in the simulator and on nodes that are allowed to take input.
3. **Applications react.** A scene app reads `inputOf(state)` in `update()` on every node, deterministically. An app can also implement `onInput(actions, dt, state, send)`, which runs on the controller only and may patch shared state; the map uses it to pan, rotate, pitch and zoom from a gamepad, and declares `ownsNavigation` so the sticks are not also flying the CAVE.

**Input on a node.** Wall nodes are display-only unless a node has `"input": true` in the config (or `?input=1` on its URL for development). Such a node takes the keyboard, mouse and any gamepad plugged into its computer and steers the cluster like the simulator does: arrows look, `I K J L U O` fly, `Space` pauses rotation, `R` resets, `Enter` and `Backspace` are the application buttons A and B, drag looks, right-drag pans, wheel flies, and for the map the node's own view becomes interactive. Fullscreen then moves to the `F` key alone, since clicks, `Enter` and `Space` have other meanings. The simulator's head keys `W S A D Q E` stay simulator-only. Several input clients can be active at once; the Manager merges them.

Input is off by default on purpose: render machines often have keyboards and mice attached for administration, kiosk windows grab keyboard focus, and a bumped mouse or a stray key on a display-only machine must not steer the wall. Turn it on where the controller physically is, typically the one machine with the gamepad (for a single-computer CAVE, set it on the `pc` node), or use the simulator on a laptop. Keyboard events only reach the focused window, so on a multi-window node only the last-clicked window hears keys; gamepads are readable from any window, which makes them the better device for a wall.

Gamepads use the browser Gamepad API. Pads reporting the W3C standard layout work out of the box: left stick moves, right stick looks, triggers go up and down, Y or Triangle toggles rotation, Back or Select resets. Other layouts are matched by id against profiles in `src/input/gamepad.ts` (Xbox on Linux, older PlayStation mappings); adding a device is adding a profile. Connected pads show in the simulator footer, and `?gamepad=NAME` forces a profile. Browsers only expose a pad after a button press on it.

## Applications

An application owns a three.js scene and advances it from the cluster's simulation time. WebCAVE handles cameras, stereo and screens. Two are included, in `src/apps/`:

| Name | What it shows | Options |
|---|---|---|
| `shapes` (default) | Basic animated shapes in and around the CAVE; button A (Enter on the keyboard) toggles a slow rotation of the arrangement | none |
| `gltf` | One glTF / GLB model, fitted, placed in the CAVE and slowly spinning; animations play from cluster time | `model` URL, `size` (largest dimension, m), `spin` (rad/s), position |
| `map` | MapLibre GL JS map with 3D buildings (OpenFreeMap tiles) spread across a display wall; a *flat* app, see below | `style` URL, `center` lng,lat, `zoom`, `pitch`, `bearing`, `buildings`, `autoRotate` (deg/s, default 0) |
| `vdb` | OpenVDB volume (smoke, clouds) ray-marched in the CAVE; the file is fetched and decoded in the browser | `vdb` URL, `grid`, `size`, `spin`, position, `density` (multiplier), `steps`, `color`, `maxDim`, `lightDir` |
| `points` | OpenVDB PointDataGrid (particles) as a point cloud, decoded in the browser; colours from `Cd` when present | `points` URL, `grid`, `size`, `spin`, position, `maxPoints`, `pointSize`, `colorAttribute`, `color` |
| `density` | 2D choropleth of population density from a GeoJSON (MapLibre's "visualize population density" example, Rwanda provinces); same wall and camera machinery as `map` | the `map` camera options plus `data` (GeoJSON URL with `population` and `sq-km` per feature), `opacity` |

The application is part of the cluster config, so every Node runs the same one. Set it on the Manager:

```sh
npm run manager -- --model /models/DamagedHelmet.glb --size 0.8 --spin 0.3
```

For development, URL parameters override it on the simulator or a Node: `?app=gltf&model=/models/DamagedHelmet.glb&size=0.8&spin=0.3&mx=0&my=1.5&mz=-1.05`. Files under `public/` are served at the root, so drop a `.glb` in `public/models/` and reference it as `/models/name.glb`. The bundled Damaged Helmet is a Khronos sample, CC BY 4.0 (see `public/models/README.md`).

There are two kinds of application. **Scene apps** (shapes, gltf) own a three.js scene that WebCAVE renders from each screen's off-axis camera, with stereo and navigation. **Flat apps** (map) are 2D: they render themselves into a container per screen and receive the screen's rectangle in the overall wall image, so adjacent screens join into one picture. Stereo does not apply to flat apps.

To add an application, create a folder `src/apps/<name>/` whose `index.ts` default-exports an app definition. Folders are discovered automatically; nothing to register. See `src/apps/README.md` for both contracts and templates.

### The VDB application

```
http://localhost:5173/simulator.html?config=cave-3m&app=vdb
npm run manager -- --app vdb                        # default /volumes/smoke2.vdb
npm run manager -- --app vdb --model /volumes/other.vdb --size 2 --spin 0.1
```

OpenVDB files are decoded entirely in the browser. The `openvdb` npm package parses the file's topology (grids, transforms, tree, leaf masks); it does not read leaf values, so `src/apps/vdb/leafValues.ts` reads the leaf buffer section itself following OpenVDB's record layout, with a small Blosc + LZ4 + byte-unshuffle decoder in `src/apps/vdb/blosc.ts`. Every leaf's mask is checked against the topology, and the active voxel count must match the file's own count, so a format mismatch fails loudly instead of rendering garbage. The active bounding box is densified into an 8-bit 3D texture, normalized to the 99.5th percentile of non-empty voxels so thin smoke keeps precision, downsampled by an integer factor when the longest side exceeds `maxDim` (384). A fragment shader ray-marches the box front to back with absorption and a one-tap shadow toward the light. The box is fitted like the glTF model (`size`, position, `spin`), and stereo works per eye. Drop a `.vdb` in `public/volumes/` and pass `vdb=/volumes/name.vdb`. Float and half-float grids, blosc and uncompressed buffers are handled; zip-compressed buffers are not yet.

### The points application

```
http://localhost:5173/simulator.html?config=cave-3m&app=points
npm run manager -- --app points                      # default /volumes/waterfall_points.vdb
npm run manager -- --app points --model /volumes/other.vdb --size 2
```

PointDataGrids store particles rather than voxel values, in a layout of their own: a multi-pass buffer section with an attribute descriptor, per-leaf cumulative voxel offsets, and paged attribute payloads. `src/apps/points/pointsReader.ts` decodes it, reusing the Blosc and LZ4 code, and checks every size against the descriptor so a mismatch fails loudly. Positions use their codec (16-bit or 8-bit fixed point, half, float) relative to their voxel and the grid transform; a vec3 `Cd` attribute becomes per-point colour, otherwise a height gradient in the tint. Clouds larger than `maxPoints` (4 million) are decimated with a uniform stride. The result is a three.js point cloud fitted and placed like the model and volume apps; stereo works per eye.

### The MapLibre applications

```
http://localhost:5173/simulator.html?config=wall-3x1&app=map
http://localhost:5173/simulator.html?config=wall-3x1&app=density
npm run manager -- --config wall-2x2            # wall-2x2.json already selects the map
npm run manager -- --config wall-3x1 --app density
```

Both are thin definitions on a shared module, `src/apps/map/wallmap.ts`: a default camera and style plus a `setup(map)` hook that adds sources and layers once the style has loaded. A new MapLibre-based app is a folder with those two things.

Every node runs its own MapLibre instance with the same camera. To show exactly its part of the wall, a tile shifts MapLibre's center point with asymmetric padding, which MapLibre turns into a proper off-center perspective, and scales its vertical field of view so its camera distance matches the wall's. MapLibre clamps the center point to the canvas, so tiles far from the wall center get a canvas that extends to the center and is clipped to the tile: the outer tiles of a 3x1 render 1.5 times their pixels, a 2x2 wall nothing extra. Because MapLibre's zoom is a pixel scale, a canvas drawn smaller than the display's native size (a simulator tile, a windowed node) uses zoom plus log2 of the scale, so it shows the same extent as the wall. A side effect: small simulator tiles render at a lower zoom level, and zoom-dependent styling such as the 3D buildings (from zoom 15) may not appear there even though the fullscreen wall shows it; zoom in on the controller to see it. Neighbouring tiles unproject to identical coordinates at their shared edge, bezels included.

**Interaction and synchronization.** The camera (center, zoom, bearing, pitch) lives in the Manager's shared application state and is broadcast in every frame. On the wall, nodes are not interactive; they apply the camera they receive. On a controller, such as the simulator connected with `?manager=`, each tile takes the mouse as a normal MapLibre map: drag to pan, wheel to zoom, right-drag or Ctrl-drag to rotate and pitch. Every move sends the camera to the Manager, which rebroadcasts it, so all screens follow within a frame. A view ignores incoming state for a quarter second after it sent one, so the drag is never fought by its own echo. Until anyone touches the map it shows the configured initial view; set `autoRotate` (degrees per second) for a slow deterministic rotation when idle. Tiles load asynchronously on each node, so a freshly panned area can pop in at slightly different moments; the camera itself never drifts.

Map data: OpenFreeMap vector tiles with OpenMapTiles building heights, no API key, attribution required (the compact control on each view). Any MapLibre style URL works via `style=`, but 3D buildings need the OpenMapTiles `building` layer.

## Technology

- **TypeScript** throughout, shared between browser and server
- **Vite** for the dev server and bundling
- **three.js** on **WebGL2** for rendering in v0; WebGPU is the target for the next version
- **WebSocket** (`ws`) for Manager to Node transport; WebTransport planned
- **zod** for validating configuration files and generating their JSON Schema
- **MapLibre GL JS** for the map application (served unbundled in dev: Vite's pre-bundling breaks its worker URL)
- **openvdb** (npm) for OpenVDB topology, plus in-house decoders for leaf buffers, point-data buffers and Blosc/LZ4 (`src/apps/vdb/`, `src/apps/points/`)
- **Node.js** for the Manager server, run with `tsx`
- Off-axis projection after Kooima's generalized perspective; anaglyph after Dubois' least-squares method

## Layout

```
configs/        cluster configuration files (JSON) and their generated schema
src/core/       config types, config file schema and loader, projection math, wall pixel layout, protocol, ClusterManager (transport-agnostic)
src/input/      input abstraction: action vocabulary, keyboard and gamepad devices with profiles
src/manager/    WebSocket server wrapping ClusterManager
src/node/       render node page
src/launcher/   node launcher: displays of this computer, one window per screen
src/core/screens.ts  Window Management API helpers (display list, fullscreen on a display)
src/simulator/  in-page cluster with in-memory transport
src/apps/       application contract and auto-discovering registry; one folder per app (shapes/, gltf/)
src/render/     per-screen viewport renderer, stereo packer, off-axis helper, 3D overview
public/models/  sample glTF assets
public/volumes/ OpenVDB files for the vdb app
scripts/        launch-nodes.sh (one kiosk Chrome per display), gen-schema.ts, screenshot.mjs (DevTools-driven page capture for testing)
index.html, simulator.html, node.html
```

## License

To be decided.
