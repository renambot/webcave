#!/usr/bin/env node
// Switch the running cluster's display configuration from a shell, without restarting anything:
//   node scripts/set-config.mjs ws://localhost:8765 cave-3m
// The Manager loads configs/NAME.json from its own folder and every connected page rebuilds.
import WebSocket from "ws";

const [url, name] = process.argv.slice(2);
if (!url || !name) {
  console.error("usage: set-config.mjs ws://host:8765 CONFIG_NAME");
  process.exit(2);
}
const ws = new WebSocket(url);
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", nodeId: "set-config", role: "controller" }));
  ws.send(JSON.stringify({ type: "setConfig", name }));
  console.log(`[set-config] ${url}: config -> ${name}`);
  setTimeout(() => ws.close(), 200);
});
ws.on("error", (e) => {
  console.error(`[set-config] ${e.message}`);
  process.exit(1);
});
