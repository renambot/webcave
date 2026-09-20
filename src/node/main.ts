/**
 * Render node: one browser window driving one physical screen.
 *
 * Lifecycle
 *   connect   WebSocket to the Manager
 *   welcome   receive the cluster config, pick our screen, build the
 *             application and either a ViewportRenderer (scene apps) or a
 *             FlatView (flat apps such as the map), say hello
 *   frame     scene app: app.update(time), render the eye(s) offscreen, ack
 *             flat app:  view.render(state), ack
 *   present   scene app: pack the eyes onto the canvas (barrier tier), or do
 *             it right after rendering (loose tier). Flat apps draw on their
 *             own schedule and ignore present.
 *   close     retry every second; the manager can restart underneath us
 *
 * The node holds no state of its own beyond what the last frame message
 * carried, which is why any window can join or rejoin at any time and show
 * the same picture as the others.
 *
 * URL: node.html?node=front&manager=ws://host:8765
 *   node=ID      node id from the cluster config
 *   view=SCREEN  which of the node's screens this window renders (default: its first)
 *   screen=N     display index for fullscreen (Window Management API, needs a gesture)
 *   stereo=MODE  override the configured output mode (scene apps)
 *   input=1      take keyboard, mouse and gamepad input on this window (development;
 *                the config's `input: true` on the node is the proper switch)
 *   app= model= size= spin= mx= my= mz= style= center= zoom= ...   override the application, for development
 *
 * A computer with several displays runs one window per display, all with the
 * same node id and a different view; the launcher page or the kiosk script
 * opens them. Keys: click / f / Enter / Space = fullscreen, h = toggle HUD.
 */
import type { ClusterConfig, ScreenConfig, StereoMode } from "../core/config";
import { resolveStereo } from "../core/config";
import { decode, encode, type ClientMessage, type FrameState, type ServerMessage } from "../core/protocol";
import { currentScreenIndex, describeScreen, getScreens, hasWindowManagement, requestFullscreenOn } from "../core/screens";
import { wallLayout } from "../core/wall";
import { appSpecFromParams, createApp, isFlatApp, type AnyApp, type FlatView } from "../apps";
import { InputController } from "../input/controller";
import { screenSize } from "../core/projection";
import { ViewportRenderer } from "../render/viewport";

const params = new URLSearchParams(location.search);
const nodeId = params.get("node") ?? "front";
const viewId = params.get("view");
const screenIndex = params.has("screen") ? Number(params.get("screen")) : null;
const managerUrl = params.get("manager") ?? `ws://${location.hostname}:8765`;
const modeOverride = params.get("stereo") as StereoMode | null;

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const hud = document.querySelector<HTMLElement>("#hud")!;
/** Container for flat apps; created on demand, letterboxed like the canvas. */
let flatContainer: HTMLDivElement | null = null;

let app: AnyApp | null = null;
let viewport: ViewportRenderer | null = null;
let flatView: FlatView | null = null;
let screen: ScreenConfig | null = null;
let cfg: ClusterConfig | null = null;
let frames = 0;
let lastHud = performance.now();
let displayInfo = "";
/** Identity reported to the manager: "node" or "node:view" for multi-screen nodes. */
let clientId = nodeId;
/** Input on this window: config `input: true` on the node, or ?input=1. */
let inputEnabled = params.get("input") === "1";
let input: InputController | null = null;
let sendToManager: ((m: ClientMessage) => void) | null = null;
/** Last frame received, for the debug handle. */
let lastState: FrameState | null = null;

/**
 * Which screen this window renders: the `view` parameter if given, else the
 * node's first screen. Also decides the id we report to the manager, so that
 * two windows of the same multi-screen node show up separately in the stats.
 */
function pickScreen(c: ClusterConfig): ScreenConfig {
  const node = c.nodes.find((n) => n.id === nodeId);
  const screens = node?.screens ?? [nodeId];
  const screenId = viewId ?? screens[0];
  if (viewId && node && !screens.includes(viewId)) {
    throw new Error(`Node ${nodeId} has no screen "${viewId}" (has ${screens.join(", ")})`);
  }
  const s = c.screens.find((sc) => sc.id === screenId);
  if (!s) throw new Error(`No screen "${screenId}" for node ${nodeId}`);
  clientId = screenId === nodeId ? nodeId : `${nodeId}:${screenId}`;
  return s;
}

/** Letterbox a w x h box to the screen's physical aspect. */
function fitBox(aspect: number, boxW: number, boxH: number) {
  let w = boxW;
  let h = w / aspect;
  if (h > boxH) {
    h = boxH;
    w = h * aspect;
  }
  return { width: Math.floor(w), height: Math.floor(h) };
}

/** Size the canvas (scene apps) or the flat container to the window, keeping the screen aspect. */
function fit() {
  if (viewport) {
    const size = viewport.fitInto(window.innerWidth, window.innerHeight);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
  } else if (flatView && flatContainer && screen) {
    const s = screenSize(screen);
    const size = fitBox(s.width / s.height, window.innerWidth, window.innerHeight);
    flatContainer.style.width = `${size.width}px`;
    flatContainer.style.height = `${size.height}px`;
    flatView.resize(size.width, size.height);
  }
}
window.addEventListener("resize", fit);

/** Tear down whatever the previous config built. */
function teardown() {
  viewport?.dispose();
  viewport = null;
  flatView?.dispose();
  flatView = null;
  app?.dispose?.();
  app = null;
}

/** Build the renderer or flat view for the current config and screen. */
function setup(c: ClusterConfig, s: ScreenConfig) {
  const spec = appSpecFromParams(params, c.app);
  app = createApp(spec);
  if (isFlatApp(app)) {
    canvas.style.display = "none";
    if (!flatContainer) {
      flatContainer = document.createElement("div");
      flatContainer.id = "flat";
      flatContainer.style.cssText = "position:relative;overflow:hidden;background:#000;";
      document.body.append(flatContainer);
    }
    flatContainer.style.display = "";
    flatView = app.createView(flatContainer, s, wallLayout(c), {
      interactive: inputEnabled,
      send: (patch) => sendToManager?.({ type: "setAppState", patch }),
    });
  } else {
    if (flatContainer) flatContainer.style.display = "none";
    canvas.style.display = "";
    const stereo = resolveStereo(c, s);
    if (modeOverride) stereo.mode = modeOverride;
    viewport = new ViewportRenderer(c, s, canvas, stereo);
  }
  fit();
  // Input: this window may steer the cluster (keyboard, mouse, gamepad).
  if (inputEnabled && !input) {
    input = new InputController({
      send: (m) => sendToManager?.(m),
      getState: () => lastState ?? { frame: 0, time: 0, head: c.defaultHead, navigation: { position: [0, 0, 0], yaw: 0, pitch: 0 }, appState: {}, issuedAt: 0 },
      getApp: () => app,
      onReset: () => sendToManager?.({ type: "setNavigation", navigation: { position: [0, 0, 0], yaw: 0, pitch: 0 } }),
      forcedProfile: params.get("gamepad"),
    });
    input.bindKeyboard();
    document.body.style.cursor = "auto";
  }
  if (input) input.bindMouse(isFlatApp(app) ? flatContainer! : canvas);
  // Debug handle for scripts/screenshot.mjs --eval and the browser console.
  (window as unknown as { webcave: unknown }).webcave = { app, viewport, flatView, container: flatContainer, screen: s, lastState: () => lastState };
}

function connect() {
  const ws = new WebSocket(managerUrl);
  const send = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(encode(m));

  ws.addEventListener("open", () => {
    hud.textContent = `connected to ${managerUrl} as ${nodeId}`;
  });

  ws.addEventListener("message", (ev) => {
    const msg = decode<ServerMessage>(ev.data);
    switch (msg.type) {
      case "welcome": {
        cfg = msg.config;
        try {
          screen = pickScreen(cfg);
        } catch (e) {
          hud.textContent = String((e as Error).message);
          return;
        }
        send({ type: "hello", nodeId: clientId, role: "node" });
        sendToManager = send;
        inputEnabled = inputEnabled || !!cfg.nodes.find((n) => n.id === nodeId)?.input;
        teardown();
        setup(cfg, screen);
        break;
      }
      case "frame": {
        if (!cfg || !app) return;
        const prevTime = lastState?.time ?? msg.state.time;
        lastState = msg.state;
        // Input runs at the cluster frame rate, before rendering, so a key press affects the next frame.
        input?.step(Math.max(0, Math.min(0.1, msg.state.time - prevTime)));
        const t0 = performance.now();
        if (flatView) {
          flatView.render(msg.state);
        } else if (viewport && !isFlatApp(app)) {
          app.update(msg.state.time, msg.state);
          viewport.renderFrame(app.scene, msg.state);
        }
        send({ type: "ack", frame: msg.state.frame, renderMs: performance.now() - t0 });
        if (viewport && cfg.sync === "loose") viewport.present(msg.state.frame);
        frames++;
        break;
      }
      case "present":
        viewport?.present(msg.frame);
        break;
      case "stats": {
        const now = performance.now();
        if (now - lastHud > 500) {
          const me = msg.nodes.find((n) => n.nodeId === clientId);
          const mode = viewport ? viewport.stereo.mode : "flat";
          const inputInfo = input ? `\ninput on${input.pads.length ? " · 🎮 " + input.pads.map((g) => g.profile).join(", ") : ""} · keys, mouse drag / wheel, gamepad` : "";
          hud.textContent =
            `${clientId}  ${mode}  frames ${frames}  late ${me?.lateFrames ?? 0}  render ${me?.renderMs.toFixed(1) ?? "-"} ms` +
            `\n${app?.name ?? ""}: ${app?.status ?? ""}` +
            inputInfo +
            (displayInfo ? `\n${displayInfo}` : "") +
            (!document.fullscreenElement ? `\nclick for fullscreen${screenIndex !== null ? ` on display ${screenIndex}` : ""}` : "");
          lastHud = now;
        }
        break;
      }
    }
  });

  ws.addEventListener("close", () => {
    hud.textContent = `disconnected from ${managerUrl}, retrying...`;
    setTimeout(connect, 1000);
  });
  ws.addEventListener("error", () => ws.close());
}

/**
 * Fullscreen needs a user gesture; the first click or key press provides it.
 * With ?screen=N and the Window Management permission, the window moves to
 * that display. Also records which display we ended up on, for the HUD.
 */
async function goFullscreen() {
  if (document.fullscreenElement) return;
  try {
    await requestFullscreenOn(document.documentElement, screenIndex);
  } catch {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      /* no gesture yet or refused */
    }
  }
  await refreshDisplayInfo();
}

async function refreshDisplayInfo() {
  if (!hasWindowManagement) return;
  const screens = await getScreens();
  if (!screens) return;
  const cur = currentScreenIndex(screens);
  displayInfo = cur >= 0 ? `on ${describeScreen(screens[cur])} of ${screens.length}` : `${screens.length} displays`;
}

// Flat apps cover the page with their own element, so listen on the body.
// With input enabled the mouse navigates, so fullscreen is on the F key only.
document.body.addEventListener("click", () => {
  if (!inputEnabled) void goFullscreen();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "h") {
    hud.style.display = hud.style.display === "none" ? "" : "none";
    return;
  }
  // Fullscreen keys. On an input-enabled node Enter and Space are application
  // and rotation actions, so only F remains for fullscreen there.
  if (e.key === "f" || (!inputEnabled && (e.key === "Enter" || e.key === " "))) void goFullscreen();
});
// Windows opened by the launcher are already fullscreen; just read the display.
if (document.fullscreenElement || params.has("screen")) void refreshDisplayInfo().catch(() => {});

connect();
