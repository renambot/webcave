/**
 * VRPN client over TCP, in TypeScript, for Tracker, Button and Analog servers.
 *
 * Wire format (vrpn_Connection.C, version 07.xx):
 *   - on connect each side writes a 24-byte cookie: "vrpn: ver. 07.38  0"
 *     zero-padded (the digit is the log mode); only the major version must match
 *   - then messages: a 24-byte header of big-endian int32
 *       [ headerLen(24) + payloadLen, tv_sec, tv_usec, senderId, typeId, seq ]
 *     followed by the payload padded to 8 bytes
 *   - negative type ids are system messages: -1 describes a sender (payload:
 *     int32 length, then the name with its NUL; the header's sender field is
 *     the id), -2 describes a type the same way; the server sends all its
 *     descriptions right after the cookies, so ids are learned before use
 *   - payloads (big-endian):
 *       "vrpn_Tracker Pos_Quat"  int32 sensor, int32 pad, f64 pos[3], f64 quat[4] (x y z w)
 *       "vrpn_Button Change"     int32 button, int32 state
 *       "vrpn_Button States"     int32 n, int32 states[n]
 *       "vrpn_Analog Channel"    f64 n, f64 values[n]
 *
 * We never announce a UDP port, so the server keeps every message on TCP.
 * Sender names are the device names ("Tracker0"); poses are reported as
 * "device/sensor", buttons and analog as the device name. VRPN trackers are
 * in meters by convention, but each server has its own frame: use the
 * calibration.
 */
import { connect, type Socket } from "node:net";
import type { TrackerEvent, TrackerSource } from "./types";

const MAGIC = "vrpn: ver. 07.38";
const COOKIE_SIZE = 24;
const HEADER = 24;
const SENDER_DESCRIPTION = -1;
const TYPE_DESCRIPTION = -2;

export class VrpnParser {
  private buf: Buffer = Buffer.alloc(0);
  private gotCookie = false;
  readonly senders = new Map<number, string>();
  readonly types = new Map<number, string>();

  constructor(private onEvent: (e: TrackerEvent) => void, private log: (m: string) => void) {}

  /** Our cookie: magic, two spaces, log mode 0, zero padded to 24 bytes. */
  static cookie(): Buffer {
    const b = Buffer.alloc(COOKIE_SIZE);
    b.write(`${MAGIC}  0`, "ascii");
    return b;
  }

  push(chunk: Buffer, now: number) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.gotCookie) {
      if (this.buf.length < COOKIE_SIZE) return;
      const cookie = this.buf.toString("ascii", 0, COOKIE_SIZE).replace(/\0.*$/, "");
      const majorOk = cookie.slice(0, MAGIC.lastIndexOf(".")) === MAGIC.slice(0, MAGIC.lastIndexOf("."));
      if (!majorOk) throw new Error(`incompatible VRPN cookie "${cookie}"`);
      this.log(`server cookie "${cookie}"`);
      this.buf = this.buf.subarray(COOKIE_SIZE);
      this.gotCookie = true;
    }
    for (;;) {
      if (this.buf.length < HEADER) return;
      const total = this.buf.readInt32BE(0);
      const sec = this.buf.readInt32BE(4);
      const usec = this.buf.readInt32BE(8);
      const sender = this.buf.readInt32BE(12);
      const type = this.buf.readInt32BE(16);
      const payloadLen = total - HEADER;
      if (payloadLen < 0 || payloadLen > 1_000_000) throw new Error(`bad VRPN message length ${total}`);
      const padded = HEADER + Math.ceil(payloadLen / 8) * 8;
      if (this.buf.length < padded) return;
      const payload = this.buf.subarray(HEADER, HEADER + payloadLen);
      this.buf = this.buf.subarray(padded);
      this.handle(type, sender, payload, sec + usec / 1e6 || now);
    }
  }

  private handle(type: number, sender: number, p: Buffer, time: number) {
    if (type < 0) {
      if (type === SENDER_DESCRIPTION || type === TYPE_DESCRIPTION) {
        const len = p.readInt32BE(0);
        const name = p.toString("ascii", 4, 4 + Math.max(0, len - 1));
        (type === SENDER_DESCRIPTION ? this.senders : this.types).set(sender, name);
        this.log(`${type === SENDER_DESCRIPTION ? "sender" : "type"} ${sender} = "${name}"`);
      }
      return;
    }
    const typeName = this.types.get(type);
    const device = this.senders.get(sender) ?? `sender${sender}`;
    switch (typeName) {
      case "vrpn_Tracker Pos_Quat": {
        if (p.length < 64) return;
        const sensor = p.readInt32BE(0);
        const f = (i: number) => p.readDoubleBE(8 + i * 8);
        this.onEvent({ kind: "pose", id: `${device}/${sensor}`, position: [f(0), f(1), f(2)], rotation: [f(3), f(4), f(5), f(6)], time, tracked: true });
        break;
      }
      case "vrpn_Button Change": {
        const button = p.readInt32BE(0);
        const state = p.readInt32BE(4) !== 0;
        const states = this.buttonState.get(device) ?? [];
        while (states.length <= button) states.push(false);
        states[button] = state;
        this.buttonState.set(device, states);
        this.onEvent({ kind: "buttons", id: device, states: [...states] });
        break;
      }
      case "vrpn_Button States": {
        const n = p.readInt32BE(0);
        const states = Array.from({ length: n }, (_, i) => p.readInt32BE(4 + i * 4) !== 0);
        this.buttonState.set(device, states);
        this.onEvent({ kind: "buttons", id: device, states: [...states] });
        break;
      }
      case "vrpn_Analog Channel": {
        const n = Math.round(p.readDoubleBE(0));
        const values = Array.from({ length: n }, (_, i) => p.readDoubleBE(8 + i * 8));
        this.onEvent({ kind: "analog", id: device, values });
        break;
      }
    }
  }

  /** Button servers send changes one at a time; keep the whole state per device. */
  private buttonState = new Map<string, boolean[]>();
}

export class VrpnSource implements TrackerSource {
  readonly name: string;
  private socket: Socket | null = null;
  private stopped = false;
  constructor(private host: string, private port: number) {
    this.name = `vrpn ${host}:${port}`;
  }

  start(onEvent: (e: TrackerEvent) => void, log: (m: string) => void): Promise<void> {
    return new Promise((resolve) => {
      const open = () => {
        if (this.stopped) return;
        const parser = new VrpnParser(onEvent, log);
        const s = connect(this.port, this.host);
        this.socket = s;
        s.setNoDelay(true);
        s.on("connect", () => {
          log(`connected to ${this.host}:${this.port}`);
          s.write(VrpnParser.cookie());
          resolve();
        });
        s.on("data", (chunk) => {
          try {
            parser.push(chunk, Date.now() / 1000);
          } catch (e) {
            log(`vrpn: ${(e as Error).message}; reconnecting`);
            s.destroy();
          }
        });
        s.on("error", (e) => log(`vrpn: ${e.message}`));
        s.on("close", () => {
          if (!this.stopped) setTimeout(open, 1000);
        });
      };
      open();
    });
  }

  stop() {
    this.stopped = true;
    this.socket?.destroy();
  }
}
