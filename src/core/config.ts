/**
 * Runtime cluster configuration: the in-memory shape every part of WebCAVE
 * works with. Configurations are *written* as JSON files in configs/ and
 * turned into this shape by core/configFile.ts (validation, defaults, screen
 * placement -> corners). Nothing here is read from disk.
 *
 * Vocabulary
 *   screen   a physical display surface: three corners in meters plus pixel size
 *   node     a computer; renders one or more screens, one browser window each
 *   stereo   how a screen's two eye images are packed for its display
 *   app      which application the whole cluster runs
 *
 * Units: meters, radians at runtime (degrees only in the JSON placement
 * form). Frame: Y up, right-handed, physical floor at y = 0, viewer near the
 * origin looking toward -z. Screen corners follow Kooima: pa lower-left, pb
 * lower-right, pc upper-left; the normal (pb-pa) x (pc-pa) must point toward
 * the viewer, or the image is mirrored.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

/** Output packing mode; see SPECIFICATION "Stereo and output modes". */
export type StereoMode =
  | "mono"
  | "side-by-side" // double-wide canvas, full-res eyes
  | "side-by-side-half" // canvas at screen size, eyes squeezed to half width
  | "top-bottom"
  | "top-bottom-half"
  | "row-interleaved"
  | "column-interleaved"
  | "checkerboard"
  | "anaglyph"
  | "frame-sequential"; // experimental: parity from cluster frame counter

/**
 * Anaglyph method, both for red-cyan glasses.
 *   "dubois" - Dubois least-squares optimized matrices, keeps colour
 *   "bw"     - black-and-white: each eye's luminance drives its filter colour,
 *              no colour rivalry at all
 */
export type AnaglyphScheme = "dubois" | "bw";

export interface StereoParams {
  mode: StereoMode;
  /** Interpupillary distance in meters. */
  eyeSeparation: number;
  swapEyes: boolean;
  /** For interleaved modes: which eye owns row/column/pixel 0. */
  firstEye: "left" | "right";
  /** Pixel phase compensation for windows not starting on an even row/column. */
  phaseX: number;
  phaseY: number;
  anaglyph: AnaglyphScheme;
  /** Which eye a mono viewport renders from. */
  monoEye: "center" | "left" | "right";
}

export const defaultStereo: StereoParams = {
  mode: "mono",
  eyeSeparation: 0.065,
  swapEyes: false,
  firstEye: "left",
  phaseX: 0,
  phaseY: 0,
  anaglyph: "dubois",
  monoEye: "center",
};

/** A planar screen defined by three corners (Kooima convention). */
export interface ScreenConfig {
  id: string;
  /** Lower-left corner. */
  pa: Vec3;
  /** Lower-right corner. */
  pb: Vec3;
  /** Upper-left corner. */
  pc: Vec3;
  /** Native pixel size of the display. */
  widthPx: number;
  heightPx: number;
  stereo?: Partial<StereoParams>;
}

export interface NodeConfig {
  id: string;
  /** Screen ids this node renders (one window each). */
  screens: string[];
  /** Whether this node's windows may take keyboard, mouse and gamepad input and steer the cluster. Default false. */
  input?: boolean;
  /**
   * Whether this node plays the application's sound (the machine wired to the
   * speakers). Default false: a cluster has many render machines and one
   * sound system, so exactly one node (or the simulator with ?audio=1) should
   * have it. Apps receive it as AppContext.audio.
   */
  audio?: boolean;
}

/** Which application the cluster runs; see src/apps. */
export interface AppSpec {
  name: string;
  url?: string;
  size?: number;
  position?: Vec3;
  spin?: number;
  /** Free-form per-app options (see each app's index.ts). */
  options?: Record<string, unknown>;
}

export interface ClusterConfig {
  name: string;
  fps: number;
  /** Application every node runs. Defaults to "shapes". */
  app: AppSpec;
  /** Frame synchronization tier. */
  sync: "loose" | "barrier";
  /** Barrier timeout in ms before the manager forces a present. */
  barrierTimeoutMs: number;
  /** Default head pose when nothing is tracking. */
  defaultHead: { position: Vec3; orientation: Quat };
  /**
   * Where the wand sits relative to the head when no tracker reports it, in a
   * frame at the head turned by the head's yaw: a hand in front of and below
   * the eyes, moving with the body but not with the gaze.
   */
  defaultWand: { position: Vec3; orientation: Quat };
  near: number;
  far: number;
  stereo: StereoParams;
  screens: ScreenConfig[];
  nodes: NodeConfig[];
}

export function resolveStereo(cfg: ClusterConfig, screen: ScreenConfig): StereoParams {
  return { ...cfg.stereo, ...(screen.stereo ?? {}) };
}
