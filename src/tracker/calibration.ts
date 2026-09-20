/**
 * Tracker frame -> CAVE frame, without three.js (this runs in Node).
 *
 * position:  p_cave = Ry(yaw) * P * (s * p_tracker) + offset
 * rotation:  R_cave = Ry(yaw) * P * R_tracker * P^T
 * where s is the unit scale, P the signed axis permutation from the config
 * (a proper or improper rotation; the P R P^T conjugation handles both) and
 * yaw a rotation about the CAVE's up axis. The optional per-body local offset
 * (sensor -> eye center) is added in the body's calibrated frame:
 * p += R_cave * localOffset.
 */
import type { Calibration } from "./config";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
/** Row-major 3x3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

const UNIT: Record<Calibration["units"], number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export function mat3Transpose(a: Mat3): Mat3 {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

export function mat3Apply(a: Mat3, v: Vec3): Vec3 {
  return [a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[3] * v[0] + a[4] * v[1] + a[5] * v[2], a[6] * v[0] + a[7] * v[1] + a[8] * v[2]];
}

export function quatToMat3(q: Quat): Mat3 {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Shepperd's method; the matrix must be a rotation (a reflection would give garbage, so P R P^T is used, never P R). */
export function mat3ToQuat(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

/** Signed permutation matrix: row i picks the tracker axis that becomes CAVE axis i. */
function permutation(axes: Calibration["axes"]): Mat3 {
  const P = new Array(9).fill(0) as Mat3;
  axes.forEach((a, row) => {
    const sign = a.startsWith("-") ? -1 : 1;
    const col = "xyz".indexOf(a.replace("-", ""));
    P[row * 3 + col] = sign;
  });
  return P;
}

function rotY(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export class Calibrator {
  private readonly scale: number;
  private readonly P: Mat3;
  private readonly Pt: Mat3;
  private readonly Y: Mat3;
  private readonly YP: Mat3;
  private readonly offset: Vec3;

  constructor(cal: Calibration) {
    this.scale = UNIT[cal.units];
    this.P = permutation(cal.axes);
    this.Pt = mat3Transpose(this.P);
    this.Y = rotY((cal.yaw * Math.PI) / 180);
    this.YP = mat3Mul(this.Y, this.P);
    this.offset = cal.offset;
  }

  /** A tracker pose -> CAVE frame, meters; `localOffset` moves from the sensor to the point of interest in the body's frame. */
  pose(position: Vec3, rotation: Quat, localOffset: Vec3 = [0, 0, 0]): { position: Vec3; orientation: Quat } {
    const R = mat3Mul(this.YP, mat3Mul(quatToMat3(rotation), this.Pt));
    const p = mat3Apply(this.YP, [position[0] * this.scale, position[1] * this.scale, position[2] * this.scale]);
    const lo = mat3Apply(R, localOffset);
    return {
      position: [p[0] + lo[0] + this.offset[0], p[1] + lo[1] + this.offset[1], p[2] + lo[2] + this.offset[2]],
      orientation: mat3ToQuat(R),
    };
  }
}
