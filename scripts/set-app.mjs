#!/usr/bin/env node
// Switch the running cluster's application from a shell, without restarting anything:
//   node scripts/set-app.mjs ws://localhost:8765 crayoland
//   node scripts/set-app.mjs ws://localhost:8765 gltf model=/webcave/models/DamagedHelmet.glb size=1
// Connects as a controller, sends setApp, and exits. Options after the name become app spec fields.
import WebSocket from "ws";

const [url, name, ...opts] = process.argv.slice(2);
if (!url || !name) {
  console.error("usage: set-app.mjs ws://host:8765 APP [key=value ...]");
  process.exit(2);
}
const app = { name };
for (const o of opts) {
  const [k, v] = o.split("=");
  app[k] = v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v;
}
const ws = new WebSocket(url);
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", nodeId: "set-app", role: "controller" }));
  ws.send(JSON.stringify({ type: "setApp", app }));
  console.log(`[set-app] ${url}: app -> ${JSON.stringify(app)}`);
  setTimeout(() => ws.close(), 200);
});
ws.on("error", (e) => {
  console.error(`[set-app] ${e.message}`);
  process.exit(1);
});
