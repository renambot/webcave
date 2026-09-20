# Configuration files

An installation is a JSON file in `configs/`. The Manager loads it by name (`--config cave-3m`) or by path, the simulator lists the bundled ones in its dropdown, and every file carries `"$schema": "./schema.json"` so VS Code and other editors autocomplete and validate it. Copy one and edit it.

| File | What it describes |
|---|---|
| `cave-3m.json` | 3 m CAVE, four screens, one computer per screen |
| `cave-3m-1pc.json` | The same CAVE from one computer with four displays |
| `wall-3x1.json` | Three 16:9 tiles side by side |
| `wall-2x2.json` | Four 16:9 tiles with 2 cm bezels, runs the map app by default |
| `example-measured.json` | Template using measured corners and a per-screen stereo override |
| `schema.json` | Generated JSON Schema; regenerate with `npm run schema` after changing the types |

## Screens

A screen can be written two ways. By placement, for quick descriptions:

```json
{ "id": "left", "center": [-1.5, 1.5, 0], "width": 3, "height": 3, "yaw": 90, "widthPx": 1920, "heightPx": 1920 }
```

The screen starts facing the viewer at +z, centered at `center`. `yaw` turns it about the vertical axis in degrees (90 makes a left wall facing +x, -90 a right wall), `pitch` tilts it (-90 for a floor), `roll` turns it about its normal. Or by three measured corners in meters, lower-left `pa`, lower-right `pb`, upper-left `pc`:

```json
{ "id": "front", "pa": [-1.5, 0, -1.5], "pb": [1.5, 0, -1.5], "pc": [-1.5, 3, -1.5], "widthPx": 1920, "heightPx": 1920 }
```

Units are meters and degrees in a Y-up, right-handed frame with the physical floor at y = 0 and the viewer near the origin.

## Nodes

A node is a computer running one browser window per screen it lists. `"input": true` lets that node's keyboard, mouse and gamepads steer the cluster (see [input.md](input.md)); it is off by default.

```json
{ "id": "pc", "screens": ["front", "left", "right", "floor"], "input": true }
```

## Defaults and validation

Everything except `name`, `screens` and `nodes` has a default: `fps` 60, `sync` barrier, `defaultHead` at (0, 1.6, 0), mono stereo, the shapes app. A screen may override stereo settings, for instance a passive wall whose odd column needs `"firstEye": "right"`. The `app` object selects the application and its options (see [applications.md](applications.md)).

Validation errors name the field: `npm run schema` checks all files, and the Manager refuses to start on an invalid one and prints why.

The file format lives in `src/core/configFile.ts` as a zod schema; the runtime types are in `src/core/config.ts`.
