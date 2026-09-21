/**
 * Node launcher for a computer that drives several displays.
 *
 * Connects to the Manager to read the cluster config, enumerates the displays
 * attached to this machine (Window Management API), lets you map each of a
 * node's screens to a display, and opens one fullscreen node window per
 * display in a single click. Also prints the equivalent kiosk command for
 * scripts/launch-nodes.sh, with the detected display positions filled in.
 *
 * URL: launcher.html?manager=ws://host:8765&node=pc (&stereo=MODE preselects the mode)
 *
 * Besides the display mapping the page carries the per-window switches the
 * cluster config cannot express for one computer: the stereo output mode, which
 * window plays the sound, and which windows take input. Each is written on the
 * node URLs as stereo=, audio=1|0 and input=1|0, so a choice here overrides the
 * config in both directions; "from the config" writes nothing.
 *
 * Flow
 *   connect()  -> welcome gives us the config; we close the socket again
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
const btnNext = $<HTMLButtonElement>("#btn-next");
const stereoSel = $<HTMLSelectElement>("#stereo");
const audioSel = $<HTMLSelectElement>("#audio");
const inputSel = $<HTMLSelectElement>("#input");
const cmdEl = $("#cmd");
const noteEl = $("#note");

let cfg: ClusterConfig | null = null;
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
  const u = new URL(publicUrl("/node.html"), location.origin);
  u.searchParams.set("node", nodeId);
  u.searchParams.set("view", view);
  u.searchParams.set("screen", String(display));
  u.searchParams.set("manager", managerUrl);
  if (stereoSel.value) u.searchParams.set("stereo", stereoSel.value);
  // Written as 1 or 0 on every window, so the choice overrides the config
  // both ways; left out entirely when the config is to decide.
  if (audioSel.value) u.searchParams.set("audio", audioSel.value === view ? "1" : "0");
  if (inputSel.value) u.searchParams.set("input", inputSel.value === "all" || inputSel.value === view ? "1" : "0");
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
connect();
