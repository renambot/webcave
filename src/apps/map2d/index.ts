/**
 * "map2d": clustered earthquakes with donut-chart clusters, across a wall.
 *
 * A port of MapLibre's "Display HTML clusters with custom properties"
 * example. A GeoJSON of earthquakes is clustered by MapLibre itself
 * (`cluster: true`), and five cluster properties count the quakes in each
 * magnitude band. Single quakes draw as circles coloured by magnitude with
 * the magnitude as label; clusters draw as HTML markers: an SVG donut whose
 * segments are the five counts and whose center shows the total.
 *
 * On a wall each view runs its own MapLibre instance with the same camera
 * and the same data, so the clusters come out identical on neighbouring
 * screens and a donut straddling a bezel is drawn by both sides at the same
 * world position. Markers are DOM elements inside the map container, which
 * the wall machinery already extends to the wall center and clips to the
 * tile, so they are clipped like the canvas. The simulator's small tiles
 * render at a lower zoom (see wallmap.ts), where clustering differs from the
 * full-size wall; that is expected.
 *
 * Options (config `app.options` or URL): style, center, zoom, pitch, bearing,
 * autoRotate (shared with the other MapLibre apps), `data` (GeoJSON URL of
 * points with a numeric `mag`), `clusterRadius` (pixels, 80).
 */
import { Marker, type Map as MapLibreMap } from "maplibre-gl";
import type { AppDefinition, AppSpec } from "../types";
import { createWallMapApp, type WallMapDefinition } from "../map/wallmap";

/** The example's own basemap: MapLibre's demo tiles, coloured countries on a blue ocean. */
const DEMOTILES = "https://demotiles.maplibre.org/style.json";

const EARTHQUAKES = "https://maplibre.org/maplibre-gl-js/docs/assets/earthquakes.geojson";

// Magnitude bands and their colours, as in the example.
const mag1 = ["<", ["get", "mag"], 2];
const mag2 = ["all", [">=", ["get", "mag"], 2], ["<", ["get", "mag"], 3]];
const mag3 = ["all", [">=", ["get", "mag"], 3], ["<", ["get", "mag"], 4]];
const mag4 = ["all", [">=", ["get", "mag"], 4], ["<", ["get", "mag"], 5]];
const mag5 = [">=", ["get", "mag"], 5];
const COLORS = ["#fed976", "#feb24c", "#fd8d3c", "#fc4e2a", "#e31a1c"];

/** One arc of the donut, from `start` to `end` (fractions of the whole), outer radius r, inner r0. */
function donutSegment(start: number, end: number, r: number, r0: number, color: string): string {
  if (end - start === 1) end -= 0.00001;
  const a0 = 2 * Math.PI * (start - 0.25);
  const a1 = 2 * Math.PI * (end - 0.25);
  const x0 = Math.cos(a0), y0 = Math.sin(a0);
  const x1 = Math.cos(a1), y1 = Math.sin(a1);
  const largeArc = end - start > 0.5 ? 1 : 0;
  return `<path d="M ${r + r0 * x0} ${r + r0 * y0} L ${r + r * x0} ${r + r * y0} A ${r} ${r} 0 ${largeArc} 1 ${r + r * x1} ${r + r * y1} L ${r + r0 * x1} ${r + r0 * y1} A ${r0} ${r0} 0 ${largeArc} 0 ${r + r0 * x0} ${r + r0 * y0}" fill="${color}" />`;
}

/** The donut for a cluster: segment per magnitude band, size and font from the total. */
function createDonutChart(props: Record<string, unknown>): HTMLElement {
  const counts = [props.mag1, props.mag2, props.mag3, props.mag4, props.mag5].map((v) => Number(v) || 0);
  const offsets: number[] = [];
  let total = 0;
  for (const c of counts) {
    offsets.push(total);
    total += c;
  }
  const fontSize = total >= 1000 ? 22 : total >= 100 ? 20 : total >= 10 ? 18 : 16;
  const r = total >= 1000 ? 50 : total >= 100 ? 32 : total >= 10 ? 24 : 18;
  const r0 = Math.round(r * 0.6);
  const w = r * 2;
  let html = `<div><svg width="${w}" height="${w}" viewBox="0 0 ${w} ${w}" text-anchor="middle" style="font: ${fontSize}px sans-serif; display: block">`;
  for (let i = 0; i < counts.length; i++) html += donutSegment(offsets[i] / (total || 1), (offsets[i] + counts[i]) / (total || 1), r, r0, COLORS[i]);
  html += `<circle cx="${r}" cy="${r}" r="${r0}" fill="white" /><text dominant-baseline="central" transform="translate(${r}, ${r})">${total.toLocaleString()}</text></svg></div>`;
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.firstElementChild as HTMLElement;
}

const definition: WallMapDefinition = {
  name: "map2d",
  // Zoom 3.5 spans the world once across a 5760-pixel wall (world width is 512 * 2^zoom pixels);
  // set zoom in the config for other wall widths. One world only, so a donut is never drawn twice.
  defaults: {
    style: DEMOTILES,
    center: [0, 20],
    zoom: 3.5,
    pitch: 0,
    bearing: 0,
    autoRotate: 0,
  },
  renderWorldCopies: false,
  setup(map: MapLibreMap, opts) {
    const data = typeof opts.raw.data === "string" ? opts.raw.data : EARTHQUAKES;
    const clusterRadius = typeof opts.raw.clusterRadius === "number" ? opts.raw.clusterRadius : 80;
    map.addSource("earthquakes", {
      type: "geojson",
      data,
      cluster: true,
      clusterRadius,
      // Counts per magnitude band, accumulated by the clustering.
      clusterProperties: {
        mag1: ["+", ["case", mag1, 1, 0]],
        mag2: ["+", ["case", mag2, 1, 0]],
        mag3: ["+", ["case", mag3, 1, 0]],
        mag4: ["+", ["case", mag4, 1, 0]],
        mag5: ["+", ["case", mag5, 1, 0]],
      },
    } as Parameters<MapLibreMap["addSource"]>[1]);

    // Single quakes: a circle coloured by band, labelled with the magnitude.
    map.addLayer({
      id: "earthquake_circle",
      type: "circle",
      source: "earthquakes",
      filter: ["!=", "cluster", true],
      paint: {
        "circle-color": ["case", mag1, COLORS[0], mag2, COLORS[1], mag3, COLORS[2], mag4, COLORS[3], COLORS[4]] as never,
        "circle-opacity": 0.6,
        "circle-radius": 12,
      },
    });
    map.addLayer({
      id: "earthquake_label",
      type: "symbol",
      source: "earthquakes",
      filter: ["!=", "cluster", true],
      layout: {
        "text-field": ["number-format", ["get", "mag"], { "min-fraction-digits": 1, "max-fraction-digits": 1 }],
        "text-font": ["Open Sans Semibold"], // the demo tiles' glyphs (the example's font)
        "text-size": 10,
      },
      paint: { "text-color": ["case", ["<", ["get", "mag"], 3], "black", "white"] },
    });

    // Clusters: one HTML marker per cluster id, cached and shown while on screen.
    const markers = new Map<number, Marker>();
    let onScreen = new Map<number, Marker>();
    const updateMarkers = () => {
      const next = new Map<number, Marker>();
      for (const f of map.querySourceFeatures("earthquakes")) {
        const props = f.properties as Record<string, unknown>;
        if (!props.cluster) continue;
        const id = Number(props.cluster_id);
        let marker = markers.get(id);
        if (!marker) {
          const coords = (f.geometry as { coordinates: number[] }).coordinates;
          marker = new Marker({ element: createDonutChart(props) }).setLngLat([coords[0], coords[1]]);
          markers.set(id, marker);
        }
        next.set(id, marker);
        if (!onScreen.has(id)) marker.addTo(map);
      }
      for (const [id, m] of onScreen) if (!next.has(id)) m.remove();
      onScreen = next;
    };
    map.on("data", (e) => {
      if ((e as { sourceId?: string }).sourceId !== "earthquakes" || !(e as { isSourceLoaded?: boolean }).isSourceLoaded) return;
      updateMarkers();
    });
    // The wall machinery moves the camera every frame it changes; markers follow.
    // `idle` covers a node whose camera never moves: it fires once every tile
    // is loaded and clustered, after which querySourceFeatures is complete.
    map.on("move", updateMarkers);
    map.on("moveend", updateMarkers);
    map.on("idle", updateMarkers);
  },
};

export default {
  name: "map2d",
  description: "Clustered earthquakes with donut-chart clusters (MapLibre example) across the wall; shared camera",
  create: (spec: AppSpec) => createWallMapApp(spec, definition),
} satisfies AppDefinition;
