/**
 * Crayoland's creatures: the bees and the butterflies, as deterministic
 * simulations every node can run on its own.
 *
 * The original stepped these with the frame's dt and drand48() on the master
 * and shared the result through CAVElib's shared memory. Here every node
 * steps them itself at a fixed rate (SIM_HZ) from time 0 with a seeded PRNG,
 * so given the same cluster time they are in the same state everywhere, and
 * a node that joins late fast-forwards (a few million trivial steps per hour
 * of session, well under a second). Bee and butterfly logic is ported line
 * for line from Bees.cxx and Butterfly.cxx, with drand48() -> rng.next() and
 * random() % n -> rng.int(n).
 *
 * What the user does to them (bees swarming an intruder, a butterfly landing
 * on the hand) is *not* in these simulations: those reactions come from the
 * controller through the shared app state and are layered on top in
 * index.ts, so they never desynchronize the base simulation.
 *
 * Units: feet, like the World file. Angles in degrees inside the sims, as in
 * the original code.
 */
import type { Vec3 } from "../../core/config";
import { Rng } from "../../core/random";
import type { BeesDef, ButterflyDef } from "./world";

export const SIM_HZ = 60;
const DT = 1 / SIM_HZ;

// ---- Bees -------------------------------------------------------------------

const enum BeeMode {
  HangOut = 1, // at the hive, not drawn
  GoFlower,
  Pollenate,
  GoHive,
}

const BEE_SPEED = 2.0; // ft/s

/** One swarm: N bees commuting between their hive and the flowers. */
export class BeeSim {
  readonly n: number;
  readonly mode: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  /** Heading about +y, degrees. */
  readonly ry: Float32Array;
  private readonly timer: Float32Array;
  private readonly dest: Int32Array;
  private rng: Rng;
  private steps = 0;

  constructor(private def: BeesDef, private seed: number) {
    this.n = def.num;
    this.mode = new Uint8Array(this.n);
    this.x = new Float32Array(this.n);
    this.y = new Float32Array(this.n);
    this.z = new Float32Array(this.n);
    this.ry = new Float32Array(this.n);
    this.timer = new Float32Array(this.n);
    this.dest = new Int32Array(this.n);
    this.rng = new Rng(seed);
    this.reset();
  }

  private reset() {
    this.rng = new Rng(this.seed);
    this.steps = 0;
    const [hx, hy, hz] = this.def.hive;
    for (let i = 0; i < this.n; i++) {
      this.mode[i] = BeeMode.HangOut;
      this.timer[i] = this.rng.int(6);
      this.x[i] = hx + this.rng.jitter();
      this.y[i] = hy + this.rng.jitter();
      this.z[i] = hz + this.rng.jitter();
      this.ry[i] = this.rng.int(360);
    }
  }

  /** Drawn bees are the ones away from the hive. */
  visible(i: number): boolean {
    return this.mode[i] !== BeeMode.HangOut;
  }

  /** Step the simulation up to cluster time `time` (rewinds by restarting). */
  advanceTo(time: number) {
    const target = Math.floor(time * SIM_HZ);
    if (target < this.steps) this.reset();
    while (this.steps < target) {
      this.step();
      this.steps++;
    }
  }

  private step() {
    const rng = this.rng;
    const { hive, flowers } = this.def;
    for (let b = 0; b < this.n; b++) {
      switch (this.mode[b]) {
        case BeeMode.HangOut:
          this.timer[b] -= DT;
          if (this.timer[b] <= 0) {
            this.mode[b] = BeeMode.GoFlower;
            this.dest[b] = flowers.length ? rng.int(flowers.length) : 0;
          } else {
            this.x[b] += rng.jitter() * BEE_SPEED * DT;
            this.y[b] += rng.jitter() * BEE_SPEED * DT;
            this.z[b] += rng.jitter() * BEE_SPEED * DT;
            this.face(b, hive[0] - this.x[b], hive[2] - this.z[b]);
          }
          break;
        case BeeMode.GoFlower: {
          const f = flowers[this.dest[b]] ?? hive;
          let dx = f[0] - this.x[b], dy = f[1] - this.y[b], dz = f[2] - this.z[b];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < 0.25) {
            this.mode[b] = BeeMode.Pollenate;
            this.timer[b] = 3 + rng.next() * 8;
          } else {
            const k = 1 / Math.sqrt(d);
            dx *= k; dy *= k; dz *= k;
            this.x[b] += (dx + (rng.next() - 0.5) * 3) * BEE_SPEED * DT;
            this.y[b] += (dy + (rng.next() - 0.5) * 3) * BEE_SPEED * DT;
            this.z[b] += (dz + (rng.next() - 0.5) * 3) * BEE_SPEED * DT;
            this.face(b, dx, dz);
          }
          break;
        }
        case BeeMode.Pollenate: {
          this.timer[b] -= DT;
          if (this.timer[b] <= 0) {
            this.mode[b] = BeeMode.GoHive;
          } else {
            const f = flowers[this.dest[b]] ?? hive;
            this.x[b] += rng.jitter() * (BEE_SPEED / 2) * DT;
            this.y[b] += rng.jitter() * (BEE_SPEED / 2) * DT;
            this.z[b] += rng.jitter() * (BEE_SPEED / 2) * DT;
            this.face(b, f[0] - this.x[b], f[2] - this.z[b]);
          }
          break;
        }
        case BeeMode.GoHive: {
          let dx = hive[0] - this.x[b], dy = hive[1] - this.y[b], dz = hive[2] - this.z[b];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < 1) {
            this.mode[b] = BeeMode.HangOut;
            this.timer[b] = rng.next() * 8;
          } else {
            const k = 1 / Math.sqrt(d);
            dx *= k; dy *= k; dz *= k;
            this.x[b] += (dx + rng.next() - 0.5) * BEE_SPEED * DT;
            this.y[b] += (dy + rng.next() - 0.5) * BEE_SPEED * DT;
            this.z[b] += (dz + rng.next() - 0.5) * BEE_SPEED * DT;
            this.face(b, dx, dz);
          }
          break;
        }
      }
    }
  }

  /** Heading toward a horizontal direction, as the original: ry = -atan2(dx, -dz). */
  private face(b: number, dx: number, dz: number) {
    this.ry[b] = (-Math.atan2(dx, -dz) * 180) / Math.PI;
  }
}

// ---- Butterflies ------------------------------------------------------------

const MIN_Y = 1, MAX_Y = 8;
const MAX_VY = 1;
const MAX_SPEED = 4;
const MAX_FLAPSPEED = 20;
const MAX_TURN = 180;

/** One butterfly wandering: the WANDER branch of Butterfly::Update, stepped at SIM_HZ. */
export class ButterflySim {
  pos: Vec3;
  /** Heading about +y, degrees. */
  ry = 0;
  /** Wing phase, radians; the wings fold with sin(phase). */
  phase = 0;
  private dry = 90;
  private vy = 0;
  private speed = MAX_SPEED;
  private flapspeed = MAX_FLAPSPEED;
  private rng: Rng;
  private steps = 0;

  constructor(private def: ButterflyDef, private seed: number) {
    this.pos = [...def.pos];
    this.rng = new Rng(seed);
  }

  private reset() {
    this.pos = [...this.def.pos];
    this.ry = 0;
    this.phase = 0;
    this.dry = 90;
    this.vy = 0;
    this.speed = MAX_SPEED;
    this.flapspeed = MAX_FLAPSPEED;
    this.rng = new Rng(this.seed);
    this.steps = 0;
  }

  advanceTo(time: number) {
    const target = Math.floor(time * SIM_HZ);
    if (target < this.steps) this.reset();
    while (this.steps < target) {
      this.step();
      this.steps++;
    }
  }

  private step() {
    const rng = this.rng;
    // Wander()
    this.vy += rng.next() - 0.5;
    this.vy = Math.max(-MAX_VY, Math.min(MAX_VY, this.vy));
    this.dry += rng.jitter() * MAX_TURN * DT;
    this.dry = Math.max(-MAX_TURN, Math.min(MAX_TURN, this.dry));
    if (this.flapspeed < MAX_FLAPSPEED) this.flapspeed += MAX_FLAPSPEED * 2 * DT;
    if (this.speed < MAX_SPEED) this.speed += MAX_SPEED * 2 * DT;
    // Move()
    const p = this.pos;
    p[1] = Math.max(MIN_Y, Math.min(MAX_Y, p[1] + DT * this.vy));
    const r = (this.ry * Math.PI) / 180;
    p[0] -= Math.sin(r) * DT * this.speed;
    p[2] -= Math.cos(r) * DT * this.speed;
    this.phase += DT * this.flapspeed;
    let ry = this.ry + DT * this.dry;
    while (ry > 180) ry -= 360;
    while (ry < -180) ry += 360;
    this.ry = ry;
  }
}

/** Shortest signed difference between two headings in degrees. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}
