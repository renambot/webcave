/**
 * Crayoland's soundscape, on the one window that has AppContext.audio.
 *
 * A port of audio.cxx from the "bergen" sound server to Web Audio. Sample
 * files are whatever the Sounds file names (MP3 here, converted from the
 * original AIFF), fetched from its `directory` under the data folder.
 *   loop      always playing, gain from the user's distance (the stream)
 *   random    when silent, starts with `probability` per update; gain by distance
 *   trigger   starts once when the user enters its circle, re-arms on leaving
 *   footfall  when the user has walked `radius` since the last step, looks the
 *             ground type up in a mask image (lake, floorboards) and plays
 *   bees      the hive's hum: gain from how many bees are within earshot,
 *             tripled when they are angry; a thud when the hive is hit
 * Distance attenuation is the original's linear falloff to 40 ft.
 *
 * Sound is a local effect: only the audio window runs this, nobody compares
 * it with another node, so Math.random() is fine here. Browsers only start
 * audio after a gesture, so the context is created on the first click or key
 * press and everything waits until then.
 */
import type { Vec3 } from "../../core/config";
import type { SampleDef, SoundsFile } from "./world";

const MAX_AUDIBLE_DISTSQ = 1600;
const BEE_MAX_AUDIBLE_DISTSQ = 400;
const BEE_MAX_AMPLITUDE = 0.15;
const BEE_AMPLITUDE_PER_BEE = 0.025;

interface Sample {
  def: SampleDef;
  buffer: AudioBuffer | null;
  gain: GainNode | null;
  source: AudioBufferSourceNode | null;
  endTime: number;
  latched: boolean;
  ampl: number;
  /** footfall: mask pixels (0 = silent) and its size. */
  mask?: { data: Uint8ClampedArray; w: number; h: number };
  /** footfall: where the last step sounded. */
  last: Vec3;
}

function distSq(a: Vec3, b: Vec3) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Original ComputeAmplitude: linear falloff to MAX_AUDIBLE distance, then silence. */
function attenuation(distsq: number, max = MAX_AUDIBLE_DISTSQ) {
  return distsq > max - 1 ? 0 : (max - distsq) / max;
}

export class Soundscape {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private samples: Sample[] = [];
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private bees: { gain: GainNode; source: AudioBufferSourceNode } | null = null;
  private beeAmpl = 0;
  private hitBuffer: AudioBuffer | null = null;
  private dir: string;
  private loaded = false;
  private loading = false;
  private gestureEvents = ["pointerdown", "keydown", "touchend"] as const;
  private onGesture = () => void this.start();
  status = "audio: click the page to start";

  /**
   * @param base       URL of the data folder (the Sounds file's `directory` and the mask images are relative to it)
   * @param sounds     parsed Sounds file
   * @param beeSound   the hive's loop and hit sample file names, if any
   */
  constructor(private base: string, sounds: SoundsFile, private beeSound: { loop?: string; hit?: string }) {
    this.dir = sounds.directory;
    this.samples = sounds.samples.map((def) => ({ def, buffer: null, gain: null, source: null, endTime: 0, latched: false, ampl: 0, last: [1e9, 0, 1e9] }));
    // Keep listening until the context really runs: a browser may refuse the
    // first gesture (a modifier key, a synthetic event, a popup without
    // activation) and only honour a later one.
    for (const ev of this.gestureEvents) window.addEventListener(ev, this.onGesture);
  }

  private url(file: string) {
    return `${this.base}${this.dir}/${file}`;
  }

  private load(file: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(file);
    if (!p) {
      p = fetch(this.url(file))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${this.url(file)}`))))
        .then((ab) => this.ctx!.decodeAudioData(ab))
        .catch((e) => (console.warn(`[crayoland] sound: ${(e as Error).message}`), null));
      this.buffers.set(file, p);
    }
    return p;
  }

  private async loadMask(s: Sample) {
    if (!s.def.map) return;
    const img = new Image();
    img.src = `${this.base}${s.def.map}`;
    await img.decode().catch(() => {});
    if (!img.naturalWidth) return;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    const mask = new Uint8ClampedArray(c.width * c.height);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4];
    s.mask = { data: mask, w: c.width, h: c.height };
  }

  /** Start now, from a caller that has a user gesture (a button handler); otherwise the next gesture starts it. */
  enable(): Promise<void> {
    return this.start();
  }

  /** Called on every gesture until the context is running; creates and loads once. */
  private async start() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.ctx.addEventListener("statechange", () => {
        if (this.ctx?.state === "running") for (const ev of this.gestureEvents) window.removeEventListener(ev, this.onGesture);
        this.updateStatus();
      });
    }
    // resume() only settles once the browser accepts a gesture, so do not await it:
    // the state change above reports success, and loading proceeds meanwhile.
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
    this.updateStatus();
    if (this.loaded) return;
    this.loaded = true;
    this.loading = true;
    await this.loadAll();
    this.loading = false;
    this.updateStatus();
  }

  private updateStatus() {
    const n = this.samples.filter((s) => s.buffer).length;
    const load = this.loading ? ", loading" : this.loaded && n < this.samples.length ? `, ${this.samples.length - n} missing` : "";
    this.status = this.ctx?.state === "running" ? `audio: on${load}` : `audio: click the page to start${load}`;
  }

  private async loadAll() {
    await Promise.all([
      ...this.samples.map(async (s) => {
        s.buffer = await this.load(s.def.file);
        s.gain = this.ctx!.createGain();
        s.gain.gain.value = 0;
        s.gain.connect(this.master!);
        if (s.def.type === "footfall") await this.loadMask(s);
        if (s.def.type === "loop" && s.buffer) s.source = this.play(s, true);
      }),
      (async () => {
        if (!this.beeSound.loop) return;
        const buf = await this.load(this.beeSound.loop);
        if (!buf) return;
        const gain = this.ctx!.createGain();
        gain.gain.value = 0;
        gain.connect(this.master!);
        const source = this.ctx!.createBufferSource();
        source.buffer = buf;
        source.loop = true;
        source.connect(gain);
        source.start();
        this.bees = { gain, source };
      })(),
      (async () => {
        if (this.beeSound.hit) this.hitBuffer = await this.load(this.beeSound.hit);
      })(),
    ]);
  }

  private play(s: Sample, loop = false): AudioBufferSourceNode | null {
    if (!this.ctx || !s.buffer || !s.gain) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = s.buffer;
    src.loop = loop;
    src.connect(s.gain);
    src.start();
    return src;
  }

  private setGain(s: Sample, ampl: number) {
    if (s.gain && Math.abs(ampl - s.ampl) > 0.001) {
      s.gain.gain.setTargetAtTime(ampl, this.ctx!.currentTime, 0.05);
      s.ampl = ampl;
    }
  }

  /** Play the hive's hit sound once (the controller reported a hit). */
  hitHive() {
    if (!this.ctx || !this.hitBuffer || !this.master) return;
    const g = this.ctx.createGain();
    g.gain.value = 0.75;
    g.connect(this.master);
    const src = this.ctx.createBufferSource();
    src.buffer = this.hitBuffer;
    src.connect(g);
    src.start();
  }

  /**
   * Per frame. `user` is the head in world feet; `bees` the drawn bees'
   * positions (world feet) with whether they are angry.
   */
  update(time: number, user: Vec3, bees: { positions: ArrayLike<number>; count: number; angry: boolean }) {
    if (!this.ctx) return;
    for (const s of this.samples) {
      const d = s.def;
      switch (d.type) {
        case "loop":
          this.setGain(s, d.maxAmpl * attenuation(distSq(user, d.pos)));
          break;
        case "background":
        case "random":
          if (s.endTime < time && Math.random() < d.probability) {
            s.ampl = 0;
            this.play(s);
            s.endTime = time + d.length;
          }
          if (s.endTime > time) this.setGain(s, d.maxAmpl * attenuation(distSq(user, d.pos)));
          break;
        case "trigger": {
          if (s.endTime < time) {
            const dx = user[0] - d.pos[0], dz = user[2] - d.pos[2];
            if (dx * dx + dz * dz < d.radius * d.radius) {
              if (!s.latched) {
                s.ampl = 0;
                this.play(s);
                s.endTime = time + d.length;
                s.latched = true;
              }
            } else s.latched = false;
          }
          if (s.endTime > time) this.setGain(s, d.maxAmpl * attenuation(distSq(user, d.pos)));
          break;
        }
        case "footfall": {
          if (s.endTime > time) break;
          if (s.mask && d.area) {
            const [x0, z0, x1, z1] = d.area;
            const ix = Math.floor(((user[0] - x0) * s.mask.w) / (x1 - x0));
            const iz = Math.floor(((user[2] - z0) * s.mask.h) / (z1 - z0));
            if (ix < 0 || ix >= s.mask.w || iz < 0 || iz >= s.mask.h) break;
            // The original read SGI images, whose first row is the bottom of the
            // picture; the PNG masks keep that picture, so row 0 (top) is z1.
            if (!s.mask.data[ix + (s.mask.h - 1 - iz) * s.mask.w]) break;
          }
          const foot: Vec3 = [user[0], 0, user[2]];
          if (distSq(foot, s.last) > d.radius * d.radius) {
            this.setGain(s, d.maxAmpl);
            this.play(s);
            s.endTime = time + d.length;
            s.last = foot;
          }
          break;
        }
      }
    }
    if (this.bees) {
      const mult = bees.angry ? 3 : 1;
      let ampl = 0;
      for (let i = 0; i < bees.count; i++) {
        const dx = bees.positions[i * 3] - user[0], dy = bees.positions[i * 3 + 1] - user[1], dz = bees.positions[i * 3 + 2] - user[2];
        ampl += BEE_AMPLITUDE_PER_BEE * mult * attenuation(dx * dx + dy * dy + dz * dz, BEE_MAX_AUDIBLE_DISTSQ);
      }
      ampl = Math.min(ampl, BEE_MAX_AMPLITUDE * mult);
      if (Math.abs(ampl - this.beeAmpl) > 0.0025) {
        this.bees.gain.gain.setTargetAtTime(ampl, this.ctx.currentTime, 0.1);
        this.beeAmpl = ampl;
      }
    }
  }

  dispose() {
    for (const ev of this.gestureEvents) window.removeEventListener(ev, this.onGesture);
    void this.ctx?.close();
    this.ctx = null;
  }
}
