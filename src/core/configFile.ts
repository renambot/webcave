/**
 * Cluster configuration files: JSON on disk, validated with zod, with a few
 * conveniences the in-memory ClusterConfig does not have:
 *
 *  - a screen may be given by three corners (pa, pb, pc) for measured
 *    installations, or by center + width + height + yaw/pitch/roll for
 *    quick descriptions; the loader derives the corners
 *  - most fields have defaults
 *  - "$schema" is accepted and ignored, so editors can validate the file
 *
 * `npm run schema` writes configs/schema.json from the zod schema below.
 */
import { z } from "zod";
import { defaultStereo, type ClusterConfig, type ScreenConfig, type Vec3 } from "./config";

const vec3 = z.tuple([z.number(), z.number(), z.number()]).describe("x, y, z in meters");
const quat = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("quaternion x, y, z, w");

export const stereoModeSchema = z.enum([
  "mono",
  "side-by-side",
  "side-by-side-half",
  "top-bottom",
  "top-bottom-half",
  "row-interleaved",
  "column-interleaved",
  "checkerboard",
  "anaglyph",
  "frame-sequential",
]);

export const stereoSchema = z
  .object({
    mode: stereoModeSchema.describe("Output packing mode"),
    eyeSeparation: z.number().positive().describe("Interpupillary distance in meters"),
    swapEyes: z.boolean(),
    firstEye: z.enum(["left", "right"]).describe("Interleaved modes: eye on row/column/pixel 0"),
    phaseX: z.number().int(),
    phaseY: z.number().int(),
    anaglyph: z.enum(["dubois", "bw"]).describe("Red-cyan anaglyph method"),
    monoEye: z.enum(["center", "left", "right"]).describe("Eye used when mode is mono"),
  })
  .partial();

const screenCommon = {
  id: z.string().min(1).describe("Unique screen id, referenced by nodes"),
  widthPx: z.number().int().positive().describe("Native pixel width"),
  heightPx: z.number().int().positive().describe("Native pixel height"),
  stereo: stereoSchema.optional().describe("Per-screen stereo overrides"),
};

/** Screen given by corners: lower-left, lower-right, upper-left. */
const screenByCorners = z.object({
  ...screenCommon,
  pa: vec3.describe("Lower-left corner"),
  pb: vec3.describe("Lower-right corner"),
  pc: vec3.describe("Upper-left corner"),
});

/**
 * Screen given by placement. The screen starts facing +z (toward a viewer at
 * larger z), centered at `center`; yaw turns it about +y, pitch about its own
 * x axis (negative = tilt to face up, e.g. a floor is pitch -90), roll about
 * its normal. Angles in degrees.
 */
const screenByPlacement = z.object({
  ...screenCommon,
  center: vec3.describe("Center of the screen"),
  width: z.number().positive().describe("Physical width in meters"),
  height: z.number().positive().describe("Physical height in meters"),
  yaw: z.number().default(0).describe("Rotation about +y, degrees; 90 faces +x (a left wall)"),
  pitch: z.number().default(0).describe("Tilt about the screen's x axis, degrees; -90 for a floor"),
  roll: z.number().default(0).describe("Rotation about the screen normal, degrees"),
});

export const screenSchema = z.union([screenByCorners, screenByPlacement]);

export const nodeSchema = z.object({
  id: z.string().min(1).describe("Node id; a computer, or a display when one per node"),
  screens: z.array(z.string()).min(1).describe("Screen ids this node renders, one window each"),
  input: z.boolean().optional().describe("Let this node's windows take keyboard, mouse and gamepad input and steer the cluster (default false)"),
});

export const appSchema = z.object({
  name: z.string().min(1).describe("Application folder name under src/apps"),
  url: z.string().optional().describe("Asset URL (gltf)"),
  size: z.number().positive().optional().describe("Fitted size in meters (gltf)"),
  position: vec3.optional().describe("Model center in the CAVE frame (gltf)"),
  spin: z.number().optional().describe("Yaw speed in rad/s (gltf)"),
  options: z.record(z.string(), z.unknown()).optional().describe("Free-form per-app options, e.g. map style, center, zoom"),
});

export const clusterFileSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1).describe("Configuration name shown in UIs"),
  description: z.string().optional(),
  fps: z.number().positive().default(60),
  sync: z.enum(["loose", "barrier"]).default("barrier").describe("Frame synchronization tier"),
  barrierTimeoutMs: z.number().positive().default(50),
  near: z.number().positive().default(0.05),
  far: z.number().positive().default(200),
  defaultHead: z
    .object({ position: vec3, orientation: quat.default([0, 0, 0, 1]) })
    .default({ position: [0, 1.6, 0], orientation: [0, 0, 0, 1] })
    .describe("Head pose when nothing is tracking"),
  stereo: stereoSchema.default({}).describe("Cluster-wide stereo defaults"),
  app: appSchema.default({ name: "shapes" }),
  screens: z.array(screenSchema).min(1),
  nodes: z.array(nodeSchema).min(1),
});

export type ClusterFile = z.input<typeof clusterFileSchema>;

const deg = (d: number) => (d * Math.PI) / 180;

/** Rotate v by yaw (about y), then pitch (about x), then roll (about z), intrinsic. */
function placementBasis(yaw: number, pitch: number, roll: number): { right: Vec3; up: Vec3 } {
  const cy = Math.cos(deg(yaw)), sy = Math.sin(deg(yaw));
  const cp = Math.cos(deg(pitch)), sp = Math.sin(deg(pitch));
  const cr = Math.cos(deg(roll)), sr = Math.sin(deg(roll));
  // R = Ry * Rx * Rz applied to local axes
  const rot = (v: Vec3): Vec3 => {
    // Rz
    let x = v[0] * cr - v[1] * sr;
    let y = v[0] * sr + v[1] * cr;
    let z = v[2];
    // Rx
    const y2 = y * cp - z * sp;
    const z2 = y * sp + z * cp;
    y = y2;
    z = z2;
    // Ry
    const x3 = x * cy + z * sy;
    const z3 = -x * sy + z * cy;
    return [x3, y, z3];
  };
  return { right: rot([1, 0, 0]), up: rot([0, 1, 0]) };
}

function toScreen(s: z.output<typeof screenSchema>): ScreenConfig {
  const base = { id: s.id, widthPx: s.widthPx, heightPx: s.heightPx, stereo: s.stereo };
  if ("pa" in s) return { ...base, pa: s.pa, pb: s.pb, pc: s.pc };
  const { right, up } = placementBasis(s.yaw, s.pitch, s.roll);
  const [cx, cy, cz] = s.center;
  const hw = s.width / 2;
  const hh = s.height / 2;
  const at = (u: number, v: number): Vec3 => [
    cx + right[0] * u + up[0] * v,
    cy + right[1] * u + up[1] * v,
    cz + right[2] * u + up[2] * v,
  ];
  return { ...base, pa: at(-hw, -hh), pb: at(hw, -hh), pc: at(-hw, hh) };
}

/** Validate a parsed JSON value and produce a runtime ClusterConfig. Throws with a readable message. */
export function parseClusterConfig(data: unknown, source = "config"): ClusterConfig {
  const result = clusterFileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid cluster config ${source}:\n${issues}`);
  }
  const f = result.data;
  const screens = f.screens.map(toScreen);
  const ids = new Set(screens.map((s) => s.id));
  if (ids.size !== screens.length) throw new Error(`Invalid cluster config ${source}: duplicate screen ids`);
  for (const n of f.nodes) {
    for (const sid of n.screens) {
      if (!ids.has(sid)) throw new Error(`Invalid cluster config ${source}: node "${n.id}" references unknown screen "${sid}"`);
    }
  }
  return {
    name: f.name,
    fps: f.fps,
    app: f.app,
    sync: f.sync,
    barrierTimeoutMs: f.barrierTimeoutMs,
    near: f.near,
    far: f.far,
    defaultHead: f.defaultHead,
    stereo: { ...defaultStereo, ...f.stereo },
    screens,
    nodes: f.nodes,
  };
}

/** JSON Schema for editors; written to configs/schema.json by `npm run schema`. */
export function clusterJsonSchema(): unknown {
  return z.toJSONSchema(clusterFileSchema, { target: "draft-7", io: "input" });
}
