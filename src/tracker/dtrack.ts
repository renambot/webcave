/**
 * ART DTrack (DTrack2 / DTrack3) output over UDP: one ASCII datagram per
 * frame, one line per record type. Positions in millimeters, rotations as a
 * 3x3 matrix listed column by column. Records handled:
 *
 *   fr <frame>
 *   ts <seconds>
 *   6d <n> [id qu][sx sy sz ex ey ez][b0 b1 b2 b3 b4 b5 b6 b7 b8] ...          standard bodies
 *   6df2 <nf> <n> [id qu nbt nct][sx sy sz][b0 .. b8][bt ..][ct ..] ...          Flystick2/3: buttons packed in 32-bit ints, joystick floats
 *   6df <n> [id qu bt][sx sy sz ex ey ez][b0 .. b8] ...                          old Flystick: button bitmask
 *
 * Body ids in DTrack are 1-based in the software but 0-based on the wire;
 * this source reports the wire id (what DTrack's monitor calls "id 1" is
 * "0" here). Bodies that are not tracked this frame have quality -1 and are
 * reported with tracked = false. Flysticks appear twice: as a pose ("flystick
 * 0") and as buttons / analog with the same id.
 *
 * Enable "6d" (and "6df2" for Flysticks) in DTrack's Output settings and
 * point it at this machine and port.
 */
import { createSocket } from "node:dgram";
import type { TrackerEvent, TrackerSource } from "./types";
import { mat3ToQuat, type Mat3 } from "./calibration";

/** Every bracketed group of a record line, as numbers. */
function groups(line: string): number[][] {
  const out: number[][] = [];
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1].trim().split(/\s+/).filter(Boolean).map(Number));
  return out;
}

/** DTrack lists the rotation matrix column by column: b0 b1 b2 is the first column. */
function rotation(b: number[]): Mat3 {
  return [b[0], b[3], b[6], b[1], b[4], b[7], b[2], b[5], b[8]];
}

export function parseDTrackDatagram(text: string, now: number): TrackerEvent[] {
  const events: TrackerEvent[] = [];
  let time = now;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.indexOf(" ");
    const tag = sp < 0 ? line : line.slice(0, sp);
    if (tag === "ts") {
      time = Number(line.slice(sp + 1)) || now;
      continue;
    }
    if (tag !== "6d" && tag !== "6df" && tag !== "6df2") continue;
    const g = groups(line);
    if (tag === "6d") {
      // groups per body: [id qu] [sx sy sz ex ey ez] [b0..b8]
      for (let i = 0; i + 2 < g.length; i += 3) {
        const [id, qu] = g[i];
        const p = g[i + 1];
        const b = g[i + 2];
        if (b.length < 9) continue;
        events.push({ kind: "pose", id: String(id), position: [p[0], p[1], p[2]], rotation: mat3ToQuat(rotation(b)), time, tracked: qu >= 0 });
      }
    } else if (tag === "6df2") {
      // groups per flystick: [id qu nbt nct] [sx sy sz] [b0..b8] [bt ..] [ct ..]
      for (let i = 0; i + 4 < g.length; i += 5) {
        const [id, qu, nbt, nct] = g[i];
        const p = g[i + 1];
        const b = g[i + 2];
        const bt = g[i + 3];
        const ct = g[i + 4];
        const fid = `flystick ${id}`;
        if (b.length >= 9) events.push({ kind: "pose", id: fid, position: [p[0], p[1], p[2]], rotation: mat3ToQuat(rotation(b)), time, tracked: qu >= 0 });
        const states: boolean[] = [];
        for (let k = 0; k < nbt; k++) states.push(((bt[Math.floor(k / 32)] ?? 0) >> (k % 32)) & 1 ? true : false);
        events.push({ kind: "buttons", id: fid, states });
        events.push({ kind: "analog", id: fid, values: ct.slice(0, nct) });
      }
    } else {
      // 6df: [id qu bt] [sx sy sz ex ey ez] [b0..b8]; bt is a bitmask of up to 8 buttons
      for (let i = 0; i + 2 < g.length; i += 3) {
        const [id, qu, bt] = g[i];
        const p = g[i + 1];
        const b = g[i + 2];
        const fid = `flystick ${id}`;
        if (b.length >= 9) events.push({ kind: "pose", id: fid, position: [p[0], p[1], p[2]], rotation: mat3ToQuat(rotation(b)), time, tracked: qu >= 0 });
        events.push({ kind: "buttons", id: fid, states: Array.from({ length: 8 }, (_, k) => ((bt >> k) & 1) === 1) });
      }
    }
  }
  return events;
}

export class DTrackSource implements TrackerSource {
  readonly name: string;
  private socket = createSocket("udp4");
  constructor(private port: number) {
    this.name = `dtrack udp :${port}`;
  }
  start(onEvent: (e: TrackerEvent) => void, log: (m: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.on("error", (e) => (log(`dtrack socket error: ${e.message}`), reject(e)));
      this.socket.on("message", (buf) => {
        for (const e of parseDTrackDatagram(buf.toString("ascii"), Date.now() / 1000)) onEvent(e);
      });
      this.socket.bind(this.port, () => {
        log(`listening for DTrack on udp ${this.port}`);
        resolve();
      });
    });
  }
  stop() {
    this.socket.close();
  }
}
