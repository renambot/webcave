/**
 * Wire protocol between the Manager and its clients (render nodes and
 * controllers). JSON text messages in v0; a binary encoding is planned for
 * the per-frame state once it carries tracking data.
 *
 * One frame, with the barrier tier:
 *
 *   Manager                       Node
 *     |-- frame {state} ----------->|   render eyes to offscreen targets
 *     |<-- ack {frame, renderMs} ---|
 *     |   (waits for every node, or the barrier timeout)
 *     |-- present {frame} --------->|   copy to the canvas (the "swap")
 *
 * With the loose tier there is no present message; nodes swap as soon as
 * they have rendered. Controllers receive the same frame/present messages
 * (so a laptop can mirror the wall) but never ack, so they cannot hold the
 * barrier.
 *
 * Design rule: everything a node needs to draw a frame is in FrameState.
 * Nodes keep no input state of their own, which is what makes them
 * interchangeable and lets one rejoin mid-session.
 */
import type { ClusterConfig, Quat, Vec3 } from "./config";
import type { ActionState } from "../input/actions";

/** Tracked head: position of the eye center and orientation, CAVE frame, meters. */
export interface HeadPose {
  position: Vec3;
  orientation: Quat;
}

/**
 * A tracked 6-DOF pose in the CAVE frame (meters, Y up): the wand today,
 * further trackers (glove, second wand) later. The head is the same shape.
 * Convention for the wand: it points along its local -Z, like a camera, so
 * a zero orientation points at the front wall.
 */
export type Pose = HeadPose;

/**
 * Navigation: where the physical CAVE sits in the virtual world.
 * Position is the CAVE origin in world units; yaw and pitch in radians.
 * Roll is intentionally absent (tilting the horizon in a CAVE causes sickness).
 *
 * Head and navigation are deliberately separate: the head is measured (by
 * tracking, or simulated) and changes each screen's frustum; navigation is
 * commanded (wand, keyboard) and moves the whole CAVE through the scene.
 */
export interface Navigation {
  position: Vec3;
  yaw: number;
  pitch: number;
}

/** Everything a node needs to render one frame deterministically. */
export interface FrameState {
  /** Monotonic frame counter, also the barrier id and the stereo parity source. */
  frame: number;
  /** Simulation time in seconds, derived from the frame counter (frame / fps), never from the wall clock. */
  time: number;
  head: HeadPose;
  /**
   * The wand (hand-held tracked controller), CAVE frame. Set by a tracker or
   * by the simulator's Ctrl + W S A D Q E keys; otherwise the config's
   * defaultWand. Its buttons are not here: they arrive as input actions
   * (appState.input) so any device can stand in for the physical wand.
   * Apps convert it to world coordinates with caveToWorld(navigation, ...).
   */
  wand: Pose;
  navigation: Navigation;
  /**
   * Shared application state, owned by the Manager and replicated to every
   * node each frame. Flat apps keep their camera or document position here
   * (the map app uses `appState.map`), so the walls stay in step no matter
   * which controller moved it. Patched by "setAppState" messages.
   */
  appState: Record<string, unknown>;
  /** Wall-clock time on the manager when the frame was issued (ms), for latency measurements only. */
  issuedAt: number;
}

/** Manager -> client. */
export type ServerMessage =
  /** First message after connecting: the whole cluster config and this client's id. */
  | { type: "welcome"; config: ClusterConfig; clientId: string }
  /** Render this frame. */
  | { type: "frame"; state: FrameState }
  /** Barrier released: show the frame rendered for `frame`. */
  | { type: "present"; frame: number }
  /** Periodic per-node statistics, for HUDs and dashboards. */
  | { type: "stats"; nodes: NodeStats[] };

/** Client -> Manager. */
export type ClientMessage =
  /**
   * Identify. `nodeId` is the config node id, or "node:view" for one window
   * of a multi-screen node. Nodes take part in the barrier; controllers do not.
   */
  | { type: "hello"; nodeId: string; role: "node" | "controller" }
  /** Frame rendered (not yet presented). renderMs is the node's own render time. */
  | { type: "ack"; frame: number; renderMs: number }
  /** Set the head pose directly; switches the manager's simulated head off. */
  | { type: "setHead"; head: HeadPose }
  /** Toggle the manager's simulated head motion. */
  | { type: "setHeadAuto"; enabled: boolean }
  /** Set the wand pose (CAVE frame); from a tracker bridge or the simulator. */
  | { type: "setWand"; wand: Pose }
  /** Set navigation absolutely. */
  | { type: "setNavigation"; navigation: Navigation }
  /** Incremental navigation, applied in the CAVE's own frame (forward = -Z). */
  | { type: "navigate"; move: Vec3; yaw: number; pitch: number }
  /** Shallow-merge `patch` into the shared application state (see FrameState.appState). */
  | { type: "setAppState"; patch: Record<string, unknown> }
  /**
   * This client's current device input (see src/input). The Manager keeps the
   * latest state per client, merges them (largest axis wins, buttons OR) and
   * publishes the result as appState.input every frame.
   */
  | { type: "input"; actions: ActionState };

export interface NodeStats {
  nodeId: string;
  lastAckFrame: number;
  renderMs: number;
  /** Frames where the manager released the barrier without this node's ack. */
  lateFrames: number;
}

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(data: string | ArrayBuffer | Uint8Array): T {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
  return JSON.parse(text) as T;
}
