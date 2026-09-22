import { defineConfig, type PluginOption } from "vite";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS=1 npm run dev: a self-signed certificate, so a headset on the LAN
// gets the secure context WebXR needs (accept the certificate once on the headset).
const https = process.env.HTTPS === "1";

// BASE_PATH=/webcave/ npm run build: the site under a path prefix behind a reverse proxy (see docs/deployment.md).
const base = (process.env.BASE_PATH ?? "/").replace(/\/?$/, "/");

export default defineConfig({
  base,
  plugins: https ? [basicSsl() as PluginOption] : [],
  server: {
    port: 5173,
    host: true,
    // The headset page reaches the Manager through the dev server (wss://host:5173/manager),
    // since a secure page may not open a plain ws:// socket. MANAGER=ws://host:port overrides.
    proxy: { "/manager": { target: process.env.MANAGER ?? "ws://localhost:8765", ws: true, rewrite: () => "/" } },
  },
  // wgsl-preprocessor ships no "main" entry; point the bare import at its file.
  resolve: { alias: { "wgsl-preprocessor": resolve(__dirname, "node_modules/wgsl-preprocessor/wgsl-preprocessor.js") } },
  // MapLibre spawns its tile worker with new URL("maplibre-gl-worker.mjs", import.meta.url).
  // Vite's dependency pre-bundling rewrites the module and breaks that URL, so the
  // worker never starts and tiles never load. Serve the package as-is instead.
  optimizeDeps: { exclude: ["maplibre-gl"] },
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        simulator: resolve(__dirname, "simulator.html"),
        node: resolve(__dirname, "node.html"),
        launcher: resolve(__dirname, "launcher.html"),
        panel: resolve(__dirname, "panel.html"),
        xr: resolve(__dirname, "xr.html"),
      },
    },
  },
});
