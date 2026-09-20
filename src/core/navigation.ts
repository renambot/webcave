/**
 * Navigation math shared by renderers and applications.
 *
 * The navigation transform places the physical CAVE in the virtual world:
 *   world = Ry(yaw) * Rx(pitch) * cave + position
 * (the rig in render/viewport.ts applies exactly this, with rotation order
 * "YXZ" and no roll). Tracked poses (head, wand) arrive in the CAVE frame,
 * meters; an application that reacts to where the user or the wand *is in
 * the world* (grabbing an object, a creature approaching the hand) converts
 * them with caveToWorld(). The inverse is for placing things relative to
 * the physical room.
 */
import * as THREE from "three";
import type { Quat, Vec3 } from "./config";
import type { Navigation, Pose } from "./protocol";

const euler = new THREE.Euler();
const q = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const v = new THREE.Vector3();

/** Rotation part of the navigation transform as a quaternion. */
export function navigationQuaternion(nav: Navigation, out = new THREE.Quaternion()): THREE.Quaternion {
  euler.set(nav.pitch, nav.yaw, 0, "YXZ");
  return out.setFromEuler(euler);
}

/** Full navigation transform as a matrix (CAVE frame -> world). */
export function navigationMatrix(nav: Navigation, out = new THREE.Matrix4()): THREE.Matrix4 {
  navigationQuaternion(nav, q);
  return out.compose(v.set(...nav.position), q, new THREE.Vector3(1, 1, 1));
}

/** A point in the CAVE frame (meters) -> world coordinates. */
export function caveToWorld(nav: Navigation, p: Vec3): Vec3 {
  navigationQuaternion(nav, q);
  v.set(...p).applyQuaternion(q);
  return [v.x + nav.position[0], v.y + nav.position[1], v.z + nav.position[2]];
}

/** A world point -> CAVE frame (meters). */
export function worldToCave(nav: Navigation, p: Vec3): Vec3 {
  navigationQuaternion(nav, q).invert();
  v.set(p[0] - nav.position[0], p[1] - nav.position[1], p[2] - nav.position[2]).applyQuaternion(q);
  return [v.x, v.y, v.z];
}

/** An orientation in the CAVE frame -> world orientation. */
export function caveToWorldQuat(nav: Navigation, o: Quat): Quat {
  navigationQuaternion(nav, q);
  q2.set(...o).premultiply(q);
  return [q2.x, q2.y, q2.z, q2.w];
}

/** A whole pose (head, wand) in the CAVE frame -> world. */
export function poseToWorld(nav: Navigation, pose: Pose): Pose {
  return { position: caveToWorld(nav, pose.position), orientation: caveToWorldQuat(nav, pose.orientation) };
}

/** Direction a pose points along (its local -Z), in the frame the pose is given in. */
export function poseForward(pose: Pose): Vec3 {
  q.set(...pose.orientation);
  v.set(0, 0, -1).applyQuaternion(q);
  return [v.x, v.y, v.z];
}
