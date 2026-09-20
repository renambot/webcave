/**
 * Simulator: the whole cluster in one browser page.
 *
 * Two modes, chosen by the URL:
 *
 * Local mode (default) runs the ClusterManager in-page with an in-memory
 * transport. Each screen of the config is a tile with its own
 * ViewportRenderer; the manager's broadcast() calls the tiles directly and
 * they ack synchronously, so the same frame -> render -> ack -> present cycle
 * as a real cluster runs at the page's animation rate. Nothing is networked.
 *
 * Controller mode (?manager=ws://host:8765) connects to a running Manager
 * server as a "controller". The page receives the same frame and present
 * messages as the render nodes, mirrors the wall in its tiles and overview,
 * and its keyboard and toolbar send head and navigation commands to the
 * server. It never acks, so it cannot hold the cluster barrier.
 *
 * Both modes share createApp(): tiles, overview, toolbar, keyboard and the
 * frame loop are identical; only the ControlLink behind them differs.
 *
 * File map:
 *   ControlLink            the UI's view of "a manager": send, tick, stats
 *   bootLocal / bootRemote build the link for each mode, then createApp()
 *   createApp              tiles, overview, toolbar, help, keyboard, frame loop
 *
 * URL parameters: config=NAME|url, manager=ws://..., app=/model=/size=/spin=/mx my mz,
 * stereo=, anaglyph=, overview=none|walls|world, yaw= pitch= x= y= z=, help=1, autohead=1,
 * audio=1 (this page plays the application's sound), debug=1 (the application's debug drawing).
 */
import * as THREE from "three";
import { type ClusterConfig, type StereoMode, type AnaglyphScheme, resolveStereo } from "../core/config";
import { bundledConfigNames, bundledConfigs, loadConfig } from "../core/configs";
import { ClusterManager, type ManagerTransport } from "../core/manager";
import { decode, encode, type ClientMessage, type ServerMessage, type NodeStats, type FrameState } from "../core/protocol";
import { appSpecFromParams, createApp as createCaveApp, isFlatApp, toggleSpinPatch, type FlatView } from "../apps";
import { InputController } from "../input/controller";
import { wallLayout } from "../core/wall";
import { screenSize } from "../core/projection";
import { ViewportRenderer } from "../render/viewport";
import { OverviewRenderer, type OverviewMode } from "../render/overview";
import { wandFromHead } from "../core/pose";

const params = new URLSearchParams(location.search);
const managerUrl = params.get("manager");
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// Surface runtime errors in the footer: a simulator that silently freezes is
// useless on a wall. The frame loop below also survives exceptions.
let lastError = "";
const reportError = (msg: string) => {
  lastError = msg;
  console.error(msg);
  const el = document.querySelector<HTMLElement>("#stats");
  if (el) el.innerHTML = `<span class="warn">${msg.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</span>`;
};
window.addEventListener("error", (e) => reportError(`error: ${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => reportError(`unhandled: ${(e.reason as Error)?.message ?? e.reason}`));

/**
 * Everything the UI needs from a Manager, local or remote. Keeping this tiny
 * is what lets the same toolbar drive an in-page manager or a live cluster.
 */
interface ControlLink {
  readonly label: string;
  send(msg: ClientMessage): void;
  /** Local only: advance a frame. Remote: no-op, frames come from the server. */
  tick(): void;
  stats(): NodeStats[];
}

// ---------------------------------------------------------------------------
// Boot: local manager immediately, or wait for the server's welcome message.
// ---------------------------------------------------------------------------

if (managerUrl) {
  bootRemote(managerUrl);
} else {
  loadConfig(params.get("config")).then(bootLocal, (e: Error) => {
    $("#stats").textContent = e.message;
    $("#link-status").textContent = "● config error";
  });
}

/** Local mode: an in-memory manager whose broadcast() feeds the tiles directly. */
function bootLocal(cfg: ClusterConfig) {
  const transport: ManagerTransport = {
    send: () => {}, // welcome messages are not needed locally
    broadcast: (msg) => app?.handleServerMessage(msg),
  };
  const manager = new ClusterManager(cfg, transport);
  const link: ControlLink = {
    label: `local manager (${cfg.name})`,
    send: (msg) => manager.onMessage("ui", msg),
    tick: () => manager.tick(Date.now()),
    stats: () => manager.stats(),
  };
  const app = createApp(cfg, link, {
    ack: (nodeId, frame, renderMs) => manager.onMessage(nodeId, { type: "ack", frame, renderMs }),
    onSyncChange: (sync) => (cfg.sync = sync),
  });
  // Register one fake node per screen so the barrier has participants.
  for (const s of cfg.screens) {
    manager.onConnect(s.id);
    manager.onMessage(s.id, { type: "hello", nodeId: s.id, role: "node" });
  }
  app.start();
}

/**
 * Controller mode: WebSocket to the server. The config arrives in the
 * "welcome" message, so the page is built only then; frames follow.
 * Reconnects every second if the server goes away.
 */
function bootRemote(url: string) {
  const statsEl = $("#stats");
  statsEl.textContent = `connecting to ${url} ...`;
  let app: App | null = null;
  let statsCache: NodeStats[] = [];
  let ws: WebSocket;

  const link: ControlLink = {
    label: `controller of ${url}`,
    send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(encode(msg)),
    tick: () => {},
    stats: () => statsCache,
  };

  const connect = () => {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => link.send({ type: "hello", nodeId: "simulator", role: "controller" }));
    ws.addEventListener("message", (ev) => {
      const msg = decode<ServerMessage>(ev.data);
      if (msg.type === "welcome") {
        if (!app) {
          app = createApp(msg.config, link, { ack: () => {}, onSyncChange: () => {} });
          app.start();
        }
        return;
      }
      if (msg.type === "stats") statsCache = msg.nodes;
      app?.handleServerMessage(msg);
    });
    ws.addEventListener("close", () => {
      statsEl.textContent = `disconnected from ${url}, retrying...`;
      setTimeout(connect, 1000);
    });
    ws.addEventListener("error", () => ws.close());
  };
  connect();
}

// ---------------------------------------------------------------------------
// The app: tiles, overview, toolbar, keyboard. Same for both modes.
// ---------------------------------------------------------------------------

/** Mode-specific callbacks: local tiles ack to the in-page manager; a controller does not ack. */
interface AppHooks {
  ack(nodeId: string, frame: number, renderMs: number): void;
  onSyncChange(sync: ClusterConfig["sync"]): void;
}

interface App {
  start(): void;
  handleServerMessage(msg: ServerMessage): void;
}

function createApp(cfg: ClusterConfig, link: ControlLink, hooks: AppHooks): App {
  const remote = !!managerUrl;
  const grid = $("#grid");
  const overviewCanvas = $<HTMLCanvasElement>("#overview");
  const statsEl = $("#stats");
  // The application comes from the cluster config; URL parameters override it.
  // A "scene" app is rendered by one ViewportRenderer per tile; a "flat" app
  // (the map) creates one FlatView per tile inside a plain div.
  const audioParam = params.get("audio") === "1";
  const debugParam = params.get("debug") === "1";
  const demo = createCaveApp(appSpecFromParams(params, cfg.app), { audio: audioParam, debug: debugParam });
  const flat = isFlatApp(demo) ? demo : null;
  const sceneApp = isFlatApp(demo) ? null : demo;
  const layout3 = wallLayout(cfg);

  // Last frame received (or produced). Everything displayed derives from it.
  let lastState: FrameState = {
    frame: 0,
    time: 0,
    head: { ...cfg.defaultHead },
    wand: wandFromHead(cfg.defaultHead, cfg.defaultWand),
    navigation: { position: [0, 0, 0], yaw: 0, pitch: 0 },
    appState: {},
    issuedAt: 0,
  };

  // ---- Tiles ---------------------------------------------------------------
  // One canvas and ViewportRenderer per screen in the config. They all draw
  // the same scene object; three.js keeps per-context GPU resources.
  const tiles: { id: string; viewport: ViewportRenderer }[] = [];
  /** Flat app views, one per screen, with the element the view lives in. */
  const flatViews: { id: string; screen: ClusterConfig["screens"][number]; view: FlatView; el: HTMLDivElement }[] = [];
  grid.replaceChildren();
  for (const screen of cfg.screens) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = screen.id;
    if (flat) {
      // Interactive: the simulator is a controller. Camera changes go to the
      // manager as setAppState patches and come back to every tile in the frame.
      const el = document.createElement("div");
      el.className = "flat";
      tile.append(el, label);
      grid.append(tile);
      const view = flat.createView(el, screen, layout3, {
        interactive: true,
        send: (patch) => link.send({ type: "setAppState", patch }),
      });
      flatViews.push({ id: screen.id, screen, view, el });
    } else {
      const canvas = document.createElement("canvas");
      tile.append(canvas, label);
      grid.append(tile);
      tiles.push({ id: screen.id, viewport: new ViewportRenderer(cfg, screen, canvas, resolveStereo(cfg, screen)) });
    }
  }

  const overview = new OverviewRenderer(cfg, overviewCanvas);

  // Debug handle for scripts/screenshot.mjs --eval and the browser console.
  (window as unknown as { webcave: unknown }).webcave = { cfg, app: demo, tiles, flatViews, lastState: () => lastState, input: () => input };

  /**
   * The node side of the protocol, for all tiles at once. Same shape as
   * node/main.ts: update the app to the frame's time, render every tile's
   * eyes, ack, and present now (loose) or on the manager's "present".
   */
  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "frame": {
        lastState = msg.state;
        if (flat) {
          for (const v of flatViews) {
            const t0 = performance.now();
            v.view.render(msg.state);
            hooks.ack(v.id, msg.state.frame, performance.now() - t0);
          }
          break;
        }
        sceneApp!.update(msg.state.time, msg.state);
        for (const t of tiles) {
          const t0 = performance.now();
          t.viewport.renderFrame(sceneApp!.scene, msg.state);
          hooks.ack(t.id, msg.state.frame, performance.now() - t0);
          if (cfg.sync === "loose") t.viewport.present(msg.state.frame);
        }
        break;
      }
      case "present":
        for (const t of tiles) t.viewport.present(msg.frame);
        break;
    }
  }

  // ---- Layout --------------------------------------------------------------
  // Tiles fit their grid cell keeping the screen's physical aspect (a 3 m
  // square wall stays square). Up to 3 screens in one row, 4 as 2x2, else 3 columns.
  function layout() {
    const n = cfg.screens.length;
    const cols = n <= 3 ? n : n <= 4 ? 2 : 3;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    for (const t of tiles) {
      const el = t.viewport.renderer.domElement;
      const r = el.parentElement!.getBoundingClientRect();
      const size = t.viewport.fitInto(r.width - 8, r.height - 8);
      el.style.width = `${size.width}px`;
      el.style.height = `${size.height}px`;
    }
    for (const v of flatViews) {
      const r = v.el.parentElement!.getBoundingClientRect();
      const s = screenSize(v.screen);
      const aspect = s.width / s.height;
      let w = r.width - 8;
      let h = w / aspect;
      if (h > r.height - 8) {
        h = r.height - 8;
        w = h * aspect;
      }
      v.el.style.width = `${Math.floor(w)}px`;
      v.el.style.height = `${Math.floor(h)}px`;
      v.view.resize(Math.floor(w), Math.floor(h));
    }
    const or = overviewCanvas.parentElement!.getBoundingClientRect();
    overview.setSize(Math.floor(or.width), Math.floor(or.height));
    overviewCanvas.style.width = `${Math.floor(or.width)}px`;
    overviewCanvas.style.height = `${Math.floor(or.height)}px`;
  }
  window.addEventListener("resize", layout);

  // ---- Toolbar -------------------------------------------------------------
  const modeSel = $<HTMLSelectElement>("#mode");
  const anaglyphSel = $<HTMLSelectElement>("#anaglyph");
  const ipdInput = $<HTMLInputElement>("#ipd");
  const btnSwap = $<HTMLButtonElement>("#btn-swap");
  const btnAutoHead = $<HTMLButtonElement>("#btn-autohead");
  const btnAudio = $<HTMLButtonElement>("#btn-audio");
  const btnDebug = $<HTMLButtonElement>("#btn-debug");
  const syncSel = $<HTMLSelectElement>("#sync");
  const configSel = $<HTMLSelectElement>("#config");
  const overviewModeSel = $<HTMLSelectElement>("#overview-mode");

  // Toggle buttons (panoweb style): .active plus aria-pressed.
  const toggles = { swap: false, autoHead: false, audio: audioParam, debug: debugParam };
  const setToggle = (btn: HTMLButtonElement, on: boolean) => {
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  };

  // Header: link status and app info.
  const linkStatus = $("#link-status");
  linkStatus.textContent = remote ? `● controller · ${managerUrl}` : `● local manager · ${cfg.name}`;
  linkStatus.classList.toggle("remote", remote);
  const appInfo = $("#app-info");

  // Readout cells.
  const ro = {
    frame: $("#ro-frame"),
    fps: $("#ro-fps"),
    head: $("#ro-head"),
    headrot: $("#ro-headrot"),
    wand: $("#ro-wand"),
    nav: $("#ro-nav"),
    navrot: $("#ro-navrot"),
    late: $("#ro-late"),
  };

  // Config selector lists the bundled configs/*.json files.
  configSel.innerHTML = "";
  for (const name of bundledConfigNames) {
    const c = bundledConfigs[name];
    configSel.append(new Option(`${name} · ${c.screens.length} screens · ${c.nodes.length} node${c.nodes.length > 1 ? "s" : ""}`, name));
  }
  if (remote) {
    // Config and sync tier belong to the server in controller mode.
    configSel.disabled = true;
    syncSel.disabled = true;
    configSel.append(new Option(`${cfg.name} (server)`, "__server"));
    configSel.value = "__server";
  } else {
    const current = params.get("config") ?? bundledConfigNames[0];
    if ([...configSel.options].some((o) => o.value === current)) configSel.value = current;
    else configSel.append(new Option(cfg.name, current)), (configSel.value = current);
    configSel.addEventListener("change", () => {
      const p = new URLSearchParams(location.search);
      p.set("config", configSel.value);
      location.search = p.toString();
    });
  }
  syncSel.value = cfg.sync;
  syncSel.addEventListener("change", () => hooks.onSyncChange(syncSel.value as ClusterConfig["sync"]));

  // Stereo from the URL: ?stereo=anaglyph&anaglyph=bw
  if (params.has("stereo")) modeSel.value = params.get("stereo")!;
  if (params.has("anaglyph")) anaglyphSel.value = params.get("anaglyph")!;

  // Stereo does not apply to flat apps: grey the controls out.
  if (flat) {
    for (const el of [modeSel, anaglyphSel, ipdInput, btnSwap]) el.disabled = true;
    modeSel.title = "Stereo output does not apply to flat (2D) applications";
  }

  function applyStereo() {
    anaglyphSel.disabled = flat ? true : modeSel.value !== "anaglyph";
    for (const t of tiles) {
      t.viewport.stereo.mode = modeSel.value as StereoMode;
      t.viewport.stereo.anaglyph = anaglyphSel.value as AnaglyphScheme;
      t.viewport.stereo.eyeSeparation = Number(ipdInput.value) / 1000;
      t.viewport.stereo.swapEyes = toggles.swap;
    }
    layout();
  }
  modeSel.addEventListener("change", applyStereo);
  anaglyphSel.addEventListener("change", applyStereo);
  ipdInput.addEventListener("input", applyStereo);
  btnSwap.addEventListener("click", () => {
    toggles.swap = !toggles.swap;
    setToggle(btnSwap, toggles.swap);
    applyStereo();
  });
  const setAutoHead = (on: boolean) => {
    toggles.autoHead = on;
    setToggle(btnAutoHead, on);
    link.send({ type: "setHeadAuto", enabled: on });
    if (!on) sendHead(); // take over from the sway at the simulator's own pose, so keys do not jump
  };
  btnAutoHead.addEventListener("click", () => setAutoHead(!toggles.autoHead));
  // Audio: apps with setAudio switch at runtime (this click is the gesture the
  // browser wants); others reload with the parameter, since audio is decided at creation.
  // Both toggles work the same way: an app with the hook switches live; otherwise
  // the page reloads with the parameter, since the context is fixed at creation.
  const bindContextToggle = (btn: HTMLButtonElement, key: "audio" | "debug", hook: ((on: boolean) => void) | undefined) => {
    setToggle(btn, toggles[key]);
    btn.addEventListener("click", () => {
      toggles[key] = !toggles[key];
      setToggle(btn, toggles[key]);
      if (hook) {
        hook(toggles[key]);
      } else {
        const p = new URLSearchParams(location.search);
        if (toggles[key]) p.set(key, "1");
        else p.delete(key);
        location.search = p.toString();
      }
    });
  };
  bindContextToggle(btnAudio, "audio", demo.setAudio?.bind(demo));
  bindContextToggle(btnDebug, "debug", demo.setDebug?.bind(demo));
  if (params.get("autohead") === "1") setAutoHead(true); // simulated head sway is off by default
  $("#btn-reset").addEventListener("click", () => resetAll());

  if (params.has("overview")) overviewModeSel.value = params.get("overview")!;
  overview.mode = overviewModeSel.value as OverviewMode;
  overviewModeSel.addEventListener("change", () => (overview.mode = overviewModeSel.value as OverviewMode));
  $("#view-head").addEventListener("click", () => overview.viewFromHead(lastState.head));

  // Initial navigation from the URL, in degrees and meters: ?yaw=20&pitch=30&x=0&y=0&z=0
  if (["yaw", "pitch", "x", "y", "z"].some((k) => params.has(k))) {
    const num = (k: string) => Number(params.get(k) ?? 0);
    link.send({
      type: "setNavigation",
      navigation: { position: [num("x"), num("y"), num("z")], yaw: (num("yaw") * Math.PI) / 180, pitch: (num("pitch") * Math.PI) / 180 },
    });
  }

  // ---- Help overlay --------------------------------------------------------
  const helpEl = $("#help");
  function toggleHelp(show = helpEl.hidden) {
    helpEl.hidden = !show;
    if (!show) keys.clear();
  }
  $("#help-btn").addEventListener("click", () => toggleHelp(true));
  $("#help-close").addEventListener("click", () => toggleHelp(false));
  helpEl.addEventListener("click", (e) => {
    if (e.target === helpEl) toggleHelp(false);
  });
  if (params.get("help") === "1") toggleHelp(true);

  // ---- Keyboard and devices ----------------------------------------------------
  // The InputController owns the held-key sets, gamepad polling, the mouse
  // navigation on tiles and the standard bindings; see src/input/controller.ts.
  // It is the same class an input-enabled node uses.
  const input = new InputController({
    send: (msg) => link.send(msg),
    getState: () => lastState,
    getApp: () => demo,
    onReset: () => resetAll(),
    forcedProfile: params.get("gamepad"),
    defaultWand: cfg.defaultWand,
  });
  const keys = input.keys;
  input.bindKeyboard((e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT") return false;
    const k = e.key.toLowerCase();
    if (k === "h" || k === "?") {
      toggleHelp();
      return false;
    }
    if (k === "escape") {
      toggleHelp(false);
      return false;
    }
    // Alt + letter opens Chrome's menu or focuses the address bar on Windows and
    // Linux; the head and wand bindings below use those combinations, so swallow them.
    if ((e.altKey || e.shiftKey) && /^Key[WSADQE]$/.test(e.code)) e.preventDefault();
    return helpEl.hidden; // keys do nothing while help is open
  });
  for (const t of tiles) input.bindMouse(t.viewport.renderer.domElement);

  // Manual head: W/S A/D Q/E move (1 m/s); Alt + same rotate (60°/s).
  // Only active with auto head off. The head is sent as an absolute pose
  // (position + quaternion), the same message a tracker bridge would send.
  const head = { position: [...cfg.defaultHead.position] as [number, number, number], yaw: 0, pitch: 0, roll: 0 };
  const headEuler = new THREE.Euler(0, 0, 0, "YXZ");
  const headQuat = new THREE.Quaternion();
  function headOrientation(): [number, number, number, number] {
    headEuler.set(head.pitch, head.yaw, head.roll);
    headQuat.setFromEuler(headEuler);
    return [headQuat.x, headQuat.y, headQuat.z, headQuat.w];
  }
  function sendHead() {
    link.send({ type: "setHead", head: { position: [...head.position], orientation: headOrientation() } });
  }
  function resetAll() {
    link.send({ type: "setNavigation", navigation: { position: [0, 0, 0], yaw: 0, pitch: 0 } });
    head.position = [...cfg.defaultHead.position] as [number, number, number];
    head.yaw = head.pitch = head.roll = 0;
    if (!toggles.autoHead) sendHead();
    input.resetWand();
  }

  // Simulated wand: the InputController owns the hand offset (d-pad, reset);
  // the simulator adds keys on top: Shift + W/S A/D Q/E move it (1 m/s),
  // Shift + Alt + W/S A/D pitch and yaw it (60°/s). Keys are matched by
  // physical code (keyw...) so modifiers do not change them, and Ctrl is
  // avoided: Ctrl+W closes the tab on Windows and Linux.
  const K = { w: "keyw", s: "keys", a: "keya", d: "keyd", q: "keyq", e: "keye" };
  function stepWand(dt: number): boolean {
    if (!keys.has("shift")) return false;
    const axis = (neg: string, pos: string) => (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
    if (keys.has("alt")) {
      const r = ((60 * Math.PI) / 180) * dt;
      const dyaw = axis(K.d, K.a) * r;
      const dpitch = axis(K.s, K.w) * r;
      if (dyaw || dpitch) input.rotateWand(dyaw, dpitch);
    } else {
      const v = 1.0 * dt;
      const dx = axis(K.a, K.d) * v;
      const dy = axis(K.q, K.e) * v;
      const dz = axis(K.w, K.s) * v;
      if (dx || dy || dz) input.moveWand(dx, dy, dz);
    }
    return true; // Shift held: the head keys stay out of it
  }
  // Head: W/S A/D Q/E move (1 m/s); Alt + the same rotate (60°/s).
  function stepHead(dt: number) {
    if (stepWand(dt)) return;
    if (toggles.autoHead) return;
    let changed = false;
    if (keys.has("alt")) {
      const r = ((60 * Math.PI) / 180) * dt;
      if (keys.has(K.w)) (head.pitch += r), (changed = true);
      if (keys.has(K.s)) (head.pitch -= r), (changed = true);
      if (keys.has(K.a)) (head.yaw += r), (changed = true);
      if (keys.has(K.d)) (head.yaw -= r), (changed = true);
      if (keys.has(K.q)) (head.roll += r), (changed = true);
      if (keys.has(K.e)) (head.roll -= r), (changed = true);
      head.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, head.pitch));
    } else {
      const v = 1.0 * dt;
      const p = head.position;
      if (keys.has(K.w)) (p[2] -= v), (changed = true);
      if (keys.has(K.s)) (p[2] += v), (changed = true);
      if (keys.has(K.a)) (p[0] -= v), (changed = true);
      if (keys.has(K.d)) (p[0] += v), (changed = true);
      if (keys.has(K.q)) (p[1] -= v), (changed = true);
      if (keys.has(K.e)) (p[1] += v), (changed = true);
    }
    if (changed || keys.size === 0) sendHead();
  }

  // ---- Frame loop ----------------------------------------------------------
  // requestAnimationFrame drives: input sampling, the local manager tick (which
  // renders the tiles through handleServerMessage), the overview, and the
  // readout. In controller mode tiles render from socket messages instead and
  // this loop only handles input, overview and readout.
  let last = performance.now();
  let fpsAcc = 0;
  let fpsCount = 0;
  let fps = 0;
  const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);

  function loop(now: number) {
    requestAnimationFrame(loop); // schedule first, so an exception below does not stop the loop
    try {
      loopBody(now);
    } catch (e) {
      reportError(`frame loop: ${(e as Error).stack?.split("\n").slice(0, 2).join(" ") ?? e}`);
    }
  }

  function loopBody(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsAcc += dt;
    if (++fpsCount >= 30) {
      fps = fpsCount / fpsAcc;
      fpsAcc = 0;
      fpsCount = 0;
    }

    stepHead(dt);
    input.step(dt);
    // Local mode: this drives frame -> render -> ack -> present for all tiles.
    // Controller mode: frames arrive over the socket instead.
    link.tick();

    if (flat) {
      overview.render(lastState.head, lastState.navigation, null, new Map(flatViews.map((v) => [v.id, v.view.canvas])), lastState.wand);
    } else {
      overview.render(lastState.head, lastState.navigation, sceneApp!.scene, undefined, lastState.wand);
    }

    const h = lastState.head.position;
    const nv = lastState.navigation;
    const f2 = (v: number) => v.toFixed(2);
    const f1 = (v: number) => v.toFixed(1);
    ro.frame.textContent = String(lastState.frame);
    ro.fps.textContent = fps.toFixed(0);
    ro.head.textContent = `${f2(h[0])} ${f2(h[1])} ${f2(h[2])}`;
    ro.headrot.textContent = `${deg(head.yaw)}° ${deg(head.pitch)}° ${deg(head.roll)}°`;
    const wp = lastState.wand.position;
    ro.wand.textContent = `${f2(wp[0])} ${f2(wp[1])} ${f2(wp[2])}`;
    ro.nav.textContent = `${f1(nv.position[0])} ${f1(nv.position[1])} ${f1(nv.position[2])}`;
    ro.navrot.textContent = `${deg(nv.yaw)}° ${deg(nv.pitch)}°`;
    const nodeStats = link.stats();
    const late = nodeStats.reduce((a, s) => a + s.lateFrames, 0);
    ro.late.textContent = String(late);
    ro.late.classList.toggle("warn", late > 0);
    appInfo.textContent = `${demo.name} · ${demo.status}`;
    if (!lastError) {
      const pads = input.pads;
      const padText = pads.length ? " · " + pads.map((g) => `<span class="ok">🎮 ${g.profile}</span> ${g.id.replace(/\s*\(.*$/, "").slice(0, 28)}`).join(" · ") : "";
      statsEl.innerHTML =
        nodeStats
          .map((s) => `${s.nodeId} <span class="${s.lateFrames ? "warn" : "ok"}">ack ${s.lastAckFrame}</span> ${s.renderMs.toFixed(1)} ms${s.lateFrames ? ` late ${s.lateFrames}` : ""}`)
          .join(" · ") + padText;
    }
  }

  return {
    start() {
      layout();
      applyStereo();
      requestAnimationFrame(loop);
    },
    handleServerMessage,
  };
}
