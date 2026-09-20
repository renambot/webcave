/**
 * The metaballs panel: the two rendering options kept from the original's
 * Tweakpane (style, resolution) as shared state, and the stats of this
 * window's rendering (frames per second, JavaScript frame time, GPU pass
 * timings from timestamp queries when the adapter has them).
 */
import type { AppPanel, PanelContext } from "../types";
import type { FrameState } from "../../core/protocol";
import { RESOLUTIONS, STYLES, settingsOf, type MetaballSettings } from "./settings";

const CSS = `
.mb h2 { margin: 0 0 4px; font-size: 15px; letter-spacing: 0.04em; }
.mb .sub { margin: 0 0 12px; color: var(--muted, #8b93a5); font-size: 12px; line-height: 1.4; }
.mb h3 { margin: 14px 0 6px; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted, #8b93a5); font-family: var(--mono, ui-monospace, monospace); }
.mb .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.mb button { background: #1a1e27; color: inherit; border: 1px solid var(--panel-edge, #262a33); border-radius: 5px; padding: 6px 8px; font: inherit; font-size: 12px; cursor: pointer; }
.mb button:hover { border-color: var(--amber, #f59e0b); }
.mb button.active { background: var(--amber, #f59e0b); color: #111; border-color: var(--amber, #f59e0b); font-weight: 600; }
.mb table { width: 100%; border-collapse: collapse; font-family: var(--mono, ui-monospace, monospace); font-size: 12px; }
.mb td { padding: 3px 0; border-bottom: 1px solid var(--panel-edge, #262a33); }
.mb td:last-child { text-align: right; }
.mb .note { color: var(--muted, #8b93a5); font-size: 11px; line-height: 1.4; margin-top: 12px; }
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** What the panel reads from the app's PerformanceTracker each frame. */
export interface StatsSource {
  fps(): number;
  /** name -> average value; GPU timings in microseconds, "frameJs µs" in microseconds. */
  entries(): [string, number][];
  rendering(): boolean;
}

export function createMetaballsPanel(container: HTMLElement, ctx: PanelContext, stats: StatsSource): AppPanel {
  const style = el("style");
  style.textContent = CSS;
  const root = el("div", "mb");
  root.append(style, el("h2", undefined, "WebGPU Metaballs"), el("p", "sub", "Marching cubes on the GPU over a dungeon lit by clustered lights. The blobs rise just past the front wall."));

  let current: MetaballSettings = settingsOf(ctx.getState().appState);
  const patch = (p: Partial<MetaballSettings>) => {
    current = { ...current, ...p };
    ctx.send({ metaballs: current });
  };

  root.append(el("h3", undefined, "Metaball style"));
  const styleGrid = el("div", "grid");
  const styleButtons = new Map(
    STYLES.map((s) => {
      const b = el("button", undefined, s[0].toUpperCase() + s.slice(1));
      b.addEventListener("click", () => patch({ style: s }));
      styleGrid.append(b);
      return [s, b] as const;
    }),
  );
  root.append(styleGrid);

  root.append(el("h3", undefined, "Metaball resolution"));
  const resGrid = el("div", "grid");
  const resButtons = RESOLUTIONS.map((r) => {
    const b = el("button", undefined, `${r.label} (${r.step})`);
    b.addEventListener("click", () => patch({ resolution: r.step }));
    resGrid.append(b);
    return { step: r.step, b };
  });
  root.append(resGrid);

  root.append(el("h3", undefined, "Stats"));
  const table = el("table");
  root.append(table);
  root.append(el("p", "note", "Stats are this window's own rendering. GPU pass times come from WebGPU timestamp queries when the adapter supports them. webgpu-metaballs by Brandon Jones (MIT); dungeon scene and textures under their own licenses, see the credits in public/metaballs/."));
  container.append(root);

  let statsTick = 0;
  return {
    update(state: FrameState) {
      current = settingsOf(state.appState);
      for (const [s, b] of styleButtons) b.classList.toggle("active", s === current.style);
      for (const r of resButtons) r.b.classList.toggle("active", Math.abs(r.step - current.resolution) < 1e-6);
      if (++statsTick % 15 !== 0) return; // a quarter second at 60 fps
      table.replaceChildren();
      if (!stats.rendering()) {
        const tr = el("tr");
        tr.append(el("td", undefined, "no rendering in this window"), el("td"));
        table.append(tr);
        return;
      }
      const row = (k: string, v: string) => {
        const tr = el("tr");
        tr.append(el("td", undefined, k), el("td", undefined, v));
        table.append(tr);
      };
      row("fps", stats.fps().toFixed(0));
      for (const [name, value] of stats.entries()) {
        const ms = value / 1000;
        row(name.replace(/ µs$/, ""), `${ms.toFixed(2)} ms`);
      }
    },
    dispose() {
      root.remove();
    },
  };
}
