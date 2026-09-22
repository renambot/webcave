/**
 * "points": an OpenVDB PointDataGrid (particles) as a point cloud in the CAVE.
 *
 * Pipeline
 *   1. fetch the .vdb with progress; parse the topology with the `openvdb`
 *      package (grids, transform, tree, leaf origins)
 *   2. read the point buffers with ./pointsReader.ts: attribute descriptor,
 *      per-leaf voxel offsets, and the paged attribute payloads (Blosc/LZ4
 *      via ../vdb/blosc.ts); decode P (and Cd when present) with their codecs
 *   3. build a three.js Points object: positions in meters, per-point colour
 *      from Cd or a height gradient, sized in world units
 *
 * Fitted and placed like the model and volume apps: largest side = `size`,
 * centered at `position`, spinning at `spin`. Motion derives from cluster
 * time only. Large clouds are decimated with a uniform stride to `maxPoints`.
 *
 * Options (config `app.options` or URL): url (.vdb), grid, size, position,
 * spin, maxPoints (4,000,000), pointSize (meters after fitting, 0.006),
 * colorAttribute ("Cd"), color (hex tint when no colour attribute).
 */
import * as THREE from "three";
import { loadVDB } from "openvdb";
import { spinTime, type AppDefinition, type AppSpec, type CaveApp } from "../types";
import type { FrameState } from "../../core/protocol";
import { readPointDataGrid } from "./pointsReader";
import { collectLeaves, type TreeLeaf } from "../vdb/tree";
import { publicUrl } from "../../core/base";

interface PointsOptions {
  url: string;
  grid: string | null;
  size: number;
  position: THREE.Vector3;
  spin: number;
  maxPoints: number;
  pointSize: number;
  colorAttribute: string;
  color: THREE.Color;
}

function readOptions(spec: AppSpec): PointsOptions {
  const o = (spec.options ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    url: publicUrl(typeof o.url === "string" ? o.url : spec.url ?? "/volumes/waterfall_points.vdb"),
    grid: typeof o.grid === "string" ? o.grid : null,
    size: spec.size ?? num(o.size, 2.2),
    position: spec.position ? new THREE.Vector3(...spec.position) : new THREE.Vector3(0, 1.3, -1.0),
    spin: spec.spin ?? num(o.spin, 0.1),
    maxPoints: Math.round(num(o.maxPoints, 4_000_000)),
    pointSize: num(o.pointSize, 0.006),
    colorAttribute: typeof o.colorAttribute === "string" ? o.colorAttribute : "Cd",
    color: new THREE.Color(typeof o.color === "string" || typeof o.color === "number" ? (o.color as string | number) : 0x9fd3ff),
  };
}

interface VdbGrid {
  gridType: string;
  blockBufferPosition: number;
  root: unknown;
  transform: { transformMap: { voxelSize?: { x: number; y: number; z: number }; translation?: { x: number; y: number; z: number } } };
}
interface VdbFile {
  grids: Record<string, VdbGrid>;
}

export function createPointsApp(spec: AppSpec): CaveApp {
  const opts = readOptions(spec);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090c14);
  scene.fog = new THREE.Fog(0x090c14, 25, 80);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x2a2418, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(3, 6, 4);
  scene.add(key);

  // Floor at the physical floor and distant pillars for parallax reference.
  scene.add(new THREE.GridHelper(40, 40, 0x2f4a6b, 0x18233a));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x131b2c, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.001;
  scene.add(ground);
  const pillarGeo = new THREE.BoxGeometry(0.4, 4, 0.4);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x55688f, roughness: 0.6 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const m = new THREE.Mesh(pillarGeo, pillarMat);
    m.position.set(Math.cos(a) * 12, 2, Math.sin(a) * 12);
    scene.add(m);
  }

  const pivot = new THREE.Group();
  pivot.position.copy(opts.position);
  scene.add(pivot);
  const placeholder = new THREE.Mesh(new THREE.BoxGeometry(opts.size * 0.6, opts.size, opts.size * 0.6), new THREE.MeshBasicMaterial({ color: 0x3b82f6, wireframe: true }));
  pivot.add(placeholder);

  let points: THREE.Points | null = null;

  const app: CaveApp = {
    name: "points",
    scene,
    status: `loading ${opts.url}`,
    ready: Promise.resolve(),
    update(time: number, state?: FrameState) {
      pivot.rotation.y = spinTime(state, time) * opts.spin;
    },
    dispose() {
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((mat) => mat.dispose());
        }
      });
    },
  };

  (app as { ready: Promise<void> }).ready = (async () => {
    try {
      const res = await fetch(opts.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length") ?? 0);
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        app.status = total ? `loading ${Math.round((100 * got) / total)}% of ${(total / 1e6).toFixed(0)} MB` : `loading ${(got / 1e6).toFixed(1)} MB`;
      }
      const blob = new Blob(chunks as unknown as BlobPart[]);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const blobUrl = URL.createObjectURL(blob);
      app.status = "parsing topology";
      await new Promise((r) => setTimeout(r, 0));
      const t0 = performance.now();
      const file = (await loadVDB(blobUrl)) as unknown as VdbFile;
      URL.revokeObjectURL(blobUrl);

      const names = Object.keys(file.grids);
      const pick = opts.grid && file.grids[opts.grid] ? opts.grid : names.find((n) => /ptdataidx|PointDataIndex/i.test(file.grids[n].gridType)) ?? names[0];
      const grid = file.grids[pick];
      if (!grid) throw new Error(`no grid in file (have: ${names.join(", ")})`);
      if (!/ptdataidx|PointDataIndex/i.test(grid.gridType)) throw new Error(`grid "${pick}" is ${grid.gridType}, not a PointDataGrid; use the vdb app for volumes`);

      const leaves: TreeLeaf[] = collectLeaves(grid.root);
      const cloud = readPointDataGrid(bytes, grid.blockBufferPosition, leaves, {
        maxPoints: opts.maxPoints,
        colorAttribute: opts.colorAttribute,
        onProgress: (m) => (app.status = m),
      });

      // Index space -> grid world space (uniform scale + translation), then fit.
      const vs = grid.transform.transformMap.voxelSize ?? { x: 1, y: 1, z: 1 };
      const tr = grid.transform.transformMap.translation ?? { x: 0, y: 0, z: 0 };
      const pos = cloud.positions;
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (let i = 0; i < cloud.count; i++) {
        pos[i * 3] = pos[i * 3] * vs.x + tr.x;
        pos[i * 3 + 1] = pos[i * 3 + 1] * vs.y + tr.y;
        pos[i * 3 + 2] = pos[i * 3 + 2] * vs.z + tr.z;
        box.expandByPoint(v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
      }
      const dims = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const k = opts.size / (Math.max(dims.x, dims.y, dims.z) || 1);

      // Colours: Cd when present, else a height gradient in the tint.
      let colors = cloud.colors;
      if (!colors) {
        colors = new Float32Array(cloud.count * 3);
        const c = new THREE.Color();
        for (let i = 0; i < cloud.count; i++) {
          const t = dims.y > 0 ? (pos[i * 3 + 1] - box.min.y) / dims.y : 0.5;
          c.copy(opts.color).offsetHSL(0, 0, (t - 0.5) * 0.5);
          colors[i * 3] = c.r;
          colors[i * 3 + 1] = c.g;
          colors[i * 3 + 2] = c.b;
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const material = new THREE.PointsMaterial({ size: opts.pointSize, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false });
      points = new THREE.Points(geometry, material);
      points.scale.setScalar(k);
      points.position.copy(center).multiplyScalar(-k);
      pivot.remove(placeholder);
      pivot.add(points);

      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const attrs = cloud.attributes.map((a) => `${a.name}:${a.type}/${a.codec}`).join(" ");
      app.status = `ready: ${cloud.count.toLocaleString()} of ${cloud.totalPoints.toLocaleString()} points (stride ${cloud.stride}) · ${leaves.length} leaves · ${dims.x.toFixed(1)}×${dims.y.toFixed(1)}×${dims.z.toFixed(1)} m · ${attrs} · ${secs}s`;
    } catch (e) {
      app.status = `failed: ${(e as Error).message ?? e}`;
      (placeholder.material as THREE.MeshBasicMaterial).color.set(0xef4444);
    }
  })();

  return app;
}

export default {
  name: "points",
  description: "OpenVDB PointDataGrid (particles) as a point cloud in the CAVE; decoded in the browser",
  create: (spec) => createPointsApp(spec),
} satisfies AppDefinition;
