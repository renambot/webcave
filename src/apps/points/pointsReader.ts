/**
 * Reader for OpenVDB PointDataGrid buffers (Tree_ptdataidx32_5_4_3): the
 * particle format written by Houdini and the OpenVDB Points tools.
 *
 * The `openvdb` npm package parses the topology (tree, leaf masks, origins)
 * but not the buffers. A point grid's buffer section is written in several
 * passes over the whole tree (Grid::readBuffers with multi-pass IO):
 *
 *   uint16 numPasses            = 2 * attributes + 4
 *   pass 0      per leaf: uint16 voxelBufferSize            (for seeking; ignored)
 *   pass 1      first leaf: uint8 header, attribute descriptor; then every
 *               leaf: per attribute int64 bytes, uint8 flags, uint8
 *               serialization flags (1 strided, 2 uniform, 8 paged), uint32
 *               size, [uint32 stride]. dataBytes = bytes - 6 - (strided ? 4 : 0)
 *   pass 2..n+1 per attribute: page headers only. Each page: int32 c; if
 *               c > 0 the page is compressed and int32 u (uncompressed size)
 *               follows; if c < 0 the page is raw with -c bytes. Pages
 *               continue until their sizes sum to that attribute's total.
 *   pass n+2    per leaf: 64-byte value mask, uint16 bytes, then that many
 *               bytes: a Blosc frame (or raw when bytes == 2048) holding 512
 *               uint32 cumulative point-end offsets, one per voxel
 *   pass n+3..2n+2  per attribute: the page payloads, in header order
 *   pass 2n+3   nothing
 *
 * Attribute descriptor: int64 count; count x (type string, codec string)
 * with uint32 lengths; count x (name string, int64 position); int64 group
 * count with (name, int64); MetaMap (uint32 count, then name/type/value).
 *
 * Codecs decoded here (per component, all little-endian):
 *   fxpt16 / fxpt8    fixed point, position range: v = x / max - 0.5
 *   ufxpt16 / ufxpt8  fixed point, unit range:     v = x / max
 *   trnc              half float
 *   null              float32
 * Positions are voxel-relative: world = transform(absOrigin + voxel + P), with
 * the leaf's absolute origin from ../vdb/tree.ts.
 */
import { bloscDecompress, bloscHeader } from "../vdb/blosc";

export interface PointLeafLike {
  /** Absolute index-space origin of the leaf (see ../vdb/tree.ts). */
  absOrigin: { x: number; y: number; z: number };
}

export interface AttributeInfo {
  name: string;
  type: string;
  codec: string;
  /** Bytes per element (one point) for this codec/type. */
  elementBytes: number;
}

export interface PointCloud {
  count: number;
  /** Positions in index space (voxel units), 3 per point. */
  positions: Float32Array;
  /** Optional per-point colour 0..1 from a vec3 attribute, 3 per point. */
  colors: Float32Array | null;
  attributes: AttributeInfo[];
  totalPoints: number;
  stride: number;
}

const codecBytes = (type: string, codec: string): number => {
  const comps = type.startsWith("vec3") ? 3 : type.startsWith("vec2") ? 2 : type.startsWith("vec4") ? 4 : 1;
  const base =
    codec === "fxpt16" || codec === "ufxpt16" || codec === "trnc" ? 2
    : codec === "fxpt8" || codec === "ufxpt8" ? 1
    : type.includes("64") || type === "double" || type === "vec3d" ? 8
    : type === "bool" || type === "uint8" || type === "int8" ? 1
    : type === "int16" || type === "uint16" || type === "half" ? 2
    : 4;
  return comps * base;
};

function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** Component decoder for a codec: (DataView, byteOffset) -> number. */
function componentDecoder(codec: string, type: string, positionRange: boolean): { bytes: number; read: (dv: DataView, at: number) => number } {
  const shift = positionRange ? -0.5 : 0;
  switch (codec) {
    case "fxpt16":
    case "ufxpt16":
      return { bytes: 2, read: (dv, at) => dv.getUint16(at, true) / 65535 + (codec === "fxpt16" ? shift : 0) };
    case "fxpt8":
    case "ufxpt8":
      return { bytes: 1, read: (dv, at) => dv.getUint8(at) / 255 + (codec === "fxpt8" ? shift : 0) };
    case "trnc":
      return { bytes: 2, read: (dv, at) => halfToFloat(dv.getUint16(at, true)) };
    default:
      if (type.includes("64") || type === "vec3d") return { bytes: 8, read: (dv, at) => dv.getFloat64(at, true) };
      if (type.startsWith("int32") || type === "int32") return { bytes: 4, read: (dv, at) => dv.getInt32(at, true) };
      return { bytes: 4, read: (dv, at) => dv.getFloat32(at, true) };
  }
}

export interface ReadPointsOptions {
  /** Keep at most this many points (uniform stride). Default 4,000,000. */
  maxPoints?: number;
  /** Name of a vec3 attribute to use as colour (default "Cd"). */
  colorAttribute?: string;
  onProgress?: (msg: string) => void;
}

export function readPointDataGrid(file: Uint8Array, blockBufferPosition: number, leaves: PointLeafLike[], opts: ReadPointsOptions = {}): PointCloud {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const nleaves = leaves.length;
  let p = blockBufferPosition;
  const u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const i64 = () => { const v = Number(dv.getBigInt64(p, true)); p += 8; return v; };
  const str = () => { const n = u32(); const s = new TextDecoder().decode(file.subarray(p, p + n)); p += n; return s; };

  const numPasses = u16();
  if (numPasses < 4 || (numPasses - 4) % 2 !== 0) throw new Error(`point grid: unexpected pass count ${numPasses}`);
  const nattr = (numPasses - 4) / 2;

  // pass 0: voxel buffer sizes (duplicated in pass n+2; skip)
  p += 2 * nleaves;

  // pass 1: descriptor (first leaf) + per-leaf attribute metadata
  const header = file[p++];
  void header;
  const count = i64();
  if (count !== nattr) throw new Error(`point grid: descriptor has ${count} attributes, passes imply ${nattr}`);
  const types: [string, string][] = [];
  for (let i = 0; i < count; i++) types.push([str(), str()]);
  const names = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const name = str();
    const pos = i64();
    if (pos >= 0 && pos < count) names[pos] = name;
  }
  const groups = i64();
  for (let i = 0; i < groups; i++) { str(); i64(); }
  const mcount = u32();
  for (let i = 0; i < mcount; i++) { str(); str(); p += u32(); }
  const attributes: AttributeInfo[] = types.map(([type, codec], i) => ({ name: names[i] ?? `attr${i}`, type, codec, elementBytes: codecBytes(type, codec) }));

  interface LeafAttr { dataBytes: number; uniform: boolean; size: number }
  const perLeaf: LeafAttr[][] = new Array(nleaves);
  const totals = new Array<number>(nattr).fill(0);
  for (let li = 0; li < nleaves; li++) {
    const row: LeafAttr[] = new Array(nattr);
    for (let a = 0; a < nattr; a++) {
      const bytes = i64();
      const flags = file[p++];
      const ser = file[p++];
      const size = u32();
      if (ser & 1) u32(); // stride
      if (bytes < 6 || flags > 63 || ser > 15) throw new Error(`point grid: attribute metadata desync at leaf ${li}, attribute ${a}`);
      const dataBytes = bytes - 6 - (ser & 1 ? 4 : 0);
      row[a] = { dataBytes, uniform: (ser & 2) !== 0, size };
      totals[a] += dataBytes;
    }
    perLeaf[li] = row;
  }

  // passes 2..n+1: page headers
  const pages: { c: number; u: number }[][] = [];
  for (let a = 0; a < nattr; a++) {
    const list: { c: number; u: number }[] = [];
    let acc = 0;
    while (acc < totals[a]) {
      const c = i32();
      const u = c > 0 ? i32() : -c;
      if (u <= 0) throw new Error(`point grid: bad page header for attribute ${a}`);
      list.push({ c, u });
      acc += u;
    }
    if (acc !== totals[a]) throw new Error(`point grid: attribute ${a} pages sum to ${acc}, expected ${totals[a]}`);
    pages.push(list);
  }

  // pass n+2: per-leaf voxel offsets
  opts.onProgress?.("reading voxel offsets");
  const offsets: Uint32Array[] = new Array(nleaves);
  let totalPoints = 0;
  for (let li = 0; li < nleaves; li++) {
    p += 64; // value mask (voxels with points); the offsets carry the same information
    const n = u16();
    const blob = file.subarray(p, p + n);
    p += n;
    let raw: Uint8Array;
    if (n === 2048 && bloscHeader(blob).version !== 2) raw = blob;
    else raw = bloscDecompress(blob);
    if (raw.length !== 2048) throw new Error(`point grid: leaf ${li} offsets decoded to ${raw.length} bytes`);
    const o = new Uint32Array(512);
    const rdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < 512; i++) o[i] = rdv.getUint32(i * 4, true);
    offsets[li] = o;
    totalPoints += o[511];
  }

  // passes n+3..2n+2: attribute payloads
  const posIdx = attributes.findIndex((a) => a.name === "P");
  if (posIdx < 0) throw new Error(`point grid: no "P" attribute (have ${attributes.map((a) => a.name).join(", ")})`);
  const colorName = opts.colorAttribute ?? "Cd";
  const colIdx = attributes.findIndex((a) => a.name === colorName && a.type.startsWith("vec3"));
  const payload: (Uint8Array | null)[] = new Array(nattr).fill(null);
  for (let a = 0; a < nattr; a++) {
    const want = a === posIdx || a === colIdx;
    const out = want ? new Uint8Array(totals[a]) : null;
    let w = 0;
    opts.onProgress?.(`reading attribute "${attributes[a].name}"`);
    for (const pg of pages[a]) {
      if (pg.c > 0) {
        if (out) {
          const d = bloscDecompress(file.subarray(p, p + pg.c));
          if (d.length !== pg.u) throw new Error(`point grid: page of "${attributes[a].name}" decoded to ${d.length}, expected ${pg.u}`);
          out.set(d, w);
        }
        p += pg.c;
      } else {
        if (out) out.set(file.subarray(p, p + pg.u), w);
        p += pg.u;
      }
      w += pg.u;
    }
    payload[a] = out;
  }

  // Decode positions (and colours) with a uniform stride to respect maxPoints.
  const maxPoints = opts.maxPoints ?? 4_000_000;
  const stride = Math.max(1, Math.ceil(totalPoints / maxPoints));
  const kept = Math.ceil(totalPoints / stride);
  const positions = new Float32Array(kept * 3);
  const colors = colIdx >= 0 ? new Float32Array(kept * 3) : null;
  const P = payload[posIdx]!;
  const pdv = new DataView(P.buffer, P.byteOffset, P.byteLength);
  const pdec = componentDecoder(attributes[posIdx].codec, attributes[posIdx].type, true);
  const C = colIdx >= 0 ? payload[colIdx]! : null;
  const cdv = C ? new DataView(C.buffer, C.byteOffset, C.byteLength) : null;
  const cdec = colIdx >= 0 ? componentDecoder(attributes[colIdx].codec, attributes[colIdx].type, false) : null;

  opts.onProgress?.(`decoding ${kept.toLocaleString()} of ${totalPoints.toLocaleString()} points`);
  let pOff = 0;
  let cOff = 0;
  let globalIndex = 0;
  let out = 0;
  for (let li = 0; li < nleaves; li++) {
    const o = leaves[li].absOrigin;
    const offs = offsets[li];
    const pa = perLeaf[li][posIdx];
    const ca = colIdx >= 0 ? perLeaf[li][colIdx] : null;
    let prev = 0;
    for (let vi = 0; vi < 512; vi++) {
      const end = offs[vi];
      if (end > prev) {
        const vx = o.x + (vi >> 6);
        const vy = o.y + ((vi >> 3) & 7);
        const vz = o.z + (vi & 7);
        for (let k = prev; k < end; k++, globalIndex++) {
          if (globalIndex % stride !== 0) continue;
          const pi = pa.uniform ? 0 : k;
          const b = pOff + pi * pdec.bytes * 3;
          positions[out * 3] = vx + pdec.read(pdv, b);
          positions[out * 3 + 1] = vy + pdec.read(pdv, b + pdec.bytes);
          positions[out * 3 + 2] = vz + pdec.read(pdv, b + 2 * pdec.bytes);
          if (colors && cdv && cdec && ca) {
            const ci = ca.uniform ? 0 : k;
            const cb = cOff + ci * cdec.bytes * 3;
            colors[out * 3] = cdec.read(cdv, cb);
            colors[out * 3 + 1] = cdec.read(cdv, cb + cdec.bytes);
            colors[out * 3 + 2] = cdec.read(cdv, cb + 2 * cdec.bytes);
          }
          out++;
        }
      }
      prev = end;
    }
    pOff += pa.dataBytes;
    if (ca) cOff += ca.dataBytes;
  }

  return {
    count: out,
    positions: out === kept ? positions : positions.slice(0, out * 3),
    colors: colors ? (out === kept ? colors : colors.slice(0, out * 3)) : null,
    attributes,
    totalPoints,
    stride,
  };
}
