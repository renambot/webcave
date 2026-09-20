/**
 * Tracking bridge: feeds a WebCAVE Manager with the head and wand from a
 * tracking system, and the wand's buttons and joystick as input actions.
 *
 *   npm run tracker -- --config dtrack            # configs/trackers/dtrack.json
 *   npm run tracker -- --config path/to/file.json --manager ws://host:8765
 *   npm run tracker -- --list
 *
 * One process per tracker. It connects to the Manager as a controller (so it
 * never holds the frame barrier), listens to the tracker with the source the
 * config names (dtrack, natnet, vrpn), calibrates every pose into the CAVE
 * frame and sends
 *   setHead  { head }        for the body the config calls head
 *   setWand  { wand }        for the body it calls wand (absolute: this
 *                            replaces the head-relative hand)
 *   input    { actions }     the wand's buttons and joystick mapped onto the
 *                            action vocabulary, merged by the Manager with
 *                            any other input client
 * Poses are rate-limited per body (config `rate`), untracked bodies are
 * skipped (the last good pose stands), and the Manager connection reconnects
 * every second if it drops. Ctrl-C stops everything.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { encode, type ClientMessage, type Pose } from "../core/protocol";
import { emptyActions, type ActionState } from "../input/actions";
import { parseTrackerConfig, type TrackerConfig } from "./config";
import { Calibrator, type Quat, type Vec3 } from "./calibration";
import { DTrackSource } from "./dtrack";
import { NatNetSource } from "./natnet";
import { VrpnSource } from "./vrpn";
import type { TrackerEvent, TrackerSource } from "./types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = resolve(root, "configs/trackers");
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const log = (m: string) => console.log(`[tracker] ${m}`);

if (argv.includes("--list")) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "schema.json")) {
    try {
      const c = parseTrackerConfig(JSON.parse(readFileSync(resolve(dir, f), "utf8")), f);
      console.log(`${basename(f, ".json").padEnd(14)} ${c.source.type.padEnd(7)} ${c.description ?? c.name}`);
    } catch (e) {
      console.log(`${basename(f, ".json").padEnd(14)} INVALID: ${(e as Error).message.split("\n")[1] ?? ""}`);
    }
  }
  process.exit(0);
}

const cfgArg = arg("config", "dtrack");
const cfgPath = existsSync(cfgArg) ? cfgArg : resolve(dir, `${cfgArg.replace(/\.json$/, "")}.json`);
let cfg: TrackerConfig;
try {
  cfg = parseTrackerConfig(JSON.parse(readFileSync(cfgPath, "utf8")), cfgPath);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const managerUrl = arg("manager", cfg.manager);

// ---- Source -----------------------------------------------------------------------
function makeSource(c: TrackerConfig): TrackerSource {
  switch (c.source.type) {
    case "dtrack":
      return new DTrackSource(c.source.port);
    case "natnet":
      return new NatNetSource(c.source);
    case "vrpn":
      return new VrpnSource(c.source.host, c.source.port);
  }
}

// ---- Manager link -----------------------------------------------------------------
let ws: WebSocket | null = null;
let connected = false;
function connectManager() {
  ws = new WebSocket(managerUrl);
  ws.on("open", () => {
    connected = true;
    log(`connected to ${managerUrl}`);
    send({ type: "hello", nodeId: `tracker:${cfg.name}`, role: "controller" });
  });
  ws.on("close", () => {
    if (connected) log(`disconnected from ${managerUrl}, retrying`);
    connected = false;
    setTimeout(connectManager, 1000);
  });
  ws.on("error", () => ws?.close());
  ws.on("message", () => {}); // frames come in; nothing to do with them here
}
function send(msg: ClientMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
}

// ---- Mapping ----------------------------------------------------------------------
const calibrator = new Calibrator(cfg.calibration);
const minInterval = 1000 / cfg.rate;
const lastSent = new Map<string, number>();
const seen = new Map<string, number>(); // body id -> poses received, for the status line
const actions: ActionState = emptyActions();
let actionsDirty = false;

/** Does event id or name match the config's body id? Ids may be numbers or names. */
function matches(e: { id: string; name?: string }, id: number | string | undefined): boolean {
  if (id === undefined) return false;
  const s = String(id);
  return e.id === s || e.name === s;
}

function handlePose(e: Extract<TrackerEvent, { kind: "pose" }>) {
  seen.set(e.name ? `${e.id} (${e.name})` : e.id, (seen.get(e.name ? `${e.id} (${e.name})` : e.id) ?? 0) + 1);
  if (!e.tracked) return;
  const which = matches(e, cfg.head?.id) ? "head" : matches(e, cfg.wand?.id) ? "wand" : null;
  if (!which) return;
  const now = performance.now();
  if (now - (lastSent.get(which) ?? 0) < minInterval) return;
  lastSent.set(which, now);
  const body = which === "head" ? cfg.head! : cfg.wand!;
  const pose: Pose = calibrator.pose(e.position as Vec3, e.rotation as Quat, body.localOffset as Vec3);
  send(which === "head" ? { type: "setHead", head: pose } : { type: "setWand", wand: pose });
}

/** Which device carries the wand's buttons / analog: the wand body itself (DTrack Flystick) or a named VRPN device. */
function isWandDevice(id: string, kind: "buttons" | "analog"): boolean {
  const w = cfg.wand;
  if (!w) return false;
  const explicit = kind === "buttons" ? w.buttonDevice : w.analogDevice;
  if (explicit) return id === explicit;
  // VRPN poses are "device/sensor"; the button device is usually the same device name.
  return id === String(w.id) || String(w.id).split("/")[0] === id;
}

function handleButtons(e: Extract<TrackerEvent, { kind: "buttons" }>) {
  if (!cfg.wand || !isWandDevice(e.id, "buttons")) return;
  for (const [index, action] of Object.entries(cfg.wand.buttons)) {
    const v = e.states[Number(index)] ?? false;
    if (actions.buttons[action] !== v) (actions.buttons[action] = v), (actionsDirty = true);
  }
}

const dz = (v: number) => (Math.abs(v) < 0.1 ? 0 : Math.max(-1, Math.min(1, v)));
function handleAnalog(e: Extract<TrackerEvent, { kind: "analog" }>) {
  if (!cfg.wand || !isWandDevice(e.id, "analog")) return;
  const ax = cfg.wand.axes;
  const set2 = (key: "move" | "look", idx?: [number, number]) => {
    if (!idx) return;
    const v: [number, number] = [dz(e.values[idx[0]] ?? 0), dz(e.values[idx[1]] ?? 0)];
    if (actions[key][0] !== v[0] || actions[key][1] !== v[1]) (actions[key] = v), (actionsDirty = true);
  };
  set2("move", ax.move);
  set2("look", ax.look);
  if (ax.fly !== undefined) {
    const v = dz(e.values[ax.fly] ?? 0);
    if (actions.fly !== v) (actions.fly = v), (actionsDirty = true);
  }
}

function onEvent(e: TrackerEvent) {
  if (e.kind === "pose") handlePose(e);
  else if (e.kind === "buttons") handleButtons(e);
  else handleAnalog(e);
  if (actionsDirty) {
    actionsDirty = false;
    send({ type: "input", actions: { ...actions, buttons: { ...actions.buttons } } });
  }
}

// ---- Run ----------------------------------------------------------------------------
const source = makeSource(cfg);
log(`config "${cfg.name}": ${source.name}; head ${cfg.head ? cfg.head.id : "-"}, wand ${cfg.wand ? cfg.wand.id : "-"}; units ${cfg.calibration.units}, axes ${cfg.calibration.axes.join(",")}`);
connectManager();
source.start(onEvent, log).catch((e: Error) => {
  console.error(`[tracker] cannot start ${source.name}: ${e.message}`);
  process.exit(1);
});

// A status line every 5 s: which bodies are seen, so a wrong id in the config shows up immediately.
setInterval(() => {
  const bodies = [...seen].map(([id, n]) => `${id}: ${n}`).join(", ");
  log(`${connected ? "manager ok" : "manager DOWN"} · bodies seen: ${bodies || "none yet"}`);
  seen.clear();
}, 5000);

process.on("SIGINT", () => {
  source.stop();
  ws?.close();
  process.exit(0);
});
