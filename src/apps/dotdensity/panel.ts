/**
 * The dot-density control panel: the original page's sidebar as a WebCAVE
 * panel. Plain DOM, no framework. Every control sends a patch of
 * appState.dotDensity (or the shared map camera for the 3D pitch); update()
 * mirrors the state, so two panels never disagree and a control that someone
 * else changed moves here too.
 */
import type { AppPanel, PanelContext } from "../types";
import type { FrameState } from "../../core/protocol";
import type { MapCamera } from "../map/wallmap";
import { CATEGORY_LABELS, FIELDS, FIELD_LABELS, SCHEMES, stateOf, type DotDensityState, type Field } from "./schemes";

const CSS = `
.dd h2 { margin: 0 0 4px; font-size: 15px; letter-spacing: 0.04em; }
.dd .sub { margin: 0 0 12px; color: var(--muted, #8b93a5); font-size: 12px; line-height: 1.4; }
.dd h3 { margin: 14px 0 6px; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted, #8b93a5); font-family: var(--mono, ui-monospace, monospace); }
.dd .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dd button { background: #1a1e27; color: inherit; border: 1px solid var(--panel-edge, #262a33); border-radius: 5px; padding: 6px 8px; font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.dd button:hover { border-color: var(--amber, #f59e0b); }
.dd button.active { background: var(--amber, #f59e0b); color: #111; border-color: var(--amber, #f59e0b); font-weight: 600; }
.dd .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 8px 0; background: #1a1e27; }
.dd .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-size: 12px; }
.dd .legend span { display: flex; align-items: center; gap: 6px; }
.dd .legend i { width: 10px; height: 10px; border-radius: 5px; display: inline-block; flex: none; }
.dd .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 12px; }
.dd input[type=range] { flex: 1; accent-color: var(--amber, #f59e0b); }
.dd .val { font-family: var(--mono, ui-monospace, monospace); min-width: 3em; text-align: right; }
.dd .toggles { display: flex; gap: 6px; }
.dd .toggles button { flex: 1; text-align: center; }
.dd .note { color: var(--muted, #8b93a5); font-size: 11px; line-height: 1.4; margin-top: 12px; }
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function createDotDensityPanel(container: HTMLElement, ctx: PanelContext, dataBase: string, defaultCamera: MapCamera): AppPanel {
  const style = el("style");
  style.textContent = CSS;
  const root = el("div", "dd");
  root.append(style);
  root.append(el("h2", undefined, "Toronto 2021 dot density"));
  root.append(el("p", "sub", "Each dot is ten people, coloured by a census field. Pan and zoom the map on a tile; the wall follows."));

  // Field buttons
  root.append(el("h3", undefined, "Colour by"));
  const fields = el("div", "fields");
  const fieldButtons = new Map<Field, HTMLButtonElement>();
  for (const f of FIELDS) {
    const b = el("button", undefined, FIELD_LABELS[f]);
    b.addEventListener("click", () => patch({ field: f }));
    fields.append(b);
    fieldButtons.set(f, b);
  }
  root.append(fields);

  // Legend: a proportional bar plus a list, from the summary CSV of the field.
  root.append(el("h3", undefined, "Legend"));
  const bar = el("div", "bar");
  const legend = el("div", "legend");
  root.append(bar, legend);

  // Dot size
  root.append(el("h3", undefined, "Dots"));
  const sizeRow = el("div", "row");
  const size = el("input");
  size.type = "range";
  size.min = "0.2";
  size.max = "3";
  size.step = "0.1";
  const sizeVal = el("span", "val");
  sizeRow.append(el("span", undefined, "Size"), size, sizeVal);
  root.append(sizeRow);
  size.addEventListener("input", () => patch({ pointSize: Number(size.value) }));

  // Theme and 3D
  const toggles = el("div", "toggles");
  const dark = el("button", undefined, "Dark basemap");
  const threeD = el("button", undefined, "3D");
  toggles.append(dark, threeD);
  root.append(toggles);
  dark.addEventListener("click", () => patch({ dark: !current.dark }));
  threeD.addEventListener("click", () => {
    const on = !current.extruded;
    const state = ctx.getState();
    const cam = (state.appState?.map as MapCamera | undefined) ?? defaultCamera;
    // Lift the dots and tilt the shared camera, like the original's 3D button.
    ctx.send({ dotDensity: { ...current, extruded: on, since: state.time }, map: { ...cam, pitch: on ? 54 : 0 } satisfies MapCamera });
  });

  root.append(
    el(
      "p",
      "note",
      "Data: Statistics Canada, 2021 Census, prepared by the School of Cities, University of Toronto (schoolofcities.github.io/dot-density). Points load once per screen; the first frames show the basemap only.",
    ),
  );
  container.append(root);

  let current: DotDensityState = stateOf(ctx.getState().appState);
  function patch(p: Partial<DotDensityState>) {
    ctx.send({ dotDensity: { ...current, ...p } });
  }

  // Legend data per field, fetched once.
  const summaries = new Map<Field, Promise<{ key: string; value: number }[]>>();
  const summary = (f: Field) => {
    let p = summaries.get(f);
    if (!p) {
      p = fetch(`${dataBase}summary-${f}.csv`)
        .then((r) => (r.ok ? r.text() : ""))
        .then((t) =>
          t
            .trim()
            .split(/\r?\n/)
            .slice(1)
            .map((line) => line.split(","))
            .filter((c) => c.length >= 2 && Number(c[1]) > 0)
            .map((c) => ({ key: c[0], value: Number(c[1]) })),
        )
        .catch(() => []);
      summaries.set(f, p);
    }
    return p;
  };
  let legendField: Field | null = null;
  let legendDark: boolean | null = null;
  async function renderLegend(f: Field, isDark: boolean) {
    legendField = f;
    legendDark = isDark;
    bar.replaceChildren();
    legend.replaceChildren();
    if (f === "people") {
      const s = el("span");
      const i = el("i");
      i.style.background = isDark ? "#fff" : "#000";
      s.append(i, document.createTextNode("Ten people per dot"));
      legend.append(s);
      return;
    }
    const rows = await summary(f);
    if (legendField !== f) return; // the field changed while loading
    const scheme = SCHEMES[f];
    const labels = CATEGORY_LABELS[f] ?? {};
    for (const row of rows) {
      const c = scheme[row.key];
      if (!c || c[3] === 0) continue;
      const rgb = `rgb(${c[0]},${c[1]},${c[2]})`;
      const seg = el("div");
      seg.style.cssText = `width:${row.value}%;background:${rgb}`;
      seg.title = `${labels[row.key] ?? row.key}: ${row.value.toFixed(1)}%`;
      bar.append(seg);
      const s = el("span");
      const i = el("i");
      i.style.background = rgb;
      s.append(i, document.createTextNode(`${labels[row.key] ?? row.key} (${row.value.toFixed(1)}%)`));
      legend.append(s);
    }
  }

  return {
    update(state: FrameState) {
      current = stateOf(state.appState);
      for (const [f, b] of fieldButtons) b.classList.toggle("active", f === current.field);
      if (document.activeElement !== size) size.value = String(current.pointSize);
      sizeVal.textContent = current.pointSize.toFixed(1);
      dark.classList.toggle("active", current.dark);
      threeD.classList.toggle("active", current.extruded);
      if (legendField !== current.field || legendDark !== current.dark) void renderLegend(current.field, current.dark);
    },
    dispose() {
      root.remove();
    },
  };
}
