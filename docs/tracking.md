# Tracking

WebCAVE reads the head and the wand from a tracking system through a small **tracking bridge**, a Node.js process that speaks the tracker's protocol, calibrates poses into the CAVE frame and sends them to the Manager. Nodes never talk to trackers: the Manager stamps the poses into every frame, so all screens see the same head and wand and the barrier keeps tracking and simulation together.

```sh
npm run tracker -- --list                                   # configs in configs/trackers/
npm run tracker -- --config dtrack                          # configs/trackers/dtrack.json
npm run tracker -- --config natnet --manager ws://cave-manager:8765
npm run tracker -- --config path/to/my-tracker.json
```

The bridge connects to the Manager as a controller, so it never holds the frame barrier, and reconnects if the Manager restarts. It logs every five seconds which body ids it has seen, so a wrong id in the config shows up at once.

## Supported systems

| System | Protocol | How the bridge reads it |
|---|---|---|
| ART DTrack2 / DTrack3 | DTrack output, ASCII over UDP | Listens on the configured port (5000 by default). Standard bodies from `6d` records, Flysticks from `6df2` (pose, buttons, joystick) and the older `6df`. Enable those outputs in DTrack and point them at the bridge's machine. Millimeters, Z up in most rooms: see the calibration below. |
| OptiTrack Motive | NatNet, binary over UDP | Joins the multicast group (`239.255.42.99:1511` by default) or listens for unicast. Asks Motive over the command port for its NatNet version and the asset names, so bodies can be named in the config (`"Head"`) rather than by streaming id. Rigid bodies only; skeletons and markers are skipped. Meters and Y up by default in Motive. |
| VRPN | VRPN over TCP | Connects to `host:3883` and reads `vrpn_Tracker Pos_Quat`, `vrpn_Button Change` / `States` and `vrpn_Analog Channel` messages. Poses are `"Device/sensor"`; buttons and analog come from devices named in the config. VRPN fronts many systems (Vicon, PhaseSpace, Polhemus, Intersense, DIY servers), so it is the catch-all. |

All three are implemented in TypeScript with no vendor libraries: `src/tracker/dtrack.ts`, `natnet.ts`, `vrpn.ts`. A source reports bodies by id in the tracker's own units and axes; `src/tracker/bridge.ts` maps them onto the head and wand.

## Configuration

A JSON file in `configs/trackers/`, validated with zod; `"$schema": "./schema.json"` gives editor completion (`npm run schema` regenerates it and validates every file).

```json
{
  "$schema": "./schema.json",
  "name": "dtrack",
  "manager": "ws://localhost:8765",
  "source": { "type": "dtrack", "port": 5000 },
  "calibration": { "units": "mm", "axes": ["x", "z", "-y"], "yaw": 0, "offset": [0, 0, 0] },
  "head": { "id": 0, "localOffset": [0, -0.02, -0.03] },
  "wand": {
    "id": "flystick 0",
    "buttons": { "0": "primary", "1": "secondary", "2": "tertiary", "3": "quaternary", "4": "menu", "5": "reset" },
    "axes": { "move": [0, 1] }
  }
}
```

**Source.** `dtrack` takes a `port`. `natnet` takes the Motive `server` address (for the command port), the `multicast` group (empty string for unicast), `dataPort` and `commandPort`. `vrpn` takes `host` and `port`.

**Calibration**, applied in this order to every pose:

1. `units`: `m`, `cm`, `mm`, `ft` or `in`, the tracker's length unit.
2. `axes`: the CAVE's x, y, z each as a signed tracker axis. `["x", "y", "z"]` for a Y-up tracker aligned with the CAVE; `["x", "z", "-y"]` for a Z-up tracker whose y points at the front wall. Orientations are conjugated with the same mapping, so a mirrored mapping stays a proper rotation.
3. `yaw`: degrees about the CAVE's up axis, for a tracker whose horizontal axes do not line up with the walls.
4. `offset`: meters, added last; where the tracker's origin sits in the CAVE frame. The CAVE origin is on the floor at the center of the room, so a tracker whose origin is on the floor under the front wall needs `[0, 0, -1.5]` in the 3 m CAVE.

**Bodies.** `head` and `wand` name a body by `id`: the DTrack wire id (0-based; DTrack's display shows it 1-based), a NatNet streaming id or asset name, or a VRPN `"Device/sensor"`. `localOffset` moves from the sensor to the point WebCAVE wants, in the body's own frame: from the marker cluster on the glasses to the eye center, or from the wand's markers to its tip.

**Wand buttons and joystick.** `buttons` maps button indexes to the action vocabulary (`primary`, `secondary`, `tertiary`, `quaternary`, `prev`, `next`, `reset`, `menu`, `spin`), `axes` maps analog channels to the `move` and `look` sticks and the `fly` axis. The bridge sends them as an input client, and the Manager merges them with any gamepad or keyboard, so the physical wand grabs in Crayoland and walks the world exactly like a pad. For DTrack the Flystick carries its own buttons and joystick; for VRPN, `buttonDevice` and `analogDevice` name the Button and Analog servers when they are not the tracker device.

`rate` caps the poses sent per body per second (120 by default); trackers often run faster than the cluster's frame rate.

## Testing without a tracker

`scripts/fake-tracker.ts` pretends to be each system, with a swaying head, a circling wand, a button toggling every second and a joystick pushed forward:

```sh
npm run manager
npx tsx scripts/fake-tracker.ts dtrack        # or natnet, or vrpn; an optional port follows (dtrack 5001)
npm run tracker -- --config dtrack             # natnet needs "multicast": "" and "server": "127.0.0.1" for the fake
```

Stop the fake with Ctrl-C. The `vrpn` config works with the fake as it is; for `natnet`, edit the config as noted or pass a copy with `--config path/to/file.json`.

Open the simulator as a controller (`?manager=ws://localhost:8765`) and watch the head and the wand stick move in the overview. The bridge was verified this way for all three protocols, including the axis and unit conversion from DTrack's Z-up millimeters, NatNet's asset-name resolution and VRPN's button and analog messages.

## Not yet

Vicon's DataStream SDK protocol and its UDP object stream, Qualisys QTM, OSC and VMC for SteamVR trackers and phones, a guided calibration (touch three screen corners with the wand and solve), recording and replay of tracking streams, and a VRPN server mode so other applications can share the calibrated source. Vicon systems can use their built-in VRPN server in the meantime.
