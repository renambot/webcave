/**
 * OptiTrack NatNet (Motive's streaming protocol), binary UDP, little-endian.
 *
 * Data arrives on the data port (multicast 239.255.42.99:1511 by default) as
 * NAT_FRAMEOFDATA packets:
 *
 *   uint16 messageId (7)   uint16 payloadBytes
 *   int32  frameNumber
 *   int32  nMarkerSets   { cstring name; int32 n; n x float[3] }
 *   int32  nUnlabeled    n x float[3]
 *   int32  nRigidBodies  { int32 id; float x y z; float qx qy qz qw;
 *                          (NatNet < 3: marker block) ; float meanError (>= 2);
 *                          int16 params (>= 2.6, bit 0 = tracked) }
 *   ... skeletons, labeled markers, force plates, devices, timing
 *
 * Only rigid bodies are needed, and they come before the version-sensitive
 * tail, so parsing stops after them. The NatNet version is asked from the
 * command port with NAT_CONNECT (the answer, NAT_SERVERINFO, carries it),
 * and NAT_REQUEST_MODELDEF gives the asset names so the config can say
 * "Head" instead of a streaming id. Both are best effort: without an answer
 * the source assumes NatNet 3+ and ids only.
 *
 * Motive streams Y-up in meters by default (both configurable in Motive);
 * the calibration's units and axes take care of other choices.
 */
import { createSocket, type Socket } from "node:dgram";
import type { TrackerEvent, TrackerSource } from "./types";

const NAT_CONNECT = 0;
const NAT_SERVERINFO = 1;
const NAT_REQUEST_MODELDEF = 4;
const NAT_MODELDEF = 5;
const NAT_FRAMEOFDATA = 7;

class Reader {
  off = 0;
  constructor(private b: Buffer) {}
  i16() { const v = this.b.readInt16LE(this.off); this.off += 2; return v; }
  u16() { const v = this.b.readUInt16LE(this.off); this.off += 2; return v; }
  i32() { const v = this.b.readInt32LE(this.off); this.off += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.off); this.off += 4; return v; }
  skip(n: number) { this.off += n; }
  cstring() {
    const end = this.b.indexOf(0, this.off);
    const s = this.b.toString("utf8", this.off, end < 0 ? this.b.length : end);
    this.off = end < 0 ? this.b.length : end + 1;
    return s;
  }
  get left() { return this.b.length - this.off; }
}

export interface NatNetVersion { major: number; minor: number }

/** Rigid bodies of a NAT_FRAMEOFDATA packet. Returns null for other message ids. */
export function parseFrameOfData(buf: Buffer, v: NatNetVersion, now: number): TrackerEvent[] | null {
  const r = new Reader(buf);
  const id = r.u16();
  r.u16(); // payload size
  if (id !== NAT_FRAMEOFDATA) return null;
  r.i32(); // frame number
  const nSets = r.i32();
  for (let s = 0; s < nSets; s++) {
    r.cstring();
    r.skip(r.i32() * 12);
  }
  r.skip(r.i32() * 12); // unlabeled markers
  const nBodies = r.i32();
  const events: TrackerEvent[] = [];
  for (let b = 0; b < nBodies; b++) {
    const bodyId = r.i32();
    const position: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    const rotation: [number, number, number, number] = [r.f32(), r.f32(), r.f32(), r.f32()];
    if (v.major < 3 && v.major !== 0) {
      const n = r.i32();
      r.skip(n * 12); // marker positions
      if (v.major >= 2) r.skip(n * 4 + n * 4); // ids, sizes
    }
    let tracked = true;
    if (v.major >= 2 || v.major === 0) r.f32(); // mean marker error
    if ((v.major === 2 && v.minor >= 6) || v.major > 2 || v.major === 0) tracked = (r.i16() & 0x01) !== 0;
    events.push({ kind: "pose", id: String(bodyId), position, rotation, time: now, tracked });
  }
  return events;
}

/** Asset names from a NAT_MODELDEF packet: rigid body id -> name. Throws on layouts it does not understand. */
export function parseModelDef(buf: Buffer, v: NatNetVersion): Map<number, string> {
  const r = new Reader(buf);
  if (r.u16() !== NAT_MODELDEF) return new Map();
  r.u16();
  const names = new Map<number, string>();
  const n = r.i32();
  for (let i = 0; i < n; i++) {
    const type = r.i32();
    // NatNet 4 prefixes each description with its byte size, which makes skipping exact.
    const size = v.major >= 4 ? r.i32() : -1;
    const start = r.off;
    if (type === 1) {
      const name = r.cstring();
      const id = r.i32();
      names.set(id, name);
      if (size < 0) {
        r.i32(); // parent id
        r.skip(12); // offset
        if (v.major >= 3) {
          const nm = r.i32();
          r.skip(nm * 12 + nm * 4);
          if (v.major >= 4) for (let k = 0; k < nm; k++) r.cstring();
        }
      }
    } else if (size < 0) {
      // Without sizes only marker sets (type 0) can be skipped reliably; stop at anything else.
      if (type !== 0) break;
      r.cstring();
      const nm = r.i32();
      for (let k = 0; k < nm; k++) r.cstring();
    }
    if (size >= 0) r.off = start + size;
    if (r.left <= 0) break;
  }
  return names;
}

export class NatNetSource implements TrackerSource {
  readonly name: string;
  private data: Socket | null = null;
  private cmd: Socket | null = null;
  private version: NatNetVersion = { major: 0, minor: 0 };
  private names = new Map<number, string>();

  constructor(private opts: { server: string; multicast: string; dataPort: number; commandPort: number }) {
    this.name = `natnet ${opts.multicast || "unicast"}:${opts.dataPort} (${opts.server})`;
  }

  async start(onEvent: (e: TrackerEvent) => void, log: (m: string) => void): Promise<void> {
    // Command channel: ask Motive its version and the asset names. Answers are optional.
    this.cmd = createSocket("udp4");
    this.cmd.on("message", (buf) => {
      const id = buf.readUInt16LE(0);
      if (id === NAT_SERVERINFO && buf.length >= 4 + 256 + 8) {
        const app = buf.toString("utf8", 4, buf.indexOf(0, 4));
        this.version = { major: buf[4 + 256 + 4], minor: buf[4 + 256 + 5] };
        log(`Motive "${app}" speaks NatNet ${this.version.major}.${this.version.minor}`);
        this.request(NAT_REQUEST_MODELDEF);
      } else if (id === NAT_MODELDEF) {
        try {
          this.names = parseModelDef(buf, this.version);
          log(`assets: ${[...this.names].map(([i, n]) => `${n}=${i}`).join(", ") || "none"}`);
        } catch (e) {
          log(`model definitions not understood (${(e as Error).message}); use streaming ids in the config`);
        }
      }
    });
    this.cmd.on("error", (e) => log(`natnet command socket: ${e.message}`));
    await new Promise<void>((res) => this.cmd!.bind(0, res));
    this.request(NAT_CONNECT);

    // Data channel: multicast group or unicast to this host.
    this.data = createSocket({ type: "udp4", reuseAddr: true });
    this.data.on("error", (e) => log(`natnet data socket: ${e.message}`));
    this.data.on("message", (buf) => {
      let events: TrackerEvent[] | null;
      try {
        events = parseFrameOfData(buf, this.version, Date.now() / 1000);
      } catch (e) {
        log(`frame not parsed: ${(e as Error).message}`);
        return;
      }
      if (!events) return;
      for (const e of events) {
        if (e.kind === "pose") e.name = this.names.get(Number(e.id));
        onEvent(e);
      }
    });
    await new Promise<void>((res) => this.data!.bind(this.opts.dataPort, res));
    if (this.opts.multicast) {
      this.data.addMembership(this.opts.multicast);
      log(`joined ${this.opts.multicast}:${this.opts.dataPort}`);
    } else {
      log(`listening for unicast NatNet on udp ${this.opts.dataPort}`);
    }
  }

  private request(id: number) {
    const b = Buffer.alloc(4);
    b.writeUInt16LE(id, 0);
    b.writeUInt16LE(0, 2);
    this.cmd?.send(b, this.opts.commandPort, this.opts.server);
  }

  stop() {
    this.data?.close();
    this.cmd?.close();
  }
}
