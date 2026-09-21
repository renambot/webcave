# TODO: applications to make or port

Ideas for what would exercise WebCAVE next, grouped by what each one teaches the framework. Bundled apps live in `src/apps/` and are described in [docs/applications.md](docs/applications.md).

## Scientific visualization

- [ ] **vtk.js / ParaView Glance**: isosurfaces, slices and streamlines of a real dataset with the pipeline in shared state. The app CAVE visitors expect; vtk.js renders with WebGL, so it is a raw-app port like the aquarium.
- [ ] **Molecular viewer** (Mol* or NGL): a protein at room scale to walk around. Large geometry and a wand picking model.
- [ ] **Astronomy / point clouds at scale**: Gaia stars or a LiDAR scan with a streaming octree (Potree). Level of detail per node, beyond what fits in one buffer.

## Geospatial beyond flat walls

- [ ] **A 3D globe** (CesiumJS or terrain tiles) as a scene app: a curved world in the CAVE instead of a map on a wall; tile streaming per node.

## Collaboration and data walls

- [ ] **SAGE-style multi-window wall**: documents, PDFs, images and video arranged on the tiled wall from the panel. Pushes the panel, shared layout state and media sync.
- [ ] **Synchronized video**: a flat or 360-degree video across nodes. Decoded video that must stay in sync exposes any clock drift the current apps hide.

## Classic CAVE demos, after Crayoland

- [ ] **Battalion**, **CAVE Quake** or the **Virtual Director** camera tool: cheap to port where sources exist, and they carry the lab's history. A Quake-style BSP renderer in raw WebGL would be a strong short demo.

## Framework stress tests

- [x] **WebXR headset viewer** (`xr.html`): the scene in a headset, driven from the simulator; the headset as tracked head and its controller as wand. Not yet tried on a real headset.
- [ ] **WebXR adapter**: run an existing WebXR scene unmodified by feeding it CAVE views as if they were an XR session. Opens up hundreds of apps at once.
- [ ] **Shadertoy player**: a full-screen fragment shader with the off-axis camera in uniforms. Tiny to build; a smoke test for stereo and wall alignment.
- [ ] **Multiplayer presence**: two CAVEs, or a CAVE plus laptops, in one world with avatars over the Manager. Several writers on the state layer.

Suggested order: the WebXR adapter for leverage, a vtk.js volume and isosurface app for the scientific audience, and the synchronized video wall to shake out the barrier.
