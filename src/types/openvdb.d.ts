/**
 * Minimal typings for the `openvdb` package (mjurczyk/openvdb), which ships
 * no declarations. Only what src/apps/vdb uses.
 */
declare module "openvdb" {
  /** Fetch and parse a .vdb file. Resolves to the reader, whose `grids` map holds one entry per grid. */
  export function loadVDB(url: string): Promise<unknown>;
}
