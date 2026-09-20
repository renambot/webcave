/**
 * Gamepads as an input device, through the browser Gamepad API.
 *
 * The API exposes raw axes and buttons; a *profile* maps them to the
 * ActionState vocabulary. Browsers report most modern pads with the W3C
 * "standard" mapping (left stick 0/1, right stick 2/3, A B X Y 0..3, bumpers
 * 4/5, triggers 6/7, Back 8, Start 9, sticks 10/11, d-pad 12..15), which the
 * default profile uses. Pads that report a non-standard layout are matched by
 * their id string against `profiles`; unmatched ones fall back to standard.
 *
 * Add a device by adding a profile: axis indexes, button indexes, optional
 * inversions. Pass ?gamepad=NAME to force a profile while testing.
 *
 * Polling: navigator.getGamepads() is sampled once per frame by poll(); the
 * API has no per-change events for values.
 */
import { deadzone, deadzone1, emptyActions, mergeActions, type ActionState, type ButtonName } from "./actions";

export interface GamepadProfile {
  name: string;
  /** Regular expression tested against Gamepad.id (case-insensitive); omit for the default. */
  match?: RegExp;
  axes: { moveX: number; moveY: number; lookX: number; lookY: number; invertMoveY?: boolean; invertLookY?: boolean };
  /** Button indexes; triggers may be buttons (value 0..1) or axes (see `triggerAxes`). */
  buttons: Partial<Record<ButtonName, number>>;
  /** Fly = flyUp - flyDown, read from button values (analog triggers). */
  flyUp?: number;
  flyDown?: number;
  /** Alternative: fly from an axis (e.g. Xbox on some Linux builds: axis 5 - axis 2). */
  triggerAxes?: { up: number; down: number };
  dpad?: { up: number; down: number; left: number; right: number };
  /** Some pads expose the d-pad as a hat axis (-1..1, 8 positions). */
  dpadHatAxis?: number;
}

export const STANDARD: GamepadProfile = {
  name: "standard",
  axes: { moveX: 0, moveY: 1, lookX: 2, lookY: 3, invertMoveY: true, invertLookY: true },
  buttons: { primary: 0, secondary: 1, tertiary: 2, quaternary: 3, prev: 4, next: 5, reset: 8, menu: 9, spin: 3 },
  flyUp: 7,
  flyDown: 6,
  dpad: { up: 12, down: 13, left: 14, right: 15 },
};

/** Known non-standard layouts. Extend as devices show up. */
export const PROFILES: GamepadProfile[] = [
  {
    // Xbox controllers on Firefox/Linux often come through without the standard mapping:
    // triggers as axes 2 (LT) and 5 (RT), right stick on axes 3/4.
    name: "xbox-linux",
    match: /xbox|x-box|045e/i,
    axes: { moveX: 0, moveY: 1, lookX: 3, lookY: 4, invertMoveY: true, invertLookY: true },
    buttons: { primary: 0, secondary: 1, tertiary: 2, quaternary: 3, prev: 4, next: 5, reset: 6, menu: 7, spin: 3 },
    triggerAxes: { up: 5, down: 2 },
    dpadHatAxis: 6,
  },
  {
    // DualShock 4 / DualSense without standard mapping (older Firefox): Cross 1, Circle 2, Square 0, Triangle 3.
    name: "playstation-legacy",
    match: /054c|dualshock|dualsense|wireless controller/i,
    axes: { moveX: 0, moveY: 1, lookX: 2, lookY: 5, invertMoveY: true, invertLookY: true },
    buttons: { primary: 1, secondary: 2, tertiary: 0, quaternary: 3, prev: 4, next: 5, reset: 8, menu: 9, spin: 3 },
    flyUp: 7,
    flyDown: 6,
    dpadHatAxis: 9,
  },
];

export function profileFor(gp: Gamepad, forced?: string | null): GamepadProfile {
  if (forced) {
    const f = PROFILES.find((p) => p.name === forced) ?? (forced === "standard" ? STANDARD : null);
    if (f) return f;
  }
  if (gp.mapping === "standard") return STANDARD;
  return PROFILES.find((p) => p.match?.test(gp.id)) ?? STANDARD;
}

const btn = (gp: Gamepad, i: number | undefined) => (i !== undefined && gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0);
const axis = (gp: Gamepad, i: number | undefined) => (i !== undefined && i < gp.axes.length ? gp.axes[i] : 0);

/** Map one gamepad's raw state to actions. */
export function actionsFromGamepad(gp: Gamepad, profile: GamepadProfile): ActionState {
  const a = emptyActions();
  const [mx, my] = deadzone(axis(gp, profile.axes.moveX), axis(gp, profile.axes.moveY));
  const [lx, ly] = deadzone(axis(gp, profile.axes.lookX), axis(gp, profile.axes.lookY));
  a.move = [mx, profile.axes.invertMoveY ? -my : my];
  a.look = [lx, profile.axes.invertLookY ? -ly : ly];
  if (profile.triggerAxes) {
    // Trigger axes rest at -1 and go to +1 when pulled.
    const up = (axis(gp, profile.triggerAxes.up) + 1) / 2;
    const down = (axis(gp, profile.triggerAxes.down) + 1) / 2;
    a.fly = deadzone1(up - down, 0.05);
  } else {
    a.fly = deadzone1(btn(gp, profile.flyUp) - btn(gp, profile.flyDown), 0.05);
  }
  for (const name of Object.keys(profile.buttons) as ButtonName[]) a.buttons[name] = btn(gp, profile.buttons[name]) > 0.5;
  if (profile.dpad) {
    a.dpad = [btn(gp, profile.dpad.right) - btn(gp, profile.dpad.left), btn(gp, profile.dpad.up) - btn(gp, profile.dpad.down)];
  } else if (profile.dpadHatAxis !== undefined) {
    // Hat axis: -1 up, then clockwise in steps of 2/7, 1.28 (out of range) = centered.
    const h = axis(gp, profile.dpadHatAxis);
    if (h >= -1 && h <= 1) {
      const dir = Math.round(((h + 1) / 2) * 7); // 0..7 starting at up, clockwise
      const dx = [0, 1, 1, 1, 0, -1, -1, -1][dir];
      const dy = [1, 1, 0, -1, -1, -1, 0, 1][dir];
      a.dpad = [dx, dy];
    }
  }
  return a;
}

export interface GamepadInfo {
  index: number;
  id: string;
  profile: string;
  mapping: string;
}

/** Snapshot of all connected gamepads merged into one ActionState, plus what was found. */
export function pollGamepads(forcedProfile?: string | null): { actions: ActionState; pads: GamepadInfo[] } {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return { actions: emptyActions(), pads: [] };
  const states: ActionState[] = [];
  const pads: GamepadInfo[] = [];
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue;
    const profile = profileFor(gp, forcedProfile);
    states.push(actionsFromGamepad(gp, profile));
    pads.push({ index: gp.index, id: gp.id, profile: profile.name, mapping: gp.mapping || "none" });
  }
  return { actions: states.length ? mergeActions(states) : emptyActions(), pads };
}
