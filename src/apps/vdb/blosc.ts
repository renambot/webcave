/**
 * Minimal Blosc (v1 format) decompressor with LZ4 block decoding and byte
 * unshuffle, enough for OpenVDB leaf buffers (which OpenVDB writes with
 * blosc_compress_ctx(clevel 9, byte shuffle, typesize, ..., "lz4")).
 *
 * Blosc v1 frame:
 *   byte 0   format version (2)
 *   byte 1   compressor's format version
 *   byte 2   flags: bit0 byte-shuffle, bit1 memcpyed (data stored raw),
 *            bit2 bit-shuffle, bits 5..7 compressor code (0 blosclz, 1 lz4,
 *            2 snappy, 3 zlib, 4 zstd)
 *   byte 3   typesize
 *   4..7     nbytes      uncompressed size          (int32 LE)
 *   8..11    blocksize   size of each block         (int32 LE)
 *   12..15   cbytes      total compressed size      (int32 LE)
 *   16..     bstarts: int32 offset of each block (nblocks = ceil(nbytes/blocksize))
 *   block:   if "split" (byte-shuffle on, typesize <= 16, blocksize/typesize >= 128,
 *            and not the partial last block): typesize streams, else one
 *            stream; each stream is int32 cbytes then
 *            either raw bytes (cbytes == stream size) or an LZ4 block.
 *   after all streams of a block, undo the byte shuffle: the block was stored as
 *   typesize planes (all byte 0s, then all byte 1s, ...).
 *
 * Only blosclz is not implemented; OpenVDB does not use it.
 */

const MIN_BUFFERSIZE = 128;
const MAX_SPLITS = 16;

/** LZ4 block format decoder. Returns the number of bytes written to dst. */
export function lz4BlockDecode(src: Uint8Array, dst: Uint8Array): number {
  let s = 0;
  let d = 0;
  const n = src.length;
  while (s < n) {
    const token = src[s++];
    let literal = token >> 4;
    if (literal === 15) {
      let b: number;
      do {
        b = src[s++];
        literal += b;
      } while (b === 255);
    }
    dst.set(src.subarray(s, s + literal), d);
    s += literal;
    d += literal;
    if (s >= n) break; // last sequence has no match
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0) throw new Error("lz4: zero offset");
    let matchLen = (token & 15) + 4;
    if ((token & 15) === 15) {
      let b: number;
      do {
        b = src[s++];
        matchLen += b;
      } while (b === 255);
    }
    let ref = d - offset;
    if (ref < 0) throw new Error("lz4: offset before start");
    // Byte-wise copy: matches may overlap their own output.
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[ref++];
  }
  return d;
}

function unshuffle(block: Uint8Array, typesize: number, out: Uint8Array) {
  const n = block.length;
  const elems = Math.floor(n / typesize);
  const planeLen = elems;
  for (let j = 0; j < typesize; j++) {
    const plane = j * planeLen;
    for (let i = 0; i < elems; i++) out[i * typesize + j] = block[plane + i];
  }
  // Leftover bytes (n not a multiple of typesize) are stored raw at the end.
  for (let i = elems * typesize; i < n; i++) out[i] = block[i];
}

export interface BloscInfo {
  version: number;
  flags: number;
  typesize: number;
  nbytes: number;
  blocksize: number;
  cbytes: number;
  compressor: number;
  shuffle: boolean;
  memcpyed: boolean;
}

export function bloscHeader(buf: Uint8Array): BloscInfo {
  if (buf.length < 16) throw new Error("blosc: frame too short");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[2];
  return {
    version: buf[0],
    flags,
    typesize: buf[3],
    nbytes: dv.getInt32(4, true),
    blocksize: dv.getInt32(8, true),
    cbytes: dv.getInt32(12, true),
    compressor: flags >> 5,
    shuffle: (flags & 1) !== 0,
    memcpyed: (flags & 2) !== 0,
  };
}

/** Decompress a Blosc v1 frame into a fresh Uint8Array of nbytes. */
export function bloscDecompress(buf: Uint8Array): Uint8Array {
  const h = bloscHeader(buf);
  if (h.version !== 2 && h.version !== 1) throw new Error(`blosc: unsupported format version ${h.version}`);
  if ((h.flags & 4) !== 0) throw new Error("blosc: bit-shuffle not supported");
  const out = new Uint8Array(h.nbytes);
  if (h.nbytes === 0) return out;
  if (h.memcpyed) {
    out.set(buf.subarray(16, 16 + h.nbytes));
    return out;
  }
  if (h.compressor !== 1 && h.compressor !== 0) {
    throw new Error(`blosc: compressor code ${h.compressor} not supported (need lz4)`);
  }
  if (h.compressor === 0) throw new Error("blosc: blosclz not implemented");

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nblocks = Math.ceil(h.nbytes / h.blocksize);
  const leftover = h.nbytes % h.blocksize;
  // Split decision, as c-blosc's split_block() with the default "forward compat" mode (lz4 splits).
  const doSplit = h.shuffle && h.typesize > 1 && h.typesize <= MAX_SPLITS && h.blocksize / h.typesize >= MIN_BUFFERSIZE;
  const tmp = new Uint8Array(h.blocksize);

  for (let b = 0; b < nblocks; b++) {
    const isLeftover = b === nblocks - 1 && leftover > 0;
    const bsize = isLeftover ? leftover : h.blocksize;
    let p = dv.getInt32(16 + 4 * b, true);
    // c-blosc never splits the leftover (partial last) block into streams.
    const nstreams = doSplit && !isLeftover ? h.typesize : 1;
    const neblock = Math.floor(bsize / nstreams);
    let written = 0;
    for (let s = 0; s < nstreams; s++) {
      const cb = dv.getInt32(p, true);
      p += 4;
      const streamOut = tmp.subarray(written, written + neblock);
      if (cb === neblock) {
        streamOut.set(buf.subarray(p, p + cb));
      } else if (cb > 0) {
        const n = lz4BlockDecode(buf.subarray(p, p + cb), streamOut);
        if (n !== neblock) throw new Error(`blosc: lz4 stream decoded ${n} bytes, expected ${neblock}`);
      } else {
        throw new Error("blosc: empty stream");
      }
      p += cb;
      written += neblock;
    }
    // Streams shorter than bsize (when bsize is not a multiple of nstreams) leave raw tail bytes.
    if (written < bsize) tmp.set(buf.subarray(p, p + (bsize - written)), written);
    const dst = out.subarray(b * h.blocksize, b * h.blocksize + bsize);
    if (h.shuffle && h.typesize > 1) unshuffle(tmp.subarray(0, bsize), h.typesize, dst);
    else dst.set(tmp.subarray(0, bsize));
  }
  return out;
}
