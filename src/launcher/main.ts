/**
 * Control page: one place to run a deployed cluster from.
 *
 * Stays connected to the Manager as a controller and
 *   - switches the display configuration (setConfig, from the list of the
 *     Manager's configs folder it sends in "welcome") and the application
 *     (setApp, from this build's apps), and shows what is running;
 *   - opens the simulator as a controller of this Manager, the app's control
 *     panel and the headset viewer;
 *   - lists every node window of the current configuration with its link and
 *     whether it is connected (from the Manager's stats), and opens them;
 *   - for a computer that drives several displays: enumerates them (Window
 *     Management API), maps each of a node's screens to one, opens one
 *     fullscreen node window per display in a click, and prints the
 *     equivalent kiosk command for scripts/launch-nodes.sh.
 *
 * URL: launcher.html?manager=ws://host:8765&node=pc (both optional; deployed,
 * the Manager defaults to <base>manager on the same origin)
 *
 * Besides the display mapping the page carries the per-window switches the
 * cluster config cannot express for one computer: the stereo output mode, which
 * window plays the sound, and which windows take input. Each is written on the
 * node URLs as stereo=, audio=1|0 and input=1|0, so a choice here overrides the
 * config in both directions; "from the config" writes nothing.
 *
 * Flow
 *   connect()  -> welcome: config and config names; again after a config switch
 *                 frame: the current app (state.app); stats: connected node windows
 *   detect()   -> getScreenDetails() inside the click (permission prompt once)
 *   render()   -> displays table + one "screen -> display" selector per screen
 *   launch     -> window.open(node.html?node=..&view=..&screen=N, "popup,fullscreen,left,top,...")
 *                 per screen; with the window-management permission Chromium
 *                 opens each directly fullscreen on the display containing left/top
 *   updateCommand() -> the same layout as a scripts/launch-nodes.sh command line
 *
 * Pop-ups: Chromium opens one pop-up per user gesture unless the site is
 * allowed to, so a three-screen node opens one window and the browser blocks
 * the other two (silently: window.open returns null). The blocked screens stay
 * in `pending`, the note says so, and "open next window" opens them one click
 * at a time; allowing pop-ups for this origin opens all of them at once.
 * A permission prompt also outlives the gesture, so the first click only
 * detects the displays.
 */
import type { ClusterConfig, StereoMode } from "../core/config";
import { decode, encode, type ClientMessage, type NodeStats, type ServerMessage } from "../core/protocol";
import { getScreens, hasWindowManagement, isMultiScreen, onScreensChange, type ScreenInfo } from "../core/screens";
import { defaultManagerUrl, publicUrl } from "../core/base";
import { bundledConfigNames, bundledConfigs } from "../core/configs";

const params = new URLSearchParams(location.search);
const managerUrl = params.get("manager") ?? defaultManagerUrl();
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const linkStatus = $("#link-status");
const configSel = $<HTMLSelectElement>("#config");
const btnConfig = $<HTMLButtonElement>("#btn-config");
const appSel = $<HTMLSelectElement>("#app");
const btnApp = $<HTMLButtonElement>("#btn-app");
const clusterStatus = $("#cluster-status");
const nodesEl = $("#nodes");
const nodesNote = $("#nodes-note");
const btnOpenAll = $<HTMLButtonElement>("#btn-open-all");
const nodeSel = $<HTMLSelectElement>("#node");
const displaysEl = $("#displays");
const mappingEl = $("#mapping");
const btnDetect = $<HTMLButtonElement>("#btn-detect");
const btnLaunch = $<HTMLButtonElement>("#btn-launch");
const btnClose = $<HTMLButtonElement>("#btn-close");
const btnNext = $<HTMLButtonElement>("#btn-next");
const stereoSel = $<HTMLSelectElement>("#stereo");
const audioSel = $<HTMLSelectElement>("#audio");
const inputSel = $<HTMLSelectElement>("#input");
const cmdEl = $("#cmd");
const noteEl = $("#note");

let cfg: ClusterConfig | null = null;
/** Config names the Manager can switch to; this build's configs/ when it sends none. */
let configNames: string[] = bundledConfigNames;
/** The application the cluster runs now: state.app from the frames, else the config's. */
let currentApp = "";
/** Connected node windows ("node" or "node:view"), from the latest stats. */
let connected = new Set<string>();
let screens: ScreenInfo[] | null = null;
const opened: Window[] = [];
/** Screens whose window the browser blocked, waiting for another gesture. */
let pending: { view: string; display: number }[] = [];

// ---- Output and roles -------------------------------------------------------
/** StereoMode, in the order the specification lists the output modes. */
const STEREO_MODES: StereoMode[] = [
  "mono",
  "side-by-side",
  "side-by-side-half",
  "top-bottom",
  "top-bottom-half",
  "row-interleaved",
  "column-interleaved",
  "checkerboard",
  "anaglyph",
  "frame-sequential",
];
stereoSel.append(new Option("from the config", ""));
for (const m of STEREO_MODES) stereoSel.append(new Option(m, m));
// ?stereo=MODE on the launcher preselects it, as before.
const stereoParam = params.get("stereo");
if (stereoParam && STEREO_MODES.includes(stereoParam as StereoMode)) stereoSel.value = stereoParam;
for (const sel of [stereoSel, audioSel, inputSel]) sel.addEventListener("change", updateCommand);

/**
 * Fill the audio and input selectors with this node's screens, keeping the
 * current choice when it still exists. "" means: leave it to the config.
 */
function populateRoles(screenIds: string[]) {
  const fill = (sel: HTMLSelectElement, extra: [string, string][]) => {
    const prev = sel.value;
    sel.innerHTML = "";
    sel.append(new Option("from the config", ""));
    for (const [value, label] of extra) sel.append(new Option(label, value));
    for (const id of screenIds) sel.append(new Option(`${id} window only`, id));
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "";
  };
  fill(audioSel, [["none", "no window"]]);
  fill(inputSel, [["all", "every window"], ["none", "no window"]]);
}

// Application names from the folder list alone: importing the registry would load every app's code.
const disabledApps = String(import.meta.env.VITE_DISABLE_APPS ?? "").split(",").map((s) => s.trim());
const appNames = Object.keys(import.meta.glob("../apps/*/index.ts"))
  .map((path) => path.split("/")[2])
  .filter((name) => !disabledApps.includes(name))
  .sort();

// ---- Manager connection: a controller that only switches and watches -------
let ws: WebSocket | null = null;
const send = (msg: ClientMessage) => ws?.readyState === WebSocket.OPEN && ws.send(encode(msg));

function connect() {
  const sock = new WebSocket(managerUrl);
  ws = sock;
  sock.addEventListener("open", () => {
    linkStatus.textContent = `● ${managerUrl}`;
    linkStatus.classList.add("ok");
    send({ type: "hello", nodeId: "control", role: "controller" });
  });
  sock.addEventListener("message", (ev) => {
    const msg = decode<ServerMessage>(ev.data);
    switch (msg.type) {
      case "welcome": {
        // First connection, a reconnect, or a live config switch: rebuild everything from it.
        cfg = msg.config;
        clearTimeout(switchTimer);
        configNames = msg.configs ?? bundledConfigNames;
        currentApp = cfg.app.name;
        connected = new Set();
        populateCluster();
        populateNodes();
        render();
        break;
      }
      case "frame": {
        const name = msg.state.app?.name ?? cfg?.app.name ?? "";
        if (name !== currentApp) {
          currentApp = name;
          populateApps();
          updateStatus();
        }
        break;
      }
      case "stats":
        setConnected(msg.nodes);
        break;
    }
  });
  sock.addEventListener("close", () => {
    linkStatus.textContent = `● no manager at ${managerUrl}, retrying`;
    linkStatus.classList.remove("ok");
    connected = new Set();
    renderNodeList();
    setTimeout(connect, 1500);
  });
  sock.addEventListener("error", () => sock.close());
}

// ---- Cluster: configuration and application ---------------------------------
function populateCluster() {
  if (!cfg) return;
  configSel.innerHTML = "";
  for (const name of configNames) {
    const c = bundledConfigs[name] as ClusterConfig | undefined;
    configSel.append(new Option(c ? `${name} · ${c.screens.length} screens · ${c.nodes.length} node${c.nodes.length > 1 ? "s" : ""}` : name, name));
  }
  // A config the Manager started from a path, outside its folder: show it, it cannot be switched back to by name.
  if (!configNames.includes(cfg.name)) configSel.append(new Option(`${cfg.name} (running)`, cfg.name));
  configSel.value = cfg.name;
  btnConfig.disabled = true;
  populateApps();
  updateStatus();
}

function populateApps() {
  appSel.innerHTML = "";
  for (const name of appNames) appSel.append(new Option(name, name));
  if (currentApp && !appNames.includes(currentApp)) appSel.append(new Option(`${currentApp} (not in this build)`, currentApp));
  appSel.value = currentApp;
  btnApp.disabled = true;
}

// A switch resets the cluster's state, so it takes a button press, not just a change of selection.
configSel.addEventListener("change", () => (btnConfig.disabled = !cfg || configSel.value === cfg.name));
appSel.addEventListener("change", () => (btnApp.disabled = appSel.value === currentApp));
let switchTimer = 0;
btnConfig.addEventListener("click", () => {
  const name = configSel.value;
  send({ type: "setConfig", name });
  btnConfig.disabled = true;
  clusterStatus.textContent = `switching to ${name}...`;
  // The Manager answers a switch with a new welcome; a refused one (unreadable file) only shows in its log.
  clearTimeout(switchTimer);
  switchTimer = window.setTimeout(() => {
    if (!cfg || cfg.name === name) return;
    configSel.value = cfg.name;
    updateStatus();
    clusterStatus.textContent += ` · the Manager did not switch to ${name}, see its log`;
  }, 3000);
});
btnApp.addEventListener("click", () => {
  send({ type: "setApp", app: { name: appSel.value } });
  btnApp.disabled = true;
});

function updateStatus() {
  if (!cfg) return;
  const windows = nodeWindows();
  const up = windows.filter((w) => connected.has(w.clientId)).length;
  clusterStatus.textContent =
    `running ${cfg.name} · ${currentApp} · ${cfg.screens.length} screens · sync ${cfg.sync} · ${cfg.fps} fps · ` +
    `${up} of ${windows.length} node window${windows.length > 1 ? "s" : ""} connected`;
}

// ---- Pages to open ----------------------------------------------------------
function pageUrl(page: string, extra: Record<string, string> = {}) {
  const u = new URL(publicUrl(`/${page}`), location.origin);
  u.searchParams.set("manager", managerUrl);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}
$<HTMLAnchorElement>("#open-sim").href = pageUrl("simulator.html");
$<HTMLAnchorElement>("#open-panel").href = pageUrl("panel.html");
$<HTMLAnchorElement>("#open-xr").href = pageUrl("xr.html");

// ---- Display nodes: every window of the current configuration ---------------
interface NodeWindow {
  node: string;
  screen: string;
  /** The id the node page reports to the Manager (see pickScreen in src/node/main.ts). */
  clientId: string;
  url: string;
}

function nodeWindows(): NodeWindow[] {
  if (!cfg) return [];
  return cfg.nodes.flatMap((n) =>
    n.screens.map((screen) => {
      const single = screen === n.id;
      const extra: Record<string, string> = { node: n.id };
      if (!single || n.screens.length > 1) extra.view = screen;
      const stereo = params.get("stereo");
      if (stereo) extra.stereo = stereo;
      return { node: n.id, screen, clientId: single ? n.id : `${n.id}:${screen}`, url: pageUrl("node.html", extra) };
    }),
  );
}

function setConnected(stats: NodeStats[]) {
  const next = new Set(stats.map((s) => s.nodeId));
  if (next.size === connected.size && [...next].every((id) => connected.has(id))) return;
  connected = next;
  renderNodeList();
  updateStatus();
}

function renderNodeList() {
  const windows = nodeWindows();
  if (!windows.length) {
    nodesEl.innerHTML = `<p class="muted">Waiting for the cluster config from the manager.</p>`;
    btnOpenAll.disabled = true;
    return;
  }
  btnOpenAll.disabled = false;
  nodesEl.innerHTML =
    `<table><tr><th></th><th>node</th><th>screen</th><th></th><th></th></tr>` +
    windows
      .map(
        (w, i) =>
          `<tr><td><span class="dot${connected.has(w.clientId) ? " on" : ""}" title="${connected.has(w.clientId) ? "connected" : "not connected"}"></span></td>` +
          `<td>${esc(w.node)}</td><td>${esc(w.screen)}</td>` +
          `<td><a href="${esc(w.url)}" target="webcave-${esc(w.clientId)}">open</a></td>` +
          `<td><button data-copy="${i}">copy link</button></td></tr>`,
      )
      .join("") +
    `</table>`;
  nodesEl.querySelectorAll<HTMLButtonElement>("button[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const url = windows[Number(b.dataset.copy)].url;
      try {
        await navigator.clipboard.writeText(url);
        nodesNote.textContent = "link copied";
      } catch {
        // The clipboard needs a secure context; show the link to copy by hand instead.
        nodesNote.textContent = url;
      }
    }),
  );
}

btnOpenAll.addEventListener("click", () => {
  const windows = nodeWindows();
  let count = 0;
  for (const w of windows) {
    const win = window.open(w.url, `webcave-${w.clientId}`, "popup");
    if (win) count++;
  }
  nodesNote.textContent =
    count === windows.length
      ? `${count} window${count > 1 ? "s" : ""} opened; drag each to its display and click it to go fullscreen.`
      : `The browser opened ${count} of ${windows.length}: allow popups for this site and try again.`;
});

function populateNodes() {
  if (!cfg) return;
  const prev = nodeSel.value || params.get("node");
  nodeSel.innerHTML = "";
  for (const n of cfg.nodes) {
    nodeSel.append(new Option(`${n.id} · ${n.screens.length} screen${n.screens.length > 1 ? "s" : ""}: ${n.screens.join(", ")}`, n.id));
  }
  if (prev && cfg.nodes.some((n) => n.id === prev)) nodeSel.value = prev;
  renderNodeList();
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
    // Fewer displays than screens: the windows all land on the same display and
    // cover each other, which looks like only one of them opened.
    if (screens && screens.length < node.screens.length) {
      const warn = document.createElement("p");
      warn.className = "muted";
      warn.textContent =
        `This computer reports ${screens.length} display${screens.length > 1 ? "s" : ""} for ${node.screens.length} screens: ` +
        `windows sharing a display open fullscreen on top of each other.`;
      mappingEl.append(warn);
    }
  }
  populateRoles(node?.screens ?? []);
  btnLaunch.disabled = !node;
  updateCommand();
}

function nodeUrl(nodeId: string, view: string, display: number) {
  const extra: Record<string, string> = { node: nodeId, view, screen: String(display) };
  if (stereoSel.value) extra.stereo = stereoSel.value;
  // Written as 1 or 0 on every window, so the choice overrides the config
  // both ways; left out entirely when the config is to decide.
  if (audioSel.value) extra.audio = audioSel.value === view ? "1" : "0";
  if (inputSel.value) extra.input = inputSel.value === "all" || inputSel.value === view ? "1" : "0";
  return pageUrl("node.html", extra);
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
    ` --server ${location.origin} --manager ${managerUrl}` +
    (stereoSel.value ? ` --stereo ${stereoSel.value}` : "") +
    (audioSel.value ? ` --audio ${audioSel.value}` : "") +
    (inputSel.value ? ` --input ${inputSel.value}` : "");
}

// ---- Launch -------------------------------------------------------------------
btnLaunch.addEventListener("click", async () => {
  const node = currentNode();
  if (!node) return;
  // The window-management prompt outlives the click's user activation, so
  // pop-ups opened after awaiting it are all blocked. Detect on this click and
  // let the next one open the windows, rather than opening none.
  if (!screens) {
    await detect();
    if (screens) noteEl.textContent = "Displays detected. Click launch again to open the windows.";
    return;
  }
  closeAll();
  const map = mapping();
  const wanted = node.screens.map((view, i) => ({ view, display: map[i] ?? i }));
  pending = openWindows(wanted);
  report(wanted.length);
});

/** One more window per click: a gesture the browser has not spent yet. */
btnNext.addEventListener("click", () => {
  if (!pending.length) return;
  const wanted = pending.length;
  pending = [...openWindows(pending.slice(0, 1)), ...pending.slice(1)];
  report(wanted);
});

/** Open a window per entry; returns the ones the browser blocked. */
function openWindows(items: typeof pending): typeof pending {
  const node = currentNode();
  if (!node) return items;
  const blocked: typeof pending = [];
  for (const item of items) {
    const s = screens?.[item.display];
    const url = nodeUrl(node.id, item.view, item.display);
    // Chromium: "fullscreen" pop-ups need the window-management permission and
    // open directly fullscreen on the display that contains left/top. Without
    // it the window opens normally on that display and the node page goes
    // fullscreen on its first click.
    const feat = s
      ? `popup,fullscreen,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`
      : "popup";
    const w = window.open(url, `webcave-${node.id}-${item.view}`, feat);
    if (w) opened.push(w);
    else blocked.push(item);
  }
  return blocked;
}

/** Note and buttons after an attempt that asked for `wanted` windows. */
function report(wanted: number) {
  btnClose.disabled = opened.length === 0;
  btnNext.disabled = pending.length === 0;
  btnNext.textContent = pending.length ? `open next window (${pending.length} left)` : "open next window";
  if (!pending.length) {
    noteEl.textContent = opened.length
      ? `${opened.length} window${opened.length > 1 ? "s" : ""} opened. If a window is not fullscreen, click inside it once.`
      : "No window opened.";
    return;
  }
  const got = wanted - pending.length;
  noteEl.textContent =
    `${got} of ${wanted} opened; the browser blocked ${pending.map((p) => p.view).join(", ")}. ` +
    `Chrome opens one pop-up per click unless the site may open them: allow pop-ups for this site ` +
    `(icon at the right of the address bar) and launch again, or use "open next window" once per screen.`;
}

function closeAll() {
  for (const w of opened) {
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }
  opened.length = 0;
  pending = [];
  btnClose.disabled = true;
  btnNext.disabled = true;
  btnNext.textContent = "open next window";
}
btnClose.addEventListener("click", closeAll);
window.addEventListener("beforeunload", closeAll);

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

render();
renderNodeList();
connect();
