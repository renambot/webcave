/**
 * Crayoland's data files, as Dave Pape's 1995 CAVE program read them.
 *
 * World: one scene element per line.
 *   dir tex                                         texture directory
 *   pict FILE pos=x,y,z orient=rx,ry,rz size=w,h color=aarrggbb texc=u0,v0,u1,v1
 *   pictobj FILE ...                                same, but grabbable (a flower, a rock)
 *   butterfly FILE pos=x,y,z
 *   bees FILE num=N hive=x,y,z size=w,h flower=x,y,z ... sound=F hitsound=F
 *   flies pos=x,y,z num=N size=R
 * Units are feet (the CAVE was a 10 ft cube), Y up, the ground at y = 0.
 * Keywords have aliases (pos/position, orient/orientation/angle, size/scale,
 * num/number, ...), kept here so the original files load unchanged.
 *
 * A picture is an upright quad standing on `pos` (bottom center), `size`
 * wide and tall, rotated by the three Euler angles in degrees. The rotation
 * formula below is the one from Picture.cxx, reproduced rather than
 * re-derived so every tree leans exactly as it did.
 *
 * Sounds: a `directory` line naming the folder of the sample files (relative
 * to the data folder), then one sample per line.
 *   loop FILE pos=x,y,z                             positional loop (a stream)
 *   random FILE pos= length=s prob=p maxampl= minampl=   plays at random when the user is near
 *   trigger FILE pos= radius=r length=              plays once when the user enters the circle
 *   footfall FILE map=IMG area=x0,z0,x1,z1 radius= amplitude=   step sounds by ground type
 */
import type { Vec3 } from "../../core/config";

export interface PictureDef {
  kind: "pict" | "pictobj";
  texture: string;
  /** Bottom center, feet. */
  pos: Vec3;
  /** Rotation about x, y, z in radians. */
  rot: Vec3;
  /** Width and height, feet. */
  size: [number, number];
  /** 0xaarrggbb; only used when textures are off in the original. */
  color: number;
  /** Texture rectangle: lower-left u, v, upper-right u, v. */
  texc: [number, number, number, number];
}

export interface BeesDef {
  texture: string;
  num: number;
  hive: Vec3;
  flowers: Vec3[];
  size: [number, number];
  sound?: string;
  hitsound?: string;
}

export interface ButterflyDef {
  texture: string;
  pos: Vec3;
}

export interface FliesDef {
  pos: Vec3;
  radius: number;
  num: number;
}

export interface World {
  textureDir: string;
  pictures: PictureDef[];
  bees: BeesDef[];
  butterflies: ButterflyDef[];
  flies: FliesDef[];
}

const DTOR = Math.PI / 180;

function nums(v: string): number[] {
  return v.split(",").map((s) => Number(s.trim()));
}

function vec3(v: string, fallback: Vec3 = [0, 0, 0]): Vec3 {
  const n = nums(v);
  return [n[0] ?? fallback[0], n[1] ?? fallback[1], n[2] ?? fallback[2]];
}

/** Split "key=value" options; keys are lower-cased. */
function options(tokens: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const t of tokens) {
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).toLowerCase();
    const v = t.slice(eq + 1);
    const list = m.get(k) ?? [];
    list.push(v);
    m.set(k, list);
  }
  return m;
}

const first = (m: Map<string, string[]>, ...keys: string[]) => {
  for (const k of keys) {
    const v = m.get(k);
    if (v && v.length) return v[0];
  }
  return undefined;
};

export function parseWorld(text: string): World {
  const w: World = { textureDir: "", pictures: [], bees: [], butterflies: [], flies: [] };
  for (const raw of text.split(/\r?\n/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens[0].startsWith("#")) continue;
    const type = tokens[0].toLowerCase();
    switch (type) {
      case "dir":
      case "directory":
        w.textureDir = tokens[1] ?? "";
        break;
      case "pict":
      case "picture":
      case "pictobj":
      case "pictureobject": {
        const o = options(tokens.slice(2));
        const rotDeg = vec3(first(o, "orientation", "orient", "angle") ?? "0,0,0");
        const size = nums(first(o, "size", "scale") ?? "1,1");
        const texc = nums(first(o, "texc", "texcoords") ?? "0,0,1,1");
        w.pictures.push({
          kind: type.startsWith("pictobj") || type === "pictureobject" ? "pictobj" : "pict",
          texture: tokens[1],
          pos: vec3(first(o, "position", "pos") ?? "0,0,0"),
          rot: [rotDeg[0] * DTOR, rotDeg[1] * DTOR, rotDeg[2] * DTOR],
          size: [size[0] ?? 1, size[1] ?? size[0] ?? 1],
          color: parseInt(first(o, "color") ?? "ffffffff", 16),
          texc: [texc[0] ?? 0, texc[1] ?? 0, texc[2] ?? 1, texc[3] ?? 1],
        });
        break;
      }
      case "butterfly": {
        const o = options(tokens.slice(2));
        w.butterflies.push({ texture: tokens[1], pos: vec3(first(o, "position", "pos") ?? "0,2,0") });
        break;
      }
      case "bees":
      case "bee": {
        const o = options(tokens.slice(2));
        const size = nums(first(o, "size") ?? "0.2,0.2");
        w.bees.push({
          texture: tokens[1],
          num: Number(first(o, "num", "number") ?? 8),
          hive: vec3(first(o, "hive", "hivepos", "hiveposition") ?? "0,5,0"),
          flowers: (o.get("flower") ?? o.get("flowerpos") ?? o.get("flowerposition") ?? []).map((v) => vec3(v)),
          size: [size[0] ?? 0.2, size[1] ?? size[0] ?? 0.2],
          sound: first(o, "sound", "soundfile"),
          hitsound: first(o, "hitsound", "hitsoundfile"),
        });
        break;
      }
      case "flies":
      case "fly": {
        const o = options(tokens.slice(1));
        w.flies.push({
          pos: vec3(first(o, "position", "pos") ?? "0,0,0"),
          radius: Number(first(o, "radius", "size", "scale") ?? 1),
          num: Number(first(o, "number", "num", "count") ?? 1),
        });
        break;
      }
      default:
        console.warn(`[crayoland] World: unknown element type "${tokens[0]}"`);
    }
  }
  return w;
}

/**
 * The two in-plane axes of a picture quad for rotation (rx, ry, rz), exactly
 * as Picture::GLInitialize computes its vertices. X runs along the width,
 * Y along the height; for zero rotation they are +x and +y.
 */
export function pictureAxes(rot: Vec3): { x: Vec3; y: Vec3 } {
  const [rx, ry, rz] = rot;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return {
    x: [cy * cz + sy * sx * sz, cx * sz, -sy * cz + cy * sx * sz],
    y: [-cy * sz + sy * sx * cz, cz * cx, sy * sz + cy * sx * cz],
  };
}

// ---- Sounds ---------------------------------------------------------------

export type SampleType = "background" | "loop" | "random" | "trigger" | "footfall";

export interface SampleDef {
  type: SampleType;
  file: string;
  /** Seconds the sample lasts (the original had no way to ask the sound server). */
  length: number;
  pos: Vec3;
  radius: number;
  probability: number;
  minAmpl: number;
  maxAmpl: number;
  /** footfall: ground-type mask image and the world rectangle it covers (x0, z0, x1, z1). */
  map?: string;
  area?: [number, number, number, number];
}

export interface SoundsFile {
  /** Folder of the sample files, relative to the data folder ("audio" by default). */
  directory: string;
  samples: SampleDef[];
}

export function parseSounds(text: string): SoundsFile {
  const out: SampleDef[] = [];
  let directory = "audio";
  for (const raw of text.split(/\r?\n/)) {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens[0].startsWith("#")) continue;
    const type = tokens[0].toLowerCase();
    if (type === "dir" || type === "directory") {
      if (tokens[1]) directory = tokens[1].replace(/\/+$/, "");
      continue;
    }
    if (!["background", "loop", "random", "trigger", "footfall"].includes(type) || !tokens[1]) {
      console.warn(`[crayoland] Sounds: cannot parse "${raw}"`);
      continue;
    }
    const o = options(tokens.slice(2));
    const ampl = first(o, "amplitude", "ampl");
    const area = first(o, "area");
    const areaN = area ? nums(area) : null;
    out.push({
      type: type as SampleType,
      file: tokens[1],
      length: Number(first(o, "length", "len") ?? 0),
      pos: vec3(first(o, "position", "pos") ?? "0,0,0"),
      radius: Number(first(o, "radius", "rad") ?? 1),
      probability: Number(first(o, "probability", "prob") ?? 0.001),
      minAmpl: Number(ampl ?? first(o, "minampl", "minamplitude") ?? 0.1),
      maxAmpl: Number(ampl ?? first(o, "maxampl", "maxamplitude") ?? 0.25),
      map: first(o, "map"),
      area: areaN && areaN.length === 4 ? [areaN[0], areaN[1], areaN[2], areaN[3]] : undefined,
    });
  }
  return { directory, samples: out };
}
