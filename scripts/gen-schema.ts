/**
 * Write configs/schema.json from the zod schema, so editors validate and
 * autocomplete configuration files ("$schema": "./schema.json").
 *
 *   npm run schema
 */
import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterJsonSchema, parseClusterConfig } from "../src/core/configFile";
import { parseTrackerConfig, trackerJsonSchema } from "../src/tracker/config";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "configs/schema.json");
const schema = clusterJsonSchema() as Record<string, unknown>;
schema.title = "WebCAVE cluster configuration";
schema.description = "Physical screens, nodes, stereo output and application for a WebCAVE cluster. Units: meters, degrees.";
writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${out}`);

// Validate every config file while we are here.
let failed = 0;
for (const f of readdirSync(resolve(root, "configs")).filter((f) => f.endsWith(".json") && f !== "schema.json")) {
  try {
    const cfg = parseClusterConfig(JSON.parse(readFileSync(resolve(root, "configs", f), "utf8")), f);
    console.log(`ok   ${f}: ${cfg.name}, ${cfg.screens.length} screens, ${cfg.nodes.length} nodes`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${f}\n${(e as Error).message}`);
  }
}

// Tracker bridge configs: their own schema and validation.
const tOut = resolve(root, "configs/trackers/schema.json");
const tSchema = trackerJsonSchema() as Record<string, unknown>;
tSchema.title = "WebCAVE tracker bridge configuration";
tSchema.description = "Tracking source (DTrack, NatNet, VRPN), calibration into the CAVE frame, and which bodies are the head and the wand.";
writeFileSync(tOut, JSON.stringify(tSchema, null, 2) + "\n");
console.log(`wrote ${tOut}`);
for (const f of readdirSync(resolve(root, "configs/trackers")).filter((f) => f.endsWith(".json") && f !== "schema.json")) {
  try {
    const c = parseTrackerConfig(JSON.parse(readFileSync(resolve(root, "configs/trackers", f), "utf8")), f);
    console.log(`ok   trackers/${f}: ${c.name}, ${c.source.type}`);
  } catch (e) {
    failed++;
    console.error(`FAIL trackers/${f}\n${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
