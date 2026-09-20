/**
 * "vdb": volume rendering of an OpenVDB file (smoke, clouds, fire) in the CAVE.
 *
 * Pipeline
 *   1. fetch the .vdb (with progress in the status) and parse its topology
 *      with the `openvdb` package: grids, transforms, tree, leaf masks and
 *      origins. The package does not read leaf values (it marks active
 *      voxels as 1), so
 *   2. read the leaf value buffers ourselves from the file's buffer section
 *      (./leafValues.ts: OpenVDB record layout, Blosc + LZ4 in ./blosc.ts)
 *   3. pick a float grid ("density" by default, or `grid` option)
 *   4. walk the leaves and write their 8x8x8 value blocks into a dense byte
 *      array over the grid's active bounding box, downsampled if the longest
 *      side exceeds `maxDim`
 *   5. upload as a three.js Data3DTexture (WebGL2, R8) and ray-march it in a
 *      fragment shader on a box: front-to-back absorption/emission with a
 *      cheap single-scatter shadow toward one light
 *
 * The box is fitted like the glTF app: largest side = `size` meters, centered
 * at `position` in the CAVE frame, slowly spinning at `spin` rad/s. All motion
 * derives from cluster time, so every node shows the same frame; stereo comes
 * for free since each eye ray-marches from its own position.
 *
 * Options (config `app.options` or URL): url (.vdb), grid, size, position,
 * spin, density (multiplier), steps (ray march samples), color (smoke tint,
 * hex), maxDim (texture limit, default 384), lightDir [x,y,z].
 *
 * Leaf layout: OpenVDB LeafNode offset = (x << 6) | (y << 3) | z for 8^3
 * leaves (x major, z fastest). Verified against the accessor in Node. Leaf
 * origins from the package are parent-relative; ./tree.ts makes them absolute.
 */
import * as THREE from "three";
import { loadVDB } from "openvdb";
import { spinTime, type AppDefinition, type AppSpec, type CaveApp } from "../types";
import type { FrameState } from "../../core/protocol";
import { readLeafBuffers } from "./leafValues";
import { collectLeaves, type TreeLeaf } from "./tree";

interface VdbOptions {
  url: string;
  grid: string | null;
  size: number;
  position: THREE.Vector3;
  spin: number;
  density: number;
  steps: number;
  color: THREE.Color;
  maxDim: number;
  lightDir: THREE.Vector3;
}

function readOptions(spec: AppSpec): VdbOptions {
  const o = (spec.options ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const vec = (v: unknown, d: [number, number, number]) => (Array.isArray(v) && v.length === 3 ? new THREE.Vector3(...(v.map(Number) as [number, number, number])) : new THREE.Vector3(...d));
  return {
    url: typeof o.url === "string" ? o.url : spec.url ?? "/volumes/smoke2.vdb",
    grid: typeof o.grid === "string" ? o.grid : null,
    // Defaults keep the fitted volume in front of the viewer, just inside the
    // front wall of the 3 m CAVE and clear of the simulated head motion.
    size: spec.size ?? num(o.size, 1.4),
    position: spec.position ? new THREE.Vector3(...spec.position) : vec(o.position, [0, 1.4, -1.1]),
    spin: spec.spin ?? num(o.spin, 0.15),
    density: num(o.density, 6),
    steps: Math.round(num(o.steps, 96)),
    color: new THREE.Color(typeof o.color === "string" || typeof o.color === "number" ? (o.color as string | number) : 0xd9d9e0),
    maxDim: Math.round(num(o.maxDim, 384)),
    lightDir: vec(o.lightDir, [0.4, 1.0, 0.6]).normalize(),
  };
}

// ---- Minimal view of the openvdb package's objects we touch --------------------
interface VdbVec3 {
  x: number;
  y: number;
  z: number;
}
type VdbLeaf = TreeLeaf;
interface VdbGrid {
  gridName: string;
  gridType: string;
  saveAsHalfFloat?: boolean;
  /** Absolute file offset of this grid's leaf value buffers. */
  blockBufferPosition: number;
  metadata: Record<string, { type: string; value: unknown } | number>;
  root: unknown;
  transform: { transformMap: { voxelSize?: VdbVec3 } };
}
interface VdbFile {
  grids: Record<string, VdbGrid>;
}

interface DenseVolume {
  data: Uint8Array<ArrayBuffer>;
  nx: number;
  ny: number;
  nz: number;
  /** Physical size of the box in grid world units (voxelSize * extent). */
  extent: THREE.Vector3;
  maxValue: number;
  /** Value mapped to 255 in the texture (a high percentile, so thin smoke keeps precision). */
  reference: number;
  leaves: number;
  /** "cropped × of full ×" for the status line. */
  cropped: string;
}

/** Densify the grid's active bounding box into bytes, downsampling by an integer factor to respect maxDim. */
function densify(grid: VdbGrid, leaves: VdbLeaf[], maxDim: number): DenseVolume {
  const bmin = (grid.metadata.file_bbox_min as { value: VdbVec3 }).value;
  const bmax = (grid.metadata.file_bbox_max as { value: VdbVec3 }).value;
  const ex = bmax.x - bmin.x + 1;
  const ey = bmax.y - bmin.y + 1;
  const ez = bmax.z - bmin.z + 1;
  const factor = Math.max(1, Math.ceil(Math.max(ex, ey, ez) / maxDim));
  const nx = Math.ceil(ex / factor);
  const ny = Math.ceil(ey / factor);
  const nz = Math.ceil(ez / factor);

  // Accumulate into floats (box filter when downsampling), then quantize.
  const acc = new Float32Array(nx * ny * nz);
  const cnt = factor > 1 ? new Uint16Array(nx * ny * nz) : null;
  let maxValue = 0;
  for (const leaf of leaves) {
    const ox = leaf.absOrigin.x - bmin.x;
    const oy = leaf.absOrigin.y - bmin.y;
    const oz = leaf.absOrigin.z - bmin.z;
    const vals = leaf.values;
    for (let i = 0; i < 512; i++) {
      const v = vals[i];
      if (!(v > 0)) continue;
      const x = ox + (i >> 6);
      const y = oy + ((i >> 3) & 7);
      const z = oz + (i & 7);
      if (x < 0 || y < 0 || z < 0 || x >= ex || y >= ey || z >= ez) continue;
      const idx = ((z / factor) | 0) * nx * ny + ((y / factor) | 0) * nx + ((x / factor) | 0);
      acc[idx] += v;
      if (cnt) cnt[idx]++;
      if (v > maxValue) maxValue = v;
    }
  }
  // Quantize to 8 bits. Smoke densities are heavily skewed toward zero
  // (the sample file's mean is 1% of its max), so normalize to the 99.5th
  // percentile of non-empty cells rather than the max: thin smoke keeps
  // precision and the few dense cores clamp at 255.
  const perCell = factor * factor * factor;
  const cellValue = (i: number) => (cnt ? acc[i] / perCell : acc[i]);
  const bins = new Uint32Array(1024);
  let nonEmpty = 0;
  for (let i = 0; i < acc.length; i++) {
    const v = cellValue(i);
    if (v <= 0) continue;
    bins[Math.min(1023, Math.floor((v / (maxValue || 1)) * 1023))]++;
    nonEmpty++;
  }
  let reference = maxValue || 1;
  if (nonEmpty > 0) {
    let seen = 0;
    for (let b = 0; b < 1024; b++) {
      seen += bins[b];
      if (seen >= nonEmpty * 0.995) {
        reference = ((b + 1) / 1023) * (maxValue || 1);
        break;
      }
    }
  }
  const scale = 255 / (reference || 1);
  const quant = (i: number) => Math.min(255, Math.round(cellValue(i) * scale));

  // Crop to the cells that actually hold smoke. Active bounding boxes often
  // include a floor of near-zero values (this file: 0.001 everywhere the
  // simulation touched), which would make the visible plume tiny inside a
  // huge box. Keep cells above 2% of the reference, plus a 2-cell margin.
  const minQ = Math.max(1, Math.round(255 * 0.02));
  let cx0 = nx, cy0 = ny, cz0 = nz, cx1 = -1, cy1 = -1, cz1 = -1;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (quant(z * nx * ny + y * nx + x) < minQ) continue;
        if (x < cx0) cx0 = x;
        if (y < cy0) cy0 = y;
        if (z < cz0) cz0 = z;
        if (x > cx1) cx1 = x;
        if (y > cy1) cy1 = y;
        if (z > cz1) cz1 = z;
      }
  if (cx1 < 0) {
    cx0 = cy0 = cz0 = 0;
    cx1 = nx - 1;
    cy1 = ny - 1;
    cz1 = nz - 1;
  }
  const m = 2;
  cx0 = Math.max(0, cx0 - m); cy0 = Math.max(0, cy0 - m); cz0 = Math.max(0, cz0 - m);
  cx1 = Math.min(nx - 1, cx1 + m); cy1 = Math.min(ny - 1, cy1 + m); cz1 = Math.min(nz - 1, cz1 + m);
  const cnx = cx1 - cx0 + 1, cny = cy1 - cy0 + 1, cnz = cz1 - cz0 + 1;
  const data = new Uint8Array(new ArrayBuffer(cnx * cny * cnz));
  for (let z = 0; z < cnz; z++)
    for (let y = 0; y < cny; y++)
      for (let x = 0; x < cnx; x++) data[z * cnx * cny + y * cnx + x] = quant((z + cz0) * nx * ny + (y + cy0) * nx + (x + cx0));
  const vs = grid.transform?.transformMap?.voxelSize ?? { x: 1, y: 1, z: 1 };
  // Physical extent of the cropped box: cells * factor voxels * voxel size.
  return {
    data,
    nx: cnx,
    ny: cny,
    nz: cnz,
    extent: new THREE.Vector3(cnx * factor * vs.x, cny * factor * vs.y, cnz * factor * vs.z),
    maxValue,
    reference,
    leaves: leaves.length,
    cropped: `${cnx}×${cny}×${cnz} of ${nx}×${ny}×${nz}`,
  };
}

/** Small procedural checkerboard, `cells` squares per side, two colours. */
function makeCheckerTexture(a: number, b: number, cells: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64 * cells;
  const ctx = c.getContext("2d")!;
  const ca = "#" + a.toString(16).padStart(6, "0");
  const cb = "#" + b.toString(16).padStart(6, "0");
  for (let y = 0; y < cells; y++)
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 ? ca : cb;
      ctx.fillRect(x * 64, y * 64, 64, 64);
    }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---- Ray-marching shader ----------------------------------------------------------
const vertexShader = /* glsl */ `
  varying vec3 vObjPos;
  void main() {
    vObjPos = position;                       // box local space, [-0.5, 0.5]^3
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler3D uVolume;
  uniform vec3 uCameraObj;     // camera position in box local space
  uniform float uDensity;
  uniform int uSteps;
  uniform vec3 uColor;
  uniform vec3 uLightDir;      // in box local space, normalized
  uniform float uMaxValue;
  varying vec3 vObjPos;

  // Ray / unit-box intersection, box is [-0.5, 0.5]^3.
  vec2 boxHits(vec3 ro, vec3 rd) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (vec3(-0.5) - ro) * inv;
    vec3 t1 = (vec3( 0.5) - ro) * inv;
    vec3 tmin = min(t0, t1), tmax = max(t0, t1);
    return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
  }

  float sampleDensity(vec3 p) {              // p in [-0.5, 0.5]^3
    return texture(uVolume, p + 0.5).r * uMaxValue;
  }

  void main() {
    vec3 rd = normalize(vObjPos - uCameraObj);
    vec3 ro = uCameraObj;
    vec2 t = boxHits(ro, rd);
    float tStart = max(t.x, 0.0);           // camera may be inside the box
    float tEnd = t.y;
    if (tEnd <= tStart) discard;

    float stepLen = (tEnd - tStart) / float(uSteps);
    vec3 p = ro + rd * tStart;
    float transmittance = 1.0;
    vec3 radiance = vec3(0.0);
    float shadowStep = 0.06;

    for (int i = 0; i < 512; i++) {
      if (i >= uSteps) break;
      float d = sampleDensity(p);
      if (d > 0.001) {
        float sigma = d * uDensity * stepLen * 12.0;
        float alpha = 1.0 - exp(-sigma);
        // One-tap shadow toward the light: darker deep inside the plume.
        float occl = sampleDensity(p + uLightDir * shadowStep) + 0.5 * sampleDensity(p + uLightDir * shadowStep * 2.5);
        float light = exp(-occl * uDensity * 2.0);
        vec3 c = uColor * (0.25 + 0.95 * light);
        radiance += transmittance * alpha * c;
        transmittance *= (1.0 - alpha);
        if (transmittance < 0.01) break;
      }
      p += rd * stepLen;
    }
    float a = 1.0 - transmittance;
    if (a < 0.003) discard;
    gl_FragColor = vec4(radiance, a);
  }
`;

export function createVdbApp(spec: AppSpec): CaveApp {
  const opts = readOptions(spec);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d16);
  scene.fog = new THREE.Fog(0x0a0d16, 25, 80);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x2a2418, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(3, 6, 4);
  scene.add(key);
  const floorLight = new THREE.PointLight(0xffe0b0, 30, 12);
  floorLight.position.set(0, 3, 0);
  scene.add(floorLight);

  // Floor at the physical floor (y = 0): a lit checkerboard so the smoke has a
  // visible ground reference and depth cue, plus a fine grid on top.
  const floorTex = makeCheckerTexture(0x2b3650, 0x1c2438, 8);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(20, 20); // 1 m squares over a 40 m plane
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85, metalness: 0.05 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const grid = new THREE.GridHelper(40, 40, 0x4a6a9a, 0x2c3e60);
  grid.position.y = 0.002;
  scene.add(grid);
  const pillarGeo = new THREE.BoxGeometry(0.4, 4, 0.4);
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x55688f, roughness: 0.6 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const p = new THREE.Mesh(pillarGeo, pillarMat);
    p.position.set(Math.cos(a) * 12, 2, Math.sin(a) * 12);
    scene.add(p);
  }

  // Pivot at `position`; the volume box (and a placeholder) hang off it.
  const pivot = new THREE.Group();
  pivot.position.copy(opts.position);
  scene.add(pivot);
  const placeholder = new THREE.Mesh(new THREE.BoxGeometry(opts.size * 0.4, opts.size, opts.size * 0.4), new THREE.MeshBasicMaterial({ color: 0x3b82f6, wireframe: true }));
  pivot.add(placeholder);

  const uniforms = {
    uVolume: { value: null as THREE.Data3DTexture | null },
    uCameraObj: { value: new THREE.Vector3() },
    uDensity: { value: opts.density },
    uSteps: { value: opts.steps },
    uColor: { value: opts.color },
    uLightDir: { value: opts.lightDir.clone() },
    uMaxValue: { value: 1 },
  };
  let volumeMesh: THREE.Mesh | null = null;
  const invModel = new THREE.Matrix4();
  const lightObj = new THREE.Vector3();

  const app: CaveApp = {
    name: "vdb",
    scene,
    status: `loading ${opts.url}`,
    ready: Promise.resolve(),
    update(time: number, state?: FrameState) {
      pivot.rotation.y = spinTime(state, time) * opts.spin;
      pivot.updateMatrixWorld(true);
      if (volumeMesh) {
        // Light direction in box space (the box spins; the light does not).
        invModel.copy(volumeMesh.matrixWorld).invert();
        lightObj.copy(opts.lightDir).transformDirection(invModel);
        uniforms.uLightDir.value.copy(lightObj);
      }
    },
    dispose() {
      uniforms.uVolume.value?.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          (Array.isArray(m) ? m : [m]).forEach((mat) => mat.dispose());
        }
      });
    },
  };

  // The camera position must be in box space per eye: hook onBeforeRender.
  const camObj = new THREE.Vector3();
  const makeVolumeMesh = (vol: DenseVolume) => {
    const tex = new THREE.Data3DTexture(vol.data, vol.nx, vol.ny, vol.nz);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    uniforms.uVolume.value = tex;
    uniforms.uMaxValue.value = 1; // texture is normalized to vol.reference

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide, // render back faces so the volume shows when the eye is inside the box
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    // Fit: scale so the largest physical side equals opts.size.
    const maxSide = Math.max(vol.extent.x, vol.extent.y, vol.extent.z) || 1;
    const k = opts.size / maxSide;
    mesh.scale.set(vol.extent.x * k, vol.extent.y * k, vol.extent.z * k);
    mesh.onBeforeRender = (_r, _s, camera) => {
      invModel.copy(mesh.matrixWorld).invert();
      camObj.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(invModel);
      uniforms.uCameraObj.value.copy(camObj);
    };
    mesh.renderOrder = 10;
    return mesh;
  };

  (app as { ready: Promise<void> }).ready = (async () => {
    try {
      // Fetch ourselves for progress, then hand the bytes to the parser via a blob URL.
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
        app.status = total ? `loading ${Math.round((100 * got) / total)}%` : `loading ${(got / 1e6).toFixed(1)} MB`;
      }
      const blob = new Blob(chunks as unknown as BlobPart[]);
      const blobUrl = URL.createObjectURL(blob);
      app.status = "parsing VDB";
      await new Promise((r) => setTimeout(r, 0)); // let the status paint
      const t0 = performance.now();
      const file = (await loadVDB(blobUrl)) as unknown as VdbFile;
      URL.revokeObjectURL(blobUrl);

      const names = Object.keys(file.grids);
      const pick = opts.grid && file.grids[opts.grid] ? opts.grid : names.find((n) => /float/i.test(file.grids[n].gridType) && n !== "v") ?? names[0];
      const grid = file.grids[pick];
      if (!grid) throw new Error(`no grid in file (have: ${names.join(", ")})`);

      // Leaves in depth-first order, then their real values from the buffer section.
      const leaves: VdbLeaf[] = collectLeaves(grid.root);
      app.status = `reading ${leaves.length} leaf buffers of "${pick}"`;
      await new Promise((r) => setTimeout(r, 0));
      let valuesNote = "";
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const r = readLeafBuffers(bytes, grid.blockBufferPosition, leaves, { fromHalf: !!grid.saveAsHalfFloat });
        valuesNote = `values ${r.min.toFixed(3)}..${r.max.toFixed(3)} mean ${r.mean.toFixed(3)} (${r.compressedFrames} blosc, ${r.rawFrames} raw)`;
      } catch (e) {
        // Fall back to the package's topology-only values (1 in active voxels).
        valuesNote = `topology only, values not decoded: ${(e as Error).message}`;
      }

      app.status = `densifying grid "${pick}"`;
      await new Promise((r) => setTimeout(r, 0));
      const vol = densify(grid, leaves, opts.maxDim);
      volumeMesh = makeVolumeMesh(vol);
      pivot.remove(placeholder);
      pivot.add(volumeMesh);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      app.status = `ready: "${pick}" of (${names.join(", ")}) · texture ${vol.cropped} from ${vol.leaves} leaves · ${valuesNote} · 255 = ${vol.reference.toFixed(3)} · ${secs}s`;
    } catch (e) {
      app.status = `failed: ${(e as Error).message ?? e}`;
      (placeholder.material as THREE.MeshBasicMaterial).color.set(0xef4444);
    }
  })();

  return app;
}

export default {
  name: "vdb",
  description: "OpenVDB volume (smoke, clouds) ray-marched in the CAVE; parsed in the browser",
  create: (spec) => createVdbApp(spec),
} satisfies AppDefinition;
