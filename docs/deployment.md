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

**2. Serve the pages.** Development: `npm run dev` on the manager host serves on all interfaces (`host: true` in `vite.config.ts`). Production: build once and serve `dist/` from any static server, or with Vite's preview server (or use the Docker images, see [below](#docker-behind-a-reverse-proxy)):

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

**7. Switch applications** without restarting anything: pick another app in the controller simulator's application dropdown, or from a shell on any machine that can reach the Manager:

```sh
npm run set-app -- ws://manager-host:8765 aquarium        # in the compose setup, from the server: ws://localhost:8765 with the port published, or through the proxy wss://host/webcave/manager
```

Every node, panel and headset page rebuilds for the new app within a frame; the Manager's `WEBCAVE_APP` (or `--app`) is only the app it starts with.

**Startup order** that avoids waiting: page server and Manager first, then render machines, then the tracker, then the controller. Any order works, since every client reconnects every second, but nodes show "disconnected, retrying" until the Manager is up.

**Checklist**

- Every node's HUD shows its screen id, the app status and a frame counter that advances (`h` toggles the HUD).
- The overview in the controller shows the head where the tracked person stands and the wand stick in their hand.
- Late frames stay near zero at the configured frame rate; if not, lower `fps` in the config or use the loose tier.
- Exactly one window plays sound.
- Stereo on a passive wall: cover one eye and check the images swap; fix with `swapEyes` or `firstEye` per screen.

## Docker, behind a reverse proxy

The lab's servers put every service behind one nginx under a path such as `https://host/webcave/`. WebCAVE deploys there as two containers built from the repository's `Dockerfile`: **web**, an nginx serving the built pages and public files under the base path and forwarding the Manager's WebSocket, and **manager**, the Node.js frame server bundled into one file. `docker-compose.yml` wires them together.

```sh
cp .env.example .env         # BASE_PATH, port, config, app
docker compose up -d --build
```

`.env` (or the environment) sets:

| Variable | Meaning | Default |
|---|---|---|
| `BASE_PATH` | Path prefix the site is served under, with both slashes: `/webcave/` | `/` |
| `VITE_APPS_DISABLED` | Apps to leave out of the build, comma-separated folder names: `map,density,map2d,dotdensity` | none |
| `WEBCAVE_HTTP_PORT` | Host port of the web container, what the front proxy forwards to | `8080` |
| `WEBCAVE_CONFIG` | Installation config in `configs/` | `cave-3m` |
| `WEBCAVE_APP` | Application to run | `shapes` |
| `WEBCAVE_SYNC` | `barrier` or `loose` | the config's |

**Leaving apps out.** `VITE_APPS_DISABLED` names apps that the build drops entirely: they are not registered, their code and libraries are not bundled (the four map apps alone are more than half of the download), and asking for one shows the fallback app with a status line that says it is disabled in this build. Like the base path it is decided at build time, so changing it means a rebuild of the web image. It also works for a plain `npm run build` or `npm run dev`, from the environment or a `.env` file.

The base path is a **build-time** setting: Vite rewrites every bundled asset URL, the pages link to each other relatively, and the apps' default asset URLs (`/models/...`, `/crayoland/`, ...) go through `publicUrl()` in `src/core/base.ts`, so a rebuild with another `BASE_PATH` is all a move needs. `configs/` is mounted into the manager container, so an installation file can be edited and the container restarted without a rebuild; `public/volumes/` is mounted into the web container for the large sample volumes that are not in the image.

**The front proxy.** Forward the prefix to the web container and let WebSocket upgrades through; the Manager's socket is at `<base>manager` on the same origin, which is what every page uses when no `manager=` parameter is given:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

location /webcave/ {
    proxy_pass http://webcave-host:8080/webcave/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 1d;        # the Manager's socket stays open for the whole session
}
```

Then, on the render machines and the operator's laptop:

```
https://host/webcave/node.html?node=front          # the Manager is found on the same origin
https://host/webcave/simulator.html                # controller of the deployed Manager (the default in a production build)
https://host/webcave/xr.html                       # headset viewer; https gives WebXR its secure context
```

Things to expect behind a proxy:

- **One long-lived WebSocket per page.** Every node and controller keeps its socket to the Manager for the session, so the proxy's read timeout must be long (the snippet says one day) or nodes drop and reconnect every minute.
- **A tracking bridge, or nodes on the CAVE's own LAN,** can bypass the proxy: publish the Manager's port in `docker-compose.yml` (`ports: 8765:8765`) and point them at `ws://webcave-host:8765`.
- **HTTPS is a feature here**: WebXR, the Window Management API for multi-screen nodes and WebGPU all want a secure context. Kiosk Chrome on the render machines accepts the institutional certificate like any browser.
- **Asset size.** The aquarium, Crayoland and the models are tens of megabytes; the web container serves them with sendfile and long caching for hashed bundles. If the front proxy buffers responses to disk, `proxy_max_temp_file_size 0` avoids that.
- **Nothing is stateful.** Both containers can be recreated at will; navigation and app state live only for the session.

Without a proxy, the same compose file serves the site at `http://host:8080/` with `BASE_PATH=/`.

### Build, update, inspect

Everything is built on the server from a checkout; nothing is pulled from a registry.

```sh
git clone https://github.com/renambot/webcave.git && cd webcave
cp .env.example .env                       # set BASE_PATH=/webcave/, the config and the app
docker compose up -d --build               # build both images (a few minutes the first time) and start
docker compose ps                          # webcave-web-1 and webcave-manager-1 should be "Up"
docker compose logs -f manager             # "[manager] config "cave-3m" ... listening on ws://0.0.0.0:8765"
curl -sI http://localhost:8080/webcave/ | head -1        # 200 from the web container
```

To update: pull, rebuild, restart. Compose only recreates the containers whose image changed, and the render machines reconnect on their own when the Manager comes back.

```sh
git pull
docker compose up -d --build
```

To change the installation or the app without rebuilding, edit `.env` or a file in `configs/` and restart the Manager: `docker compose up -d manager` after an `.env` change, `docker compose restart manager` after a config edit (`configs/` is a mount). A change of `BASE_PATH` or `VITE_APPS_DISABLED` needs a rebuild of the web image, since Vite bakes both into the pages.

The images can also be built and run by hand, without compose:

```sh
docker build --target web --build-arg BASE_PATH=/webcave/ -t webcave-web .
docker build --target manager -t webcave-manager .
docker run -d --name webcave-manager -p 8765:8765 -e WEBCAVE_CONFIG=cave-3m -e WEBCAVE_APP=shapes -v $PWD/configs:/app/configs:ro webcave-manager
docker run -d --name webcave-web -p 8080:80 -e BASE_PATH=/webcave/ -e MANAGER_UPSTREAM=host.docker.internal:8765 webcave-web
```

Building outside Docker, on the server itself, is `npm ci && BASE_PATH=/webcave/ npm run build`. The repository's `.npmrc` sets `legacy-peer-deps`, which the install needs (openvdb's declared peer range for three.js is older than the project's); without it npm stops with an ERESOLVE error and nothing is installed.

**Without the web container.** The nginx in the web image only serves the pages and forwards the Manager's socket, so a server that already runs nginx can do both itself: build the pages once, serve `dist/` with an `alias`, and proxy the socket to the Manager container's published port.

```sh
BASE_PATH=/webcave/ npm run build            # dist/ for that prefix
docker compose up -d manager                 # with "ports: 8765:8765" uncommented in docker-compose.yml
```

```nginx
location /webcave/         { alias /srv/webcave/dist/; try_files $uri $uri/ =404; }
location /webcave/manager  { proxy_pass http://127.0.0.1:8765/; proxy_http_version 1.1;
                             proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
                             proxy_read_timeout 1d; }
```

## Updating a running installation

In containers: `git pull && docker compose up -d --build`, see [above](#build-update-inspect). Otherwise:

Edit the config, restart the Manager; nodes reconnect and rebuild with the new config, so a changed screen or app applies without touching the render machines. Code changes need a new build on the page server and a page reload on the nodes (kill and relaunch the kiosk windows, or reload from the controller machine with a remote-debugging tool).
