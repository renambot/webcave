/**
 * "dotdensity": the Toronto 2021 dot-density map across a wall, with its
 * controls in a panel.
 *
 * A port of the School of Cities' dot-density map (schoolofcities.github.io/
 * dot-density): about 278,000 dots, one per ten people from the 2021 Census,
 * each carrying a category for gender, ethnicity, income, immigration,
 * commute mode, commute time and age. The dots are a deck.gl PointCloudLayer
 * on top of the MapLibre basemap (deck's MapboxOverlay follows the map's
 * camera, padding included, so it works with the wall machinery); place
 * names are a deck TextLayer between zoom 12 and 14.
 *
 * What was a Svelte sidebar is a WebCAVE panel (panel.ts): the field to
 * colour by, the dot size, a dark basemap and a 3D mode live in
 * appState.dotDensity, and every view rebuilds its layers when that state
 * changes (onFrame). The 3D toggle also sets the shared camera's pitch to
 * 54°; the dots' heights ease in over 0.6 s from the toggle time in the
 * state, so all screens animate together.
 *
 * Dark basemap: the original inverted its custom OSM style; here the
 * MapLibre canvas gets a CSS invert filter, which leaves the deck canvas alone.
 *
 * Options (config `app.options` or URL): style, center, zoom, pitch, bearing
 * (shared), `data` (CSV URL: lon, lat, height, gender, ethnicity, income,
 * journey_mode, commute_time, immigration, age), `labels` (place labels
 * JSON), `summaries` (folder of summary-<field>.csv for the legend).
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PointCloudLayer, TextLayer } from "@deck.gl/layers";
import type { AppDefinition, AppSpec, FlatApp } from "../types";
import { OPENFREEMAP_BRIGHT, createWallMapApp, readOptions, type MapCamera, type WallMapDefinition } from "../map/wallmap";
import { createDotDensityPanel } from "./panel";
import { FIELDS, SCHEMES, stateOf, type DotDensityState, type Field } from "./schemes";
import { publicUrl } from "../../core/base";

const DATA = "https://schoolofcities.github.io/dot-density/pp-to-10m-income-edit-3.csv";
const LOCAL = publicUrl("/data/dotdensity/");
const HEIGHT_SCALE = 2000; // the CSV's normalized height -> meters, as in the original
const EASE = 0.6; // seconds for the 3D lift

/** The parsed dots: positions and, per field, a category index into that field's scheme keys. */
interface Dots {
  n: number;
  lon: Float32Array;
  lat: Float32Array;
  height: Float32Array;
  category: Record<Exclude<Field, "people">, Uint8Array>;
  keys: Record<Exclude<Field, "people">, string[]>;
}

/** Parse the CSV (no quoting in this file) into typed arrays. */
function parseDots(text: string): Dots {
  const lines = text.split("\n");
  const header = lines[0].trim().split(",");
  const col = (name: string) => header.indexOf(name);
  const iLon = col("lon"), iLat = col("lat"), iH = col("height");
  const fields = FIELDS.filter((f): f is Exclude<Field, "people"> => f !== "people");
  const iField = Object.fromEntries(fields.map((f) => [f, col(f)])) as Record<Exclude<Field, "people">, number>;
  const n = lines.length - 1;
  const dots: Dots = {
    n: 0,
    lon: new Float32Array(n),
    lat: new Float32Array(n),
    height: new Float32Array(n),
    category: Object.fromEntries(fields.map((f) => [f, new Uint8Array(n)])) as Dots["category"],
    keys: Object.fromEntries(fields.map((f) => [f, Object.keys(SCHEMES[f])])) as Dots["keys"],
  };
  const keyIndex = Object.fromEntries(fields.map((f) => [f, new Map(dots.keys[f].map((k, i) => [k, i]))])) as Record<string, Map<string, number>>;
  let k = 0;
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (c.length < header.length) continue;
    dots.lon[k] = Number(c[iLon]);
    dots.lat[k] = Number(c[iLat]);
    dots.height[k] = Number(c[iH]) || 0;
    for (const f of fields) {
      const idx = keyIndex[f].get(c[iField[f]]);
      dots.category[f][k] = idx ?? keyIndex[f].get("unknown") ?? 0;
    }
    k++;
  }
  dots.n = k;
  return dots;
}

/** Smooth ease of the 3D lift: 0 flat, 1 lifted, from the toggle time. */
function heightMultiplier(s: DotDensityState, time: number): number {
  const t = Math.max(0, Math.min(1, (time - s.since) / EASE));
  const e = t * t * (3 - 2 * t);
  return s.extruded ? e : 1 - e;
}

/** Zoom-dependent dot scale, as the original (zoom 10.887 is scale 1). */
const zoomFactor = (zoom: number) => Math.pow(2, (zoom - 10.887) * 0.38);

/** Per-view state: the deck overlay, the data, cached attribute arrays, and what the layers were last built from. */
interface ViewData {
  overlay: MapboxOverlay;
  dots: Dots | null;
  labels: { name: string; coordinates: [number, number] }[];
  positions: Float32Array | null;
  positionsMult: number;
  colors: Map<string, Uint8Array>;
  lastKey: string;
}
const views = new WeakMap<MapLibreMap, ViewData>();
/** Every view of this window, for the debug handle and the status line. */
const allViews: ViewData[] = [];
/** Loading progress of the dots, shown in the app status. */
let loadStatus = "loading dots";

function colorsFor(v: ViewData, field: Field, dark: boolean): Uint8Array {
  const key = field === "people" ? `people:${dark}` : field;
  let c = v.colors.get(key);
  if (c || !v.dots) return c ?? new Uint8Array(0);
  const d = v.dots;
  c = new Uint8Array(d.n * 4);
  if (field === "people") {
    c.fill(dark ? 255 : 0);
    for (let i = 3; i < c.length; i += 4) c[i] = 255;
  } else {
    const scheme = SCHEMES[field];
    const palette = d.keys[field].map((k) => scheme[k]);
    const cat = d.category[field];
    for (let i = 0; i < d.n; i++) c.set(palette[cat[i]], i * 4);
  }
  v.colors.set(key, c);
  return c;
}

function positionsFor(v: ViewData, mult: number): Float32Array {
  const d = v.dots!;
  if (v.positions && v.positionsMult === mult) return v.positions;
  const p = v.positions ?? new Float32Array(d.n * 3);
  for (let i = 0; i < d.n; i++) {
    p[i * 3] = d.lon[i];
    p[i * 3 + 1] = d.lat[i];
    p[i * 3 + 2] = d.height[i] * HEIGHT_SCALE * mult;
  }
  v.positions = p;
  v.positionsMult = mult;
  return p;
}

const definition: WallMapDefinition = {
  name: "dotdensity",
  // The dots cover the City of Toronto, about 42 km across; zoom 13.3 spreads
  // that over most of a 5760-pixel wall (the original showed it in 540 px at
  // zoom 10.5). Set zoom in the config for other wall widths.
  defaults: {
    style: OPENFREEMAP_BRIGHT,
    center: [-79.3859, 43.7138], // Toronto
    zoom: 13.3,
    pitch: 0,
    bearing: -17,
    autoRotate: 0,
  },
  renderWorldCopies: false,
  setup(map, opts) {
    const data = typeof opts.raw.data === "string" ? opts.raw.data : DATA;
    const labelsUrl = typeof opts.raw.labels === "string" ? opts.raw.labels : `${LOCAL}placeLabels.json`;
    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);
    const v: ViewData = { overlay, dots: null, labels: [], positions: null, positionsMult: -1, colors: new Map(), lastKey: "" };
    views.set(map, v);
    allViews.push(v);
    void fetch(labelsUrl)
      .then((r) => (r.ok ? r.json() : []))
      .then((j) => (v.labels = j as ViewData["labels"]))
      .catch(() => {});
    void fetch(data)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${data}`))))
      .then((t) => {
        v.dots = parseDots(t);
        v.lastKey = ""; // force a rebuild
        loadStatus = `${v.dots.n.toLocaleString()} dots`;
      })
      .catch((e: Error) => {
        loadStatus = `dots failed: ${e.message}`;
        console.error(`[dotdensity] ${e.message}`);
      });
  },
  onFrame(map, state, view) {
    const v = views.get(map);
    if (!v) return;
    if (!v.dots && !view.camera) return;
    const s = stateOf(state.appState);
    const mult = Math.round(heightMultiplier(s, state.time) * 1000) / 1000;
    const zoom = view.camera.zoom;
    const labelsVisible = zoom >= 12 && zoom <= 14;
    map.getCanvas().style.filter = s.dark ? "invert(1) hue-rotate(180deg) brightness(0.85)" : "";
    if (!v.dots) return;
    const key = `${s.field}|${s.dark}|${mult}|${s.pointSize}|${Math.round(zoom * 20)}|${view.k}|${labelsVisible}|${v.labels.length}`;
    if (key === v.lastKey) return;
    v.lastKey = key;
    const d = v.dots;
    const layers = [
      new PointCloudLayer({
        id: "dots",
        data: { length: d.n, attributes: { getPosition: { value: positionsFor(v, mult), size: 3 }, getColor: { value: colorsFor(v, s.field, s.dark), size: 4 } } },
        // Never below a pixel: the original's 0.6 px dots vanish in a scaled simulator tile.
        pointSize: Math.max(1, s.pointSize * zoomFactor(zoom) * view.k),
        sizeUnits: "pixels",
        opacity: 1,
        material: { ambient: 0.8, diffuse: 0.4, shininess: 8, specularColor: [30, 30, 30] },
        updateTriggers: { getPosition: mult, getColor: `${s.field}|${s.dark}` },
      }),
      new TextLayer<{ name: string; coordinates: [number, number] }>({
        id: "labels",
        data: v.labels,
        visible: labelsVisible,
        getPosition: (l) => [l.coordinates[0], l.coordinates[1], 100],
        getText: (l) => l.name.toUpperCase(),
        getSize: 13 * view.k,
        sizeUnits: "pixels",
        getColor: s.dark ? [240, 240, 240, 160] : [0, 0, 0, 160],
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        fontFamily: "sans-serif",
        fontSettings: { sdf: true },
        outlineWidth: 3,
        outlineColor: s.dark ? [0, 0, 0, 160] : [255, 255, 255, 160],
        updateTriggers: { getColor: s.dark },
      }),
    ];
    v.overlay.setProps({ layers });
  },
};

export default {
  name: "dotdensity",
  description: "Toronto 2021 dot-density map (School of Cities) on deck.gl across the wall, with a control panel",
  create(spec: AppSpec): FlatApp {
    // Extend the wall map app in place (a copy would freeze its status).
    const app = createWallMapApp(spec, definition) as FlatApp & { debug?: unknown };
    const summaries = typeof spec.options?.summaries === "string" ? spec.options.summaries : LOCAL;
    // The camera a view starts from, so the panel can tilt it before anyone has moved the map.
    const o = readOptions(spec, definition);
    const defaultCamera: MapCamera = { center: o.center, zoom: o.zoom, bearing: o.bearing, pitch: o.pitch };
    app.createPanel = (container, ctx) => createDotDensityPanel(container, ctx, summaries.replace(/\/?$/, "/"), defaultCamera);
    app.debug = { views: allViews, get loadStatus() { return loadStatus; } };
    return app;
  },
} satisfies AppDefinition;
