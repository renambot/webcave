# WebCAVE Specification

Design document and research notes for WebCAVE, a browser-based cluster rendering framework for CAVEs, tiled display walls, domes and hybrid-reality environments. For a short overview and how to run the prototype, see [README.md](../README.md).

## Original ideas

- web based CAVE rendering
- runs in browsers
- uses modern technologies, such as Typescript, WebGPU, Webcodecs, html in canvas, and such innovative APIs from the browser.
- Simulator mode
- one Manager and Nodes
- Check for ideas system like CalVR, Omegalib, unity3D cluster, nDisplay from unreal Engine
- One aspect should be the simplicity of porting applications from other systems (probably using AI)
- I should support 2D applications (like maps, argis, MapLibre Js, ...) and 3D applications like games, 3d visualizations and such.
- It should read 3D tracking from external systems (OptiTrack, Vicon, ART, and others) directly from their network protocols.

---

## Lessons from existing cluster systems

What each system does well, and what WebCAVE should borrow.

| System | Key idea worth borrowing | Source |
|---|---|---|
| **nDisplay (Unreal)** | Primary node owns time, input and "cluster events"; render nodes are deterministic replicas. Frame barriers on game and render threads. Sync policies: none / ethernet barrier / NVIDIA swap lock. | [Overview](https://dev.epicgames.com/documentation/unreal-engine/ndisplay-overview-for-unreal-engine), [Synchronization](https://dev.epicgames.com/documentation/en-us/unreal-engine/synchronization-in-ndisplay-in-unreal-engine), [Cluster Events](https://dev.epicgames.com/documentation/unreal-engine/using-cluster-events-with-ndisplay-in-unreal-engine), [3D Config Editor](https://dev.epicgames.com/documentation/en-us/unreal-engine/ndisplay-3d-config-editor-in-unreal-engine) |
| **Omegalib (EVL, CAVE2)** | Multi-view / multi-application: several apps share one display system, input is routed dynamically, output can be redirected to SAGE. Pluggable front-ends (OpenGL, OSG, VTK). Python scripting. | [Paper](https://www.researchgate.net/publication/269309888_Omegalib_A_multi-view_application_framework_for_hybrid_reality_display_environments), [EVL](https://www.evl.uic.edu/research/2018) |
| **CalVR (Calit2)** | Cluster-aware, multi-GPU, multi-user, collaborative sessions, plugin architecture, custom menu widgets. | [Paper](https://www.researchgate.net/publication/258813621_CalVR_An_Advanced_Open_Source_Virtual_Reality_Software_Framework) |
| **Equalizer** | Declarative config of compounds; decomposition modes: 2D (sort-first), DB (sort-last), EYE (stereo), DPlex (alternate frame), pixel / subpixel. Used in CAVE2 and KAUST C6. | [TVCG paper](https://www.ifi.uzh.ch/vmml/publications/ieee-tvcg-equalizer/IEEE_TVCG_equalizer.pdf), [Equalizer 2.0](https://arxiv.org/pdf/1802.08022) |
| **SGCT / OpenSpace** | JSON config: Cluster > Nodes > Windows > Viewports. Fisheye, dome and warped projections without recompiling the app. Shared-data serialization per frame. | [GitHub](https://github.com/sgct/sgct), [Docs](https://sgct.readthedocs.io/en/latest/) |
| **Unity Cluster Rendering / MiddleVR** | Framelock, genlock, swaplock; warping and blending for curved screens; multi-user between CAVEs, headsets and mobile via Netcode. | [Unity manual](https://docs.unity3d.com/560/Documentation/Manual/ClusterRendering.html), [MiddleVR](https://www.middlevr.com/) |
| **Liquid Galaxy (Google Earth)** | Simplest possible sync: master broadcasts camera pose over UDP, each slave applies a fixed yaw/pitch/roll offset. Great fallback model for 2D and map apps. | [ViewSync wiki](https://github.com/LiquidGalaxy/liquid-galaxy/wiki/GoogleEarth_ViewSync), [Cesium demo](https://cesiumjs.org/demos/LiquidGalaxy/) |
| **SAGE3** | Web stack (React, TypeScript, Electron) already driving display walls; Electron client with per-display CLI flags; synchronized embedded webviews. | [Docs](https://sage-3.github.io/docs/SAGE3-Features), [Electron client](https://sage-3.github.io/docs/Electron-client), [GitHub](https://github.com/SAGE-3) |
| **MPCDI (VESA)** | Standard file format for projector warping, blending and color correction. Import it instead of inventing a format. | [VESA](https://vesa.org/featured-articles/vesa-completes-specifications-for-new-multiple-projector-common-data-interchange-standard-mpcdi/), [What is MPCDI](https://newsandviews.dataton.com/what-is-mpcdi) |

Prior art for the "CAVE in a browser" idea specifically: a 2016 paper prototyped CAVE / Powerwall clusters using only HTML5, WebGL and WebRTC and identified synchronization as the main bottleneck ([Springer](https://link.springer.com/article/10.1007/s11042-016-4256-7)). WebGPU, WebTransport and WebCodecs did not exist then; that is the opening for WebCAVE.

---

## Architecture ideas

### Roles
- **Manager**: single source of truth. Owns wall clock, frame counter, input devices, tracking, application lifecycle, config. Runs in Node/Bun/Deno or in a browser tab.
- **Nodes (render clients)**: one browser window per display (or per GPU output). Stateless replicas that receive a frame descriptor and render their viewport(s). Should be able to crash and rejoin mid-session.
- **Controllers**: phones, tablets, laptops, headsets that inject input or show a mirror. Same protocol as Nodes, just no display assignment.
- **Simulator**: the Manager runs all Nodes as tabs, iframes or OffscreenCanvas workers on a single machine, drawing the physical geometry in a 3D "virtual CAVE" preview (like nDisplay's 3D Config Editor). Same code path as production.

### Display description (config)
- Follow SGCT/Equalizer: `cluster > node > window > viewport > projection`.
- Projection types: planar screen (corner-defined for off-axis), cylindrical (CAVE2 style columns), dome/fisheye, equirectangular, pre-warped via MPCDI mesh, "flat 2D tile" (pixel offset only, for maps and desktops).
- Screen geometry in meters plus bezel and pixel dimensions, so both 3D frusta and 2D pixel offsets derive from one file.
- Per viewport: stereo output mode and its parameters (see "Stereo and output modes"), eye separation, default head pose when untracked; tracking-to-world transform per cluster.
- Config in JSON or TypeScript; validate with a schema; hot-reload without restarting apps.
- Config editor UI: drag screens in a 3D view, see coverage, export.

### Frame synchronization tiers
Browsers cannot genlock, so offer tiers and measure what each achieves.
1. **Loose** (Liquid Galaxy style): Manager broadcasts state every frame, Nodes render as soon as it arrives. Fine for maps and slow content.
2. **Barrier**: Manager sends `frame N` descriptor; Nodes render, then ack; Manager releases `present N` when all acked; Nodes swap on the next `requestAnimationFrame`. One frame of latency, no tearing between tiles beyond one vsync.
3. **Clock-scheduled**: Nodes keep a PTP-like offset to the Manager clock (measured with WebTransport datagram round trips), and present at an agreed timestamp. Use `requestAnimationFrame` timestamps and `performance.timeOrigin` to pick the right vsync.
4. **Hardware**: if hosts run NVIDIA Quadro Sync / genlock, the barrier tier will already land on the same vsync; expose a flag so a native helper (Electron or small Rust/Go sidecar) can drive `SwapGroup` and report drift.
- Always render one or two frames ahead with a frame queue so a slow node does not stall others; drop to "loose" gracefully and report skew in the dashboard.
- Measure inter-tile skew with a camera looking at a rolling counter, or with a phone's high-speed camera; publish results.

### Determinism
- nDisplay model: Nodes are deterministic given (time, input, seed). Ship a seeded PRNG, a cluster-synced `Date.now()` and `performance.now()` shim, and a fixed-timestep simulation clock.
- Anything non-deterministic (physics, network fetches, video decode) runs on the Manager or one elected Node and is replicated as state.
- Cluster events: Manager-ordered broadcast so every node applies an event in the same frame. Use this for app events, input, scene loading.

### Transport
- **WebTransport** (QUIC) for datagrams (state, tracking) plus reliable streams (assets, events). Baseline in all browsers since Safari 26.4 ([source](https://sachinsharma.dev/blogs/webtransport-vs-websockets-realtime-streaming-2026)).
- **WebSocket** fallback for locked-down networks.
- **WebRTC DataChannel** as a peer mesh option when there is no server, or for controllers on WiFi.
- Local multicast is unavailable to browsers; a tiny native relay could bridge UDP/VRPN/OSC to WebTransport.
- Binary protocol (FlatBuffers, CBOR or hand-rolled ArrayBuffer) for per-frame state; JSON for control plane.

### Rendering
- WebGPU as the primary API, WebGL2 fallback. WebGPU is now in Chrome, Edge, Firefox 147+, Safari 26+ ([support guide](https://webo360solutions.com/blog/webgpu-browser-support/)).
- One GPUDevice can render to many canvases per frame ([WebGPU explainer](https://gpuweb.github.io/gpuweb/explainer/)), so a single browser window can drive several displays on a multi-output GPU. Chrome will not span adapters on Windows ([troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips)), so a multi-GPU host still needs one browser process per GPU.
- Render in a Worker with OffscreenCanvas so main-thread jank (HTML UI, network) never delays a frame.
- Off-axis (Kooima generalized perspective) projection per screen from head pose. See [DisplayXR](https://github.com/DisplayXR/displayxr-web) for an off-axis WebXR analog. Stereo packing is a separate, configurable output stage; see the next section.
- Warp and blend pass: fullscreen mesh from MPCDI or a captured calibration; use GPU timestamp queries to profile it.
- Equalizer-style decomposition beyond per-screen sort-first: sort-last for volume rendering with WebGPU compute compositing; DPlex for very heavy scenes.
- HTML in canvas: render DOM layers (labels, panels) into textures using `element.requestFullscreen` overlays or the emerging HTML-in-canvas proposal; fallback is CSS positioned over the canvas with the same off-axis transform.
- Gaussian splats, point clouds, volumes: track WebGPU projects like [WebSplatter](https://arxiv.org/html/2602.03207v1) as reference renderers.

### Stereo and output modes

Different walls, projectors and glasses need the same left and right eye images packed differently. WebCAVE separates **eye rendering** (two off-axis frusta into two textures, or one for mono) from an **output packer** (a fullscreen pass that combines them for the display). Any app adapter gets stereo for free, and a display can change mode in the config without touching the app. This mirrors Equalizer's eye passes plus compositing, and SGCT's per-window stereo mode.

Pipeline per viewport, per frame:

```
head pose + screen corners  ->  left frustum, right frustum  (or mono)
render(scene, left)  -> texL     render(scene, right) -> texR
packer(mode, params, texL, texR) -> warp/blend -> canvas
```

**Modes and their parameters**

| Mode | What the packer does | Parameters | Typical hardware |
|---|---|---|---|
| `mono` | Renders one eye at the cyclopean position. | `eye`: `center` \| `left` \| `right` | Any display, 2D apps, onlookers |
| `side-by-side` (full) | Canvas is twice the screen width. Left eye in left half, right eye in right half, each at full screen resolution. | `eyeOrder`: `LR` \| `RL`; `gap` px between halves | Projectors or displays that accept a double-wide input and split it, dual-input polarized projector pairs |
| `side-by-side-half` (squished) | Canvas is the screen size. Each eye rendered at full width then horizontally squeezed to half width, or rendered at half width with an anamorphic projection. | `eyeOrder`; `renderScale`: render full-res then downscale vs render half-res directly; `aspectCorrection` for the frustum | Consumer 3D TVs and projectors in HDMI 1.4 frame-packing SbS mode, many passive 3D monitors |
| `top-bottom` (full and half) | Same as above, stacked vertically. | `eyeOrder`: `TB` \| `BT`; `half`: boolean; `gap` | 3D TVs, some projector stacks |
| `line-interleaved` (row) | Even rows from one eye, odd rows from the other. Requires exact pixel mapping: window must be fullscreen at native resolution with no OS scaling. | `firstRowEye`: `left` \| `right`; `rowOffset` to compensate a window that starts on an odd row; `halfVertical`: render each eye at half height | Passive polarized LCD panels with a film patterned retarder (CAVE2, Planar, LG passive 3D) |
| `column-interleaved` | Even and odd columns alternate eyes. | `firstColumnEye`; `columnOffset` | Some passive panels and lenticular autostereoscopic displays |
| `checkerboard` | Pixel-level alternation in both directions. | `firstPixelEye`; `phaseX`, `phaseY` | DLP 3D-ready projectors and TVs (Samsung, Mitsubishi) |
| `frame-sequential` | Alternates eyes on successive presented frames. Needs the display to run at 100 Hz or more and the glasses to sync to it. | `firstFrameEye`; `swapOnFrame` parity from the cluster frame counter; `emitterSync`: `none` \| `dlp-link` \| `nvidia-3dvision` \| `external`; `phaseHint` | Active shutter glasses with DLP-Link, RF or IR emitters. Hard in a browser: no frame-parity guarantee, so mark experimental and prefer a native shell (see open questions) |
| `quad-buffer` | Native left and right back buffers. Not available to browsers; only via a native shell or an OpenXR/WebXR runtime. | none | Quadro or Radeon Pro with OpenGL quad-buffer stereo |
| `anaglyph` | Colour-multiplex both eyes into one image. | `scheme`: `red-cyan` \| `green-magenta` \| `amber-blue`; `method`: `true` \| `gray` \| `color` \| `half-color` \| `optimized` \| `dubois`; custom 3x3 `leftMatrix`, `rightMatrix` for Dubois least-squares | Paper glasses; demos, remote viewers, the simulator |
| `interlaced-3d-video` | Pack eyes for an external video device using a frame-packing code from H.264 / HDMI 1.4a. | `packing`: `sbs` \| `tb` \| `checkerboard` \| `column` \| `row` \| `temporal` | Feeding a WebCodecs stream to a 3D-capable player or TV |
| `autostereo-multiview` | Render N views along the eye axis and interleave them per the panel's lenticular or barrier layout. | `views` (5 to 9 for classic lenticulars), `viewCone` degrees, `pitch`, `slope`, `center` from the panel's calibration | Looking Glass, Dimenco, Alioscopy style displays |
| `dome-fisheye` / `cubemap` | Not stereo, but same stage: render a cubemap and resample to a fisheye or equirectangular image. | `fov`, `tilt`, `resolution`, `stereoSeparation` for omnidirectional stereo | Planetariums, OpenSpace-style domes |

**Parameters shared by every stereo mode**
- `eyeSeparation` in meters (default 0.065), `swapEyes` boolean, `stereoScale` to exaggerate or reduce depth, `zeroParallaxDistance` for toe-in-free convergence on the physical screen (the screen plane is zero parallax by construction in off-axis rendering).
- `eyeOffsets`: left and right eye positions in the glasses body frame, from the tracking config, so head roll produces correctly rotated eye pairs.
- `perEyeColorCorrection`: gain and gamma per eye to compensate polarizer or filter tint; `ghostingReduction`: cross-talk cancellation amount in percent, applied by subtracting a fraction of the other eye's image.
- `multiUser`: `primary` (one tracked viewer, stereo), `mono-for-others` (mono onlookers), or `time-multiplexed` (two tracked users, four eye passes, frame-sequential display at 120 Hz or more).
- `renderResolutionScale` per eye, so a node can trade quality for frame rate under load.
- `stereoTestPattern`: an L/R labelled test card for verifying eye order and interleave phase during setup, toggled from the dashboard.
- `mixedMode`: a node may pack different viewports differently, for example a mono 2D panel next to a stereo 3D viewport on the same screen.

**Implementation notes**
- Pixel-exact modes (row, column, checkerboard) break if the browser applies device pixel ratio scaling or the window is not aligned. Check `devicePixelRatio === 1`, use `requestFullscreen` on the intended screen, and read the window's screen position to set the row and column offsets automatically.
- Row-interleaved passive panels often need eye parity flipped per column of a display wall; expose the parity per viewport, not per node.
- Frame-sequential in a browser: the only signal is `requestAnimationFrame` cadence. Prototype with the cluster frame counter driving parity and measure with a photodiode; if it drops frames it swaps eyes, so provide an auto-resync button and a shutter-glasses phase hint. Realistic production path is an Electron/Tauri shell that talks to the driver, or WebXR with the CAVE exposed as a device.
- Anaglyph should implement Dubois least-squares matrices for red-cyan, green-magenta and amber-blue, which reduce retinal rivalry and ghosting compared to naive channel masking ([Dubois anaglyph page](https://www.site.uottawa.ca/~edubois/anaglyph/), [matrices](https://ixora.io/projects/camera-3D/dubois-anaglyphs/)).
- Frame packing vocabulary (side-by-side, top-bottom, row, column, checkerboard, temporal) follows the H.264 frame packing arrangement codes so streamed output interoperates with 3D players ([awesome-stereoscopy](https://github.com/danielcamposramos/awesome-stereoscopy)).
- Each mode ships with a unit test that packs two solid-colour eye textures and asserts pixel positions, plus a visual test card in the simulator.

### Window and display placement
- Use the Window Management API (`getScreenDetails`, cross-screen `requestFullscreen`) to auto-place one fullscreen window per monitor from a single page ([Chrome docs](https://developer.chrome.com/docs/capabilities/web-apis/window-management), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window_Management_API)). Needs a user gesture and permission once.
- Kiosk launch: `chrome --kiosk --window-position --window-size --app=URL` per display, or an Electron/Tauri shell with per-display CLI flags as SAGE3 does.
- Auto-discovery: Nodes open `http://manager/join`, get assigned a display by hostname, MAC or by showing a QR code on the screen that the operator scans.

### 3D tracking from external systems

WebCAVE must ingest head and wand poses straight from commercial tracking systems by speaking their native network protocols. No vendor SDK or DLL in the hot path; parse the packets ourselves in TypeScript.

**Where the parsing runs.** Browsers cannot open raw UDP or TCP sockets. The Direct Sockets API exists but only for Isolated Web Apps, which today ship only on ChromeOS ([Chrome IWA docs](https://developer.chrome.com/docs/iwa/direct-sockets)). So protocol parsing lives in the **Manager process** (Node, Bun or Deno with `dgram` and `net`), or in a tiny standalone **tracking bridge** daemon when the Manager is a browser tab. The bridge normalizes every source into one WebCAVE tracking message and republishes it to Nodes and Controllers over WebTransport datagrams or WebSocket. The same bridge can also serve as a VRPN server so legacy apps keep working.

**Protocols to implement, most important first**

| System | Protocol | Transport, default ports | Payload | Notes | Source |
|---|---|---|---|---|---|
| **OptiTrack Motive** | NatNet | UDP. Commands on 1510, data multicast `239.255.42.99:1511` or unicast. | Binary, little-endian. Frame packet: frame number, marker sets, rigid bodies (id, pos, quat, mean error, tracking-valid flag), skeletons, labeled markers, timecode, timestamps. | Depacketize directly following the SDK's PacketClient / PythonClient samples; bitstream version comes from the server's description reply, so parse that first. | [Data Streaming](https://docs.optitrack.com/motive/data-streaming), [NatNet SDK](https://docs.optitrack.com/developer-tools/natnet-sdk), [Python depacketizer](https://github.com/ratcave/natnetclient) |
| **Vicon Tracker / Shogun / Nexus** | DataStream | TCP on 801 (SDK protocol). Tracker 4 also has a plain **UDP object stream** broadcast. | Binary request/reply for subjects, segments, global translation and rotation (quaternion, helical, Euler). UDP stream is a simpler per-object pose packet. | Implement the UDP object stream first (no handshake), then the TCP DataStream for markers and multiple subjects. Vicon also exposes a built-in VRPN server. | [Vicon UDP stream](https://help.vicon.com/space/Tracker40/14188749/Stream+object+data+over+a+UDP+broadcast+connection), [DataStream SDK](https://www.vicon.com/software/datastream-sdk/), [SDK manual](https://www.prophysics-sol.se/wp-content/uploads/2017/06/SDK_-Vicon-DataStream-SDK-Manual.pdf) |
| **ART DTrack2 / DTRACK3** | DTrack output | UDP to a configured host and port (commonly 5000). | **ASCII**, CR/LF lines: `fr` frame, `ts` timestamp, `6d` standard bodies, `6df2` Flystick with buttons and joysticks, `6dmt` measurement tools, `gl` gloves, `3d` markers. | Easiest protocol to parse; a regex per line. Rotation arrives as a 3x3 matrix. Trigger and DTrack2 remote control commands go over TCP/UDP ASCII too. | [Programmer's Guide](https://www.schneider-digital.com/wp-content/downloadcenter/Tools_Ressourcen/ART_Tracking/DTrack3_Controller_Software/DTrack3_Programmers-Guide_v3.2.x.pdf), [DTrackSDK](https://github.com/ar-tracking/DTrackSDK) |
| **VRPN** (universal adapter) | VRPN | TCP 3883 handshake; reliable TCP-only mode, or hybrid mode that negotiates a UDP port pair. | Binary, big-endian, 8-byte aligned messages. Types: `vrpn_Tracker` (pos + quat per sensor, plus velocity), `vrpn_Button`, `vrpn_Analog`. Device names like `Head@tracker-host`. | Implement **reliable TCP-only mode** in TypeScript, which avoids the UDP dance. Covers OptiTrack, Vicon, ART, PhaseSpace, Polhemus and DIY servers in one go. Rust reimplementation documents the wire format. | [vrpn-rs Protocol.md](https://github.com/vrpn/vrpn-rs/blob/main/Protocol.md), [VRPN](https://en.wikipedia.org/wiki/VRPN), [OptiTrack VRPN](https://docs.optitrack.com/developer-tools/vrpn-sample) |
| **Qualisys QTM** | QTM RT protocol | TCP 22222 (big-endian v1.0), 22223 (little-endian v1.1+), **OSC over UDP on 22225**. | Binary packets: 6DOF bodies with position and rotation matrix or Euler, 3D markers, analog, timecode. | Qualisys publishes an official Node.js client to crib from. | [Protocol docs](https://docs.qualisys.com/qtm-rt-protocol/), [qualisys-js-rt](https://github.com/qualisys/qualisys-js-rt) |
| **PhaseSpace** | OWL streaming | TCP/UDP via the OWL server. | Markers, rigids, timestamps. | Support via VRPN first; native OWL later if a lab needs it. | [OWL API header](https://github.com/labstreaminglayer/App-PhaseSpace/blob/master/owl.h), [PhaseSpace software](https://www.phasespace.com/software/) |
| **SteamVR / Vive Trackers, Antilatency, phones** | OSC / VMC | UDP, any port. | OSC bundles: `/tracker/<id>` or VMC `/VMC/Ext/Tra/Pos` with position and quaternion. | Cheap CAVE head tracking: a Vive Tracker on the glasses with the `Camera` role, an OpenVR-to-OSC utility on the SteamVR host. Also the path for Antilatency and DIY trackers. | [OpenVR-OSC](https://github.com/BarakChamo/OpenVR-OSC), [VMC protocol](https://protocol.vmc.info/english.html), [Vive Tracker head tracking](https://github.com/Yersi88/WMR-and-Vive-Tracker) |
| **Generic** | OSC, JSON over UDP, LSL, ROS 2 | UDP / DDS | Free-form | Escape hatch for anything else. Lab Streaming Layer and ROS 2 bridges are common in research labs. | |

**Normalized tracking model** (what every parser emits)

```ts
interface TrackerSample {
  source: string;          // "optitrack-lab", "art-cave2"
  bodyId: string;          // vendor id or name, e.g. "Head", "Wand"
  role?: "head" | "wand" | "hand-left" | "hand-right" | "prop" | "camera";
  position: [number, number, number];   // meters, WebCAVE world frame
  orientation: [number, number, number, number]; // unit quaternion (x, y, z, w)
  valid: boolean;          // tracking-valid flag from the vendor
  quality?: number;        // residual, mean error, or marker count
  buttons?: number;        // bitmask
  axes?: number[];         // joysticks, triggers
  vendorTime: number;      // vendor timestamp or frame number
  receivedAt: number;      // Manager monotonic clock, for latency stats
}
```

**Per-source configuration**
- Connection: protocol, host, port, multicast group, unicast fallback, reconnect policy.
- Body mapping: vendor body id or name to WebCAVE role. Hot-swappable at runtime so a new wand can be assigned from the dashboard.
- Coordinate transform: handedness, up axis (Y-up vs Z-up), unit scale (mm vs m), plus a 4x4 tracking-to-CAVE calibration matrix. Provide a guided calibration: place the wand at three known screen corners and solve.
- Eye offset: glasses body to left and right eye offsets in the body frame, so stereo frusta come out of one tracked body.
- Filtering: One Euro or Kalman per body with tunable cutoff; dead-reckoning prediction by a configurable number of milliseconds to compensate transport plus render latency.
- Dropout policy: hold last pose, decay to default pose, or freeze frusta, chosen per role.

**Distribution to Nodes**
- The Manager stamps each sample with the cluster frame number and sends the full set of tracked bodies in every frame descriptor, so tracking and simulation state stay in the same barrier. Nodes never subscribe to trackers directly, which keeps determinism.
- Also expose a low-latency side channel (WebTransport datagram) for Nodes that want to reproject with the freshest head pose right before present, like late-latching in HMD runtimes.
- Controllers and remote viewers get the same stream at a lower rate.

**Serving trackers back out**
- The bridge can act as a **VRPN server** and an **OSC sender**, so a Unity or Unreal app running alongside WebCAVE shares one calibrated tracking source.
- Record and replay tracking streams (with timestamps) for offline development and regression tests in the simulator.

**Dashboard and diagnostics**
- Live list of sources, bodies, packet rate, dropped frames, age of last sample, residual.
- 3D view of tracked bodies inside the virtual CAVE geometry; shows immediately when the calibration matrix is wrong.
- Latency probe: motion-to-photon estimate by moving a tracker and detecting the screen update with a Node's webcam.

### Other input
- Browser-native input on the Manager or Controllers: Gamepad API, WebHID (custom wands), Pointer events, WebXR controllers from a headset acting as a 6DoF wand.
- Phone as tracker: WebXR AR session or DeviceOrientation, camera pose streamed to the Manager as an OSC-like TrackerSample.
- Camera-based head tracking with in-browser ML (MediaPipe / TensorFlow.js face landmarks) as a zero-hardware option for the simulator and small setups.
- All of these emit the same `TrackerSample`, so applications never know which tracker is in use.

### 2D application support
- Modes: **tiled** (one large virtual canvas, each node shows a pixel rectangle), **replicated** (each node runs the app and receives camera/viewport), **streamed** (one instance renders, WebCodecs-encoded tiles sent to nodes).
- MapLibre GL JS, deck.gl, Leaflet, OpenLayers, ArcGIS Maps SDK for JavaScript, CesiumJS: implement a `CameraAdapter` per library that maps the shared camera (center, zoom, bearing, pitch) to a per-tile offset, like MapLibre's [sync-move example](https://maplibre.org/maplibre-gl-js/docs/examples/sync-movement-of-multiple-maps/) but across windows. deck.gl already syncs its MapView with MapLibre ([docs](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre)).
- Generic DOM apps (dashboards, slides, video): CSS transform of the whole document per tile, plus event replay for interaction, plus synchronized `<video>` seek/play via the cluster clock.
- Arbitrary web pages: an iframe per node with a shared scroll/zoom state, or a streamed WebCodecs capture of a single headless tab.

### 3D application support
- Adapters for three.js, Babylon.js, PlayCanvas, A-Frame, Unity WebGPU export, Godot Web, Unreal Pixel Streaming (as a streamed source).
- The adapter replaces the library's camera with a WebCAVE `ClusterCamera` that yields per-viewport view and projection matrices, and hooks the render loop into the cluster frame barrier.
- WebXR bridge: present the cluster as a fake WebXR device with N views, so any WebXR app renders to the CAVE unchanged. The WebXR Layers API mirrors OpenXR closely ([explainer](https://github.com/immersive-web/layers/blob/main/explainer.md)), so a polyfilled `XRSession` with multiple `XRView`s is a plausible path.
- Multi-view rendering in one pass where a node owns several screens (WebGPU render to texture array, then blit).

### Streaming and video
- WebCodecs for hardware encode/decode of video textures, movies on the wall, and remote sources ([WebCodecs guide](https://www.digitalsamba.com/blog/webcodecs-api-explained)).
- Video sync: Manager distributes the presentation timestamp per frame; nodes decode ahead and present the matching frame.
- Omegalib-style output redirection: a node's rendered frame can be encoded and sent to SAGE3, a remote CAVE, a headset or a web viewer, enabling Cave-to-Cave collaboration.
- Media over QUIC (MoQ) as the pub/sub layer for many-viewer fan-out.

### Multi-user and collaboration
- Shared session state via CRDT (Yjs) for annotations, app layout, pointers ([Yjs](https://yjs.dev/)), while high-rate frame state stays on the custom binary protocol.
- Multiple tracked users with per-user stereo pairs on time-multiplexed displays, or "primary viewer plus mono onlookers" policy.
- Remote participants join from a headset or browser with their own view of the same scene, like MiddleVR 3.0 multi-user.

### Multi-application (Omegalib idea)
- Run several apps at once, each assigned a region of screens or a layer; the Manager composites via z-order and input focus rules.
- App lifecycle: launch, suspend, resume, migrate between nodes; app manifests declare required capabilities (stereo, tracking, GPU features).

### Porting applications
- Publish a small, documented adapter API: `onFrame(state)`, `getViewport()`, `getCamera()`, `emitEvent()`. Most ports are: replace camera, remove local input handling, subscribe to cluster events.
- Ship "port recipes" and an LLM-oriented `PORTING.md` plus a Claude Code / Copilot skill that reads an existing three.js, MapLibre or Unity WebGL app and generates the adapter glue.
- Provide the simulator as a one-line `npx webcave dev` so a developer can test the port on a laptop with 3 to 6 fake screens.
- Validation harness: run the app in the simulator, diff frames across nodes to detect nondeterminism.

### Operations and observability
- Web dashboard on the Manager: node health, FPS, frame skew histogram, GPU memory, dropped frames, temperatures via a host agent.
- Remote control from a phone: start/stop apps, switch layouts, calibrate.
- Recording and replay of the state stream for demos and regression testing.
- Chaos mode in the simulator: inject latency, drop a node, throttle GPU, to test the sync tiers.

### Calibration
- Camera-based projector calibration producing MPCDI, or import from existing tools (VIOSO, Scalable Display, Pixera).
- LCD wall alignment tool: show grid patterns, adjust per-tile pixel offset and bezel compensation in the browser.
- Color and brightness matching per tile with a shader LUT.

### Non-goals to state early
- Sub-millisecond genlock in a pure browser. Document achievable skew per tier instead.
- Replacing Unreal or Unity for AAA content. Target visualization, maps, web apps, and streamed sources from those engines.

---

## Prototype (v0)

A first working slice lives in this repo: TypeScript, Vite, three.js on WebGL2 (WebGPU is the next step). Run instructions are in [running.md](running.md).

What is implemented:

| Area | File | Status |
|---|---|---|
| Cluster config types (screens as three corners, nodes, stereo params) | `src/core/config.ts` | done |
| Configuration files: JSON in `configs/`, zod validation with defaults, screens by corners or by center/size/angles, generated JSON Schema for editors, `--config name|path`, `--list-configs` | `src/core/configFile.ts`, `configs/`, `scripts/gen-schema.ts` | done |
| Kooima off-axis frustum | `src/core/projection.ts` | done |
| Manager: frame counter, deterministic time, simulated head, navigation (position, yaw, pitch), barrier with timeout, stats | `src/core/manager.ts` | done, transport-agnostic |
| WebSocket transport (Node.js) | `src/manager/server.ts` | done |
| Simulator: in-memory transport (local mode) or WebSocket controller of a live Manager (`?manager=`), keyboard head and navigation, help overlay | `src/simulator/main.ts` | done |
| Per-screen renderer: eye targets, present pass | `src/render/viewport.ts` | done |
| Stereo packer: mono, SbS full/half, TB full/half, row, column, checkerboard, red-cyan anaglyph (Dubois colour and B/W), frame-sequential parity | `src/render/stereo.ts` | done (frame-sequential untested on hardware) |
| Application contract (scene, deterministic `update(time)`, status) and registry that auto-discovers one folder per app; app spec travels in the cluster config | `src/apps/types.ts`, `src/apps/index.ts`, `src/apps/README.md` | done, minimal |
| "shapes" app: basic shapes, deterministic animation | `src/apps/shapes/` | done |
| "gltf" app: loads a glTF/GLB, fits and places it, plays animations from cluster time | `src/apps/gltf/` | done; no Draco/KTX2 decoders yet |
| "vdb" app: OpenVDB volume rendering; topology via the `openvdb` package (leaf origins made absolute in `tree.ts`), leaf values via an in-house reader (OpenVDB record layout, Blosc v1 + LZ4 + byte unshuffle incl. unsplit leftover blocks, float/half), percentile-normalized R8 3D texture cropped to content, ray-marched with absorption and a one-tap shadow | `src/apps/vdb/` | done; zip-compressed buffers and vector grids not handled |
| "points" app: OpenVDB PointDataGrid decoding (multi-pass buffer section, attribute descriptor, voxel offsets, paged payloads, fixed-point/half/float codecs), decimation, three.js point cloud with Cd colours | `src/apps/points/` | done; verified against the file's bounding box and voxel count |
| Input abstraction: device-independent action state (axes with dead zones, buttons), keyboard and Gamepad API devices with per-device profiles, shared `InputController` (bindings to navigation/reset/spin, mouse, keyboard taps), per-client `input` messages merged on the Manager into appState.input, app hook `onInput` (map camera from a gamepad), nodes opt in with `input: true` | `src/input/`, `src/core/manager.ts`, `src/apps/types.ts` | done; wand/tracker buttons and phones to come |
| Flat (2D) application contract: one view per screen, wall pixel layout from screen geometry (bezels included, coplanarity check) | `src/apps/types.ts`, `src/core/wall.ts` | done |
| Shared application state: `appState` in every frame, `setAppState` patches from controllers, last writer wins | `src/core/protocol.ts`, `src/core/manager.ts` | done |
| MapLibre wall machinery: exact sub-rectangle per tile via padding + fov + canvas extended to the wall center, zoom compensated by canvas scale; camera shared and interactive from controllers; optional deterministic auto-rotate | `src/apps/map/wallmap.ts` | done; verified edge continuity numerically |
| "map" app: 3D buildings (MapLibre example) on the wall machinery | `src/apps/map/` | done |
| "density" app: 2D population-density choropleth (MapLibre example) on the wall machinery; custom GeoJSON via `data` | `src/apps/density/` | done |
| DevTools-driven screenshot tool for testing pages that need a live render loop (with drag and eval) | `scripts/screenshot.mjs` | done |
| 3D overview of screens, head, frusta; modes: geometry only, wall textures, scene in space; view from head | `src/render/overview.ts` | done |
| Shared off-axis camera setup | `src/render/offaxis.ts` | done |
| Kiosk launcher: one Chrome per node or per `node:view`, per-display position, own profile, kill switch | `scripts/launch-nodes.sh` | done (macOS, Linux) |
| Window Management API: display enumeration, fullscreen on a chosen display, `screen=` on nodes | `src/core/screens.ts`, `src/node/main.ts` | done (Chromium, secure context) |
| Launcher page: map a multi-screen node's screens to this computer's displays, open fullscreen popups, emit the kiosk command | `launcher.html`, `src/launcher/main.ts` | done |
| Wand pose (6-DOF like the head) in every frame: absolute from a tracker (`setWand`), else derived from the head as a hand offset in the head's yaw frame (`defaultWand`, simulator Ctrl keys adjust it), drawn in the overview; CAVE <-> world helpers for apps | `src/core/protocol.ts`, `src/core/pose.ts`, `src/core/navigation.ts`, `src/simulator/main.ts`, `src/render/overview.ts` | done; tracker bridge to come |
| Sound output node (`audio: true`, `?audio=1`) passed to apps as `AppContext.audio`; app navigation hints (speed, turn, planar) | `src/core/config.ts`, `src/apps/types.ts`, `src/input/controller.ts` | done; single node, no spatialization |
| Deterministic randomness helpers (stateless hash, seeded PRNG, smooth noise) | `src/core/random.ts` | done |
| "crayoland" app: Dave Pape's Crayoland ported from C++; original World/Sounds files, merged and instanced picture quads, fixed-step seeded bee and butterfly simulations, controller-published grab/throw, anger and landing, Web Audio soundscape | `src/apps/crayoland/`, `public/crayoland/` | done; navigation follows heading, not the wand |
| Tracking protocol parsers, WebGPU renderer, warp/blend, more 2D adapters (deck.gl, Leaflet, DOM), adapters for existing three.js/WebXR apps | | not started |

## Suggested milestones

1. **Spec**: config schema, protocol messages, frame lifecycle. Written as TypeScript types.
2. **Simulator**: Manager plus N iframes or windows on one machine, three.js cube with off-axis projection, barrier sync, dashboard showing skew.
3. **Physical wall**: Window Management API placement on a 2 to 4 display host; measure skew with a camera.
4. **2D adapters**: MapLibre and a generic DOM tile mode.
5. **Tracking**: native NatNet, DTrack and VRPN parsers in the Manager, tracking-to-CAVE calibration tool, phone-based head tracking; stereo output. Then Vicon UDP/DataStream, Qualisys, OSC/VMC.
6. **Cluster**: multiple hosts over WebTransport, node rejoin, clock-scheduled tier.
7. **Porting kit**: adapter API docs, recipes, AI porting skill, three example ports.
8. **Advanced**: warp/blend from MPCDI, WebXR bridge, streamed sources, multi-app compositing.

## Open questions

- Can a browser hit a specific vsync reliably enough for a 60 Hz wall, or is a thin native shell (Electron, Tauri, custom Chromium) required for production?
- Frame-sequential stereo in a browser: is there any path besides a native shell driving the GPU? Can `requestAnimationFrame` parity plus a photodiode calibration be made reliable enough for active glasses?
- Pixel-exact interleaved modes: how robust are they across OS scaling, browser zoom and multi-monitor DPI on macOS, Windows and Linux?
- How much determinism can we guarantee with third-party libraries (three.js animation mixers, MapLibre tile loading)? Replicated mode vs streamed mode trade-offs per library.
- Licensing and name: check for collisions with existing "WebCAVE" projects.
