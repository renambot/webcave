/**
 * "metaballs": Brandon Jones's WebGPU Metaballs (the WebGPU Samples
 * "Metaballs" entry, github.com/toji/webgpu-metaballs, MIT) as WebCAVE's
 * first WebGPU app.
 *
 * Marching cubes on the GPU turn sixteen moving metaballs into a mesh every
 * frame, shaded as lava, water or slime, in a dungeon scene lit by clustered
 * point lights, with light sprites. The original renders one view from an
 * orbit camera, or two from WebXR; WebCAVE takes the XR role and supplies one
 * view per eye per screen (renderer.ts).
 *
 * What was kept and what changed:
 *   - vendor/ is the project's js/ folder as is, except for two lines: the
 *     texture loader class is injected rather than imported (npm cannot
 *     fetch the git dependency here; the prebuilt loader and its transcoder
 *     workers live in public/metaballs/wtt/), and the media root is a field.
 *   - Time is the cluster clock in milliseconds; the metaball positions were
 *     already pure functions of it, so all screens agree.
 *   - Of the settings pane only metaball style and resolution remain, as
 *     shared state in appState.metaballs, plus the stats readout. Methods,
 *     light toggles, environment toggle and WebXR are left at their defaults.
 *   - Media is fetched from the project's GitHub Pages by default (the
 *     dungeon model is under Sketchfab's standard license and is not
 *     redistributed here); the `model` URL can point at a local copy.
 *
 * Needs a browser with WebGPU (Chrome, Edge; Safari 26; Firefox on Windows).
 * Units are meters; the scene is placed 1.8 m in front of the CAVE origin
 * (option `offset`), so the blobs rise just behind the front wall.
 */
import type { AppContext, AppDefinition, AppSpec, WebGpuApp, WebGpuRenderContext } from "../types";
import type { FrameState } from "../../core/protocol";
import { CaveMetaballRenderer } from "./renderer";
import { createMetaballsPanel, type StatsSource } from "./panel";
import { PerformanceTracker } from "./vendor/performance-tracker.js";
import { Gltf2Loader } from "./vendor/mini-gltf2.js";
import { DEFAULT_SETTINGS, settingsOf, type MetaballSettings } from "./settings";

const MEDIA = "https://toji.github.io/webgpu-metaballs/media/";
const LOADER = "/metaballs/wtt/webgpu-texture-loader.js";

export function createMetaballsApp(spec: AppSpec, _ctx: AppContext): WebGpuApp {
  const media = (spec.url ?? MEDIA).replace(/\/?$/, "/");
  const offsetOpt = spec.options?.offset;
  const offset: [number, number, number] = Array.isArray(offsetOpt) && offsetOpt.length === 3 ? (offsetOpt.map(Number) as [number, number, number]) : [0, 0, -1.8];
  let renderer: CaveMetaballRenderer | null = null;
  const stats = new PerformanceTracker();
  let settings: MetaballSettings = { ...DEFAULT_SETTINGS };
  let timeMs = 0;
  let frameBegun = false;
  let renders = 0;

  const statsSource: StatsSource = {
    fps: () => Number(stats.fps.latest) || 0,
    // The tracker's rolling average never fills (its index update has a precedence slip), so show the latest sample, as its own UI did.
    // Every entry, whatever its value: a pass short enough to round to 0 µs must not make its row flicker.
    entries: () => [...(stats.entries as Map<string, { latest: number }>)].map(([k, e]) => [k, e.latest] as [string, number]),
    rendering: () => renders > 0,
  };

  const app: WebGpuApp & { ready: Promise<void>; debug?: unknown } = {
    kind: "webgpu",
    name: "metaballs",
    ready: Promise.resolve(),
    status: "starting WebGPU",
    navigation: { flySpeed: 1, turnSpeed: 1.2 },
    update(t, state?: FrameState) {
      timeMs = t * 1000;
      const next = settingsOf(state?.appState);
      if (renderer && (next.style !== settings.style || next.resolution !== settings.resolution)) {
        if (next.style !== settings.style) void renderer.setMetaballStyle(next.style);
        if (next.resolution !== settings.resolution) renderer.setMetaballStep(next.resolution);
      }
      settings = next;
      if (!renderer) return;
      // Frame time spans everything since the previous update: all eyes and the copies.
      if (frameBegun) stats.endFrame();
      stats.beginFrame();
      frameBegun = true;
      renderer.beginCaveFrame(timeMs);
    },
    render(ctx: WebGpuRenderContext) {
      if (!renderer) return;
      renderer.renderView(ctx, ctx.eye === "right" ? 1 : 0, timeMs);
      renders++;
    },
    createPanel: (container, pctx) => createMetaballsPanel(container, pctx, statsSource),
    dispose() {
      renderer = null;
    },
  };

  app.ready = (async () => {
    if (!("gpu" in navigator)) throw new Error("WebGPU is not available in this browser");
    // Built at run time so Vite leaves the import alone: the loader is a static file in public/, not a module to bundle.
    const loaderUrl = new URL(LOADER, location.origin).href;
    const loader = (await import(/* @vite-ignore */ loaderUrl)) as { WebGPUTextureLoader: unknown };
    const r = new CaveMetaballRenderer(loader.WebGPUTextureLoader, media, offset);
    await r.init();
    r.setStats(stats);
    r.renderEnvironment = true;
    r.lightManager.render = true; // light sprites
    r.metaballMethod = "gpuGenerated";
    r.setMetaballStep(settings.resolution); // also creates the compute renderer
    await r.setMetaballStyle(settings.style);
    renderer = r;
    app.status = "loading the dungeon";
    const gltf = await new Gltf2Loader().loadFromUrl(`${media}models/dungeon/dungeon-opt.glb`);
    r.setScene(gltf);
    r.enableLights(true, true);
    app.status = `ready · ${r.adapter?.info?.description || r.adapter?.info?.vendor || "WebGPU"}`;
  })().catch((e: Error) => {
    app.status = `error: ${e.message}`;
    console.error(e);
  });
  app.debug = { get renderer() { return renderer; }, stats, get settings() { return settings; } };
  return app;
}

export default {
  name: "metaballs",
  description: "WebGPU Metaballs (Brandon Jones): GPU marching cubes in a clustered-lit dungeon, WebCAVE's first WebGPU app",
  create: (spec, ctx) => createMetaballsApp(spec, ctx),
} satisfies AppDefinition;
