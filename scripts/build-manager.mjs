// Bundle the Manager (src/manager/server.ts and its imports, ws and zod included) into one
// Node.js file, dist-manager/server.mjs, for the Docker image. Node's own modules stay external;
// ws requires a few of them at run time, hence the createRequire banner in ESM output.
import { build } from "esbuild";

await build({
  entryPoints: ["src/manager/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-manager/server.mjs",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
