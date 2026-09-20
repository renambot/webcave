/**
 * Application registry.
 *
 * Every folder under src/apps/ whose index.ts default-exports an
 * AppDefinition is an application. Nothing to register: Vite's
 * `import.meta.glob` turns the folder list into a static map at build time,
 * so adding an app is adding a folder.
 *
 * Who calls what:
 *   - the Manager puts an AppSpec in the cluster config (from configs/*.json
 *     or the --app / --model flags) and sends it to every node in "welcome"
 *   - a node or the simulator calls appSpecFromParams() to let URL parameters
 *     override that spec during development, then createApp()
 *   - createApp() looks the name up here and returns a CaveApp
 */
import type { AnyApp, AppContext, AppDefinition, AppSpec } from "./types";

export type { AnyApp, AppContext, AppDefinition, AppSpec, CaveApp, FlatApp, FlatView, FlatViewOptions, InputHook, NavigationHints } from "./types";
export { inputOf, type ActionState } from "../input/actions";
export { isFlatApp, spinTime, toggleSpinPatch, clockTime, toggleClockPatch } from "./types";

// Vite resolves this at build time to { "./shapes/index.ts": module, ... }.
// `eager: true` imports them all up front (they are small); use lazy imports
// here if an app ever pulls in a heavy library.
const modules = import.meta.glob<{ default: AppDefinition }>("./*/index.ts", { eager: true });

/** All applications by name. */
export const APPS: Record<string, AppDefinition> = {};
for (const [path, mod] of Object.entries(modules)) {
  const def = mod.default;
  if (!def || typeof def.create !== "function") {
    console.warn(`[apps] ${path} has no default AppDefinition export; skipped`);
    continue;
  }
  const folder = path.split("/")[1];
  if (def.name !== folder) console.warn(`[apps] ${path}: name "${def.name}" differs from folder "${folder}"`);
  APPS[def.name] = def;
}

/** Sorted application names, for UIs and error messages. */
export const APP_NAMES = Object.keys(APPS).sort();

/**
 * Instantiate the app named in `spec`. An unknown name falls back to "shapes"
 * (or the first app found) and says so in the app's status, so a typo shows
 * up on the wall instead of a black screen.
 */
export function createApp(spec: AppSpec, ctx: AppContext = { audio: false }): AnyApp {
  const def = APPS[spec.name];
  if (def) return def.create(spec, ctx);
  const fallback = APPS.shapes ?? Object.values(APPS)[0];
  if (!fallback) throw new Error("no applications found under src/apps/");
  const app = fallback.create(spec, ctx);
  app.status = `unknown app "${spec.name}" (have: ${APP_NAMES.join(", ")}), showing ${fallback.name}`;
  return app;
}

/**
 * Merge URL overrides onto a base spec (normally the one from the cluster
 * config). Recognized parameters:
 *   app=NAME                      pick an app
 *   model=URL                     gltf asset; implies app=gltf when app is absent
 *   size=M  spin=RAD_PER_S        gltf fitting and rotation
 *   mx=X my=Y mz=Z                gltf position, meters, CAVE frame
 *   style=URL center=LNG,LAT zoom= pitch= bearing=   MapLibre apps: camera and style
 *   data=URL opacity=                                 density: GeoJSON and fill opacity
 *   vdb=URL grid= density= steps= maxDim= color= lightDir=x,y,z   vdb volume (size, spin, mx my mz shared with gltf)
 *   points=URL maxPoints= pointSize= colorAttribute=  points cloud (size, spin, mx my mz shared)
 * Returns the base unchanged when none are present. Add your own app's
 * parameters here if you want them settable from the URL.
 */
export function appSpecFromParams(params: URLSearchParams, base: AppSpec): AppSpec {
  const spec: AppSpec = { ...base };
  if (params.has("app")) spec.name = params.get("app")!;
  if (params.has("model")) {
    spec.url = params.get("model")!;
    if (!params.has("app")) spec.name = "gltf";
  }
  if (params.has("size")) spec.size = Number(params.get("size"));
  if (params.has("spin")) spec.spin = Number(params.get("spin"));
  // vdb=URL selects the volume app; its tuning knobs land in spec.options.
  if (params.has("vdb")) {
    spec.url = params.get("vdb")!;
    if (!params.has("app")) spec.name = "vdb";
  }
  // points=URL selects the point-cloud app.
  if (params.has("points")) {
    spec.url = params.get("points")!;
    if (!params.has("app")) spec.name = "points";
  }
  const vdbKeys = ["grid", "density", "steps", "maxDim", "color", "lightDir", "maxPoints", "pointSize", "colorAttribute"];
  if (vdbKeys.some((k) => params.has(k))) {
    const o: Record<string, unknown> = { ...(spec.options ?? {}) };
    if (params.has("grid")) o.grid = params.get("grid");
    if (params.has("color")) o.color = params.get("color");
    for (const k of ["density", "steps", "maxDim", "maxPoints", "pointSize"]) if (params.has(k)) o[k] = Number(params.get(k));
    if (params.has("colorAttribute")) o.colorAttribute = params.get("colorAttribute");
    if (params.has("lightDir")) o.lightDir = params.get("lightDir")!.split(",").map(Number);
    spec.options = o;
  }
  // Map options land in spec.options so the core stays app-agnostic.
  const mapKeys = ["style", "center", "zoom", "pitch", "bearing", "buildings", "autoRotate", "data", "opacity"];
  if (mapKeys.some((k) => params.has(k))) {
    const o: Record<string, unknown> = { ...(spec.options ?? {}) };
    if (params.has("style")) o.style = params.get("style");
    if (params.has("center")) o.center = params.get("center")!.split(",").map(Number);
    for (const k of ["zoom", "pitch", "bearing", "autoRotate", "opacity"]) if (params.has(k)) o[k] = Number(params.get(k));
    if (params.has("data")) o.data = params.get("data");
    if (params.has("buildings")) o.buildings = params.get("buildings") !== "0" && params.get("buildings") !== "false";
    spec.options = o;
    if (!params.has("app") && !params.has("model")) spec.name = "map";
  }
  if (params.has("mx") || params.has("my") || params.has("mz")) {
    const p = spec.position ?? [0, 1.5, -1.05];
    spec.position = [
      params.has("mx") ? Number(params.get("mx")) : p[0],
      params.has("my") ? Number(params.get("my")) : p[1],
      params.has("mz") ? Number(params.get("mz")) : p[2],
    ];
  }
  return spec;
}
