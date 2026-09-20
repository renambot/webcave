/**
 * A pretend tracking system for testing the bridge without hardware:
 *
 *   npx tsx scripts/fake-tracker.ts dtrack [port=5000]
 *   npx tsx scripts/fake-tracker.ts natnet [dataPort=1511] [commandPort=1510]
 *   npx tsx scripts/fake-tracker.ts vrpn   [port=3883]
 *
 * Each speaks its protocol the way the real product does, as far as the
 * bridge needs: DTrack "6d" and "6df2" ASCII datagrams in millimeters, Z up;
 * NatNet 4 frames (unicast to localhost) with rigid bodies 1 (Head) and 2
 * (Wand), plus SERVERINFO and MODELDEF answers on the command port; a VRPN
 * server with a Tracker0 (sensors 0 and 1), and a Wand0 with buttons and a
 * joystick. The head sways slowly, the wand circles, button 0 toggles every
 * second, the joystick pushes forward.
 */
import { createSocket } from "node:dgram";
import { createServer } from "node:net";

const [, , kind = "dtrack", a1, a2] = process.argv;
const HZ = 60;
let frame = 0;

/** Poses in meters, Y up (CAVE frame): the fakes convert to their own frame. */
function poses(t: number) {
  const head = { p: [0.1 * Math.sin(t), 1.6 + 0.05 * Math.sin(t * 2), 0.1 * Math.cos(t)], q: [0, Math.sin(t * 0.2), 0, Math.cos(t * 0.2)] };
  const wand = { p: [0.2 + 0.1 * Math.cos(t * 2), 1.1, -0.5 + 0.1 * Math.sin(t * 2)], q: [0, 0, 0, 1] };
  return { head, wand, button0: Math.floor(t) % 2 === 0, joy: [0.5, 0] };
}

if (kind === "dtrack") {
  // Z-up, millimeters: tracker (x, y, z) = (cave x, -cave z, cave y). Identity rotation for simplicity.
  const port = Number(a1 ?? 5000);
  const sock = createSocket("udp4");
  const rot = "[1 0 0 0 1 0 0 0 1]";
  setInterval(() => {
    const t = frame / HZ;
    const { head, wand, button0, joy } = poses(t);
    const mm = (p: number[]) => `${(p[0] * 1000).toFixed(1)} ${(-p[2] * 1000).toFixed(1)} ${(p[1] * 1000).toFixed(1)}`;
    const text =
      `fr ${frame}\nts ${t.toFixed(6)}\n` +
      `6d 1 [0 1.000][${mm(head.p)} 0.0 0.0 0.0]${rot}\n` +
      `6df2 1 1 [0 1.000 6 2][${mm(wand.p)}]${rot}[${button0 ? 1 : 0}][${joy[0].toFixed(3)} ${joy[1].toFixed(3)}]\n`;
    sock.send(text, port, "127.0.0.1");
    frame++;
  }, 1000 / HZ);
  console.log(`fake DTrack -> udp 127.0.0.1:${port}`);
} else if (kind === "natnet") {
  const dataPort = Number(a1 ?? 1511);
  const commandPort = Number(a2 ?? 1510);
  const data = createSocket("udp4");
  const cmd = createSocket("udp4");
  const str = (s: string) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.alloc(1)]);
  const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const i16 = (v: number) => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; };
  const f32 = (...v: number[]) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
  const packet = (id: number, payload: Buffer) => { const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE(payload.length, 2); return Buffer.concat([h, payload]); };
  cmd.on("message", (buf, rinfo) => {
    const id = buf.readUInt16LE(0);
    if (id === 0) {
      // NAT_SERVERINFO: appName[256], appVersion[4], natNetVersion[4]
      const p = Buffer.alloc(256 + 8);
      p.write("Fake Motive", 0, "utf8");
      p.set([3, 1, 0, 0], 256);
      p.set([4, 1, 0, 0], 260);
      cmd.send(packet(1, p), rinfo.port, rinfo.address);
    } else if (id === 4) {
      // NAT_MODELDEF, NatNet 4 layout: count, then { type, sizeBytes, body }
      const rb = (name: string, bid: number) => {
        const body = Buffer.concat([str(name), i32(bid), i32(-1), f32(0, 0, 0), i32(0)]);
        return Buffer.concat([i32(1), i32(body.length), body]);
      };
      const ms = Buffer.concat([str("all"), i32(0)]);
      cmd.send(packet(5, Buffer.concat([i32(3), i32(0), i32(ms.length), ms, rb("Head", 1), rb("Wand", 2)])), rinfo.port, rinfo.address);
    }
  });
  cmd.bind(commandPort, () => console.log(`fake Motive command port udp ${commandPort}`));
  setInterval(() => {
    const t = frame / HZ;
    const { head, wand } = poses(t);
    const body = (bid: number, b: { p: number[]; q: number[] }) => Buffer.concat([i32(bid), f32(...b.p), f32(...b.q), f32(0.001), i16(1)]);
    const payload = Buffer.concat([
      i32(frame),
      i32(1), str("all"), i32(0), // one empty marker set
      i32(0), // unlabeled markers
      i32(2), body(1, head), body(2, wand),
      i32(0), i32(0), // skeletons, labeled markers (unused by the bridge)
    ]);
    data.send(packet(7, payload), dataPort, "127.0.0.1");
    frame++;
  }, 1000 / HZ);
  console.log(`fake NatNet 4.1 frames -> udp 127.0.0.1:${dataPort} (unicast)`);
} else if (kind === "vrpn") {
  const port = Number(a1 ?? 3883);
  const message = (type: number, sender: number, payload: Buffer, t: number) => {
    const padded = Math.ceil(payload.length / 8) * 8;
    const b = Buffer.alloc(24 + padded);
    b.writeInt32BE(24 + payload.length, 0);
    b.writeInt32BE(Math.floor(t), 4);
    b.writeInt32BE(Math.floor((t % 1) * 1e6), 8);
    b.writeInt32BE(sender, 12);
    b.writeInt32BE(type, 16);
    b.writeInt32BE(frame, 20);
    payload.copy(b, 24);
    return b;
  };
  const description = (type: -1 | -2, id: number, name: string, t: number) => {
    const p = Buffer.alloc(4 + name.length + 1);
    p.writeInt32BE(name.length + 1, 0);
    p.write(name, 4, "ascii");
    return message(type, id, p, t);
  };
  const posQuat = (sensor: number, b: { p: number[]; q: number[] }) => {
    const p = Buffer.alloc(64);
    p.writeInt32BE(sensor, 0);
    [...b.p, ...b.q].forEach((v, i) => p.writeDoubleBE(v, 8 + i * 8));
    return p;
  };
  const server = createServer((sock) => {
    const t0 = Date.now() / 1000;
    const cookie = Buffer.alloc(24);
    cookie.write("vrpn: ver. 07.38  0", "ascii");
    sock.write(cookie);
    sock.write(Buffer.concat([description(-1, 0, "Tracker0", t0), description(-1, 1, "Wand0", t0), description(-2, 0, "vrpn_Tracker Pos_Quat", t0), description(-2, 1, "vrpn_Button Change", t0), description(-2, 2, "vrpn_Analog Channel", t0)]));
    let lastButton = -1;
    const timer = setInterval(() => {
      const t = Date.now() / 1000;
      const { head, wand, button0, joy } = poses(frame / HZ);
      const parts = [message(0, 0, posQuat(0, head), t), message(0, 0, posQuat(1, wand), t)];
      const analog = Buffer.alloc(24);
      analog.writeDoubleBE(2, 0);
      analog.writeDoubleBE(joy[0], 8);
      analog.writeDoubleBE(joy[1], 16);
      parts.push(message(2, 1, analog, t));
      if ((button0 ? 1 : 0) !== lastButton) {
        lastButton = button0 ? 1 : 0;
        const bp = Buffer.alloc(8);
        bp.writeInt32BE(0, 0);
        bp.writeInt32BE(lastButton, 4);
        parts.push(message(1, 1, bp, t));
      }
      sock.write(Buffer.concat(parts));
      frame++;
    }, 1000 / HZ);
    sock.on("close", () => clearInterval(timer));
    sock.on("error", () => clearInterval(timer));
    sock.on("data", (d) => console.log(`client cookie "${d.toString("ascii", 0, 24).replace(/\0.*$/, "")}"`));
  });
  server.listen(port, () => console.log(`fake VRPN server on tcp ${port}: Tracker0 (sensors 0, 1), Wand0 (buttons, analog)`));
} else {
  console.error("usage: fake-tracker.ts dtrack|natnet|vrpn [port]");
  process.exit(2);
}
