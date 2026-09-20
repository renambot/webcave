/**
 * Browser-side access to the configuration files in configs/.
 *
 * The Manager server reads them from disk; a browser cannot, so Vite inlines
 * every configs/*.json into the bundle with import.meta.glob and this module
 * parses them with the same validator. The simulator's local mode uses this;
 * nodes and the controller mode get their config from the Manager instead.
 *
 * A file that fails validation is skipped with a console warning and listed
 * in bundledConfigErrors, so one broken file does not take the page down.
 */
import type { ClusterConfig } from "./config";
import { parseClusterConfig } from "./configFile";

const files = import.meta.glob<{ default: unknown }>("../../configs/*.json", { eager: true });

/** Parsed bundled configs keyed by file name without extension (e.g. "cave-3m"). */
export const bundledConfigs: Record<string, ClusterConfig> = {};
export const bundledConfigErrors: Record<string, string> = {};

for (const [path, mod] of Object.entries(files)) {
  const key = path.split("/").pop()!.replace(/\.json$/, "");
  if (key === "schema") continue;
  try {
    bundledConfigs[key] = parseClusterConfig(mod.default, path);
  } catch (e) {
    bundledConfigErrors[key] = (e as Error).message;
    console.warn(e);
  }
}

export const bundledConfigNames = Object.keys(bundledConfigs).sort();

/**
 * Resolve a config by bundled name, or fetch a JSON URL (anything containing
 * "/" or ending in .json). Falls back to the first bundled config.
 */
export async function loadConfig(nameOrUrl: string | null): Promise<ClusterConfig> {
  if (nameOrUrl && (nameOrUrl.includes("/") || nameOrUrl.endsWith(".json"))) {
    const res = await fetch(nameOrUrl);
    if (!res.ok) throw new Error(`Could not fetch config ${nameOrUrl}: ${res.status}`);
    return parseClusterConfig(await res.json(), nameOrUrl);
  }
  if (nameOrUrl && bundledConfigs[nameOrUrl]) return structuredClone(bundledConfigs[nameOrUrl]);
  const first = bundledConfigNames[0];
  if (!first) throw new Error("No configuration files found in configs/");
  if (nameOrUrl) console.warn(`Unknown config "${nameOrUrl}", using "${first}"`);
  return structuredClone(bundledConfigs[first]);
}
