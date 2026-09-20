import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: { port: 5173, host: true },
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
      },
    },
  },
});
