/**
 * "density": a 2D choropleth of population density, spread across a wall.
 *
 * A port of MapLibre's "Visualize population density" example: a GeoJSON of
 * Rwanda's provinces with `population` and `sq-km` properties, filled by
 * population / area through a `let` / `var` expression whose colour ramp
 * changes with zoom (greens below zoom 8, blues at zoom 10 and above).
 *
 * Compared with the "map" app this one is flat (pitch 0) and shows how a
 * MapLibre-based app adds its own data: everything else (wall layout, shared
 * camera, interaction) comes from ../map/wallmap.ts.
 *
 * Options (config `app.options` or URL): style, center, zoom, pitch, bearing,
 * autoRotate (shared), plus `data` (GeoJSON URL) and `opacity` (fill, 0.7).
 * A custom GeoJSON must carry numeric `population` and `sq-km` per feature.
 */
import type { AppDefinition, AppSpec } from "../types";
import { OPENFREEMAP_BRIGHT, createWallMapApp, type WallMapDefinition } from "../map/wallmap";

const RWANDA = "https://maplibre.org/maplibre-gl-js/docs/assets/rwanda-provinces.geojson";

const definition: WallMapDefinition = {
  name: "density",
  defaults: {
    style: OPENFREEMAP_BRIGHT,
    center: [30.0222, -1.9596], // Rwanda
    zoom: 7,
    pitch: 0,
    bearing: 0,
    autoRotate: 0,
  },
  setup(map, opts) {
    const data = typeof opts.raw.data === "string" ? opts.raw.data : RWANDA;
    const opacity = typeof opts.raw.opacity === "number" ? opts.raw.opacity : 0.7;
    map.addSource("density", { type: "geojson", data });
    // Below the ocean labels when the style has them, so names stay readable.
    const before = map.getLayer("watername_ocean") ? "watername_ocean" : undefined;
    map.addLayer(
      {
        id: "density",
        type: "fill",
        source: "density",
        paint: {
          "fill-color": [
            "let",
            "density",
            ["/", ["get", "population"], ["get", "sq-km"]],
            [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              ["interpolate", ["linear"], ["var", "density"], 274, ["to-color", "#edf8e9"], 1551, ["to-color", "#006d2c"]],
              10,
              ["interpolate", ["linear"], ["var", "density"], 274, ["to-color", "#eff3ff"], 1551, ["to-color", "#08519c"]],
            ],
          ],
          "fill-opacity": opacity,
        },
      },
      before,
    );
    // A thin outline makes province borders legible across bezels.
    map.addLayer({ id: "density-outline", type: "line", source: "density", paint: { "line-color": "#1f2937", "line-width": 1, "line-opacity": 0.5 } }, before);
  },
};

export default {
  name: "density",
  description: "2D choropleth of population density (MapLibre example) across the wall; shared camera",
  create: (spec: AppSpec) => createWallMapApp(spec, definition),
} satisfies AppDefinition;
