/**
 * MapLibre on a display wall: the machinery shared by every MapLibre-based
 * flat app ("map" with 3D buildings, "density" with a choropleth, yours).
 *
 * An app built on this module only supplies a WallMapDefinition: default
 * camera and style, and a setup(map) hook that adds its sources and layers
 * once the style has loaded. Everything about spreading one map across the
 * wall and keeping the camera in sync lives here.
 *
 * How the wall becomes one map
 * ---------------------------
 * Every node runs its own MapLibre instance ("replicated" mode) with the
 * same camera: center, zoom, bearing, pitch. A tile must render the exact
 * sub-rectangle of the big virtual wall view that its screen covers. Three
 * MapLibre facts make that possible with public API only:
 *
 *   padding    asymmetric padding moves MapLibre's center point away from
 *              the canvas middle, and MapLibre applies that as a proper
 *              off-center perspective shift (transform._calcMatrices sets
 *              m[8], m[9] from centerOffset), i.e. an asymmetric frustum.
 *   clamp      but the center point is clamped to the canvas, so padding can
 *              shift the view by at most half the canvas. A tile far from the
 *              wall center therefore gets a canvas that *extends* from the
 *              tile to the wall center, and the container clips it to the
 *              tile. The center tile costs nothing extra; the outer tiles of a
 *              3x1 wall render 1.5x their pixels; a 2x2 wall needs no extra
 *              pixels since the wall center sits on each tile's corner.
 *   field of   the camera distance is 0.5 * canvasHeight / tan(fov/2). A
 *   view       canvas shorter than the wall shrinks its fov so its camera sits
 *              where the wall's camera would: tan(fov_c/2) = (H_c/H_wall) tan(fov_w/2).
 *
 * With the same zoom (pixels per meter at the center), the same camera pose
 * and the same camera distance, each tile shows precisely its part of the
 * wall image and the buildings line up across bezels. Offsets are computed in
 * native pixels and scaled to the actual canvas size in resize(); since zoom
 * is itself a pixel scale, a canvas drawn at scale k uses zoom + log2(k), so a
 * scaled-down simulator tile or a windowed node shows the same extent as the
 * real wall.
 *
 * How the camera stays in sync
 * ----------------------------
 * The camera lives in the Manager's shared app state (`appState.map`) and
 * arrives in every frame. Views apply it with jumpTo() whenever it changes.
 * An *interactive* view (the simulator, or any controller) lets MapLibre
 * handle the mouse as usual and, on every "move" event, sends the new camera
 * to the Manager, which rebroadcasts it. Two guards avoid feedback:
 *   - a view ignores incoming state while it is the one moving (isMoving),
 *   - a view does not report moves that it caused itself by applying state.
 * Until a controller has touched the map, the camera is the configured
 * initial view, still by default; with `autoRotate` set it is a deterministic
 * function of cluster time (bearing rotates), so idle walls stay in step.
 *
 * Interaction (on a controller): drag to pan, wheel to zoom, right-drag or
 * Ctrl-drag to rotate and pitch, double-click to zoom in. Keyboard is left to
 * WebCAVE.
 *
 * Options (config `app.options` or URL): style (URL), center [lng, lat],
 * zoom, pitch, bearing, autoRotate (deg/s, 0 = off), plus whatever the
 * definition's setup() reads from `options`.
 *
 * Tiles load asynchronously on each node, so a freshly panned area may pop
 * in at slightly different moments on different screens. That is inherent to
 * replicated 2D apps and acceptable for maps; the camera itself never drifts.
 */
import { Map as MapLibreMap, type ErrorEvent, type PaddingOptions } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { ScreenConfig } from "../../core/config";
import type { FrameState } from "../../core/protocol";
import type { WallLayout } from "../../core/wall";
import { spinTime, type AppSpec, type FlatApp, type FlatView, type FlatViewOptions } from "../types";

/** The shared camera, as stored in appState.map. */
export interface MapCamera {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

/** Camera and style options every MapLibre wall app understands. */
export interface WallMapOptions {
  style: string;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  /** Degrees per second of bearing rotation while nobody drives the map; 0 = still. */
  autoRotate: number;
  /** The raw per-app options, for setup() to read its own keys from. */
  raw: Record<string, unknown>;
}

/** What a MapLibre-based app provides. */
export interface WallMapDefinition {
  name: string;
  /** Defaults for the camera and style; the config's app.options and URL parameters override them. */
  defaults: Omit<WallMapOptions, "raw">;
  /**
   * Called on each view once its style has loaded: add sources and layers
   * here. Runs on every node, so it must be deterministic and must not read
   * local input. May throw; the error lands in the app status.
   */
  setup?(map: MapLibreMap, opts: WallMapOptions): void;
  /** Whether the map repeats the world sideways at low zoom (MapLibre default true). A world-scale app spanning a wide wall wants false. */
  renderWorldCopies?: boolean;
}

/** OpenFreeMap: free vector tiles (OpenMapTiles schema), no API key. */
export const OPENFREEMAP_BRIGHT = "https://tiles.openfreemap.org/styles/bright";

function readOptions(spec: AppSpec, def: WallMapDefinition): WallMapOptions {
  const raw = (spec.options ?? {}) as Record<string, unknown>;
  const d = def.defaults;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const center = Array.isArray(raw.center) && raw.center.length === 2 ? (raw.center.map(Number) as [number, number]) : d.center;
  return {
    style: typeof raw.style === "string" ? raw.style : d.style,
    center,
    zoom: num(raw.zoom, d.zoom),
    pitch: num(raw.pitch, d.pitch),
    bearing: num(raw.bearing, d.bearing),
    autoRotate: num(raw.autoRotate, d.autoRotate),
    raw,
  };
}

const sameCamera = (a: MapCamera | null, b: MapCamera) =>
  !!a && a.center[0] === b.center[0] && a.center[1] === b.center[1] && a.zoom === b.zoom && a.bearing === b.bearing && a.pitch === b.pitch;

/** Build a flat app from a WallMapDefinition. */
export function createWallMapApp(spec: AppSpec, def: WallMapDefinition): FlatApp {
  const opts = readOptions(spec, def);
  const views: MapView[] = [];

  /** Camera when nobody has taken control: the initial view, rotating only if autoRotate > 0 (and the shared spin clock runs). */
  const autoCamera = (state: FrameState): MapCamera => ({
    center: opts.center,
    zoom: opts.zoom,
    pitch: opts.pitch,
    bearing: opts.bearing + opts.autoRotate * spinTime(state, state.time),
  });

  /** Current shared camera, or the idle camera when no controller has set one. */
  const cameraOf = (state: FrameState): MapCamera => {
    const shared = state.appState?.map as MapCamera | undefined;
    return shared && Array.isArray(shared.center) ? shared : autoCamera(state);
  };

  const app: FlatApp = {
    kind: "flat",
    name: def.name,
    status: "no view yet",
    ready: Promise.resolve(),
    ownsNavigation: true,
    /**
     * Controller input drives the shared camera: left stick / IJKL pans in
     * screen space (rotated by the bearing), right stick / arrows rotates and
     * pitches, triggers / U O zoom. Computed from the shared camera so every
     * controller agrees on the result, then sent as the new camera.
     */
    onInput(actions, dt, state, send) {
      const [mx, my] = actions.move;
      const [lx, ly] = actions.look;
      const fly = actions.fly;
      if (mx === 0 && my === 0 && lx === 0 && ly === 0 && fly === 0) return;
      const cam = cameraOf(state);
      const zoom = Math.max(1, Math.min(22, cam.zoom + fly * 1.2 * dt));
      const bearing = cam.bearing + lx * 70 * dt;
      const pitch = Math.max(0, Math.min(85, cam.pitch + ly * 45 * dt));
      // Pan: 700 px/s at full deflection, in the direction the map is facing.
      const px = mx * 700 * dt;
      const py = my * 700 * dt;
      const b = (bearing * Math.PI) / 180;
      const ex = px * Math.cos(b) - py * Math.sin(b); // east component in pixels
      const ny = px * Math.sin(b) + py * Math.cos(b); // north component in pixels
      const lat = cam.center[1];
      const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
      const dLng = (ex * metersPerPixel) / (111320 * Math.cos((lat * Math.PI) / 180));
      const dLat = (ny * metersPerPixel) / 110540;
      const center: [number, number] = [cam.center[0] + dLng, Math.max(-85, Math.min(85, lat + dLat))];
      send({ map: { center, zoom, bearing, pitch } satisfies MapCamera });
    },
    createView(container, screen, layout, viewOpts) {
      const v = new MapView(container, screen, layout, viewOpts, opts, def, autoCamera, (s) => (app.status = s));
      views.push(v);
      return v;
    },
    dispose() {
      for (const v of views) v.dispose();
      views.length = 0;
    },
  };
  return app;
}

class MapView implements FlatView {
  /** Public for debugging (window.webcave in the simulator). */
  readonly map: MapLibreMap;
  private div: HTMLDivElement;
  private applied: MapCamera | null = null;
  /** True while we are calling jumpTo, so our own "move" events are not reported back. */
  private applying = false;
  /** Canvas rectangle in native wall pixels: the tile extended toward the wall center. */
  private canvasRect: { x: number; y: number; w: number; h: number };
  /** Wall-center offset in *native* canvas pixels; scaled to the actual canvas in resize(). */
  private basePadding: Required<PaddingOptions>;
  /** Padding in canvas pixels, recomputed on resize. */
  padding: PaddingOptions;
  /** When this view last reported a camera to the Manager (performance.now()). */
  private lastSentAt = -Infinity;
  /**
   * Canvas pixels per native wall pixel (1 on a fullscreen node, ~0.16 in a
   * simulator tile). Zoom is a pixel scale in MapLibre, so a canvas drawn at
   * scale k must use zoom + log2(k) to show the same extent as the wall.
   */
  private k = 1;
  private disposed = false;

  constructor(
    container: HTMLElement,
    private screen: ScreenConfig,
    private layout: WallLayout,
    private viewOpts: FlatViewOptions,
    private opts: WallMapOptions,
    private def: WallMapDefinition,
    private autoCamera: (state: FrameState) => MapCamera,
    private setStatus: (s: string) => void,
  ) {
    this.div = document.createElement("div");
    this.div.style.cssText = "position:absolute;left:0;top:0;background:#0b0e14;";
    container.style.position = container.style.position || "relative";
    container.style.overflow = "hidden"; // clip the canvas to the tile
    container.append(this.div);

    // ---- Sub-rectangle of the wall ------------------------------------------------
    // The canvas covers the tile plus whatever it takes to reach the wall
    // center, so the center point is never clamped (see file header).
    const rect = layout.rects[screen.id];
    const wcx = layout.widthPx / 2;
    const wcy = layout.heightPx / 2;
    const x0 = Math.min(rect.x, wcx);
    const x1 = Math.max(rect.x + rect.w, wcx);
    const y0 = Math.min(rect.y, wcy);
    const y1 = Math.max(rect.y + rect.h, wcy);
    this.canvasRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    // centerPoint = ((W + left - right) / 2, (H + top - bottom) / 2) must land on the wall center.
    const dx = 2 * (wcx - x0) - this.canvasRect.w;
    const dy = 2 * (wcy - y0) - this.canvasRect.h;
    this.basePadding = { left: Math.max(0, dx), right: Math.max(0, -dx), top: Math.max(0, dy), bottom: Math.max(0, -dy) };
    this.padding = { ...this.basePadding };

    this.map = new MapLibreMap({
      container: this.div,
      style: opts.style,
      center: opts.center,
      zoom: opts.zoom,
      pitch: opts.pitch,
      bearing: opts.bearing,
      maxPitch: 85,
      interactive: viewOpts.interactive,
      keyboard: false, // WebCAVE owns the keyboard
      attributionControl: false, // no attribution button/popup on the tiles
      pixelRatio: 1,
      renderWorldCopies: def.renderWorldCopies ?? true,
      canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
    });

    // Field of view so the camera distance equals the wall's (see file header).
    const fovWall = this.map.getVerticalFieldOfView(); // degrees, default 36.87
    const fovCanvas = (2 * Math.atan((this.canvasRect.h / layout.heightPx) * Math.tan((fovWall * Math.PI) / 360)) * 180) / Math.PI;
    this.map.setVerticalFieldOfView(fovCanvas);
    this.map.setPadding(this.padding);

    setStatus(`loading ${opts.style}`);
    this.map.once("load", () => {
      try {
        def.setup?.(this.map, opts);
      } catch (e) {
        setStatus(`${def.name} setup failed: ${(e as Error).message}`);
        return;
      }
      const extra = Math.round((100 * (this.canvasRect.w * this.canvasRect.h)) / (rect.w * rect.h));
      const where = layout.coplanar
        ? `tile ${rect.x},${rect.y} ${rect.w}×${rect.h} of ${layout.widthPx}×${layout.heightPx}, canvas ${extra}%`
        : "non-coplanar screens, centered view";
      setStatus(`ready · ${where}`);
    });
    this.map.on("error", (e: ErrorEvent) => setStatus(`map error: ${e.error?.message ?? "unknown"}`));

    // ---- Interaction: report camera changes to the Manager -----------------------
    // Only *user* moves are reported. MapLibre also fires "move" for
    // programmatic changes (our jumpTo, resize, the initial load); reporting
    // those would let a newly connected controller reset the whole wall to its
    // default camera. User moves carry `originalEvent`; drag inertia after
    // the mouse is released does not, so a short tail after a gesture also counts.
    if (viewOpts.interactive && viewOpts.send) {
      let gesture = false;
      let lastGestureAt = -Infinity;
      for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"] as const) {
        this.map.on(ev, () => {
          gesture = true;
          lastGestureAt = performance.now();
        });
      }
      for (const ev of ["dragend", "zoomend", "rotateend", "pitchend"] as const) {
        this.map.on(ev, () => {
          gesture = false;
          lastGestureAt = performance.now();
        });
      }
      this.map.on("move", (e: { originalEvent?: Event }) => {
        if (this.applying) return;
        const inertia = performance.now() - lastGestureAt < 1500 && this.map.isMoving();
        if (!e.originalEvent && !gesture && !inertia) return;
        const c = this.map.getCenter();
        // Report the wall-equivalent zoom, not this canvas's.
        const cam: MapCamera = { center: [c.lng, c.lat], zoom: this.map.getZoom() - Math.log2(this.k), bearing: this.map.getBearing(), pitch: this.map.getPitch() };
        this.lastSentAt = performance.now();
        viewOpts.send!({ map: cam });
      });
    }
  }

  get canvas(): HTMLCanvasElement | null {
    return this.disposed ? null : this.map.getCanvas();
  }

  render(state: FrameState) {
    if (this.disposed) return;
    const shared = state.appState?.map as MapCamera | undefined;
    const cam = shared && Array.isArray(shared.center) ? shared : this.autoCamera(state);
    // While this view is being dragged it is the source of truth: the shared
    // camera coming back is a frame or two old and applying it would fight
    // the drag. "Being dragged" = we reported a camera very recently.
    if (this.viewOpts.interactive && performance.now() - this.lastSentAt < 250) return;
    if (sameCamera(this.applied, cam)) return;
    this.applying = true;
    this.map.jumpTo({ center: cam.center, zoom: cam.zoom + Math.log2(this.k), bearing: cam.bearing, pitch: cam.pitch, padding: this.padding });
    this.applying = false;
    this.applied = { ...cam, center: [cam.center[0], cam.center[1]] };
  }

  /**
   * The container shows the tile at `width` x `height` CSS pixels. The map
   * canvas is the (possibly larger) canvasRect at the same scale, positioned
   * so the tile's part is what the clipped container reveals.
   */
  resize(width: number, height: number) {
    const rect = this.layout.rects[this.screen.id];
    const k = width / rect.w; // canvas pixels per native wall pixel
    this.k = k;
    const c = this.canvasRect;
    this.div.style.left = `${(c.x - rect.x) * k}px`;
    this.div.style.top = `${(c.y - rect.y) * k}px`;
    this.div.style.width = `${c.w * k}px`;
    this.div.style.height = `${c.h * k}px`;
    this.map.resize();
    const b = this.basePadding;
    this.padding = { left: b.left * k, right: b.right * k, top: b.top * k, bottom: b.bottom * k };
    this.map.setPadding(this.padding);
    this.applied = null; // re-apply the camera with the new padding
  }

  dispose() {
    this.disposed = true;
    this.map.remove();
    this.div.remove();
  }
}

