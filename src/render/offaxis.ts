/**
 * three.js side of the off-axis projection (see core/projection.ts for the
 * math). Two helpers shared by the per-screen renderer and the overview:
 *
 *   applyOffAxis()  pose a camera at the eye, aligned with the screen, and
 *                   write its asymmetric projection matrix directly
 *   eyePositions()  left / right / center eye from a head pose and IPD
 *
 * Conventions: positions and screen corners are in the physical CAVE frame.
 * The camera is expected to be a child of a "rig" object that carries the
 * navigation transform, so the same eye + screen give a view into whatever
 * part of the virtual world the CAVE has been flown to.
 */
import * as THREE from "three";
import type { ScreenConfig, Vec3 } from "../core/config";
import { offAxisFrustum } from "../core/projection";
import type { HeadPose } from "../core/protocol";

const basis = new THREE.Matrix4();
const vr = new THREE.Vector3();
const vu = new THREE.Vector3();
const vn = new THREE.Vector3();

/**
 * Configure `camera` as an off-axis view from `eye` through `screen`.
 *
 * Position and orientation are set in the camera's parent frame. The camera's
 * local axes are aligned with the screen basis (x = screen right, y = screen
 * up, z = screen normal toward the viewer), which is exactly what a camera
 * looking down -z at the screen needs. The projection matrix is written
 * directly with makePerspective(l, r, t, b, n, f), so callers must not call
 * camera.updateProjectionMatrix() afterwards (it would overwrite it with a
 * symmetric one).
 */
export function applyOffAxis(camera: THREE.PerspectiveCamera, screen: ScreenConfig, eye: Vec3, near: number, far: number) {
  const f = offAxisFrustum(screen, eye, near, far);
  basis.makeBasis(vr.set(...f.vr), vu.set(...f.vu), vn.set(...f.vn));
  camera.position.set(...eye);
  camera.quaternion.setFromRotationMatrix(basis);
  camera.projectionMatrix.makePerspective(f.left, f.right, f.top, f.bottom, f.near, f.far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

const q = new THREE.Quaternion();
const offset = new THREE.Vector3();
const p = new THREE.Vector3();

/**
 * Left, right and center eye positions for a head pose and interpupillary
 * distance (meters). The eyes sit ±IPD/2 along the head's local x axis, so
 * turning or rolling the head rotates the eye pair; that is why head
 * orientation matters for stereo even though it does not change a screen's
 * frustum.
 */
export function eyePositions(head: HeadPose, eyeSeparation: number): { left: Vec3; right: Vec3; center: Vec3 } {
  q.set(...head.orientation);
  offset.set(eyeSeparation / 2, 0, 0).applyQuaternion(q);
  p.set(...head.position);
  return {
    left: [p.x - offset.x, p.y - offset.y, p.z - offset.z],
    right: [p.x + offset.x, p.y + offset.y, p.z + offset.z],
    center: [p.x, p.y, p.z],
  };
}
