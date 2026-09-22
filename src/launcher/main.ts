/**
 * Node launcher for a computer that drives several displays.
 *
 * Connects to the Manager to read the cluster config, enumerates the displays
 * attached to this machine (Window Management API), lets you map each of a
 * node's screens to a display, and opens one fullscreen node window per
 * display in a single click. Also prints the equivalent kiosk command for
 * scripts/launch-nodes.sh, with the detected display positions filled in.
 *
 * URL: launcher.html?manager=ws://host:8765&node=pc
 *
 * Flow
 *   connect()  -> welcome gives us the config; we close the socket again
 *   detect()   -> getScreenDetails() inside the click (permission prompt once)
 *   render()   -> displays table + one "screen -> display" selector per screen
 *   launch     -> window.open(node.html?node=..&view=..&screen=N, "popup,fullscreen,left,top,...")
 *                 per screen; with the window-management permission Chromium
 *                 opens each directly fullscreen on the display containing left/top
 *   updateCommand() -> the same layout as a scripts/launch-nodes.sh command line
 */
import type { ClusterConfig } from "../core/config";
import { decode, encode, type ClientMessage, type ServerMessage } from "../core/protocol";
import { getScreens, hasWindowManagement, isMultiScreen, onScreensChange, type ScreenInfo } from "../core/screens";
import { defaultManagerUrl, publicUrl } from "../core/base";

const params = new URLSearchParams(location.search);
const managerUrl = params.get("manager") ?? defaultManagerUrl();
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const linkStatus = $("#link-status");
const nodeSel = $<HTMLSelectElement>("#node");
const displaysEl = $("#displays");
const mappingEl = $("#mapping");
const btnDetect = $<HTMLButtonElement>("#btn-detect");
const btnLaunch = $<HTMLButtonElement>("#btn-launch");
const btnClose = $<HTMLButtonElement>("#btn-close");
const cmdEl = $("#cmd");
const noteEl = $("#note");

let cfg: ClusterConfig | null = null;
let screens: ScreenInfo[] | null = null;
const opened: Window[] = [];

// ---- Manager connection: only to fetch the config -------------------------
function connect() {
  const ws = new WebSocket(managerUrl);
  ws.addEventListener("open", () => {
    linkStatus.textContent = `● ${managerUrl}`;
    linkStatus.classList.add("ok");
    ws.send(encode({ type: "hello", nodeId: "launcher", role: "controller" } satisfies ClientMessage));
  });
  ws.addEventListener("message", (ev) => {
    const msg = decode<ServerMessage>(ev.data);
    if (msg.type === "welcome") {
      cfg = msg.config;
      populateNodes();
      render();
      // Config in hand; no need to stay connected and receive frames.
      ws.close();
    }
  });
  ws.addEventListener("close", () => {
    if (!cfg) {
      linkStatus.textContent = `● no manager at ${managerUrl}, retrying`;
      linkStatus.classList.remove("ok");
      setTimeout(connect, 1500);
    }
  });
  ws.addEventListener("error", () => ws.close());
}

function populateNodes() {
  if (!cfg) return;
  nodeSel.innerHTML = "";
  for (const n of cfg.nodes) {
    nodeSel.append(new Option(`${n.id} · ${n.screens.length} screen${n.screens.length > 1 ? "s" : ""}: ${n.screens.join(", ")}`, n.id));
  }
  const want = params.get("node");
  if (want && cfg.nodes.some((n) => n.id === want)) nodeSel.value = want;
}
nodeSel.addEventListener("change", render);

// ---- Displays ---------------------------------------------------------------
async function detect() {
  screens = await getScreens();
  if (!screens) {
    noteEl.textContent = hasWindowManagement
      ? "Display permission refused. Allow \"Window management\" for this site in the address bar and try again."
      : "This browser has no Window Management API. Use Chrome or Edge on a secure origin (https, or http://localhost).";
  } else {
    noteEl.textContent = "";
  }
  render();
}
btnDetect.addEventListener("click", () => void detect());
onScreensChange((s) => {
  screens = s;
  render();
});

function currentNode() {
  return cfg?.nodes.find((n) => n.id === nodeSel.value) ?? null;
}

/** Display index chosen for each of the node's screens. */
function mapping(): number[] {
  return [...mappingEl.querySelectorAll<HTMLSelectElement>("select")].map((s) => Number(s.value));
}

function render() {
  // Displays table
  if (!screens) {
    displaysEl.innerHTML = `<p class="muted">${
      hasWindowManagement
        ? `Click <em>detect displays</em> (asks once for the window-management permission).${isMultiScreen ? "" : " This computer reports a single display."}`
        : "Window Management API not available in this browser or on this origin."
    }</p>`;
  } else {
    displaysEl.innerHTML =
      `<table><tr><th>#</th><th>label</th><th>pixels</th><th>position</th><th>scale</th><th></th></tr>` +
      screens
        .map(
          (s) =>
            `<tr><td>${s.index}</td><td>${esc(s.label)}</td><td>${s.width}×${s.height}</td><td>${s.left},${s.top}</td><td>${s.devicePixelRatio}x</td><td>${s.isPrimary ? "★ primary" : ""}${s.isInternal ? " internal" : ""}</td></tr>`,
        )
        .join("") +
      `</table>`;
  }

  // Mapping: node screen -> display
  const node = currentNode();
  const prev = mapping();
  mappingEl.innerHTML = "";
  if (!node) {
    mappingEl.innerHTML = `<p class="muted">Waiting for the cluster config from the manager.</p>`;
  } else {
    node.screens.forEach((screenId, i) => {
      const row = document.createElement("div");
      row.className = "map-row";
      const label = document.createElement("span");
      label.className = "map-label";
      label.textContent = screenId;
      const sel = document.createElement("select");
      const count = screens?.length ?? Math.max(node.screens.length, 1);
      for (let d = 0; d < count; d++) {
        const s = screens?.[d];
        sel.append(new Option(s ? `display ${d} · ${s.label} ${s.width}×${s.height}` : `display ${d}`, String(d)));
      }
      sel.value = String(prev[i] ?? Math.min(i, count - 1));
      sel.addEventListener("change", updateCommand);
      row.append(label, sel);
      mappingEl.append(row);
    });
  }
  btnLaunch.disabled = !node;
  updateCommand();
}

function nodeUrl(nodeId: string, view: string, display: number) {
  const u = new URL(publicUrl("/node.html"), location.origin);
  u.searchParams.set("node", nodeId);
  u.searchParams.set("view", view);
  u.searchParams.set("screen", String(display));
  u.searchParams.set("manager", managerUrl);
  const stereo = params.get("stereo");
  if (stereo) u.searchParams.set("stereo", stereo);
  return u.toString();
}

/** Equivalent unattended command for scripts/launch-nodes.sh. */
function updateCommand() {
  const node = currentNode();
  if (!node) {
    cmdEl.textContent = "";
    return;
  }
  const map = mapping();
  const views = node.screens;
  const pos = views.map((_, i) => {
    const s = screens?.[map[i] ?? i];
    return s ? `${s.left},${s.top}` : `${i * 1920},0`;
  });
  const w = screens?.[map[0] ?? 0]?.width ?? 1920;
  const h = screens?.[map[0] ?? 0]?.height ?? 1080;
  // launch-nodes.sh takes node ids; for a multi-screen node pass "node:view" pairs.
  const ids = views.map((v) => (views.length > 1 || v !== node.id ? `${node.id}:${v}` : node.id)).join(",");
  cmdEl.textContent =
    `scripts/launch-nodes.sh --nodes ${ids} --positions "${pos.join(" ")}" --width ${w} --height ${h}` +
    ` --server ${location.origin} --manager ${managerUrl}`;
}

// ---- Launch -------------------------------------------------------------------
btnLaunch.addEventListener("click", async () => {
  const node = currentNode();
  if (!node) return;
  // Enumerating inside the click keeps the gesture valid for the popups.
  if (!screens) await detect();
  const map = mapping();
  closeAll();
  node.screens.forEach((view, i) => {
    const s = screens?.[map[i] ?? i];
    const url = nodeUrl(node.id, view, map[i] ?? i);
    // Chromium: "fullscreen" popups need the window-management permission and
    // open directly fullscreen on the display that contains left/top. Without
    // it the window opens normally on that display and the node page goes
    // fullscreen on its first click.
    const feat = s
      ? `popup,fullscreen,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`
      : "popup";
    const w = window.open(url, `webcave-${node.id}-${view}`, feat);
    if (w) opened.push(w);
  });
  btnClose.disabled = opened.length === 0;
  noteEl.textContent = opened.length
    ? `${opened.length} window${opened.length > 1 ? "s" : ""} opened. If a window is not fullscreen, click inside it once.`
    : "The browser blocked the popups. Allow popups for this site and try again.";
});

function closeAll() {
  for (const w of opened) {
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }
  opened.length = 0;
  btnClose.disabled = true;
}
btnClose.addEventListener("click", closeAll);
window.addEventListener("beforeunload", closeAll);

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

render();
connect();
