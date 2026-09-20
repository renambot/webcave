/**
 * "crayoland": Dave Pape's Crayoland (EVL, 1995), the first CAVE demo, as a
 * WebCAVE application.
 *
 * A crayon-drawn meadow: trees, flowers, a lake, a house, a well, clouds and
 * a sun, all flat textured quads ("pictures") standing on the ground; bees
 * commuting between their hive and the flowers; butterflies wandering; a
 * cloud of flies over the lake. The user walks around with the wand, can
 * grab and throw flowers and rocks, wake the bees by poking the hive, and
 * have a butterfly land on the hand. A soundscape of birds, frogs, crickets,
 * a stream and the hive's hum follows the user.
 *
 * Port notes (what changed from the C++ and why):
 *   - The World and Sounds files load unchanged from public/crayoland/.
 *     Units stay in feet; the scene sits in a group scaled by 0.3048.
 *   - Static pictures sharing a texture are merged into one mesh; grabbable
 *     ones are instances of one quad per texture, so 313 flowers and rocks
 *     are five draw calls.
 *   - Creatures run as deterministic fixed-step simulations on every node
 *     (creatures.ts); what the user does to them is shared state layered on
 *     top, so all nodes agree and late joiners catch up.
 *   - Interaction runs on the controller (onInput): it sees the wand in the
 *     frame like everyone else, decides "grabbed", "thrown", "angry",
 *     "landing", and publishes compact state; nodes evaluate the result as a
 *     function of time (a thrown flower is a parabola from p0, v0, t0).
 *   - Navigation uses WebCAVE's standard bindings with this app's hints:
 *     walking speed, and planar so the CAVE floor stays on the grass.
 *   - Sound is Web Audio on the window that has AppContext.audio (sound.ts).
 *
 * Shared state keys (all prefixed "cray"):
 *   crayGrab        { id, local[16] }   object held by the wand, in wand coordinates
 *   crayObjects     { [id]: { p, q, v?, t? } }  moved objects: rest pose, or a throw from (p, v) at time t
 *   crayAngry       { since, until? }   bees swarming the user since `since`, back home after `until`
 *   crayButterflies { [i]: { mode: seek|rest, since, restAt?, until? } }
 */
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import type { AppContext, AppDefinition, AppSpec, CaveApp } from "../types";
import type { FrameState, Navigation, Pose } from "../../core/protocol";
import type { Vec3 } from "../../core/config";
import { caveToWorld, caveToWorldQuat } from "../../core/navigation";
import { hash } from "../../core/random";
import { inputOf, type ActionState } from "../../input/actions";
import { parseSounds, parseWorld, pictureAxes, type BeesDef, type PictureDef } from "./world";
import { BeeSim, ButterflySim, SIM_HZ, angleDelta } from "./creatures";
import { Soundscape } from "./sound";

/** Feet to meters: the World file is in feet, the CAVE frame in meters. */
const FT = 0.3048;
const GRAVITY = 32; // ft/s²
const MAX_THROW_SPEED = 10; // ft/s
const SKY = new THREE.Color(0.22, 0.47, 1.0);

// Shared state shapes.
interface Angry { since: number; until?: number }
interface FlyState { mode: "seek" | "rest"; since: number; restAt?: number; until?: number }
interface Grab { id: number; local: number[] }
interface ObjState { p: Vec3; q: [number, number, number, number]; v?: Vec3; t?: number }

const IDENTITY_NAV: Navigation = { position: [0, 0, 0], yaw: 0, pitch: 0 };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const distSq = (a: ArrayLike<number>, b: ArrayLike<number>) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** A tracked pose (CAVE frame, meters) as a world pose in feet. */
function worldPoseFt(nav: Navigation, pose: Pose): { p: Vec3; q: THREE.Quaternion } {
  const w = caveToWorld(nav, pose.position);
  const q = caveToWorldQuat(nav, pose.orientation);
  return { p: [w[0] / FT, w[1] / FT, w[2] / FT], q: new THREE.Quaternion(...q) };
}

/** Position (feet) of a moved object at `time`: at rest, or on its throw parabola until it lands. */
function objectPosition(o: ObjState, time: number, out: THREE.Vector3): THREE.Vector3 {
  if (!o.v || o.t === undefined) return out.set(...o.p);
  const [vx, vy, vz] = o.v;
  let tau = Math.max(0, time - o.t);
  // Landing time: p.y + vy tau - 16 tau² = 0. After that the object lies where it fell.
  const land = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * o.p[1])) / GRAVITY;
  if (tau > land) tau = land;
  return out.set(o.p[0] + vx * tau, Math.max(0, o.p[1] + vy * tau - 0.5 * GRAVITY * tau * tau), o.p[2] + vz * tau);
}

export function createCrayolandApp(spec: AppSpec, ctx: AppContext): CaveApp {
  const base = (spec.url ?? "/crayoland/").replace(/\/?$/, "/");
  const worldFile = String(spec.options?.world ?? "World");
  const soundsFile = String(spec.options?.sounds ?? "Sounds");

  const scene = new THREE.Scene();
  scene.background = SKY;
  /** Everything in feet lives here. */
  const root = new THREE.Group();
  root.scale.setScalar(FT);
  scene.add(root);

  // ---- Materials: one per texture, crayon drawings cut out by alpha test -------
  const loader = new THREE.TextureLoader();
  const materials = new Map<string, THREE.MeshBasicMaterial>();
  let textureDir = "";
  function material(file: string): THREE.MeshBasicMaterial {
    let m = materials.get(file);
    if (m) return m;
    const tex = loader.load(`${base}${textureDir}${file}`, undefined, undefined, () => {
      m!.map = null;
      m!.color.set(0xff00ff);
      m!.needsUpdate = true;
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // GL_ALPHA_TEST GEQUAL 0.25 in the original: hard cut-outs, no sorting problems.
    m = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.25, side: THREE.DoubleSide });
    materials.set(file, m);
    return m;
  }

  // ---- Grabbable objects: one instanced quad per texture ------------------------
  interface Obj {
    def: PictureDef;
    mesh: THREE.InstancedMesh;
    index: number;
    /** Placement from the World file (T · R · S). */
    base: THREE.Matrix4;
    /** Where it is drawn this frame, world feet. */
    world: THREE.Matrix4;
    /** Quad center offset in local units (half the height up) and pick radius (feet). */
    radius: number;
  }
  const objects: Obj[] = [];

  // ---- Creatures ---------------------------------------------------------------
  interface Swarm {
    def: BeesDef;
    sim: BeeSim;
    mesh: THREE.InstancedMesh;
    /** Drawn positions this frame (world feet), for the hum. */
    drawn: Float32Array;
    drawnCount: number;
  }
  const swarms: Swarm[] = [];
  interface Fly {
    sim: ButterflySim;
    mesh: THREE.Mesh;
    positions: THREE.BufferAttribute;
    /** Where it is drawn this frame, for the controller's distance checks. */
    displayed: Vec3;
  }
  const flies: Fly[] = [];
  const flyClouds: { points: THREE.Points; attr: THREE.BufferAttribute; center: Vec3; radius: number; num: number }[] = [];

  // ---- The hand at the wand --------------------------------------------------------
  const hand = new THREE.Group();
  root.add(hand);
  let handOpen: THREE.Object3D | null = null;
  let handClosed: THREE.Object3D | null = null;

  let sound: Soundscape | null = null;
  const mat4 = new THREE.Matrix4();
  const mat4b = new THREE.Matrix4();
  const v3 = new THREE.Vector3();
  const v3b = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  const app: CaveApp & { ready: Promise<void> } = {
    name: "crayoland",
    scene,
    ready: Promise.resolve(),
    status: "loading world",
    update,
    onInput,
    // 30 ft/s walking (the original's joystick did 40), 90°/s turning; stay on the ground.
    navigation: { flySpeed: 30 * FT, turnSpeed: Math.PI / 2, planar: true },
    dispose() {
      sound?.dispose();
      for (const m of materials.values()) {
        m.map?.dispose();
        m.dispose();
      }
    },
  };

  // ---- Build the world -------------------------------------------------------------
  async function build() {
    const text = await fetch(`${base}${worldFile}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${base}${worldFile}`))));
    const world = parseWorld(text);
    textureDir = world.textureDir ? `${world.textureDir}/` : "";

    // Static pictures: one merged geometry per texture.
    const byTexture = new Map<string, PictureDef[]>();
    for (const p of world.pictures) {
      if (p.kind !== "pict") continue;
      const list = byTexture.get(p.texture) ?? [];
      list.push(p);
      byTexture.set(p.texture, list);
    }
    for (const [tex, list] of byTexture) {
      const pos = new Float32Array(list.length * 12);
      const uv = new Float32Array(list.length * 8);
      const idx = new Uint32Array(list.length * 6);
      list.forEach((p, i) => {
        const { x, y } = pictureAxes(p.rot);
        const [xs, ys] = p.size;
        // v0 bottom-left, v1 bottom-right, v2 top-left, v3 top-right; pos is the bottom center.
        const v0 = [p.pos[0] - (x[0] * xs) / 2, p.pos[1] - (x[1] * xs) / 2, p.pos[2] - (x[2] * xs) / 2];
        const corners = [v0, [v0[0] + x[0] * xs, v0[1] + x[1] * xs, v0[2] + x[2] * xs], [v0[0] + y[0] * ys, v0[1] + y[1] * ys, v0[2] + y[2] * ys]];
        corners.push([corners[2][0] + x[0] * xs, corners[2][1] + x[1] * xs, corners[2][2] + x[2] * xs]);
        const [u0, t0, u1, t1] = p.texc;
        const uvs = [u0, t0, u1, t0, u0, t1, u1, t1];
        for (let k = 0; k < 4; k++) {
          pos.set(corners[k], i * 12 + k * 3);
          uv.set([uvs[k * 2], uvs[k * 2 + 1]], i * 8 + k * 2);
        }
        idx.set([0, 1, 2, 2, 1, 3].map((n) => n + i * 4), i * 6);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      root.add(new THREE.Mesh(geo, material(tex)));
    }

    // Grabbable pictures: one InstancedMesh per texture, unit quad standing on its bottom center.
    const objByTexture = new Map<string, PictureDef[]>();
    for (const p of world.pictures) {
      if (p.kind !== "pictobj") continue;
      const list = objByTexture.get(p.texture) ?? [];
      list.push(p);
      objByTexture.set(p.texture, list);
    }
    for (const [tex, list] of objByTexture) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
      geo.setIndex([0, 1, 2, 2, 1, 3]);
      const mesh = new THREE.InstancedMesh(geo, material(tex), list.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      root.add(mesh);
      list.forEach((def, index) => {
        const { x, y } = pictureAxes(def.rot);
        const X = new THREE.Vector3(...x), Y = new THREE.Vector3(...y);
        const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
        const basis = new THREE.Matrix4().makeBasis(X, Y, Z);
        const m = new THREE.Matrix4().makeTranslation(...def.pos).multiply(basis).scale(new THREE.Vector3(def.size[0], def.size[1], 1));
        mesh.setMatrixAt(index, m);
        objects.push({ def, mesh, index, base: m, world: m.clone(), radius: Math.hypot(def.size[0] / 2, def.size[1] / 2) });
      });
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Bees: a quad in the y-z plane facing along -z (the drawing's head is at u = 0).
    world.bees.forEach((def, s) => {
      const [xs, ys] = def.size;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([0, -ys / 2, -xs / 2, 0, ys / 2, -xs / 2, 0, -ys / 2, xs / 2, 0, ys / 2, xs / 2], 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 1, 1], 2));
      geo.setIndex([0, 1, 2, 2, 1, 3]);
      const mesh = new THREE.InstancedMesh(geo, material(def.texture), def.num);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      root.add(mesh);
      swarms.push({ def, sim: new BeeSim(def, 1000 + s), mesh, drawn: new Float32Array(def.num * 3), drawnCount: 0 });
    });

    // Butterflies: two flapping wings, six vertices rewritten every frame.
    world.butterflies.forEach((def, i) => {
      const geo = new THREE.BufferGeometry();
      const positions = new THREE.BufferAttribute(new Float32Array(18), 3);
      positions.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("position", positions);
      geo.setAttribute("uv", new THREE.Float32BufferAttribute([0.01, 0.01, 0.01, 0.99, 0.5, 0.01, 0.5, 0.99, 0.99, 0.01, 0.99, 0.99], 2));
      geo.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5]);
      const mesh = new THREE.Mesh(geo, material(def.texture));
      mesh.frustumCulled = false;
      root.add(mesh);
      flies.push({ sim: new ButterflySim(def, 2000 + i), mesh, positions, displayed: [...def.pos] });
    });

    // Flies: a jittering cloud of black points.
    for (const def of world.flies) {
      const attr = new THREE.BufferAttribute(new Float32Array(def.num * 3), 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", attr);
      const points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x000000, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.5 }));
      points.frustumCulled = false;
      root.add(points);
      flyClouds.push({ points, attr, center: def.pos, radius: def.radius, num: def.num });
    }

    // The hand: Wavefront models from the original data, feet.
    const objLoader = new OBJLoader();
    const handMat = new THREE.MeshBasicMaterial({ color: 0xf2c9a0 });
    const loadHand = (file: string) =>
      objLoader.loadAsync(`${base}${file}`).then(
        (o) => (o.traverse((c) => (c as THREE.Mesh).isMesh && ((c as THREE.Mesh).material = handMat)), o),
        () => null,
      );
    [handOpen, handClosed] = await Promise.all([loadHand("hand-open.obj"), loadHand("hand-closed.obj")]);
    if (handOpen) hand.add(handOpen);
    if (handClosed) hand.add(handClosed), (handClosed.visible = false);

    // Sound, only where this window is the speaker.
    if (ctx.audio) {
      const st = await fetch(`${base}${soundsFile}`).then((r) => (r.ok ? r.text() : ""));
      const bees = world.bees[0];
      sound = new Soundscape(base, parseSounds(st), { loop: bees?.sound, hit: bees?.hitsound });
    }

    const nPict = world.pictures.filter((p) => p.kind === "pict").length;
    const bees = world.bees.reduce((a, b) => a + b.num, 0);
    app.status = `${nPict} pictures · ${objects.length} objects · ${bees} bees · ${flies.length} butterflies · Enter / A grabs`;
  }
  app.ready = build().catch((e: Error) => {
    app.status = `error: ${e.message}`;
    console.error(e);
  });

  // ---- Per frame -------------------------------------------------------------------
  let lastSoundTime = -1;
  let lastAngrySince = -1;

  function update(time: number, state?: FrameState) {
    const nav = state?.navigation ?? IDENTITY_NAV;
    const wand = state ? worldPoseFt(nav, state.wand) : { p: [0.8, 3.6, -1] as Vec3, q: new THREE.Quaternion() };
    const headM = state ? caveToWorld(nav, state.head.position) : [0, 1.6, 0];
    const head: Vec3 = [headM[0] / FT, headM[1] / FT, headM[2] / FT];
    const as = state?.appState ?? {};
    const angry = as.crayAngry as Angry | null | undefined;
    const flyStates = (as.crayButterflies ?? {}) as Record<string, FlyState>;
    const grab = as.crayGrab as Grab | null | undefined;
    const objStates = (as.crayObjects ?? {}) as Record<string, ObjState>;
    const buttons = inputOf(state).buttons;
    const frame = Math.floor(time * SIM_HZ);

    // Wand matrix in world feet; the hand sits on it, grabbed objects hang off it.
    const wandM = mat4.compose(v3.set(...wand.p), wand.q, v3b.set(1, 1, 1));
    hand.position.set(...wand.p);
    hand.quaternion.copy(wand.q);
    if (handOpen) handOpen.visible = !buttons.primary;
    if (handClosed) handClosed.visible = buttons.primary;

    // Objects: held by the wand, moved earlier (at rest or flying), or where the World put them.
    const dirty = new Set<THREE.InstancedMesh>();
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i];
      const st = objStates[i];
      if (grab && grab.id === i) {
        o.world.fromArray(grab.local).premultiply(wandM);
      } else if (st) {
        objectPosition(st, time, v3);
        o.world.compose(v3, quat.set(...st.q), v3b.set(o.def.size[0], o.def.size[1], 1));
      } else {
        o.world.copy(o.base);
      }
      o.mesh.setMatrixAt(o.index, o.world);
      dirty.add(o.mesh);
    }
    for (const m of dirty) m.instanceMatrix.needsUpdate = true;

    // Bees: the simulation, plus the swarm around the user when angry.
    let angryW = 0;
    if (angry) {
      const up = clamp01((time - angry.since) / 1);
      const down = angry.until !== undefined ? clamp01(1 - (time - angry.until) / 3) : 1;
      angryW = Math.min(up, down);
    }
    for (const sw of swarms) {
      const { sim } = sw;
      sim.advanceTo(time);
      sw.drawnCount = 0;
      for (let i = 0; i < sim.n; i++) {
        const visible = sim.visible(i) || angryW > 0.01;
        if (!visible) {
          sw.mesh.setMatrixAt(i, ZERO);
          continue;
        }
        let x = sim.x[i], y = sim.y[i], z = sim.z[i], ry = sim.ry[i];
        if (angryW > 0) {
          // Each bee keeps its own offset around the head and buzzes about it.
          const sx = head[0] + (hash(i, 1) * 2 - 1) + 0.4 * Math.sin(time * 7 + i);
          const sy = head[1] + (hash(i, 2) * 2 - 1) * 0.6 + 0.3 * Math.cos(time * 5.3 + i * 2);
          const sz = head[2] + (hash(i, 3) * 2 - 1) + 0.4 * Math.sin(time * 6.1 + i * 3);
          x += (sx - x) * angryW;
          y += (sy - y) * angryW;
          z += (sz - z) * angryW;
          if (angryW > 0.5) ry = (-Math.atan2(head[0] - x, -(head[2] - z)) * 180) / Math.PI + (hash(frame, i) * 30 - 15);
        }
        mat4b.makeRotationY((ry * Math.PI) / 180).setPosition(x, y, z);
        sw.mesh.setMatrixAt(i, mat4b);
        sw.drawn.set([x, y, z], sw.drawnCount * 3);
        sw.drawnCount++;
      }
      sw.mesh.instanceMatrix.needsUpdate = true;
    }

    // Butterflies: the wander simulation, drawn toward the hand when seeking or resting on it.
    const target: Vec3 = [wand.p[0], wand.p[1] + 0.3, wand.p[2]];
    flies.forEach((f, i) => {
      f.sim.advanceTo(time);
      const st = flyStates[i];
      let w = 0, restW = 0;
      if (st) {
        const active = st.until === undefined || time < st.until;
        w = active ? clamp01((time - st.since) / 1.5) : clamp01(1 - (time - st.until!) / 2);
        if (st.mode === "rest" && st.restAt !== undefined) restW = active ? clamp01((time - st.restAt) / 0.5) : w;
      }
      const p = f.sim.pos;
      const x = p[0] + (target[0] - p[0]) * w, y = p[1] + (target[1] - p[1]) * w, z = p[2] + (target[2] - p[2]) * w;
      f.displayed = [x, y, z];
      let ry = f.sim.ry;
      if (w > 0) {
        const dir = (-Math.atan2(wand.p[0] - x, z - wand.p[2]) * 180) / Math.PI;
        ry += angleDelta(ry, dir) * w;
      }
      f.mesh.position.set(x, y, z);
      f.mesh.rotation.y = (ry * Math.PI) / 180;
      // Wing angle: 0 flat to π/2 folded up, from the flap phase; nearly folded and still when resting.
      const flap = (Math.PI / 4) * (Math.sin(f.sim.phase) + 1);
      const a = flap + (1.35 + 0.08 * Math.sin(time * 3) - flap) * restW;
      const pc = 0.75 * Math.cos(a), ps = 0.75 * Math.sin(a);
      f.positions.set([pc, -0.1 + ps, 0.5, pc, 0.1 + ps, -0.5, 0, -0.1, 0.5, 0, 0.1, -0.5, -pc, -0.1 + ps, 0.5, -pc, 0.1 + ps, -0.5]);
      f.positions.needsUpdate = true;
    });

    // Flies: fresh jitter every simulation frame, the same on every node.
    for (const c of flyClouds) {
      for (let i = 0; i < c.num; i++) {
        for (let k = 0; k < 3; k++) c.attr.array[i * 3 + k] = c.center[k] + (hash(frame, i, k) + hash(frame, i, k + 3) - 1) * c.radius;
      }
      c.attr.needsUpdate = true;
    }

    // Sound follows the head; once per distinct frame time.
    if (sound && time !== lastSoundTime) {
      lastSoundTime = time;
      if (angry && angry.since !== lastAngrySince) {
        lastAngrySince = angry.since;
        sound.hitHive();
      }
      const sw = swarms[0];
      sound.update(time, head, { positions: sw?.drawn ?? [], count: sw?.drawnCount ?? 0, angry: angryW > 0.5 });
      app.status = app.status.replace(/ · audio:.*$/, "") + ` · ${sound.status}`;
    }
  }

  // ---- Interaction, on the controller ------------------------------------------------
  let prevPrimary = false;
  let prevWand: Vec3 | null = null;
  const wandHistory: { t: number; p: Vec3 }[] = [];
  let angryCleared = false;

  function onInput(actions: ActionState, dt: number, state: FrameState, send: (patch: Record<string, unknown>) => void) {
    const t = state.time;
    const as = state.appState;
    const wand = worldPoseFt(state.navigation, state.wand);
    const headM = caveToWorld(state.navigation, state.head.position);
    const head: Vec3 = [headM[0] / FT, headM[1] / FT, headM[2] / FT];
    const wandM = mat4.compose(v3.set(...wand.p), wand.q, v3b.set(1, 1, 1));
    wandHistory.push({ t, p: wand.p });
    while (wandHistory.length && wandHistory[0].t < t - 0.3) wandHistory.shift();
    const wandMoving = prevWand ? distSq(prevWand, wand.p) > 0.1 * dt : false;
    prevWand = wand.p;

    // ---- Grab and throw (PictureObject::Update) ----
    const grab = as.crayGrab as Grab | null | undefined;
    const primary = actions.buttons.primary;
    if (primary && !prevPrimary && !grab) {
      // Nearest object whose picking sphere (center of the quad) contains the wand.
      let best = -1, bestD = Infinity;
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        v3.set(0, 0.5, 0).applyMatrix4(o.world); // quad center
        const d = v3.distanceToSquared(v3b.set(...wand.p));
        if (d < o.radius * o.radius && d < bestD) (best = i), (bestD = d);
      }
      if (best >= 0) {
        const local = mat4b.copy(wandM).invert().multiply(objects[best].world);
        send({ crayGrab: { id: best, local: local.toArray().map(r3) } });
      }
    } else if (!primary && grab) {
      // Release: rest pose from the wand, velocity from the last quarter second of hand motion (x5, as the original).
      const world = mat4b.fromArray(grab.local).premultiply(wandM);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      world.decompose(p, q, s);
      const old = wandHistory.find((h) => h.t <= t - 0.2) ?? wandHistory[0];
      let v: Vec3 = [0, 0, 0];
      if (old && t - old.t > 0.05) {
        const k = 5 / (t - old.t);
        v = [(wand.p[0] - old.p[0]) * k, (wand.p[1] - old.p[1]) * k, (wand.p[2] - old.p[2]) * k];
        const speed = Math.hypot(...v);
        if (speed > MAX_THROW_SPEED) v = v.map((c) => (c * MAX_THROW_SPEED) / speed) as Vec3;
      }
      const objs = { ...((as.crayObjects ?? {}) as Record<string, ObjState>) };
      objs[grab.id] = { p: [r3(p.x), r3(Math.max(0, p.y)), r3(p.z)], q: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)], v: v.map(r3) as Vec3, t: r3(t) };
      send({ crayGrab: null, crayObjects: objs });
    }
    prevPrimary = primary;

    // ---- Bees: poke the hive and they swarm you until you are 40 ft away ----
    const angry = as.crayAngry as Angry | null | undefined;
    const hive = swarms[0]?.def.hive;
    if (hive) {
      const active = angry && angry.until === undefined;
      if (!active && distSq(wand.p, hive) < 2 && (!angry || angry.until === undefined || t > angry.until + 3)) {
        send({ crayAngry: { since: r3(t) } });
        angryCleared = false;
      } else if (active && distSq(head, hive) > 1600) {
        send({ crayAngry: { since: angry!.since, until: r3(t) } });
      } else if (angry && angry.until !== undefined && t > angry.until + 3 && !angryCleared) {
        send({ crayAngry: null });
        angryCleared = true;
      }
    }

    // ---- Butterflies: a still hand nearby attracts one; it lands, rests, leaves ----
    const flyStates = (as.crayButterflies ?? {}) as Record<string, FlyState>;
    let next: Record<string, FlyState> | null = null;
    const patchFly = (i: number, st: FlyState | null) => {
      next ??= { ...flyStates };
      if (st) next[i] = st;
      else delete next[i];
    };
    flies.forEach((f, i) => {
      const st = flyStates[i];
      const near = distSq(f.displayed, wand.p) < 25;
      if (!st || (st.until !== undefined && t >= st.until)) {
        if (st && t > st.until! + 6) patchFly(i, null); // forget, after the ramp back and a pause
        else if (!st && near && !wandMoving) patchFly(i, { mode: "seek", since: r3(t) });
        return;
      }
      if (!near || wandMoving) {
        patchFly(i, { ...st, until: r3(t) });
      } else if (st.mode === "seek" && distSq(f.displayed, [wand.p[0], wand.p[1] + 0.3, wand.p[2]]) < 0.04) {
        patchFly(i, { mode: "rest", since: st.since, restAt: r3(t), until: r3(t + 1 + Math.random() * 4) });
      }
    });
    if (next) send({ crayButterflies: next });
  }

  // Internals for scripts/screenshot.mjs --eval and the console (window.webcave.app.debug).
  (app as CaveApp & { debug: unknown }).debug = { objects, swarms, flies, flyClouds, FT };
  return app;
}

export default {
  name: "crayoland",
  description: "Crayoland (Dave Pape, EVL 1995): a crayon-drawn meadow with bees, butterflies and things to throw",
  create: (spec, ctx) => createCrayolandApp(spec, ctx),
} satisfies AppDefinition;
