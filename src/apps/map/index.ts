/**
 * "map": a MapLibre map with 3D buildings, spread across a display wall.
 *
 * All the wall logic (one exact sub-rectangle per tile, camera shared through
 * the Manager, interaction from controllers) is in ./wallmap.ts. This file
 * only says which style and camera to start from and adds the fill-extrusion
 * layer from MapLibre's "Display buildings in 3D" example. Use it as the
 * template for other MapLibre-based apps (see ../density for a choropleth).
 *
 * Options (config `app.options` or URL): style, center, zoom, pitch, bearing,
 * autoRotate (shared), plus `buildings` (default true).
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { AppDefinition, AppSpec } from "../types";
import { OPENFREEMAP_BRIGHT, createWallMapApp, type WallMapDefinition, type WallMapOptions } from "./wallmap";

/** The fill-extrusion layer from the MapLibre "Display buildings in 3D" example. */
function addBuildingsLayer(map: MapLibreMap) {
  const layers = map.getStyle().layers ?? [];
  // Insert below the first symbol layer that draws text, so labels stay readable.
  let labelLayerId: string | undefined;
  for (const l of layers) {
    if (l.type === "symbol" && (l.layout as Record<string, unknown> | undefined)?.["text-field"]) {
      labelLayerId = l.id;
      break;
    }
  }
  if (map.getLayer("3d-buildings")) return;
  map.addLayer(
    {
      id: "3d-buildings",
      source: "openmaptiles",
      "source-layer": "building",
      type: "fill-extrusion",
      minzoom: 15,
      filter: ["!", ["has", "hide_3d"]],
      paint: {
        "fill-extrusion-color": ["interpolate", ["linear"], ["get", "render_height"], 0, "lightgray", 200, "royalblue", 400, "lightblue"],
        "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, ["get", "render_height"]],
        "fill-extrusion-base": ["case", [">=", ["get", "zoom"], 16], ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.9,
      },
    },
    labelLayerId,
  );
}

const definition: WallMapDefinition = {
  name: "map",
  defaults: {
    style: OPENFREEMAP_BRIGHT,
    center: [-87.6298, 41.8781], // Chicago Loop
    zoom: 15.5,
    pitch: 45,
    bearing: -17.6,
    autoRotate: 0,
  },
  setup(map, opts: WallMapOptions) {
    const buildings = typeof opts.raw.buildings === "boolean" ? opts.raw.buildings : true;
    if (buildings) addBuildingsLayer(map);
  },
};

export default {
  name: "map",
  description: "MapLibre map with 3D buildings spread across the wall; camera shared through the Manager",
  create: (spec: AppSpec) => createWallMapApp(spec, definition),
} satisfies AppDefinition;
