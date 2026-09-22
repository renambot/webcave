/**
 * Panel page: an application's control panel on its own, for a tablet or a
 * laptop next to the wall.
 *
 *   panel.html?manager=ws://host:8765
 *
 * Connects to the Manager as a controller (never holds the barrier), builds
 * the cluster's application without any view, and mounts the app's
 * createPanel() full width. Every control sends a shared-state patch; every
 * frame the panel is updated from the state, so it always shows what the wall
 * shows, whoever changed it. Apps without a panel get a note instead.
 *
 * URL: manager=ws://..., and the usual app overrides (app=, options) for
 * development; normally the app comes from the Manager's config.
 */
import { decode, encode, type ClientMessage, type FrameState, type ServerMessage } from "../core/protocol";
import { appSpecFromParams, createApp, type AnyApp, type AppPanel } from "../apps";
import { defaultManagerUrl } from "../core/base";

const params = new URLSearchParams(location.search);
const managerUrl = params.get("manager") ?? defaultManagerUrl();
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const statusEl = $("#status");
const mainEl = $("#panel");

let app: AnyApp | null = null;
let panel: AppPanel | null = null;
let lastState: FrameState | null = null;
let ws: WebSocket;

const send = (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(encode(m));

function connect() {
  ws = new WebSocket(managerUrl);
  ws.addEventListener("open", () => {
    statusEl.textContent = `● ${managerUrl}`;
    send({ type: "hello", nodeId: "panel", role: "controller" });
  });
  ws.addEventListener("message", (ev) => {
    const msg = decode<ServerMessage>(ev.data);
    if (msg.type === "welcome") {
      if (!app) {
        app = createApp(appSpecFromParams(params, msg.config.app), { audio: false, debug: false });
        $("#app-name").textContent = `· ${app.name}`;
        mainEl.replaceChildren();
        if (app.createPanel) {
          panel = app.createPanel(mainEl, {
            send: (patch) => send({ type: "setAppState", patch }),
            getState: () => lastState ?? { frame: 0, time: 0, head: msg.config.defaultHead, wand: msg.config.defaultHead, navigation: { position: [0, 0, 0], yaw: 0, pitch: 0 }, appState: {}, issuedAt: 0 },
          });
        } else {
          const p = document.createElement("p");
          p.className = "note";
          p.textContent = `The "${app.name}" application has no control panel.`;
          mainEl.append(p);
        }
      }
      return;
    }
    if (msg.type === "frame") {
      lastState = msg.state;
      panel?.update(msg.state);
    }
  });
  ws.addEventListener("close", () => {
    statusEl.textContent = `disconnected from ${managerUrl}, retrying…`;
    setTimeout(connect, 1000);
  });
  ws.addEventListener("error", () => ws.close());
}
connect();
