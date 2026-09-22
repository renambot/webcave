/**
 * "aquarium": the WebGL Aquarium (WebGLSamples, Google, 2009) as a raw WebGL
 * app in the CAVE.
 *
 * The original is 2,300 lines of plain WebGL on the tdl helper library, with
 * fish that swim as pure functions of time and a render function that, for
 * its VR mode, already took a projection and a view-inverse matrix. That is
 * the whole hook WebCAVE needs: public/aquarium/aquarium-core.js is that
 * code with the page, UI, network sync and WebXR removed and one instance per
 * WebGL context (a simulator draws several screens with several contexts).
 * See its header for what changed.
 *
 * This file is the WebCAVE side: it loads tdl and the core as classic
 * scripts (they expect a global `gl` and a global `tdl`), keeps one core
 * instance per context, converts WebCAVE's meter matrices into the
 * aquarium's units, forwards the cluster time, and pushes the shared
 * settings from appState.aquarium into every instance. The panel (panel.ts)
 * is the original's settings page: fish count, options, lasers, speed.
 *
 * Units: the tank is a globe of radius 74 in the aquarium's units. At 0.1 m
 * per unit it is 7.4 m across the radius, the fish swim at 1 to 4 m above the
 * floor and the CAVE stands at its center, so they pass through the room.
 * The `scale` option changes that.
 */
import type { AppContext, AppDefinition, AppSpec, RawApp, RawRenderContext } from "../types";
import type { FrameState } from "../../core/protocol";
import { createAquariumPanel } from "./panel";
import { DEFAULT_SETTINGS, settingsOf, type AquariumSettings } from "./settings";
import { publicUrl } from "../../core/base";

/** The tdl modules in dependency order, then the adapted aquarium. */
const SCRIPTS = ["tdl/base.js", "tdl/log.js", "tdl/string.js", "tdl/math.js", "tdl/webgl.js", "tdl/buffers.js", "tdl/shader.js", "tdl/programs.js", "tdl/textures.js", "tdl/io.js", "tdl/misc.js", "tdl/fast.js", "tdl/primitives.js", "tdl/models.js", "tdl/particles.js", "aquarium-core.js"];

interface CoreInstance {
  gl: WebGLRenderingContext;
  setSettings(s: AquariumSettings): void;
  update(time: number): void;
  render(projection: Float32Array, viewInverse: Float32Array): void;
  loaded(): { models: number; total: number; placement: boolean };
}
interface AquariumCoreApi {
  create(gl: WebGLRenderingContext, opts: { root: string; shaders: Record<string, string>; onStatus?: (s: string) => void }): CoreInstance;
  fishCounts: number[];
  views: string[];
}
declare global {
  interface Window {
    AquariumCore?: AquariumCoreApi;
  }
}

/** Load classic scripts one after the other, once per page. */
let scriptsLoading: Promise<void> | null = null;
function loadScripts(root: string): Promise<void> {
  if (window.AquariumCore) return Promise.resolve();
  scriptsLoading ??= (async () => {
    for (const src of SCRIPTS) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `${root}${src}`;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`failed to load ${s.src}`));
        document.head.append(s);
      });
      // tdl.require() would document.write() missing modules; everything is loaded in order, so make it a no-op.
      const tdl = (window as unknown as { tdl?: { require?: unknown } }).tdl;
      if (tdl && src === "tdl/base.js") tdl.require = () => {};
    }
  })();
  return scriptsLoading;
}

export function createAquariumApp(spec: AppSpec, _ctx: AppContext): RawApp {
  const root = publicUrl((spec.url ?? "/aquarium/").replace(/\/?$/, "/"));
  const scale = typeof spec.options?.scale === "number" && spec.options.scale > 0 ? spec.options.scale : 0.1; // meters per aquarium unit
  let shaders: Record<string, string> | null = null;
  const instances = new Map<WebGLRenderingContext, CoreInstance>();
  let settings: AquariumSettings = { ...DEFAULT_SETTINGS };
  let time = 0;
  const proj = new Float32Array(16);
  const viewInv = new Float32Array(16);

  const app: RawApp & { ready: Promise<void>; debug?: unknown } = {
    kind: "raw",
    name: "aquarium",
    ready: Promise.resolve(),
    status: "loading scripts",
    navigation: { flySpeed: 2, turnSpeed: 1.2 },
    update(t, state?: FrameState) {
      time = t;
      const next = settingsOf(state?.appState);
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        settings = next;
        for (const inst of instances.values()) inst.setSettings(settings);
      }
      for (const inst of instances.values()) inst.update(time);
      const first = instances.values().next().value as CoreInstance | undefined;
      if (first) {
        const l = first.loaded();
        app.status = l.models < l.total ? `loading ${l.models}/${l.total} models` : `${window.AquariumCore?.fishCounts[settings.fishSetting] ?? "?"} fish · ${instances.size} context${instances.size > 1 ? "s" : ""}`;
      }
    },
    render(ctx: RawRenderContext) {
      if (!shaders || !window.AquariumCore) return;
      let inst = instances.get(ctx.gl);
      if (!inst) {
        inst = window.AquariumCore.create(ctx.gl, { root, shaders });
        inst.setSettings(settings);
        inst.update(time);
        instances.set(ctx.gl, inst);
      }
      // Meters -> aquarium units. Eye space stays rigid: rotation unchanged,
      // translations scaled; in the projection only the near*far term (index 14) scales.
      const k = 1 / scale;
      for (let i = 0; i < 16; i++) {
        viewInv[i] = ctx.viewInverse[i];
        proj[i] = ctx.projection[i];
      }
      viewInv[12] *= k;
      viewInv[13] *= k;
      viewInv[14] *= k;
      proj[14] *= k;
      inst.render(proj, viewInv);
    },
    createPanel: (container, pctx) => createAquariumPanel(container, pctx),
    dispose() {
      instances.clear();
    },
  };

  app.ready = (async () => {
    await loadScripts(root);
    const r = await fetch(`${root}shaders.json`);
    if (!r.ok) throw new Error(`${r.status} ${root}shaders.json`);
    shaders = (await r.json()) as Record<string, string>;
    app.status = "loading models";
  })().catch((e: Error) => {
    app.status = `error: ${e.message}`;
    console.error(e);
  });
  app.debug = { instances, get settings() { return settings; } };
  return app;
}

export default {
  name: "aquarium",
  description: "WebGL Aquarium (Google, 2009) as a raw WebGL app: the CAVE stands in the tank; fish count and options in a panel",
  create: (spec, ctx) => createAquariumApp(spec, ctx),
} satisfies AppDefinition;
