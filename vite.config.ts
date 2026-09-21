import { defineConfig, loadEnv, type PluginOption } from "vite";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS=1 npm run dev: a self-signed certificate, so a headset on the LAN
// gets the secure context WebXR needs (accept the certificate once on the headset).
const https = process.env.HTTPS === "1";

/**
 * Apps switched off on this machine, from VITE_DISABLE_APPS: a comma-separated
 * list of folder names under src/apps/, normally set in a local .env.local.
 *
 * The registry discovers apps with import.meta.glob, which Vite resolves at
 * build time and which cannot be filtered from a variable, so a disabled app's
 * index.ts is replaced here by an empty module: neither the app nor the
 * dependencies it imports (openvdb, the WebGPU vendor code, ...) reach the
 * bundle. The registry skips the same names, so the app is simply not there.
 */
function disableApps(names: string[]): PluginOption {
  const disabled = new Set(names);
  return {
    name: "webcave:disable-apps",
    enforce: "pre",
    load(id) {
      const path = id.split("?")[0].replace(/\\/g, "/");
      const m = /\/src\/apps\/([^/]+)\/index\.ts$/.exec(path);
      if (!m || !disabled.has(m[1])) return null;
      return "export default null;\n";
    },
  };
}

// BASE_PATH=/webcave/ npm run build: the site under a path prefix behind a reverse proxy (see docs/deployment.md).
const base = (process.env.BASE_PATH ?? "/").replace(/\/?$/, "/");

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const disabled = (env.VITE_DISABLE_APPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (disabled.length) console.log(`[apps] disabled in this build: ${disabled.join(", ")} (VITE_DISABLE_APPS)`);
  return {
  base,
  // The registry reads the same list; define it, since loadEnv() also picks the
  // variable up from the environment, where import.meta.env would not see it.
  define: { "import.meta.env.VITE_DISABLE_APPS": JSON.stringify(disabled.join(",")) },
  // Workers (MapLibre's tile worker) are bundled as ES modules, so they may share code-split chunks.
  worker: { format: "es" },
  plugins: [disableApps(disabled), ...(https ? [basicSsl() as PluginOption] : [])],
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
  // worker never starts and tiles never load. Serve the package as-is in development;
  // production builds get the worker as an explicit asset (see src/apps/map/wallmap.ts).
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
};
});
