/**
 * "shapes": the smallest complete application, and the template to copy.
 *
 * It builds a static scene once (lights, ground, a few primitives) and then
 * moves things purely as a function of the cluster time. Read it top to
 * bottom as a tutorial:
 *
 *   1. build the scene in create()            - runs once per browser window
 *   2. keep handles to what will move          - the `shapes` and `orbiters` arrays
 *   3. write update(time) from `time` only     - no deltas, no Date.now()
 *   4. export a default AppDefinition          - so the registry finds the folder
 *   5. (input) onInput toggles a shared clock on button A; update() turns the
 *      whole arrangement by that clock, so every node agrees
 *
 * Placement guide (meters, CAVE frame, floor at y = 0, viewer at the origin
 * looking toward -z; the 3 m CAVE walls are at x = ±1.5 and z = -1.5):
 *   - things at |x|,|z| < 1.5 are *inside* the CAVE, floating around the viewer
 *   - things beyond the walls are seen "through the windows"
 *   - distant, static objects (pillars) give the eye a parallax reference so
 *     head movement reads as depth
 */
import * as THREE from "three";
import { clockTime, toggleClockPatch, type AppDefinition, type CaveApp } from "../types";
import type { FrameState } from "../../core/protocol";
import type { ActionState } from "../../input/actions";

/** appState key of this app's rotation clock; off until button A (primary) turns it on. */
const ROTATE_KEY = "shapesRotate";
const ROTATE_RATE = 0.25; // rad/s

export function createShapesApp(): CaveApp {
  // ---- 1. Scene, background and fog -----------------------------------------
  // Fog hides the far edge of the ground plane; keep it far enough not to
  // swallow the reference pillars at 10 to 16 m.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  scene.fog = new THREE.Fog(0x0b1020, 18, 70);

  // ---- Lights ---------------------------------------------------------------
  // There is no environment map yet, so use several direct lights and enough
  // ambient that nothing falls to pure black. Positions are in the CAVE frame.
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  scene.add(new THREE.HemisphereLight(0x8899ff, 0x334422, 1.2)); // sky / ground tint
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(4, 8, 3);
  scene.add(sun);
  const back = new THREE.DirectionalLight(0x99bbff, 0.8); // cool rim light from behind
  back.position.set(-6, 5, -8);
  scene.add(back);
  const fill = new THREE.PointLight(0xff8844, 40, 25); // warm fill on the left
  fill.position.set(-3, 2.5, 2);
  scene.add(fill);

  // ---- Ground ---------------------------------------------------------------
  // The physical floor is y = 0, so the virtual ground goes there too: with a
  // floor screen, the grid appears to be *on* the floor you stand on.
  const grid = new THREE.GridHelper(40, 40, 0x335577, 0x1c2a44);
  grid.position.y = 0.001; // a hair above the plane to avoid z-fighting
  scene.add(grid);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x1a2742, roughness: 0.9, metalness: 0.0 }),
  );
  ground.rotation.x = -Math.PI / 2; // PlaneGeometry faces +z; lay it flat
  scene.add(ground);

  // ---- Reference pillars ----------------------------------------------------
  // A ring of tall boxes at 10, 13 and 16 m. Static, far away: they make the
  // off-axis projection legible when the head moves.
  const pillarGeo = new THREE.BoxGeometry(0.4, 4, 0.4);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x6b7fa8, roughness: 0.6 });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const r = 10 + (i % 3) * 3;
    const p = new THREE.Mesh(pillarGeo, pillarMat);
    p.position.set(Math.cos(a) * r, 2, Math.sin(a) * r);
    scene.add(p);
  }

  // ---- 2. Hero shapes -------------------------------------------------------
  // Everything that moves hangs off `carousel`, a group at the origin that
  // turns about the vertical axis when auto-rotate is on (button A). Ground
  // and pillars stay fixed so the room does not seem to spin.
  const carousel = new THREE.Group();
  scene.add(carousel);
  // Each entry remembers its rest position and its spin rates so update() can
  // compute an absolute pose from `time` (rather than accumulating deltas).
  const shapes: { mesh: THREE.Mesh; base: THREE.Vector3; spin: THREE.Vector3; bob: number }[] = [];
  const add = (geo: THREE.BufferGeometry, color: number, pos: [number, number, number], spin: [number, number, number], bob = 0.2) => {
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.3 }));
    mesh.position.set(...pos);
    carousel.add(mesh);
    shapes.push({ mesh, base: mesh.position.clone(), spin: new THREE.Vector3(...spin), bob });
  };

  // Beyond the front wall (z < -1.5): seen through the front "window".
  add(new THREE.BoxGeometry(0.6, 0.6, 0.6), 0xff6b6b, [0, 1.6, -4], [0.4, 0.7, 0.1]);
  add(new THREE.SphereGeometry(0.4, 48, 32), 0x4ecdc4, [-2.2, 1.4, -3], [0, 0.3, 0], 0.3);
  add(new THREE.TorusKnotGeometry(0.35, 0.12, 160, 24), 0xffe66d, [2.2, 1.8, -3], [0.5, 0.9, 0.2]);
  // Beyond the side walls.
  add(new THREE.ConeGeometry(0.4, 0.9, 32), 0xa78bfa, [-3.5, 1.2, 1], [0.2, 0.6, 0], 0.15);
  add(new THREE.IcosahedronGeometry(0.45, 0), 0x60a5fa, [3.5, 1.5, 1], [0.6, 0.4, 0.3]);
  // Behind the viewer (no back wall in the preset, visible when navigating).
  add(new THREE.TorusGeometry(0.45, 0.15, 24, 64), 0xfb923c, [0, 2.4, 4.5], [0.3, 0.5, 0.7]);
  add(new THREE.CylinderGeometry(0.25, 0.25, 0.8, 32), 0x34d399, [-1.2, 0.9, 2.5], [0, 0.8, 0], 0.1);
  add(new THREE.OctahedronGeometry(0.35), 0xf472b6, [1.3, 1.1, 2.5], [0.7, 0.2, 0.5]);

  // ---- Orbiters inside the CAVE ---------------------------------------------
  // Twelve small spheres circling at 1.1 m radius around the viewer, inside
  // the walls: they demonstrate objects that appear to float in the room.
  const orbiters: THREE.Mesh[] = [];
  const smallGeo = new THREE.SphereGeometry(0.07, 24, 16);
  for (let i = 0; i < 12; i++) {
    const hue = i / 12;
    const m = new THREE.Mesh(
      smallGeo,
      new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.7, 0.6), emissive: new THREE.Color().setHSL(hue, 0.7, 0.2) }),
    );
    carousel.add(m);
    orbiters.push(m);
  }

  // ---- 3. update(time) --------------------------------------------------------
  // Every pose is an explicit function of `time`. Two nodes given the same
  // `time` produce identical scenes, which is what keeps the walls in step.
  function update(time: number, state?: FrameState) {
    // Auto-rotate: angle from the shared clock, so a toggle on the controller
    // turns every screen's arrangement identically and without a jump.
    carousel.rotation.y = clockTime(state, time, ROTATE_KEY, false) * ROTATE_RATE;
    for (const s of shapes) {
      s.mesh.rotation.set(time * s.spin.x, time * s.spin.y, time * s.spin.z);
      s.mesh.position.y = s.base.y + Math.sin(time * 1.3 + s.base.x) * s.bob; // gentle bob, phase from x
    }
    orbiters.forEach((m, i) => {
      const a = time * 0.6 + (i / orbiters.length) * Math.PI * 2;
      m.position.set(Math.cos(a) * 1.1, 1.5 + Math.sin(a * 2) * 0.3, Math.sin(a) * 1.1);
    });
  }

  update(0); // pose the scene for frame 0 so the first render is not empty

  // ---- 5. Input --------------------------------------------------------------
  // Runs on the controller. Button A (primary) toggles the rotation clock in
  // the shared state; the edge is detected against the previous frame.
  let prevPrimary = false;
  const onInput = (actions: ActionState, _dt: number, state: FrameState, send: (patch: Record<string, unknown>) => void) => {
    if (actions.buttons.primary && !prevPrimary) send(toggleClockPatch(state, ROTATE_KEY, false));
    prevPrimary = actions.buttons.primary;
  };

  // Nothing to load, so `ready` is already resolved and status is "ready".
  return { name: "shapes", scene, ready: Promise.resolve(), status: "ready · A / primary toggles auto-rotate", update, onInput };
}

// ---- 4. Registration ---------------------------------------------------------
// The registry (src/apps/index.ts) imports every ./*/index.ts and reads this.
export default {
  name: "shapes",
  description: "Basic animated shapes in and around the CAVE volume",
  create: () => createShapesApp(),
} satisfies AppDefinition;
