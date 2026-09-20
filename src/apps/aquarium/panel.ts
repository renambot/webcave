/**
 * The aquarium's settings page as a WebCAVE panel: fish count, rendering
 * options, lasers, speed and the fog preset. Every control patches
 * appState.aquarium; update() mirrors the state back.
 */
import type { AppPanel, PanelContext } from "../types";
import type { FrameState } from "../../core/protocol";
import { FISH_COUNTS, OPTION_LABELS, settingsOf, type AquariumSettings } from "./settings";

const CSS = `
.aq h2 { margin: 0 0 4px; font-size: 15px; letter-spacing: 0.04em; }
.aq .sub { margin: 0 0 12px; color: var(--muted, #8b93a5); font-size: 12px; line-height: 1.4; }
.aq h3 { margin: 14px 0 6px; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted, #8b93a5); font-family: var(--mono, ui-monospace, monospace); }
.aq .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.aq .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.aq button { background: #1a1e27; color: inherit; border: 1px solid var(--panel-edge, #262a33); border-radius: 5px; padding: 6px 4px; font: inherit; font-size: 12px; cursor: pointer; text-align: center; }
.aq button:hover { border-color: var(--amber, #f59e0b); }
.aq button.active { background: var(--amber, #f59e0b); color: #111; border-color: var(--amber, #f59e0b); font-weight: 600; }
.aq .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 12px; }
.aq input[type=range] { flex: 1; accent-color: var(--amber, #f59e0b); }
.aq .val { font-family: var(--mono, ui-monospace, monospace); min-width: 3em; text-align: right; }
.aq .note { color: var(--muted, #8b93a5); font-size: 11px; line-height: 1.4; margin-top: 12px; }
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function createAquariumPanel(container: HTMLElement, ctx: PanelContext): AppPanel {
  const style = el("style");
  style.textContent = CSS;
  const root = el("div", "aq");
  root.append(style, el("h2", undefined, "WebGL Aquarium"), el("p", "sub", "The CAVE stands in the tank. Walk with the sticks or the arrow keys; the fish pass through the room."));

  let current: AquariumSettings = settingsOf(ctx.getState().appState);
  // Apply optimistically, so two clicks in one frame both survive (the second would otherwise be built from stale state).
  const patch = (p: Partial<AquariumSettings>) => {
    current = { ...current, ...p, options: { ...current.options, ...(p.options ?? {}) } };
    ctx.send({ aquarium: current });
  };

  root.append(el("h3", undefined, "Fish"));
  const fishGrid = el("div", "grid");
  const fishButtons = FISH_COUNTS.map((n, i) => {
    const b = el("button", undefined, n >= 1000 ? `${n / 1000}k` : String(n));
    b.title = `${n.toLocaleString()} fish`;
    b.addEventListener("click", () => patch({ fishSetting: i }));
    fishGrid.append(b);
    return b;
  });
  root.append(fishGrid);

  root.append(el("h3", undefined, "Options"));
  const optGrid = el("div", "grid2");
  const optButtons = new Map<keyof AquariumSettings["options"], HTMLButtonElement>();
  for (const k of Object.keys(OPTION_LABELS) as (keyof AquariumSettings["options"])[]) {
    const b = el("button", undefined, OPTION_LABELS[k]);
    b.addEventListener("click", () => patch({ options: { ...current.options, [k]: !current.options[k] } }));
    optGrid.append(b);
    optButtons.set(k, b);
  }
  const lasers = el("button", undefined, "Lasers");
  lasers.addEventListener("click", () => patch({ drawLasers: !current.drawLasers }));
  optGrid.append(lasers);
  root.append(optGrid);

  root.append(el("h3", undefined, "Speed"));
  const speedRow = el("div", "row");
  const speed = el("input");
  speed.type = "range";
  speed.min = "0";
  speed.max = "4";
  speed.step = "0.1";
  const speedVal = el("span", "val");
  speedRow.append(speed, speedVal);
  root.append(speedRow);
  speed.addEventListener("input", () => patch({ speed: Number(speed.value) }));

  root.append(el("h3", undefined, "Fog preset"));
  const viewGrid = el("div", "grid2");
  const viewButtons = new Map<AquariumSettings["view"], HTMLButtonElement>();
  for (const v of ["inside", "outside", "original"] as const) {
    const b = el("button", undefined, v[0].toUpperCase() + v.slice(1));
    b.addEventListener("click", () => patch({ view: v }));
    viewGrid.append(b);
    viewButtons.set(v, b);
  }
  root.append(viewGrid);
  root.append(el("p", "note", "WebGL Aquarium by Google (WebGLSamples, 2009), BSD license; see public/aquarium/LICENSE.md. Models load once per screen; the tank appears as they arrive."));
  container.append(root);

  return {
    update(state: FrameState) {
      current = settingsOf(state.appState);
      fishButtons.forEach((b, i) => b.classList.toggle("active", i === current.fishSetting));
      for (const [k, b] of optButtons) b.classList.toggle("active", current.options[k]);
      lasers.classList.toggle("active", current.drawLasers);
      if (document.activeElement !== speed) speed.value = String(current.speed);
      speedVal.textContent = `${current.speed.toFixed(1)}×`;
      for (const [v, b] of viewButtons) b.classList.toggle("active", v === current.view);
    },
    dispose() {
      root.remove();
    },
  };
}
