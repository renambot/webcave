# Deployment

Three ways to run WebCAVE, from a laptop to a room full of machines. Each tier adds pieces; nothing changes in the code between them, only which processes run where.

| Tier | Machines | Processes |
|---|---|---|
| Minimal | one laptop | `npm run dev`, the simulator page |
| One computer, several displays | one PC with N displays and speakers | `npm run dev`, `npm run manager`, N node windows (launcher or kiosk), optionally the tracking bridge |
| Cluster | manager host, page server, N render machines, tracker host, control laptop | `npm run manager`, a page server, kiosk Chrome per display, `npm run tracker`, the simulator as controller |

Ports: the page server on **5173** (dev) or wherever you serve the built pages, the Manager WebSocket on **8765**, and whatever the tracker sends on (DTrack UDP 5000, NatNet UDP 1510 and 1511, VRPN TCP 3883). Everything is plain HTTP and WebSocket; no clock synchronization between machines is needed, because time comes from the Manager's frame counter.

## Tier 1: minimal, on a laptop

Nothing but the dev server and one browser tab. The simulator runs the Manager in the page and renders every screen as a tile.

```sh
git clone https://github.com/renambot/webcave && cd webcave
npm install
npm run dev
```

Open <http://localhost:5173/simulator.html?config=cave-3m&app=crayoland&audio=1>. Walk with the arrow keys and `I K J L`, move the hand with `Shift` + `W S A D Q E`, press `H` for the keys. Plug in a gamepad and press a button on it; the footer shows it. Add `&debug=1` for an app's debug drawing. This is also how you develop: edit a file and Vite reloads the page.

To try the cluster protocol without leaving the laptop, run the Manager and open a node page and the simulator as its controller:

```sh
npm run manager -- --config cave-3m --app crayoland
```

```
http://localhost:5173/node.html?node=front
http://localhost:5173/simulator.html?manager=ws://localhost:8765
```

The simulator now mirrors the wall and steers it; the node window renders the front screen. A fake tracker can drive the head and wand too (see [tracking.md](tracking.md)).

## Tier 2: one computer, several displays

A CAVE or a small wall driven by one PC with four displays. Use a config whose single node lists all the screens, such as `configs/cave-3m-1pc.json`, and give that node the input and the sound:

```json
"nodes": [{ "id": "pc", "screens": ["front", "left", "right", "floor"], "input": true, "audio": true }]
```

Start the page server and the Manager on the PC:

```sh
npm run dev
npm run manager -- --config cave-3m-1pc --app crayoland
```

Then one browser window per display. Two ways:

- **Launcher page**, in Chrome or Edge: <http://localhost:5173/launcher.html?node=pc>. It lists the displays, lets you map each screen to one, and opens all windows fullscreen in a click (the Window Management API prompts once for permission).
- **Kiosk script**, no clicking at all, one independent Chrome per display placed by pixel position:

  ```sh
  npm run nodes -- --nodes pc:front,pc:left,pc:right,pc:floor --positions "0,0 1920,0 3840,0 5760,0"
  npm run nodes -- --kill
  ```

  Positions are the top-left pixel of each display in the OS display settings. The script passes `--autoplay-policy=no-user-gesture-required`, so sound starts without a click.

Because the node has `input: true`, the keyboard and any gamepad plugged into the PC steer the cluster from whichever window has focus. `audio: true` on a multi-screen node applies to the window of its first screen only, so the room hears the soundscape once even with four windows open.

With a tracker, run the bridge on the same PC (`npm run tracker -- --config dtrack`); the hand then follows the real wand and the d-pad and `Shift` keys no longer apply.

## Tier 3: a cluster

One machine per display or per pair of displays, a manager host, and the room's tracking system.

**1. Describe the room.** Copy `configs/example-measured.json`, measure each screen's three corners in meters in a Y-up frame with the floor at y = 0 and the viewer near the origin (or use the placement form), fill in pixel sizes, and list the nodes with their screens. Mark the machine with the speakers `"audio": true` and, if a machine has a keyboard or gamepad for operators, `"input": true`. Set `"app"` and, for passive stereo walls, the per-screen `stereo` overrides. Validate:

```sh
npm run schema
```

**2. Serve the pages.** Development: `npm run dev` on the manager host serves on all interfaces (`host: true` in `vite.config.ts`). Production: build once and serve `dist/` from any static server, or with Vite's preview server:

```sh
npm run build
npm run preview -- --host --port 5173
```

The pages are static files; only the Manager and the tracking bridge are processes. Nodes on other machines must be able to reach both by address, not `localhost`.

**3. Start the Manager** on its host:

```sh
npm run manager -- --config path/to/room.json --port 8765
```

It prints the config name, sync tier and frame rate. Leave it running; nodes reconnect on their own if it restarts.

**4. Start the render machines.** On each, kiosk Chrome pointed at the page server and the Manager, one window per display:

```sh
scripts/launch-nodes.sh --nodes left --server http://manager-host:5173 --manager ws://manager-host:8765
scripts/launch-nodes.sh --nodes pc:front,pc:floor --positions "0,0 1920,0" --server http://manager-host:5173 --manager ws://manager-host:8765
```

On Windows, run `chrome.exe --kiosk --user-data-dir=%TEMP%\webcave-left --window-position=0,0 --window-size=1920,1080 --app="http://manager-host:5173/node.html?node=left&manager=ws://manager-host:8765"`. Put the command in a startup script or a service so the machine comes up rendering. The Window Management API (launcher page, `screen=` parameter) needs https or Chrome's `--unsafely-treat-insecure-origin-as-secure` flag on remote machines; the kiosk script needs neither.

**5. Tracking.** On the machine that can hear the tracker (any machine on the tracking network), configure `configs/trackers/room.json` with the tracker's protocol, the calibration into the CAVE frame and which bodies are the head and the wand, then:

```sh
npm run tracker -- --config path/to/room.json --manager ws://manager-host:8765
```

Its status line every five seconds lists the bodies it sees. Details and calibration in [tracking.md](tracking.md).

**6. Control and monitor.** From any laptop on the network, open the simulator as a controller, or, for an application with a control panel, the panel page on a tablet:

```
http://manager-host:5173/simulator.html?manager=ws://manager-host:8765
http://manager-host:5173/panel.html?manager=ws://manager-host:8765
```

A VR headset can join the same way and look at the scene from inside the virtual CAVE while the simulator drives it: open `xr.html` on the headset, see [Headset viewer](running.md#headset-viewer-webxr) for the secure-context setup it needs.

It shows the same frames as the wall, the overview with head and wand, and the barrier statistics per node in the footer. Its keyboard and gamepad drive navigation and the applications' buttons alongside the tracked wand. Late-frame counts that keep climbing point at a node that renders too slowly or a network problem; switch the config to `"sync": "loose"` if a soft sync is acceptable.

**Startup order** that avoids waiting: page server and Manager first, then render machines, then the tracker, then the controller. Any order works, since every client reconnects every second, but nodes show "disconnected, retrying" until the Manager is up.

**Checklist**

- Every node's HUD shows its screen id, the app status and a frame counter that advances (`h` toggles the HUD).
- The overview in the controller shows the head where the tracked person stands and the wand stick in their hand.
- Late frames stay near zero at the configured frame rate; if not, lower `fps` in the config or use the loose tier.
- Exactly one window plays sound.
- Stereo on a passive wall: cover one eye and check the images swap; fix with `swapEyes` or `firstEye` per screen.

## Updating a running installation

Edit the config, restart the Manager; nodes reconnect and rebuild with the new config, so a changed screen or app applies without touching the render machines. Code changes need a new build on the page server and a page reload on the nodes (kill and relaunch the kiosk windows, or reload from the controller machine with a remote-debugging tool).
