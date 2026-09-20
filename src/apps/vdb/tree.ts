/**
 * Leaf access on the tree built by the `openvdb` npm package.
 *
 * The package's nodes carry `origin` *relative to their parent* (a leaf's
 * origin is its offset inside the 128-voxel internal node, that node's
 * origin its offset inside the 4096-voxel root child, and the root child's
 * origin is absolute). collectLeaves() walks the tree depth-first, in the
 * order the file was written, and stamps each leaf with `absOrigin`, the
 * absolute index-space coordinate of its first voxel.
 */

export interface Vec3i {
  x: number;
  y: number;
  z: number;
}

/** A leaf node as the package builds it, plus our absolute origin. */
export interface TreeLeaf {
  origin: Vec3i;
  absOrigin: Vec3i;
  values: ArrayLike<number>;
  valueMask?: { isOn(i: number): boolean };
  parent?: TreeNodeLike;
}

interface TreeNodeLike {
  origin?: Vec3i;
  parent?: TreeNodeLike;
}

const CHILD_KEYS = ["table", "children", "childNodes", "nodes"];

/** Depth-first leaves with absolute origins, in file order. */
export function collectLeaves(root: unknown): TreeLeaf[] {
  const out: TreeLeaf[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, ox: number, oy: number, oz: number) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const n = node as Record<string, unknown> & TreeNodeLike;
    const o = n.origin;
    const ax = ox + (o?.x ?? 0);
    const ay = oy + (o?.y ?? 0);
    const az = oz + (o?.z ?? 0);
    if (o && n.values && (n.values as ArrayLike<number>).length === 512) {
      (n as unknown as TreeLeaf).absOrigin = { x: ax, y: ay, z: az };
      out.push(n as unknown as TreeLeaf);
      return;
    }
    for (const key of CHILD_KEYS) {
      const kids = n[key];
      if (!kids) continue;
      if (Array.isArray(kids)) for (const k of kids) walk(k, ax, ay, az);
      else if (kids instanceof Map) for (const k of kids.values()) walk(k, ax, ay, az);
      else if (typeof kids === "object") for (const k of Object.values(kids as Record<string, unknown>)) walk(k, ax, ay, az);
    }
  };
  // The RootNode itself has no origin; its table entries are the absolute root children.
  walk(root, 0, 0, 0);
  return out;
}
