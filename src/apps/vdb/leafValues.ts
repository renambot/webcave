/**
 * Read the real voxel values of an OpenVDB grid's leaf nodes.
 *
 * The `openvdb` npm package parses the file's topology (tree, masks, leaf
 * origins) but, for leaf nodes, does not read the value buffers: it fills
 * active voxels with 1. The buffers live in a separate section of the file
 * starting at the grid's `blockBufferPosition`, one record per leaf in
 * depth-first tree order (the order in which the topology was written, and
 * in which the package created the leaf objects). This module walks that
 * section and fills each leaf with a Float32Array of 512 values.
 *
 * Record layout per leaf (OpenVDB file version >= 222, from
 * LeafNode::readBuffers and io::readCompressedValues):
 *
 *   64 bytes   value mask (must equal the topology mask; used as a check)
 *   1 byte     metadata: how inactive values are represented
 *                0 NO_MASK_OR_INACTIVE_VALS   inactive = background
 *                1 NO_MASK_AND_MINUS_BG       inactive = -background
 *                2 NO_MASK_AND_ONE_INACTIVE_VAL   one inactive value follows
 *                3 MASK_AND_NO_INACTIVE_VALS  selection mask follows
 *                4 MASK_AND_ONE_INACTIVE_VAL  one inactive value + selection mask
 *                5 MASK_AND_TWO_INACTIVE_VALS two inactive values + selection mask
 *                6 NO_MASK_AND_ALL_VALS       all 512 values stored
 *   [value]    inactive value 0                     (metadata 2, 4, 5)
 *   [value]    inactive value 1                     (metadata 5)
 *   [64 bytes] selection mask: picks inactive 1 vs 0  (metadata 3, 4, 5)
 *   int64      n: if n > 0, a Blosc frame of n bytes follows; if n <= 0 the
 *              values follow raw (zip/none compression is not handled here)
 *   data       active values only (or all 512 for metadata 6), float32 or
 *              float16 when the grid was saved as half
 *
 * Values are scattered back to 512 slots with the mask; inactive slots get
 * the background or the inactive value(s).
 */
import { bloscDecompress } from "./blosc";

export interface LeafLike {
  origin: { x: number; y: number; z: number };
  values: ArrayLike<number>;
  valueMask?: { isOn(i: number): boolean };
}

export interface LeafReadResult {
  leaves: number;
  activeVoxels: number;
  compressedFrames: number;
  rawFrames: number;
  min: number;
  max: number;
  mean: number;
}

const popcount8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let c = 0;
  for (let b = i; b; b >>= 1) c += b & 1;
  popcount8[i] = c;
}

/** IEEE 754 half -> float. */
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/**
 * Fill `leaves[i].values` from the buffer section. Throws on a structural
 * mismatch (which would mean the leaf order or the format assumption is
 * wrong) rather than producing garbage.
 */
export function readLeafBuffers(
  file: Uint8Array,
  blockBufferPosition: number,
  leaves: LeafLike[],
  opts: { fromHalf?: boolean; background?: number; checkMasks?: number } = {},
): LeafReadResult {
  const fromHalf = opts.fromHalf ?? false;
  const background = opts.background ?? 0;
  const checkMasks = opts.checkMasks ?? 64;
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const valueBytes = fromHalf ? 2 : 4;
  const readValue = (at: number) => (fromHalf ? halfToFloat(dv.getUint16(at, true)) : dv.getFloat32(at, true));

  let p = blockBufferPosition;
  let activeVoxels = 0;
  let compressedFrames = 0;
  let rawFrames = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (let li = 0; li < leaves.length; li++) {
    const leaf = leaves[li];
    if (p + 65 > file.length) throw new Error(`leaf ${li}: buffer section ends early at byte ${p}`);

    // Value mask
    const mask = file.subarray(p, p + 64);
    p += 64;
    let count = 0;
    for (let i = 0; i < 64; i++) count += popcount8[mask[i]];
    if (li < checkMasks && leaf.valueMask) {
      for (let i = 0; i < 512; i += 7) {
        const on = (mask[i >> 3] >> (i & 7)) & 1;
        if (!!on !== leaf.valueMask.isOn(i)) {
          throw new Error(`leaf ${li} at (${leaf.origin.x},${leaf.origin.y},${leaf.origin.z}): file mask differs from topology mask; leaf order mismatch`);
        }
      }
    }

    const metadata = file[p++];
    if (metadata > 6) throw new Error(`leaf ${li}: bad metadata byte ${metadata}`);
    let inactive0 = background;
    let inactive1 = background;
    if (metadata === 1) inactive0 = -background;
    if (metadata === 2 || metadata === 4 || metadata === 5) {
      inactive0 = readValue(p);
      p += valueBytes;
      if (metadata === 5) {
        inactive1 = readValue(p);
        p += valueBytes;
      }
    }
    let selection: Uint8Array | null = null;
    if (metadata === 3 || metadata === 4 || metadata === 5) {
      selection = file.subarray(p, p + 64);
      p += 64;
    }
    const stored = metadata === 6 ? 512 : count;

    // Data: blosc frame or raw values.
    const n = Number(dv.getBigInt64(p, true));
    p += 8;
    let data: Uint8Array;
    if (n > 0) {
      data = bloscDecompress(file.subarray(p, p + n));
      p += n;
      compressedFrames++;
    } else {
      const bytes = stored * valueBytes;
      data = file.subarray(p, p + bytes);
      p += bytes;
      rawFrames++;
    }
    if (data.length < stored * valueBytes) throw new Error(`leaf ${li}: got ${data.length} bytes for ${stored} values`);
    const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Scatter into 512 slots.
    const values = new Float32Array(512);
    let k = 0;
    for (let i = 0; i < 512; i++) {
      const on = (mask[i >> 3] >> (i & 7)) & 1;
      if (metadata === 6) {
        values[i] = fromHalf ? halfToFloat(ddv.getUint16(i * 2, true)) : ddv.getFloat32(i * 4, true);
      } else if (on) {
        values[i] = fromHalf ? halfToFloat(ddv.getUint16(k * 2, true)) : ddv.getFloat32(k * 4, true);
        k++;
      } else {
        const sel = selection ? (selection[i >> 3] >> (i & 7)) & 1 : 0;
        values[i] = sel ? inactive1 : inactive0;
      }
      if (on) {
        const v = values[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
    }
    activeVoxels += count;
    leaf.values = values;
  }

  return {
    leaves: leaves.length,
    activeVoxels,
    compressedFrames,
    rawFrames,
    min: activeVoxels ? min : 0,
    max: activeVoxels ? max : 0,
    mean: activeVoxels ? sum / activeVoxels : 0,
  };
}
