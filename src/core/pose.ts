/**
 * Pose math without three.js, for the Manager (which runs in Node.js and in
 * the simulator page) and anything else that must stay light.
 *
 * The one job here today: derive a wand pose from the head when no tracker
 * reports one. A hand hangs in front of and below the head and turns with the
 * body, not with the gaze: the offset is applied in the head's *yaw* frame
 * only, so nodding or looking down leaves the hand where it is.
 */
import type { Quat, Vec3 } from "./config";
import type { Pose } from "./protocol";

/** Heading about +y of a quaternion (Y-X-Z Euler decomposition), radians; stable when looking straight up or down. */
export function yawOf(q: Quat): number {
  const [x, y, z, w] = q;
  const m13 = 2 * (x * z + w * y);
  const m23 = 2 * (y * z - w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  if (Math.abs(m23) < 0.9999999) return Math.atan2(m13, m33);
  // Gimbal case (pitch ±90°): take the heading from the remaining rotation.
  const m11 = 1 - 2 * (y * y + z * z);
  const m31 = 2 * (x * z - w * y);
  return Math.atan2(-m31, m11);
}

/**
 * The wand as a hand attached to the head: `offset` (position in meters,
 * orientation) is expressed in a frame at the head position turned by the
 * head's yaw. With the default offset the hand sits half a meter ahead and a
 * little below eye level, pointing where the body faces.
 */
export function wandFromHead(head: Pose, offset: Pose): Pose {
  const yaw = yawOf(head.orientation);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const [ox, oy, oz] = offset.position;
  const position: Vec3 = [head.position[0] + ox * c + oz * s, head.position[1] + oy, head.position[2] - ox * s + oz * c];
  // Ry(yaw) * offset.orientation
  const hy = Math.sin(yaw / 2);
  const hw = Math.cos(yaw / 2);
  const [qx, qy, qz, qw] = offset.orientation;
  const orientation: Quat = [hw * qx + hy * qz, hw * qy + hy * qw, hw * qz - hy * qx, hw * qw - hy * qy];
  return { position, orientation };
}
