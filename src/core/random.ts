/**
 * Deterministic randomness for applications.
 *
 * Nothing in a WebCAVE app may call Math.random() for anything that is drawn:
 * every node would get different numbers and the walls would disagree. These
 * helpers give the same numbers on every node, from seeds the app chooses:
 *
 *   hash(a, b, c)     integer hash of up to three integers -> [0, 1). Use it
 *                     for per-frame jitter: hash(frame, i) is the same on
 *                     every node and needs no state (a late-joining node
 *                     gets the same value without replaying history).
 *   Rng(seed)         a small PRNG (mulberry32) with next(), range(), int(),
 *                     for stepped simulations that consume numbers in a fixed
 *                     order from a fixed start.
 *   noise1(t, seed)   smooth value noise in [-1, 1] as a function of
 *                     continuous time: a "random walk" that any node can
 *                     evaluate at any time without integrating.
 *
 * Sounds that only one machine plays may use Math.random() freely; nobody
 * compares them.
 */

function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash up to three integers to a float in [0, 1). Deterministic and stateless. */
export function hash(a: number, b = 0, c = 0): number {
  const h = mix((mix((a | 0) + 0x9e3779b9) ^ (b | 0)) + 0x85ebca6b) ^ mix((c | 0) + 0xc2b2ae35);
  return (mix(h) >>> 8) / 16777216;
}

/** Seeded PRNG (mulberry32): fast, tiny state, adequate for animation. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed | 0) >>> 0 || 0x6d2b79f5;
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** Triangular in (-1, 1), like drand48() + drand48() - 1: a common "jitter" shape. */
  jitter(): number {
    return this.next() + this.next() - 1;
  }
}

/** Smooth value noise in [-1, 1]: cubic interpolation of hashed lattice values, one lattice step per unit of t. */
export function noise1(t: number, seed = 0): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash(i, seed) * 2 - 1;
  const b = hash(i + 1, seed) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}
