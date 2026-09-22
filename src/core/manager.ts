/**
 * ClusterManager: the single source of truth for a running cluster.
 *
 * It owns
 *   - the frame counter and the simulation clock (time = frame / fps)
 *   - the head pose (simulated, or set by a controller / tracker)
 *   - the navigation transform
 *   - the frame barrier and per-node statistics
 *
 * and it does not render anything. Every frame it broadcasts a FrameState;
 * nodes are deterministic functions of that state. This is the nDisplay
 * model: one primary, many replicas, no node-local input.
 *
 * The class is transport-agnostic. `ManagerTransport` is the only thing it
 * uses to talk to clients, so the same code runs
 *   - in Node.js behind a WebSocket server (manager/server.ts)
 *   - inside the simulator page with an in-memory transport, where
 *     broadcast() calls the tiles directly (simulator/main.ts)
 *
 * Barrier tier ("sync": "barrier"):
 *   tick()  -> open barrier for all connected nodes, broadcast frame N
 *   ack     -> remove node from the pending set; when empty, broadcast present N
 *   timeout -> broadcast present N anyway, count the missing nodes as late
 * Loose tier: broadcast frame N, nothing else; nodes present immediately.
 */
import type { ClusterConfig } from "./config";
import type { ClientMessage, FrameState, HeadPose, Navigation, NodeStats, Pose, ServerMessage, StereoOverride } from "./protocol";
import { emptyActions, isIdle, mergeActions, type ActionState } from "../input/actions";
import { wandFromHead } from "./pose";

/** What the manager needs from a transport. Implemented over WebSocket and in memory. */
export interface ManagerTransport {
  send(clientId: string, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
}

interface ClientRecord {
  nodeId: string;
  role: "node" | "controller";
  lastAckFrame: number;
  renderMs: number;
  lateFrames: number;
}

export class ClusterManager {
  readonly config: ClusterConfig;
  private transport: ManagerTransport;
  /** Connected clients by transport id (not by node id: two windows may share a node id). */
  private clients = new Map<string, ClientRecord>();
  private frame = 0;
  /** Nodes that have not acked the current frame, or null when no barrier is open. */
  private pending: Set<string> | null = null;
  private pendingFrame = -1;
  private barrierTimer: ReturnType<typeof setTimeout> | null = null;
  /** Live stereo settings from a controller, sent in every frame (see FrameState.stereo). */
  private stereo: StereoOverride = {};
  private head: HeadPose;
  /** Simulated head sway; off by default so the head stays at defaultHead until a tracker or the simulator moves it. */
  private autoHead = false;
  /** Absolute wand pose from a tracker, or null to derive the wand from the head. */
  private wandAbsolute: Pose | null = null;
  /** Hand offset in the head's yaw frame, used when no absolute pose is set (config default, or the simulator's keys). */
  private wandOffset: Pose;
  private navigation: Navigation = { position: [0, 0, 0], yaw: 0, pitch: 0 };
  /** Shared application state; see FrameState.appState. */
  private appState: Record<string, unknown> = {};
  /** Latest device input per client (simulator, input-enabled nodes); merged into appState.input. */
  private inputs = new Map<string, ActionState>();
  private statsCounter = 0;

  constructor(config: ClusterConfig, transport: ManagerTransport) {
    this.config = config;
    this.transport = transport;
    this.head = { ...config.defaultHead };
    this.wandOffset = { ...config.defaultWand };
  }

  get currentFrame() {
    return this.frame;
  }

  get headPose() {
    return this.head;
  }

  get wandPose(): Pose {
    return this.wandAbsolute ?? wandFromHead(this.head, this.wandOffset);
  }

  get nav() {
    return this.navigation;
  }

  get sharedAppState() {
    return this.appState;
  }

  // ---- Connection lifecycle ---------------------------------------------------

  /** A transport-level connection appeared. Sends the config; the client answers with "hello". */
  onConnect(clientId: string) {
    this.transport.send(clientId, { type: "welcome", config: this.config, clientId });
  }

  /** Connection gone. If it was holding the barrier, the barrier may now be complete. */
  onDisconnect(clientId: string) {
    this.clients.delete(clientId);
    if (this.inputs.delete(clientId)) this.publishInput();
    if (this.pending) {
      this.pending.delete(clientId);
      this.checkBarrier();
    }
  }

  // ---- Incoming messages ------------------------------------------------------

  onMessage(clientId: string, msg: ClientMessage) {
    switch (msg.type) {
      case "hello":
        this.clients.set(clientId, {
          nodeId: msg.nodeId,
          role: msg.role,
          lastAckFrame: -1,
          renderMs: 0,
          lateFrames: 0,
        });
        break;
      case "ack": {
        const c = this.clients.get(clientId);
        if (!c) return;
        c.lastAckFrame = msg.frame;
        c.renderMs = msg.renderMs;
        // Only acks for the frame whose barrier is open count; a stale ack
        // (node caught up late) is recorded in the stats but ignored here.
        if (this.pending && msg.frame === this.pendingFrame) {
          this.pending.delete(clientId);
          this.checkBarrier();
        }
        break;
      }
      case "setHead":
        this.head = msg.head;
        this.autoHead = false; // an external head source takes over from the simulation
        break;
      case "setHeadAuto":
        this.autoHead = msg.enabled;
        break;
      case "setStereo":
        this.stereo = { ...this.stereo, ...msg.stereo };
        break;
      case "setApp":
        // A new world: the old app's shared state and the navigation belong to the old one.
        this.config.app = msg.app;
        this.appState = {};
        this.navigation = { position: [0, 0, 0], yaw: 0, pitch: 0 };
        console.log(`[manager] app: ${msg.app.name}`);
        break;
      case "setWand":
        if (msg.relative) {
          this.wandOffset = msg.wand;
          this.wandAbsolute = null; // back to following the head
        } else {
          this.wandAbsolute = msg.wand;
        }
        break;
      case "setNavigation":
        this.navigation = msg.navigation;
        break;
      case "setAppState":
        // Last writer wins, per key. Apps decide what goes in here; the
        // manager only replicates it.
        this.appState = { ...this.appState, ...msg.patch };
        break;
      case "input":
        // Several input clients (a laptop with a pad, a node with a keyboard)
        // may be active at once: merge rather than let the last one win.
        this.inputs.set(clientId, msg.actions);
        this.publishInput();
        break;
      case "navigate": {
        // Incremental move in the heading frame: "forward" follows the current
        // yaw but ignores pitch, so flying stays level while looking up or down.
        const n = this.navigation;
        const yaw = n.yaw + msg.yaw;
        const pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, n.pitch + msg.pitch));
        const [mx, my, mz] = msg.move;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        this.navigation = {
          yaw,
          pitch,
          position: [n.position[0] + mx * c + mz * s, n.position[1] + my, n.position[2] - mx * s + mz * c],
        };
        break;
      }
    }
  }

  // ---- Frame pacing -------------------------------------------------------------

  /**
   * Advance one frame. The caller paces this at `config.fps`: a timer in the
   * server, requestAnimationFrame in the simulator. `now` is only stamped
   * into the frame for latency measurement.
   */
  tick(now = Date.now()) {
    // A barrier still open from the previous frame means some node never
    // acked: release it now (counting the stragglers) rather than stall.
    if (this.pending) {
      for (const id of this.pending) {
        const c = this.clients.get(id);
        if (c) c.lateFrames++;
      }
      this.releasePresent();
    }

    this.frame++;
    const time = this.frame / this.config.fps;
    if (this.autoHead) this.head = simulatedHead(time, this.config);

    const state: FrameState = {
      frame: this.frame,
      time,
      head: this.head,
      wand: this.wandPose,
      navigation: this.navigation,
      appState: this.appState,
      issuedAt: now,
      stereo: this.stereo,
      app: this.config.app,
    };

    // Open the barrier before broadcasting: with an in-memory transport the
    // acks can arrive synchronously inside broadcast().
    if (this.config.sync === "barrier") {
      const nodes = [...this.clients.entries()].filter(([, c]) => c.role === "node").map(([id]) => id);
      if (nodes.length > 0) {
        this.pending = new Set(nodes);
        this.pendingFrame = this.frame;
        this.barrierTimer = setTimeout(() => {
          if (this.pending) {
            for (const id of this.pending) {
              const c = this.clients.get(id);
              if (c) c.lateFrames++;
            }
            this.releasePresent();
          }
        }, this.config.barrierTimeoutMs);
      }
    }

    this.transport.broadcast({ type: "frame", state });

    // Stats every 30 frames (twice a second at 60 fps).
    if (++this.statsCounter % 30 === 0) {
      this.transport.broadcast({ type: "stats", nodes: this.stats() });
    }
  }

  private publishInput() {
    const states = [...this.inputs.values()];
    const merged = states.length ? mergeActions(states) : emptyActions();
    // Drop the key entirely when everything is idle, so appState stays small and inputOf() yields the default.
    if (isIdle(merged)) {
      if ("input" in this.appState) {
        const { input: _drop, ...rest } = this.appState;
        this.appState = rest;
      }
    } else {
      this.appState = { ...this.appState, input: merged };
    }
  }

  /** Per-node statistics (controllers excluded). */
  stats(): NodeStats[] {
    return [...this.clients.values()]
      .filter((c) => c.role === "node")
      .map((c) => ({ nodeId: c.nodeId, lastAckFrame: c.lastAckFrame, renderMs: c.renderMs, lateFrames: c.lateFrames }));
  }

  private checkBarrier() {
    if (this.pending && this.pending.size === 0) this.releasePresent();
  }

  private releasePresent() {
    if (this.barrierTimer) {
      clearTimeout(this.barrierTimer);
      this.barrierTimer = null;
    }
    const f = this.pendingFrame;
    this.pending = null;
    this.transport.broadcast({ type: "present", frame: f });
  }
}

/**
 * Demo head motion when no tracker or controller drives the head: a gentle
 * figure-eight around the default position plus a slow yaw sway, so the
 * off-axis projections visibly change and the stereo eye pair turns.
 */
export function simulatedHead(time: number, cfg: ClusterConfig): HeadPose {
  const [x, y, z] = cfg.defaultHead.position;
  const t = time * 0.5;
  const yaw = 0.6 * Math.sin(t * 0.7); // radians, about +Y
  return {
    position: [x + 0.6 * Math.sin(t), y + 0.15 * Math.sin(t * 2.3), z + 0.4 * Math.sin(t * 2)],
    orientation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
  };
}
