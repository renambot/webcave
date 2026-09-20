/**
 * Pixel layout of a display wall, for "flat" (2D) applications.
 *
 * A 3D app sees each screen as a window into the world and needs no notion
 * of a wall. A 2D app (a map, a document) instead wants the whole set of
 * coplanar screens to behave like one large image, with each node showing
 * its own rectangle of it. This module derives that image from the physical
 * screen geometry in the cluster config:
 *
 *   - the first screen defines the wall plane and pixel density
 *   - every screen's corners are projected onto that plane and converted to
 *     pixels, giving a rectangle (x, y, w, h) in a common wall image whose
 *     origin is the top-left of the bounding box of all screens
 *
 * Bezels fall out naturally: a gap between screens in meters becomes a gap in
 * pixels, so content is hidden behind the bezel rather than duplicated.
 *
 * If the screens are not coplanar (a CAVE), `coplanar` is false and each
 * screen gets a rectangle of its own at the origin; a flat app then shows the
 * same centered view on every screen, which is the only sensible fallback.
 */
import type { ClusterConfig, ScreenConfig } from "./config";
import { screenBasis, screenSize } from "./projection";

export interface ScreenRect {
  /** Top-left corner in wall pixels, y down. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WallLayout {
  /** Size of the whole wall image in pixels. */
  widthPx: number;
  heightPx: number;
  /** One rectangle per screen id. */
  rects: Record<string, ScreenRect>;
  /** Pixel density used for the conversion, from the first screen. */
  pixelsPerMeter: number;
  /** False when the screens do not share a plane; rects are then per-screen fallbacks. */
  coplanar: boolean;
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export function wallLayout(cfg: ClusterConfig): WallLayout {
  const ref = cfg.screens[0];
  const { vr, vu, vn } = screenBasis(ref);
  const refSize = screenSize(ref);
  const pixelsPerMeter = ref.widthPx / refSize.width;

  // Coplanar test: every screen's normal must match the reference normal.
  const coplanar = cfg.screens.every((s) => dot(screenBasis(s).vn, vn) > 0.9999);

  if (!coplanar) {
    const rects: Record<string, ScreenRect> = {};
    for (const s of cfg.screens) rects[s.id] = { x: 0, y: 0, w: s.widthPx, h: s.heightPx };
    return { widthPx: ref.widthPx, heightPx: ref.heightPx, rects, pixelsPerMeter, coplanar: false };
  }

  // Project each screen's lower-left corner onto the wall plane axes (u right, v up).
  const placed = cfg.screens.map((s: ScreenConfig) => {
    const d = sub(s.pa, ref.pa);
    const size = screenSize(s);
    return { id: s.id, u: dot(d, vr), v: dot(d, vu), w: size.width, h: size.height };
  });
  const umin = Math.min(...placed.map((p) => p.u));
  const umax = Math.max(...placed.map((p) => p.u + p.w));
  const vmin = Math.min(...placed.map((p) => p.v));
  const vmax = Math.max(...placed.map((p) => p.v + p.h));

  const rects: Record<string, ScreenRect> = {};
  for (const p of placed) {
    rects[p.id] = {
      x: Math.round((p.u - umin) * pixelsPerMeter),
      y: Math.round((vmax - (p.v + p.h)) * pixelsPerMeter), // flip: wall image y grows downward
      w: Math.round(p.w * pixelsPerMeter),
      h: Math.round(p.h * pixelsPerMeter),
    };
  }
  return {
    widthPx: Math.round((umax - umin) * pixelsPerMeter),
    heightPx: Math.round((vmax - vmin) * pixelsPerMeter),
    rects,
    pixelsPerMeter,
    coplanar: true,
  };
}
