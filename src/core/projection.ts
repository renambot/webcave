/**
 * Off-axis projection for a tracked viewer looking at a fixed screen.
 *
 * A CAVE wall is not a camera: it is a window. The picture on it must be what
 * the viewer would see through that window from where their eyes actually
 * are. That means an asymmetric ("off-axis") frustum whose apex is the eye
 * and whose near-plane rectangle is the screen. Move the eye and the frustum
 * changes; move it far to the left and the frustum leans strongly to the
 * right. Nothing rotates: the screen basis stays fixed.
 *
 * This is Robert Kooima's "Generalized Perspective Projection" (2008),
 * the standard formulation for CAVEs:
 *
 *   inputs   pa, pb, pc  screen corners: lower-left, lower-right, upper-left
 *            pe          eye position
 *   basis    vr = normalize(pb - pa)          screen right
 *            vu = normalize(pc - pa)          screen up
 *            vn = normalize(vr x vu)          screen normal, toward the viewer
 *   vectors  va = pa - pe, vb = pb - pe, vc = pc - pe   eye to corners
 *   depth    d  = -(va . vn)                  distance eye -> screen plane
 *   frustum  l = (vr . va) n/d,  r = (vr . vb) n/d,  b = (vu . va) n/d,  t = (vu . vc) n/d
 *
 * The camera is then placed at pe with orientation [vr vu vn] and given the
 * frustum (l, r, b, t, n, f). See render/offaxis.ts for the three.js side.
 * This file is pure math with no renderer dependency, so it can be unit
 * tested and reused by the overview and by tooling.
 */
import type { ScreenConfig, Vec3 } from "./config";

export interface OffAxisFrustum {
  /** Frustum extents on the near plane, as for glFrustum. */
  left: number;
  right: number;
  bottom: number;
  top: number;
  near: number;
  far: number;
  /** Screen basis vectors (right, up, normal toward the viewer). */
  vr: Vec3;
  vu: Vec3;
  vn: Vec3;
  /** Signed distance from eye to screen plane (positive when in front). */
  distance: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Orthonormal basis of a screen: right along the bottom edge, up along the
 * left edge, normal pointing toward the viewer's side. Independent of the eye.
 */
export function screenBasis(screen: ScreenConfig): { vr: Vec3; vu: Vec3; vn: Vec3 } {
  const vr = normalize(sub(screen.pb, screen.pa));
  const vu = normalize(sub(screen.pc, screen.pa));
  const vn = normalize(cross(vr, vu));
  return { vr, vu, vn };
}

/**
 * The asymmetric frustum from `eye` through `screen`.
 *
 * `near` and `far` are clip distances along the screen normal, as usual. The
 * extents are scaled from the screen plane (at distance d) back to the near
 * plane by n/d, which is why the same screen gives a wider frustum as the eye
 * approaches it.
 */
export function offAxisFrustum(screen: ScreenConfig, eye: Vec3, near: number, far: number): OffAxisFrustum {
  const { vr, vu, vn } = screenBasis(screen);
  const va = sub(screen.pa, eye);
  const vb = sub(screen.pb, eye);
  const vc = sub(screen.pc, eye);
  const d = -dot(va, vn);
  // Guard: an eye on or behind the screen plane would give a degenerate or
  // inverted frustum. Clamp so the math stays finite; the image is meaningless
  // there anyway (the viewer has walked through the wall).
  const dist = Math.max(d, 1e-4);
  const s = near / dist;
  return {
    left: dot(vr, va) * s,
    right: dot(vr, vb) * s,
    bottom: dot(vu, va) * s,
    top: dot(vu, vc) * s,
    near,
    far,
    vr,
    vu,
    vn,
    distance: d,
  };
}

/** Physical width and height of the screen in meters. */
export function screenSize(screen: ScreenConfig): { width: number; height: number } {
  const w = sub(screen.pb, screen.pa);
  const h = sub(screen.pc, screen.pa);
  return { width: Math.hypot(...w), height: Math.hypot(...h) };
}

/** Center of the screen rectangle. */
export function screenCenter(screen: ScreenConfig): Vec3 {
  const w = sub(screen.pb, screen.pa);
  const h = sub(screen.pc, screen.pa);
  return [
    screen.pa[0] + (w[0] + h[0]) / 2,
    screen.pa[1] + (w[1] + h[1]) / 2,
    screen.pa[2] + (w[2] + h[2]) / 2,
  ];
}

/** Upper-right corner, derived from the other three (pa + (pb - pa) + (pc - pa)). */
export function screenPd(screen: ScreenConfig): Vec3 {
  const w = sub(screen.pb, screen.pa);
  return [screen.pc[0] + w[0], screen.pc[1] + w[1], screen.pc[2] + w[2]];
}
