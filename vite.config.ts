import { defineConfig, loadEnv, type Plugin, type PluginOption } from "vite";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";

/**
 * VITE_APPS_DISABLED=map,density,dotdensity (environment or .env): the named
 * apps are left out of the build. Their folders stay in the repository; this
 * plugin answers the registry's import of `src/apps/<name>/index.ts` with a
 * stub that says "disabled", so none of the app's code or libraries is bundled.
 */
function disableApps(names: string[]): Plugin {
  const prefix = "\0webcave-disabled:";
  return {
    name: "webcave-disable-apps",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!names.length || !importer || !/src\/apps\/index\.ts$/.test(importer)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const m = resolved && /src\/apps\/([^/]+)\/index\.ts$/.exec(resolved.id);
      return m && names.includes(m[1]) ? prefix + m[1] : null;
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      return `export default { name: ${JSON.stringify(id.slice(prefix.length))}, disabled: true };`;
    },
  };
}

// HTTPS=1 npm run dev: a self-signed certificate, so a headset on the LAN
// gets the secure context WebXR needs (accept the certificate once on the headset).
const https = process.env.HTTPS === "1";

// BASE_PATH=/webcave/ npm run build: the site under a path prefix behind a reverse proxy (see docs/deployment.md).
const base = (process.env.BASE_PATH ?? "/").replace(/\/?$/, "/");

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const disabled = (env.VITE_APPS_DISABLED ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
  base,
  define: { "import.meta.env.VITE_APPS_DISABLED": JSON.stringify(disabled.join(",")) },
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
