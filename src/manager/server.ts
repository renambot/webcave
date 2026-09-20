/**
 * Manager server: the ClusterManager behind a WebSocket, running in Node.js.
 *
 * This file only does plumbing: parse the command line, load and validate the
 * configuration file, map WebSocket connections to ClusterManager calls, pace
 * tick() at the configured frame rate, and print statistics. All cluster
 * logic lives in core/manager.ts so the simulator can run it in-page too.
 *
 * Frame pacing uses a fixed timeline (nextTick += frameMs) rather than
 * setInterval, so timer jitter does not accumulate into drift; if we fall
 * more than five frames behind (laptop asleep), the timeline resyncs.
 *
 *   npm run manager -- [--config NAME|path.json] [--port 8765] [--sync loose|barrier]
 *                      [--app shapes|gltf] [--model URL] [--size m] [--spin rad/s]
 *                      [--list-configs]
 *
 * NAME is a file in configs/ without the .json extension (default: cave-3m).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { parseClusterConfig } from "../core/configFile";
import { ClusterManager, type ManagerTransport } from "../core/manager";
import { decode, encode, type ClientMessage, type ServerMessage } from "../core/protocol";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const configsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../configs");
const listConfigs = () =>
  readdirSync(configsDir)
    .filter((f) => f.endsWith(".json") && f !== "schema.json")
    .map((f) => basename(f, ".json"));

if (process.argv.includes("--list-configs")) {
  for (const name of listConfigs()) {
    try {
      const c = parseClusterConfig(JSON.parse(readFileSync(resolve(configsDir, `${name}.json`), "utf8")), name);
      console.log(`${name.padEnd(20)} ${c.screens.length} screens, ${c.nodes.length} nodes: ${c.nodes.map((n) => n.id).join(", ")}`);
    } catch (e) {
      console.log(`${name.padEnd(20)} INVALID: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  process.exit(0);
}

/** --config NAME (in configs/) or --config path/to/file.json */
function loadConfigArg(nameOrPath: string) {
  const path = nameOrPath.endsWith(".json") || nameOrPath.includes("/") ? resolve(nameOrPath) : resolve(configsDir, `${nameOrPath}.json`);
  if (!existsSync(path)) {
    console.error(`config not found: ${path}\navailable: ${listConfigs().join(", ")}`);
    process.exit(1);
  }
  try {
    return parseClusterConfig(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

const cfgName = arg("config", "cave-3m");
const port = Number(arg("port", "8765"));
const cfg = loadConfigArg(cfgName);
cfg.sync = arg("sync", cfg.sync) as typeof cfg.sync;
// Application: --app shapes|gltf, --model URL (implies gltf), --size meters, --spin rad/s
const appName = arg("app", "");
const model = arg("model", "");
if (appName) cfg.app.name = appName;
if (model) {
  cfg.app.url = model;
  if (!appName) cfg.app.name = "gltf";
}
if (process.argv.includes("--size")) cfg.app.size = Number(arg("size", "1.2"));
if (process.argv.includes("--spin")) cfg.app.spin = Number(arg("spin", "0.3"));

const clients = new Map<string, WebSocket>();
let nextId = 1;

const transport: ManagerTransport = {
  send(clientId, msg: ServerMessage) {
    const ws = clients.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
  },
  broadcast(msg: ServerMessage) {
    const data = encode(msg);
    for (const ws of clients.values()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  },
};

const manager = new ClusterManager(cfg, transport);
const wss = new WebSocketServer({ port });

wss.on("connection", (ws, req) => {
  const id = `c${nextId++}`;
  clients.set(id, ws);
  console.log(`[manager] ${id} connected from ${req.socket.remoteAddress}`);
  manager.onConnect(id);
  ws.on("message", (data) => {
    try {
      manager.onMessage(id, decode<ClientMessage>(data.toString()));
    } catch (e) {
      console.warn(`[manager] bad message from ${id}`, e);
    }
  });
  ws.on("close", () => {
    clients.delete(id);
    manager.onDisconnect(id);
    console.log(`[manager] ${id} disconnected`);
  });
});

// Frame pacing. setInterval drifts, so schedule against a fixed timeline.
const frameMs = 1000 / cfg.fps;
let nextTick = performance.now();
function pace() {
  const now = performance.now();
  if (now >= nextTick) {
    manager.tick(Date.now());
    nextTick += frameMs;
    if (now - nextTick > frameMs * 5) nextTick = now; // fell far behind; resync
  }
  setTimeout(pace, Math.max(0, nextTick - performance.now()));
}
pace();

setInterval(() => {
  const s = manager.stats();
  if (s.length) {
    console.log(
      `[manager] frame ${manager.currentFrame} | ` +
        s.map((n) => `${n.nodeId}: ack ${n.lastAckFrame} ${n.renderMs.toFixed(1)}ms late ${n.lateFrames}`).join(" | "),
    );
  }
}, 2000);

console.log(`[manager] config "${cfg.name}" sync=${cfg.sync} fps=${cfg.fps} listening on ws://0.0.0.0:${port}`);
console.log(`[manager] nodes: ${cfg.nodes.map((n) => n.id).join(", ")}`);
console.log(`[manager] app: ${cfg.app.name}${cfg.app.url ? " " + cfg.app.url : ""}`);
