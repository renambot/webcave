/**
 * The input abstraction: devices produce an ActionState, applications and the
 * navigation consume it. Nothing downstream knows whether a value came from a
 * gamepad stick, the arrow keys, a tracked wand or a phone.
 *
 *   device -> ActionState      src/input/gamepad.ts, keyboardActions() below,
 *                              (later: wand buttons from a tracker bridge)
 *   ActionState -> behaviour   the controller page binds standard actions to
 *                              cluster messages: move/look/fly -> navigation,
 *                              reset, spin; and replicates the whole state to
 *                              appState.input so every node sees it
 *   ActionState -> apps        apps read inputOf(state) in update(), or get
 *                              onInput() on the controller for app-specific
 *                              control (the map pans and zooms with it)
 *
 * Axes are normalized to [-1, 1] with dead zones already applied; buttons are
 * booleans. Values are sampled once per frame. Edge detection (pressed this
 * frame) is done by comparing with the previous frame's state, which is
 * deterministic across nodes because every node sees the same frames.
 */

export interface ActionState {
  /** Left stick / IJKL: x strafes (+right), y moves forward (+forward). */
  move: [number, number];
  /** Right stick / arrows: x yaws (+right), y pitches (+up). */
  look: [number, number];
  /** Triggers / U O: vertical or zoom (+up, +in). */
  fly: number;
  /** D-pad as an axis pair (+right, +up). */
  dpad: [number, number];
  buttons: {
    primary: boolean; // A / Cross
    secondary: boolean; // B / Circle
    tertiary: boolean; // X / Square
    quaternary: boolean; // Y / Triangle
    prev: boolean; // LB / L1
    next: boolean; // RB / R1
    reset: boolean; // Back / Select
    menu: boolean; // Start / Options
    spin: boolean; // Y by default: pause / resume rotation
  };
}

export type ButtonName = keyof ActionState["buttons"];

export const BUTTON_NAMES: ButtonName[] = ["primary", "secondary", "tertiary", "quaternary", "prev", "next", "reset", "menu", "spin"];

export function emptyActions(): ActionState {
  return {
    move: [0, 0],
    look: [0, 0],
    fly: 0,
    dpad: [0, 0],
    buttons: { primary: false, secondary: false, tertiary: false, quaternary: false, prev: false, next: false, reset: false, menu: false, spin: false },
  };
}

/** Radial dead zone with rescaling, so small stick drift is zero and full deflection stays 1. */
export function deadzone(x: number, y: number, dz = 0.15): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k];
}

export function deadzone1(v: number, dz = 0.1): number {
  return Math.abs(v) < dz ? 0 : Math.sign(v) * Math.min(1, (Math.abs(v) - dz) / (1 - dz));
}

/** Combine several sources: axes by the largest magnitude, buttons by OR. */
export function mergeActions(list: ActionState[]): ActionState {
  const out = emptyActions();
  const pick2 = (a: [number, number], b: [number, number]): [number, number] => (Math.hypot(b[0], b[1]) > Math.hypot(a[0], a[1]) ? b : a);
  for (const s of list) {
    out.move = pick2(out.move, s.move);
    out.look = pick2(out.look, s.look);
    out.dpad = pick2(out.dpad, s.dpad);
    if (Math.abs(s.fly) > Math.abs(out.fly)) out.fly = s.fly;
    for (const b of BUTTON_NAMES) out.buttons[b] = out.buttons[b] || s.buttons[b];
  }
  return out;
}

/** Buttons that are down now and were up before. */
export function pressed(prev: ActionState | null, curr: ActionState): Set<ButtonName> {
  const s = new Set<ButtonName>();
  for (const b of BUTTON_NAMES) if (curr.buttons[b] && !(prev && prev.buttons[b])) s.add(b);
  return s;
}

/** True when nothing is active: lets callers skip sending unchanged idle states. */
export function isIdle(a: ActionState): boolean {
  return a.move[0] === 0 && a.move[1] === 0 && a.look[0] === 0 && a.look[1] === 0 && a.fly === 0 && a.dpad[0] === 0 && a.dpad[1] === 0 && !BUTTON_NAMES.some((b) => a.buttons[b]);
}

export function sameActions(a: ActionState | null, b: ActionState): boolean {
  if (!a) return false;
  return (
    a.move[0] === b.move[0] && a.move[1] === b.move[1] && a.look[0] === b.look[0] && a.look[1] === b.look[1] && a.fly === b.fly &&
    a.dpad[0] === b.dpad[0] && a.dpad[1] === b.dpad[1] && BUTTON_NAMES.every((n) => a.buttons[n] === b.buttons[n])
  );
}

/**
 * Keyboard as a device, using the simulator's navigation keys. Held keys are
 * passed as a set of lower-case key names.
 *   arrows -> look, I K J L -> move, U O -> fly, R -> reset, Space -> spin,
 *   Enter -> primary (the gamepad's A), Backspace -> secondary (B)
 */
export function keyboardActions(keys: ReadonlySet<string>): ActionState {
  const a = emptyActions();
  a.look = [(keys.has("arrowright") ? 1 : 0) - (keys.has("arrowleft") ? 1 : 0), (keys.has("arrowup") ? 1 : 0) - (keys.has("arrowdown") ? 1 : 0)];
  a.move = [(keys.has("l") ? 1 : 0) - (keys.has("j") ? 1 : 0), (keys.has("i") ? 1 : 0) - (keys.has("k") ? 1 : 0)];
  a.fly = (keys.has("o") ? 1 : 0) - (keys.has("u") ? 1 : 0);
  a.buttons.reset = keys.has("r");
  a.buttons.spin = keys.has(" ");
  a.buttons.primary = keys.has("enter");
  a.buttons.secondary = keys.has("backspace");
  return a;
}

/** Read the replicated action state from a frame; empty when no controller has sent any. */
export function inputOf(state: { appState?: Record<string, unknown> } | undefined): ActionState {
  const s = state?.appState?.input as Partial<ActionState> | undefined;
  if (!s || !Array.isArray(s.move)) return emptyActions();
  const e = emptyActions();
  return {
    move: [s.move[0] ?? 0, s.move[1] ?? 0],
    look: [s.look?.[0] ?? 0, s.look?.[1] ?? 0],
    fly: s.fly ?? 0,
    dpad: [s.dpad?.[0] ?? 0, s.dpad?.[1] ?? 0],
    buttons: { ...e.buttons, ...(s.buttons ?? {}) },
  };
}
