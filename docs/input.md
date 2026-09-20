# Input devices

Input goes through an abstraction layer in `src/input/`, so applications and the navigation never see a device:

1. **Devices produce an action state.** Keyboard and gamepads today; a tracked wand or a phone later. The vocabulary is small: `move` and `look` as 2D axes, `fly`, a `dpad`, and buttons `primary`, `secondary`, `tertiary`, `quaternary`, `prev`, `next`, `reset`, `menu`, `spin`. Axes are normalized with dead zones applied. Several devices are merged (largest axis wins, buttons OR).
2. **A controller binds standard actions to cluster behaviour.** `move`, `look` and `fly` become navigation increments, `reset` resets, `spin` pauses the rotation clock. Each input client also reports its action state to the Manager, which merges all of them (largest axis wins, buttons OR) and replicates the result to every node in the frame, so a wall node sees exactly what the sticks do. The same `InputController` class in `src/input/controller.ts` runs in the simulator and on nodes that are allowed to take input.
3. **Applications react.** A scene app reads `inputOf(state)` in `update()` on every node, deterministically. An app can also implement `onInput(actions, dt, state, send)`, which runs on the controller only and may patch shared state; the map uses it to pan, rotate, pitch and zoom from a gamepad, and declares `ownsNavigation` so the sticks are not also flying the CAVE. A scene app can instead keep the standard navigation and tune it with `navigation` hints: speed, turn rate, and `planar` to stay on the ground (Crayoland walks at 30 ft/s).

## Keyboard and mouse

| Keys | Action |
|---|---|
| Arrow keys | Look: yaw left/right, pitch up/down |
| `I` `K` / `J` `L` / `U` `O` | Fly forward/back, strafe left/right, down/up |
| `R` | Reset navigation and head pose |
| `Space` | Pause or resume the shared rotation clock |
| `Enter` / `Backspace` | Application buttons primary / secondary (gamepad A / B) |
| Mouse on a 3D view | Drag to look, right-drag to pan, wheel to fly, double-click to reset |

The simulator adds head keys (`W S A D Q E`, with `Alt` to rotate) and wand keys (`Shift` + the same, `Shift` + `Alt` to rotate) that are simulator-only; see [running.md](running.md).

## The wand

Tracked poses are not actions: the head and the wand are each a 6-DOF pose, position and orientation, travelling in every frame (`state.head`, `state.wand`, CAVE frame), and every node sees the same values. A tracker bridge sets them absolutely; until then the Manager derives the wand from the head every frame as a hand offset in the head's yaw frame (`defaultWand`, adjusted by the simulator's `Shift` keys), so it moves with the body and not with the gaze. Its buttons are ordinary actions, so a gamepad, the keyboard or the physical wand's buttons all work: `primary` (Enter, gamepad A) and `tertiary` (gamepad X) are the grab buttons in Crayoland. Applications convert the wand to world coordinates with the navigation helpers and react on the controller, publishing the result as shared state (see [applications.md](applications.md)).

## Gamepads

Gamepads use the browser Gamepad API. Pads reporting the W3C standard layout work out of the box: left stick moves, right stick looks, triggers fly up (RT) and down (LT), bumpers look up (RB) and down (LB), the d-pad moves the hand (sideways and up / down), A is `primary`, Y or Triangle toggles rotation, Back or Select resets. Other layouts are matched by id against profiles in `src/input/gamepad.ts` (Xbox on Linux, older PlayStation mappings); adding a device is adding a profile. Connected pads show in the simulator footer, and `?gamepad=NAME` forces a profile. Browsers only expose a pad after a button press on it.

## Input on a node

Wall nodes are display-only unless a node has `"input": true` in the config (or `?input=1` on its URL for development). Such a node takes the keyboard, mouse and any gamepad plugged into its computer and steers the cluster like the simulator does: arrows look, `I K J L U O` fly, `Space` pauses rotation, `R` resets, `Enter` and `Backspace` are the application buttons A and B, the d-pad moves the hand, drag looks, right-drag pans, wheel flies, and for the map the node's own view becomes interactive. The head keys and the `Shift` hand keys are simulator-only; on a node the head comes from the tracker or the config default. Fullscreen then moves to the `F` key alone, since clicks, `Enter` and `Space` have other meanings. Several input clients can be active at once; the Manager merges them.

Input is off by default on purpose: render machines often have keyboards and mice attached for administration, kiosk windows grab keyboard focus, and a bumped mouse or a stray key on a display-only machine must not steer the wall. Turn it on where the controller physically is, typically the one machine with the gamepad (for a single-computer CAVE, set it on the `pc` node), or use the simulator on a laptop. Keyboard events only reach the focused window, so on a multi-window node only the last-clicked window hears keys; gamepads are readable from any window, which makes them the better device for a wall.
