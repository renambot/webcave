/**
 * InputController: turns devices on *this page* into cluster messages.
 *
 * Used by the simulator and by nodes that are allowed to take input
 * (`input: true` on the node in the config, or ?input=1 for development).
 * Per frame, step():
 *   1. polls gamepads and reads held keys -> one merged ActionState
 *   2. binds the standard actions: move / look / fly -> "navigate" increments
 *      (unless the app owns navigation; the bumpers prev / next also pitch
 *      down / up), reset -> onReset(), spin -> the shared spin clock
 *   3. sends the action state to the Manager ("input"), which merges the
 *      states of all input clients and replicates the result in every frame
 *   4. calls the app's onInput hook, if any, with a `send` that patches the
 *      shared app state
 *
 * Hand: without a tracker the wand is a hand hanging off the head (see
 * core/pose.ts). The controller owns that offset: the d-pad moves the hand
 * sideways and up / down, moveWand() / rotateWand() let a page add keys
 * (the simulator's Shift + W S A D Q E), and the offset is sent as a
 * relative "setWand". The reset action puts it back.
 *
 * Mouse: bindMouse(el) adds drag-to-look, right-drag-to-pan, wheel-to-fly
 * and double-click-to-reset on a canvas, sending navigation increments.
 * Keyboard: bindKeyboard(filter) listens on the window; a tap shorter than a
 * frame still counts for one frame (see `taps`).
 */
import type { AnyApp } from "../apps/types";
import type { ClientMessage, FrameState, Pose } from "../core/protocol";
import { emptyActions, keyboardActions, mergeActions, pressed, sameActions, type ActionState } from "./actions";
import { pollGamepads, type GamepadInfo } from "./gamepad";
import { toggleSpinPatch } from "../apps/types";

export interface InputControllerOptions {
  send: (msg: ClientMessage) => void;
  /** Latest frame from the Manager, for clocks and app hooks. */
  getState: () => FrameState;
  /** The running application, for onInput and ownsNavigation. */
  getApp: () => AnyApp | null;
  /** Called on the reset action. */
  onReset: () => void;
  /** Force a gamepad profile by name (?gamepad=). */
  forcedProfile?: string | null;
  /** The config's hand offset from the head, the wand's rest position (see ClusterConfig.defaultWand). */
  defaultWand?: Pose;
  flySpeed?: number; // m/s at full deflection
  turnSpeed?: number; // rad/s at full deflection
  /** m/s the d-pad and the wand keys move the hand (default 1). */
  handSpeed?: number;
  /** Another action source merged into every sample (the headset page's XR controllers). */
  extraActions?: () => ActionState | null;
}

export class InputController {
  /** Keys currently held: lower-case key names ("w", "arrowup") and physical codes ("keyw"). Pages may read this for their own bindings. */
  readonly keys = new Set<string>();
  /** Keys pressed since the last frame, so a tap shorter than a frame registers as an edge. */
  readonly taps = new Set<string>();
  /** Gamepads seen in the last poll, for HUDs. */
  pads: GamepadInfo[] = [];
  /** Merged action state of the last step(), for pages that bind extra actions (the simulator moves the hand with the d-pad). */
  actions: ActionState = emptyActions();
  private prev: ActionState | null = null;
  private lastSent: ActionState | null = null;
  private opts: Required<Pick<InputControllerOptions, "flySpeed" | "turnSpeed" | "handSpeed">> & InputControllerOptions;
  /** Hand offset from the head (head yaw frame): position in meters, yaw and pitch in radians. */
  private wand = { position: [0.15, -0.45, -0.5] as [number, number, number], yaw: 0, pitch: 0 };

  constructor(opts: InputControllerOptions) {
    this.opts = { flySpeed: 2.0, turnSpeed: 1.2, handSpeed: 1.0, ...opts };
    this.resetWand(false);
  }

  // ---- The hand -------------------------------------------------------------

  /** Move the hand by (dx, dy, dz) meters in the head's yaw frame (x right, y up, z back). */
  moveWand(dx: number, dy: number, dz: number) {
    const p = this.wand.position;
    p[0] += dx;
    p[1] += dy;
    p[2] += dz;
    this.sendWand();
  }

  /** Turn the wand by yaw and pitch increments (radians); pitch is clamped to ±90°. */
  rotateWand(dyaw: number, dpitch: number) {
    this.wand.yaw += dyaw;
    this.wand.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.wand.pitch + dpitch));
    this.sendWand();
  }

  /** Put the hand back at the config's rest offset. */
  resetWand(send = true) {
    const d = this.opts.defaultWand;
    this.wand.position = d ? ([...d.position] as [number, number, number]) : [0.15, -0.45, -0.5];
    this.wand.yaw = this.wand.pitch = 0;
    if (send) this.sendWand();
  }

  private sendWand() {
    // Ry(yaw) * Rx(pitch) as a quaternion (x, y, z, w).
    const cy = Math.cos(this.wand.yaw / 2), sy = Math.sin(this.wand.yaw / 2);
    const cp = Math.cos(this.wand.pitch / 2), sp = Math.sin(this.wand.pitch / 2);
    this.send({
      type: "setWand",
      wand: { position: [...this.wand.position], orientation: [cy * sp, sy * cp, -sy * sp, cy * cp] },
      relative: true,
    });
  }

  private get send() {
    return this.opts.send;
  }

  /** Current merged action state (devices on this page). */
  sample(): ActionState {
    const gp = pollGamepads(this.opts.forcedProfile ?? null);
    this.pads = gp.pads;
    const held = this.taps.size ? new Set([...this.keys, ...this.taps]) : this.keys;
    this.taps.clear();
    const extra = this.opts.extraActions?.();
    return mergeActions(extra ? [keyboardActions(held), gp.actions, extra] : [keyboardActions(held), gp.actions]);
  }

  /** Per-frame: sample, bind, replicate, hand to the app. */
  step(dt: number) {
    const actions = this.sample();
    this.actions = actions;
    const edges = pressed(this.prev, actions);
    const app = this.opts.getApp();
    const state = this.opts.getState();
    const ownsNav = !!(app as { ownsNavigation?: boolean } | null)?.ownsNavigation;

    if (!ownsNav) {
      // Speeds and constraints may come from the app (a world in feet wants
      // faster flight; a walk-through wants to stay on the ground).
      const hints = (app as { navigation?: { flySpeed?: number; turnSpeed?: number; planar?: boolean } } | null)?.navigation;
      const flySpeed = hints?.flySpeed ?? this.opts.flySpeed;
      const turnSpeed = hints?.turnSpeed ?? this.opts.turnSpeed;
      const [mx, my] = actions.move;
      // Bumpers pitch as well as the right stick: RB / R1 looks up, LB / L1 looks down.
      const [lx, lyStick] = actions.look;
      const ly = Math.max(-1, Math.min(1, lyStick + (actions.buttons.next ? 1 : 0) - (actions.buttons.prev ? 1 : 0)));
      const yaw = -lx * turnSpeed * dt;
      const pitch = hints?.planar ? 0 : ly * turnSpeed * dt;
      const move: [number, number, number] = [mx * flySpeed * dt, hints?.planar ? 0 : actions.fly * flySpeed * dt, -my * flySpeed * dt];
      if (yaw || pitch || move[0] || move[1] || move[2]) this.send({ type: "navigate", move, yaw, pitch });
    }
    if (edges.has("reset")) {
      this.opts.onReset();
      this.resetWand();
    }
    if (edges.has("spin")) this.send({ type: "setAppState", patch: toggleSpinPatch(state) });
    // D-pad: the hand sideways (x) and up / down (y), so a pad alone can reach for things.
    const [hx, hy] = actions.dpad;
    if (hx || hy) this.moveWand(hx * this.opts.handSpeed * dt, hy * this.opts.handSpeed * dt, 0);

    // Report to the Manager only on change; it keeps the last state per client.
    if (!sameActions(this.lastSent, actions)) {
      this.send({ type: "input", actions });
      this.lastSent = actions;
    }
    app?.onInput?.(actions, dt, state, (patch) => this.send({ type: "setAppState", patch }));
    this.prev = actions;
  }

  /**
   * Window key listeners. `filter(e)` returning false skips the event (for
   * text fields, or while a help overlay is open). Arrow keys and Space are
   * prevented from scrolling the page.
   */
  bindKeyboard(filter: (e: KeyboardEvent) => boolean = () => true) {
    const NAV_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", " "]);
    window.addEventListener("keydown", (e) => {
      if (!filter(e)) return;
      const k = e.key.toLowerCase();
      if (NAV_KEYS.has(k)) e.preventDefault();
      if (!e.repeat) this.taps.add(k);
      this.keys.add(k);
      // Also the physical key ("keyw"), for bindings that must survive
      // modifiers: on macOS Option+W reports the key as "∑", Shift+W as "W".
      if (e.code) this.keys.add(e.code.toLowerCase());
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.key.toLowerCase());
      if (e.code) this.keys.delete(e.code.toLowerCase());
    });
    window.addEventListener("blur", () => this.keys.clear());
  }

  /**
   * Mouse navigation on an element: left drag looks, right or middle drag
   * pans, wheel flies, double-click resets. Sent as increments, like the keys.
   */
  bindMouse(el: HTMLElement) {
    let dragging: "look" | "pan" | null = null;
    let lastX = 0;
    let lastY = 0;
    const LOOK = 0.004; // rad per pixel
    const PAN = 0.004; // m per pixel
    const FLY = 0.0025; // m per wheel unit
    el.style.cursor = "grab";
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => {
      dragging = e.button === 0 ? "look" : "pan";
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const planar = !!(this.opts.getApp() as { navigation?: { planar?: boolean } } | null)?.navigation?.planar;
      if (dragging === "look") this.send({ type: "navigate", move: [0, 0, 0], yaw: -dx * LOOK, pitch: planar ? 0 : -dy * LOOK });
      else this.send({ type: "navigate", move: [-dx * PAN, planar ? 0 : dy * PAN, 0], yaw: 0, pitch: 0 });
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = null;
      el.releasePointerCapture(e.pointerId);
      el.style.cursor = "grab";
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.send({ type: "navigate", move: [0, 0, e.deltaY * FLY], yaw: 0, pitch: 0 });
      },
      { passive: false },
    );
    el.addEventListener("dblclick", () => this.opts.onReset());
  }
}
