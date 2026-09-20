/**
 * The application contracts.
 *
 * WebCAVE runs two kinds of application:
 *
 *   "scene" apps (CaveApp)   own a three.js scene. WebCAVE renders it from
 *                            each screen's off-axis camera, handles stereo and
 *                            navigation. This is the 3D, head-tracked case.
 *                            Examples: shapes, gltf.
 *
 *   "flat" apps (FlatApp)    render themselves, 2D, into a DOM container that
 *                            WebCAVE gives them per screen, together with the
 *                            screen's rectangle in the overall wall image.
 *                            Stereo and off-axis projection do not apply.
 *                            Example: map (MapLibre).
 *
 *   "raw" apps (RawApp)      draw with their own WebGL code. WebCAVE owns the
 *                            context, the render targets and the cameras, and
 *                            calls render() once per eye with the off-axis
 *                            view and projection matrices; the app owns its
 *                            shaders, buffers and draw calls. For existing
 *                            WebGL programs. Example: aquarium.
 *
 *   "webgpu" apps (WebGpuApp) draw with WebGPU into an offscreen canvas that
 *                            WebCAVE provides per eye; WebCAVE copies the result
 *                            into the eye target, so stereo packing and the rest
 *                            stay in WebGL. Same matrices as raw apps. Example:
 *                            metaballs.
 *
 * Both kinds share one rule that keeps a cluster in step: what is drawn must
 * be a function of the FrameState the Manager broadcast for that frame, never
 * of local wall-clock time or local input. For scene apps that means
 * update(time). For flat apps it means reading the camera or document state
 * from `state.appState`, which the Manager owns and controllers modify.
 *
 * Coordinate frame scene apps see (the "CAVE frame", before navigation):
 *   - meters, Y up, right-handed
 *   - the physical floor is y = 0, the viewer stands near the origin at
 *     about 1.6 m eye height, looking toward -z
 *   - for the 3 m CAVE preset the walls are at x = ±1.5 and z = -1.5
 */
import type * as THREE from "three";
import type { AppSpec, ScreenConfig, Vec3 } from "../core/config";
import type { FrameState } from "../core/protocol";
import type { WallLayout } from "../core/wall";
import type { ActionState } from "../input/actions";

/**
 * Optional per-frame hook run on a *controller* (the simulator or another
 * input-bearing page), never on wall nodes. `actions` is the merged device
 * state, `dt` the seconds since the last call. Use `send` to patch the shared
 * app state; whatever you send comes back to every node in the next frame,
 * which is how an app reacts to input deterministically. Standard actions
 * (move, look, fly, reset, spin) are already bound to navigation and the spin
 * clock by the controller; apps typically use the buttons, or take over the
 * axes when navigation makes no sense for them (the map pans and zooms).
 */
export type InputHook = (actions: ActionState, dt: number, state: FrameState, send: (patch: Record<string, unknown>) => void) => void;

/**
 * Where an application instance runs. Passed to AppDefinition.create() so an
 * app can adapt to its host window without reading URL parameters itself.
 */
export interface AppContext {
  /**
   * This window is the cluster's sound output (config `audio: true` on the
   * node, or ?audio=1 on a node or the simulator). Exactly one window should
   * have it; apps with sound create their AudioContext only when it is set.
   * Browsers start audio only after a user gesture: listen for the first
   * click or key press and resume the context then.
   */
  audio: boolean;
  /**
   * Debug drawing requested (the simulator's debug button, ?debug=1). What it
   * shows is the app's business: pick volumes, markers, extra status text.
   * Off by default; nodes on a wall never need it.
   */
  debug: boolean;
}

/**
 * How a scene app wants the standard navigation bound. Speeds are hints for
 * the controller's move/look/fly actions; `planar` keeps the CAVE on the
 * ground (no vertical motion, no pitch), for worlds you walk through.
 */
export interface NavigationHints {
  /** m/s at full stick deflection (default 2). */
  flySpeed?: number;
  /** rad/s at full deflection (default 1.2). */
  turnSpeed?: number;
  /** Ignore fly and pitch: the CAVE floor stays on the world's ground. */
  planar?: boolean;
}

/**
 * What a control panel gets from its host page (the simulator's side column,
 * or the standalone panel page on a tablet).
 */
export interface PanelContext {
  /** Patch the shared app state on the Manager (shallow merge), like onInput's send. */
  send: (patch: Record<string, unknown>) => void;
  /** The latest frame, for reading the current shared state on demand. */
  getState: () => FrameState;
}

/** A mounted control panel. `update` runs once per frame with the latest state so several panels stay consistent. */
export interface AppPanel {
  update(state: FrameState): void;
  dispose(): void;
}

/** A running 3D application instance. Created once per browser window. */
export interface CaveApp {
  readonly kind?: "scene";
  /** Same as the folder name; used in HUDs. */
  readonly name: string;
  /** The scene WebCAVE renders from each screen's off-axis camera. */
  readonly scene: THREE.Scene;
  /**
   * Resolves once assets are loaded. Rendering starts before that, so show a
   * placeholder in the meantime (the gltf app draws a wireframe box).
   */
  readonly ready: Promise<void>;
  /** Free text for HUDs: "loading 45%", "ready: 3 meshes", an error message. Update it as things happen. */
  status: string;
  /**
   * Advance the scene to simulation time `time`, in seconds since the cluster
   * started. Called once per frame before rendering, possibly with the same
   * value twice (simulator overview) and never with a delta. Must be
   * deterministic: same `time` in, same scene out, on every node.
   * `state` is the full frame, for apps that read shared state (see spinTime).
   */
  update(time: number, state?: FrameState): void;
  /** Optional: react to input on controllers (see InputHook). Nodes also see inputOf(state) in update(). */
  onInput?: InputHook;
  /** Optional: how fast the standard navigation moves through this world, and whether it stays on the ground. */
  readonly navigation?: NavigationHints;
  /**
   * Optional: switch this window's sound on or off at runtime (the simulator's
   * audio button). Called from a click handler, so creating or resuming an
   * AudioContext inside it is allowed. Without it, the simulator reloads the
   * page with ?audio=1 instead.
   */
  setAudio?(enabled: boolean): void;
  /** Optional: switch debug drawing on or off at runtime (the simulator's debug button). */
  setDebug?(enabled: boolean): void;
  /**
   * Optional: a control panel (the app's "sidebar"), mounted by controller
   * pages only, never on the wall. Build DOM into `container`; every control
   * sends a shared-state patch through `ctx.send`, and `update(state)`
   * reflects the state back so the panel shows what the wall shows.
   */
  createPanel?(container: HTMLElement, ctx: PanelContext): AppPanel;
  /** Optional: release GPU resources when the app is replaced. */
  dispose?(): void;
}

/** One screen's worth of a flat app: lives in a container element that WebCAVE sizes. */
export interface FlatView {
  /** Draw the state of this frame. Called once per frame message. */
  render(state: FrameState): void;
  /** The container was resized to w x h CSS pixels. */
  resize(width: number, height: number): void;
  /** The canvas the view draws into, if any; the simulator textures overview walls with it. */
  readonly canvas: HTMLCanvasElement | null;
  dispose(): void;
}

export interface FlatViewOptions {
  /**
   * Whether this view takes user input. Nodes on the wall are not interactive;
   * the simulator (or another controller) is. An interactive view reports
   * changes with `send`, and the Manager rebroadcasts them to everyone.
   */
  interactive: boolean;
  /** Patch the shared app state on the Manager (shallow merge). Only for interactive views. */
  send?: (patch: Record<string, unknown>) => void;
}

/** A running 2D application. One instance per window; it creates one view per screen. */
export interface FlatApp {
  readonly kind: "flat";
  readonly name: string;
  readonly ready: Promise<void>;
  status: string;
  /**
   * Create the view for `screen`. `layout.rects[screen.id]` is the screen's
   * rectangle in the wall image; a view should show exactly that part of the
   * shared picture so adjacent screens join seamlessly.
   */
  createView(container: HTMLElement, screen: ScreenConfig, layout: WallLayout, opts: FlatViewOptions): FlatView;
  /** Optional: react to input on controllers (see InputHook). */
  onInput?: InputHook;
  /** When true, the controller does not bind move/look/fly to navigation, leaving the axes to onInput. */
  readonly ownsNavigation?: boolean;
  /** Optional: switch this window's sound on or off at runtime (see CaveApp.setAudio). */
  setAudio?(enabled: boolean): void;
  /** Optional: switch debug drawing on or off at runtime (see CaveApp.setDebug). */
  setDebug?(enabled: boolean): void;
  /** Optional: a control panel for controller pages (see CaveApp.createPanel). */
  createPanel?(container: HTMLElement, ctx: PanelContext): AppPanel;
  dispose?(): void;
}

/**
 * What a raw app gets for one eye of one screen. Matrices are column-major
 * 4x4 in the world frame (meters): `view` maps world to eye space, `viewInverse`
 * is the eye's pose in the world, `projection` the off-axis frustum through the
 * screen with the cluster's near and far. The framebuffer and viewport are
 * already bound and sized to width x height; draw, do not swap. WebCAVE
 * resets its own GL state after the call, so leave whatever state you like.
 *
 * GL resources belong to a context, and a simulator page draws each screen
 * with a different context: keep per-context resources in a Map keyed by `gl`.
 */
export interface RawRenderContext {
  gl: WebGL2RenderingContext | WebGLRenderingContext;
  eye: "left" | "right" | "center";
  /** Eye position in the world frame, meters. */
  eyePosition: Vec3;
  view: ArrayLike<number>;
  viewInverse: ArrayLike<number>;
  projection: ArrayLike<number>;
  width: number;
  height: number;
}

/** An application that draws with its own WebGL code from WebCAVE's cameras. */
export interface RawApp {
  readonly kind: "raw";
  readonly name: string;
  readonly ready: Promise<void>;
  status: string;
  /** Advance to cluster time `time`; once per frame per window, before the eyes are drawn. Deterministic, like CaveApp.update. */
  update(time: number, state?: FrameState): void;
  /** Draw one eye of one screen into the bound framebuffer. */
  render(ctx: RawRenderContext): void;
  onInput?: InputHook;
  readonly navigation?: NavigationHints;
  setAudio?(enabled: boolean): void;
  setDebug?(enabled: boolean): void;
  createPanel?(container: HTMLElement, ctx: PanelContext): AppPanel;
  dispose?(): void;
}

/**
 * What a WebGPU app gets for one eye of one screen: the same matrices as a
 * raw WebGL app, plus an OffscreenCanvas of the eye's size to render into.
 * Configure its "webgpu" context with your device (once per canvas: keep a
 * WeakSet), render, submit; WebCAVE then takes the canvas's image and copies
 * it into the eye target. The projection's near and far are given too, for
 * renderers that slice depth (clustered lighting).
 */
export interface WebGpuRenderContext {
  canvas: OffscreenCanvas;
  eye: "left" | "right" | "center";
  eyePosition: Vec3;
  view: ArrayLike<number>;
  viewInverse: ArrayLike<number>;
  projection: ArrayLike<number>;
  near: number;
  far: number;
  width: number;
  height: number;
}

/** An application that draws with WebGPU from WebCAVE's cameras. */
export interface WebGpuApp {
  readonly kind: "webgpu";
  readonly name: string;
  readonly ready: Promise<void>;
  status: string;
  update(time: number, state?: FrameState): void;
  /** Draw one eye of one screen into ctx.canvas and submit; return when the commands are submitted. */
  render(ctx: WebGpuRenderContext): void;
  onInput?: InputHook;
  readonly navigation?: NavigationHints;
  setAudio?(enabled: boolean): void;
  setDebug?(enabled: boolean): void;
  createPanel?(container: HTMLElement, ctx: PanelContext): AppPanel;
  dispose?(): void;
}

export type AnyApp = CaveApp | FlatApp | RawApp | WebGpuApp;

export function isFlatApp(app: AnyApp): app is FlatApp {
  return app.kind === "flat";
}

export function isRawApp(app: AnyApp): app is RawApp {
  return app.kind === "raw";
}

export function isWebGpuApp(app: AnyApp): app is WebGpuApp {
  return app.kind === "webgpu";
}

/** Scene apps are the ones that own a three.js scene: neither flat, raw nor webgpu. */
export function isSceneApp(app: AnyApp): app is CaveApp {
  return app.kind !== "flat" && app.kind !== "raw" && app.kind !== "webgpu";
}

/** What an app folder's index.ts default-exports. The registry collects these. */
export interface AppDefinition {
  /** Must equal the folder name; used in config `app.name` and `?app=`. */
  name: string;
  /** One line for listings. */
  description: string;
  /** Build an instance. `spec` carries options from the config or URL (see AppSpec); `ctx` says where it runs. */
  create(spec: AppSpec, ctx: AppContext): AnyApp;
}

/**
 * How to instantiate an application; travels in the cluster config so every
 * node runs the same app with the same options.
 *   name      registered application: "shapes", "gltf", "map", or your folder
 *   url       asset URL (gltf), resolved by the browser against the page
 *   size      largest dimension after fitting, meters (gltf)
 *   position  where the fitted model's center goes, CAVE frame (gltf)
 *   spin      yaw rotation in radians per second (gltf), 0 disables
 *   options   free-form per-app options (map: style, center, zoom, pitch,
 *             bearing, buildings, autoRotate); read them in create()
 */
export type { AppSpec } from "../core/config";

// ---- Shared spin clock ----------------------------------------------------------
// Apps that rotate something (gltf, vdb, points, the map's auto-rotate) take
// their angle from this clock rather than from raw time, so a controller can
// pause and resume the rotation for the whole cluster with one shared-state
// patch. elapsed = base + (running ? time - since : 0).

export interface SpinClock {
  running: boolean;
  /** Elapsed seconds accumulated before `since`. */
  base: number;
  /** Cluster time at which the current run (or pause) began. */
  since: number;
}

function clockOf(state: FrameState | undefined, key: string, defaultRunning: boolean): SpinClock {
  const c = state?.appState?.[key] as Partial<SpinClock> | undefined;
  return c && typeof c.running === "boolean" ? { running: c.running, base: c.base ?? 0, since: c.since ?? 0 } : { running: defaultRunning, base: 0, since: 0 };
}

/**
 * Seconds counted by a shared clock kept in appState[key]: advances while
 * running, holds while paused. `defaultRunning` applies before any toggle.
 * The default key "spinClock" is the rotation clock that Space toggles.
 */
export function clockTime(state: FrameState | undefined, time: number, key = "spinClock", defaultRunning = true): number {
  const c = clockOf(state, key, defaultRunning);
  return c.running ? c.base + (time - c.since) : c.base;
}

/** Shared-state patch that pauses a running clock or resumes a paused one, without a jump. */
export function toggleClockPatch(state: FrameState | undefined, key = "spinClock", defaultRunning = true): Record<string, unknown> {
  const c = clockOf(state, key, defaultRunning);
  const time = state?.time ?? 0;
  const next: SpinClock = c.running ? { running: false, base: c.base + (time - c.since), since: time } : { running: true, base: c.base, since: time };
  return { [key]: next };
}

/** Rotation time from the Space-toggled clock (see clockTime). */
export const spinTime = (state: FrameState | undefined, time: number) => clockTime(state, time);
/** Patch toggling the Space clock (see toggleClockPatch). */
export const toggleSpinPatch = (state: FrameState | undefined) => toggleClockPatch(state);
