/**
 * Tracker bridge configuration: a JSON file (see configs/trackers/*.json)
 * validated with zod, written to configs/trackers/schema.json by
 * `npm run schema` for editor support.
 *
 * Three parts:
 *   source        which protocol and where to listen or connect
 *   calibration   how the tracker's frame becomes the CAVE frame: units, axis
 *                 permutation with signs, a yaw about the CAVE's up axis, and
 *                 a translation, in that order
 *   head / wand   which body is which, an optional offset from the sensor to
 *                 the point WebCAVE wants (eye center, wand tip), and which
 *                 device's buttons and joystick become input actions
 */
import { z } from "zod";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** An axis of the CAVE frame expressed as a signed axis of the tracker frame. */
const axis = z.enum(["x", "y", "z", "-x", "-y", "-z"]);

export const calibrationSchema = z
  .object({
    units: z.enum(["m", "cm", "mm", "ft", "in"]).default("m").describe("Length unit of the tracker's positions"),
    axes: z
      .tuple([axis, axis, axis])
      .default(["x", "y", "z"])
      .describe("CAVE x, y, z as signed tracker axes, e.g. [\"x\", \"z\", \"-y\"] for a Z-up tracker"),
    yaw: z.number().default(0).describe("Rotation about the CAVE's up axis applied after the axis mapping, degrees"),
    offset: vec3.default([0, 0, 0]).describe("Translation added last, meters: the tracker origin in the CAVE frame"),
  })
  .prefault({});

const bodySchema = z.object({
  id: z.union([z.number(), z.string()]).describe("Body id: DTrack body id, NatNet streaming id or asset name, VRPN \"Tracker0/0\" (device/sensor)"),
  localOffset: vec3.default([0, 0, 0]).describe("Offset from the sensor to the tracked point, in the sensor's own frame, meters (glasses sensor -> eye center)"),
});

const actionNames = ["primary", "secondary", "tertiary", "quaternary", "prev", "next", "reset", "menu", "spin"] as const;

export const sourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dtrack"),
    port: z.number().int().default(5000).describe("UDP port DTrack sends to (DTrack: Output settings)"),
  }),
  z.object({
    type: z.literal("natnet"),
    server: z.string().default("127.0.0.1").describe("Motive host, for the command port (version and asset names)"),
    multicast: z.string().default("239.255.42.99").describe("Multicast group; \"\" for unicast to this host"),
    dataPort: z.number().int().default(1511),
    commandPort: z.number().int().default(1510),
  }),
  z.object({
    type: z.literal("vrpn"),
    host: z.string().default("localhost"),
    port: z.number().int().default(3883),
  }),
]);

export const trackerFileSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1).describe("Configuration name"),
  description: z.string().optional(),
  manager: z.string().default("ws://localhost:8765").describe("WebCAVE Manager to feed"),
  rate: z.number().positive().default(120).describe("Maximum poses sent per second per body"),
  source: sourceSchema,
  calibration: calibrationSchema,
  head: bodySchema.optional().describe("Body tracked on the glasses"),
  wand: bodySchema
    .extend({
      buttons: z
        .record(z.string(), z.enum(actionNames))
        .default({})
        .describe("Button index -> action, e.g. {\"0\": \"primary\", \"1\": \"secondary\"}"),
      axes: z
        .object({ move: z.tuple([z.number().int(), z.number().int()]).optional(), look: z.tuple([z.number().int(), z.number().int()]).optional(), fly: z.number().int().optional() })
        .default({})
        .describe("Analog channel indexes for the move (x, y) and look (x, y) sticks and the fly axis"),
      /** VRPN only: the Button and Analog device names, when they differ from the tracker's. */
      buttonDevice: z.string().optional().describe("VRPN: Button device name (default: the wand's tracker device)"),
      analogDevice: z.string().optional().describe("VRPN: Analog device name (default: the wand's tracker device)"),
    })
    .optional(),
});

export type TrackerFile = z.input<typeof trackerFileSchema>;
export type TrackerConfig = z.output<typeof trackerFileSchema>;
export type Calibration = z.output<typeof calibrationSchema>;

export function parseTrackerConfig(data: unknown, source = "tracker config"): TrackerConfig {
  const r = trackerFileSchema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid ${source}:\n${issues}`);
  }
  return r.data;
}

export function trackerJsonSchema(): unknown {
  return z.toJSONSchema(trackerFileSchema, { target: "draft-7", io: "input" });
}
