/**
 * "gltf": load one glTF / GLB model and show it in the CAVE.
 *
 * Compared with "shapes", this app adds the two things most real apps need:
 *
 *   - asynchronous asset loading, with a placeholder while it happens and a
 *     `status` string that tracks progress for the HUDs
 *   - options from the AppSpec (`url`, `size`, `position`, `spin`), set in the
 *     cluster config or via URL parameters
 *
 * The model is fitted (scaled so its largest dimension is `size`) and
 * centered on a pivot placed at `position`, then the pivot yaws at `spin`
 * rad/s. If the file has animation clips they all play, driven by
 * `mixer.setTime(time)` rather than `mixer.update(delta)`, so every node shows
 * the exact same pose for a given cluster time.
 *
 * Limitations: no Draco or KTX2 decoders are wired in (models using them fail
 * to load), and there is no environment map, so metallic PBR materials look
 * flatter than in a viewer with image-based lighting.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { spinTime, type AppDefinition, type AppSpec, type CaveApp } from "../types";
import type { FrameState } from "../../core/protocol";

export function createGltfApp(spec: AppSpec): CaveApp {
  // ---- Options ---------------------------------------------------------------
  // Defaults keep the model inside the CAVE just in front of the front wall
  // (z = -1.5), clear of the simulated head motion (about ±0.4 m in z).
  const url = spec.url ?? "/models/DamagedHelmet.glb";
  const size = spec.size ?? 0.8;
  const position = new THREE.Vector3(...(spec.position ?? [0, 1.5, -1.05]));
  const spin = spec.spin ?? 0.3;

  // ---- Scene, lights, ground --------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1220);
  scene.fog = new THREE.Fog(0x0e1220, 25, 80);

  // PBR materials without an environment map need generous direct light:
  // a key, a cool fill from the opposite side and a warm rim from behind.
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x40331f, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x99bbff, 1.2);
  fill.position.set(-4, 3, -3);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffcc99, 1.0);
  rim.position.set(0, 2, -6);
  scene.add(rim);

  // Ground at the physical floor (y = 0) and a ring of distant pillars, so the
  // viewer has a fixed reference while the model spins.
  scene.add(new THREE.GridHelper(40, 40, 0x335577, 0x1c2a44));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x1a2742, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.001;
  scene.add(ground);
  const pillarGeo = new THREE.BoxGeometry(0.4, 4, 0.4);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x6b7fa8, roughness: 0.6 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const p = new THREE.Mesh(pillarGeo, pillarMat);
    p.position.set(Math.cos(a) * 12, 2, Math.sin(a) * 12);
    scene.add(p);
  }

  // ---- Pivot and placeholder ---------------------------------------------------
  // The pivot is what spins. The fitted model is added as its child, centered,
  // so rotation happens about the model's own center rather than its origin.
  const pivot = new THREE.Group();
  pivot.position.copy(position);
  scene.add(pivot);

  // Until the file arrives, show a wireframe cube of the target size where the
  // model will be. It turns red if loading fails, so a broken URL is visible
  // on the wall rather than a silent empty scene.
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshBasicMaterial({ color: 0x3b82f6, wireframe: true }),
  );
  pivot.add(placeholder);

  // ---- The app object ---------------------------------------------------------
  // Created before loading starts so update() can run from the first frame.
  let mixer: THREE.AnimationMixer | null = null;
  const app: CaveApp = {
    name: "gltf",
    scene,
    status: `loading ${url}`,
    ready: Promise.resolve(), // replaced below with the real loading promise
    update(time: number, state?: FrameState) {
      const t = spinTime(state, time); // shared clock: Space in the simulator pauses it cluster-wide
      pivot.rotation.y = t * spin; // absolute angle, never accumulated
      if (mixer) mixer.setTime(time); // absolute clip time; loops per clip settings
    },
    dispose() {
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((mat) => mat.dispose());
        }
      });
    },
  };

  // ---- Loading -----------------------------------------------------------------
  // `ready` resolves in both the success and the failure case: a failed app
  // is still a valid app (it shows the red placeholder and an error status),
  // and callers awaiting `ready` should not hang.
  (app as { ready: Promise<void> }).ready = new Promise<void>((resolve) => {
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;

        // Fit: measure the model's bounding box, scale uniformly so the largest
        // dimension equals `size`, and offset it so its center sits on the pivot.
        const box = new THREE.Box3().setFromObject(model);
        const dims = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(dims.x, dims.y, dims.z) || 1;
        const scale = size / maxDim;
        const center = box.getCenter(new THREE.Vector3());
        model.scale.setScalar(scale);
        model.position.copy(center).multiplyScalar(-scale);
        pivot.remove(placeholder);
        pivot.add(model);

        // Animations: play every clip; update() drives them by absolute time.
        if (gltf.animations.length) {
          mixer = new THREE.AnimationMixer(model);
          for (const clip of gltf.animations) mixer.clipAction(clip).play();
        }

        // Status for the HUDs: what did we get?
        let meshes = 0;
        let triangles = 0;
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            meshes++;
            const idx = o.geometry.index;
            triangles += (idx ? idx.count : o.geometry.getAttribute("position").count) / 3;
          }
        });
        app.status = `ready: ${meshes} meshes, ${Math.round(triangles)} triangles, ${gltf.animations.length} animations`;
        resolve();
      },
      (ev) => {
        // Progress: percent when the server sent Content-Length, bytes otherwise.
        if (ev.lengthComputable) app.status = `loading ${Math.round((100 * ev.loaded) / ev.total)}%`;
        else app.status = `loading ${(ev.loaded / 1e6).toFixed(1)} MB`;
      },
      (err) => {
        app.status = `failed to load ${url}: ${(err as Error).message ?? err}`;
        (placeholder.material as THREE.MeshBasicMaterial).color.set(0xef4444);
        resolve();
      },
    );
  });

  return app;
}

// ---- Registration -------------------------------------------------------------
export default {
  name: "gltf",
  description: "One glTF / GLB model, fitted and placed in the CAVE; animations play from cluster time",
  create: (spec) => createGltfApp(spec),
} satisfies AppDefinition;
