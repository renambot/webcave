#!/usr/bin/env node
/**
 * Screenshot a page in a real (headless) Chrome session after N seconds of
 * wall-clock time, with console errors printed. Unlike `chrome --screenshot`,
 * the page runs normally: requestAnimationFrame fires continuously, so apps
 * like MapLibre that load tiles from their render loop actually load.
 *
 *   node scripts/screenshot.mjs <url> <out.png> [seconds=10] [width=1600] [height=900] [--drag x1,y1,x2,y2[,delaySeconds]]
 *
 * --eval "expr" evaluates a JS expression in the page before the screenshot
 * and prints the JSON result (the simulator exposes window.webcave). A promise
 * (an async IIFE) is awaited, so an expression can drive the page and wait.
 * --key "k[,delaySeconds[,holdSeconds]]" presses key k (a character such as " " or "l", or a
 *   named key such as Enter or ArrowLeft) after the
 *   delay, holding it for holdSeconds (default 0 = tap).
 * --drag presses the mouse at (x1, y1), moves to (x2, y2) in steps and
 * releases, after `delaySeconds` (default 5): enough to test map interaction
 * in the simulator against a running cluster.
 *
 * Uses the DevTools protocol over Node's built-in WebSocket; no dependencies.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const dragIdx = argv.indexOf("--drag");
const drag = dragIdx >= 0 ? argv.splice(dragIdx, 2)[1].split(",").map(Number) : null;
const evalIdx = argv.indexOf("--eval");
const evalExpr = evalIdx >= 0 ? argv.splice(evalIdx, 2)[1] : null;
const keyIdx = argv.indexOf("--key");
// --key "name[,delaySeconds]" presses one key (e.g. " " or "r") after the delay (default 5).
const keyPress = keyIdx >= 0 ? argv.splice(keyIdx, 2)[1] : null;
const [url, out, secondsArg = "10", widthArg = "1600", heightArg = "900"] = argv;
if (!url || !out) {
  console.error("usage: screenshot.mjs <url> <out.png> [seconds] [width] [height]");
  process.exit(2);
}
const seconds = Number(secondsArg);
const width = Number(widthArg);
const height = Number(heightArg);
const port = 9222 + Math.floor(Math.random() * 500);

const chromePath =
  process.env.CHROME ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/webcave-shot-${port}`,
    "--no-first-run",
    "--ignore-gpu-blocklist",
    "--use-angle=metal",
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const cleanup = () => {
  try {
    chrome.kill();
  } catch {
    /* gone */
  }
};
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  throw new Error("Chrome devtools did not come up");
}

async function main() {
  await waitForDevtools();
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));

  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      console.error("page exception:", msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
      console.error(`page ${msg.params.type}:`, msg.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  console.log(`loaded ${url}; waiting ${seconds}s`);
  if (keyPress) {
    const [k, delayStr = "5", holdStr = "0"] = keyPress.split(",");
    await sleep(Number(delayStr) * 1000);
    // Single characters are printable keys; longer names (Enter, Backspace, ArrowLeft) are named keys.
    const named = k.length > 1;
    const code = k === " " ? "Space" : named ? k : `Key${k.toUpperCase()}`;
    const down = named ? { type: "keyDown", key: k, code } : { type: "keyDown", key: k, code, text: k, unmodifiedText: k };
    await send("Input.dispatchKeyEvent", down);
    if (Number(holdStr) > 0) await sleep(Number(holdStr) * 1000);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
    console.log(`pressed "${k}"${Number(holdStr) > 0 ? ` for ${holdStr}s` : ""}`);
    await sleep(Math.max(0, seconds - Number(delayStr) - Number(holdStr)) * 1000);
  } else if (drag) {
    const [x1, y1, x2, y2, delay = 5] = drag;
    await sleep(delay * 1000);
    const mouse = (type, x, y, extra = {}) =>
      send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
    await mouse("mouseMoved", x1, y1, { buttons: 0 });
    await mouse("mousePressed", x1, y1);
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
      await sleep(30);
    }
    await mouse("mouseReleased", x2, y2);
    console.log(`dragged (${x1},${y1}) -> (${x2},${y2})`);
    await sleep(Math.max(0, seconds - delay) * 1000);
  } else {
    await sleep(seconds * 1000);
  }
  if (evalExpr) {
    // A promise-returning expression (an async IIFE) is awaited before stringifying.
    const r = await send("Runtime.evaluate", { expression: `Promise.resolve(${evalExpr}).then((v) => JSON.stringify(v))`, returnByValue: true, awaitPromise: true });
    console.log("eval:", r.result.value ?? r.result.description);
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`wrote ${out}`);
  ws.close();
  cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
