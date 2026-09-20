/** The Hacker News panel: refresh, the story list (click to open comments), close. */
import type { AppPanel, PanelContext } from "../types";
import type { FrameState } from "../../core/protocol";
import { ago, hnStateOf } from "./data";

const CSS = `
.hn h2 { margin: 0 0 4px; font-size: 15px; letter-spacing: 0.04em; }
.hn .sub { margin: 0 0 10px; color: var(--muted, #8b93a5); font-size: 12px; line-height: 1.4; }
.hn .row { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
.hn button { background: #1a1e27; color: inherit; border: 1px solid var(--panel-edge, #262a33); border-radius: 5px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.hn button:hover { border-color: #ff6600; }
.hn button.active { background: #ff6600; color: #111; border-color: #ff6600; font-weight: 600; }
.hn .status { font-family: var(--mono, ui-monospace, monospace); font-size: 11px; color: var(--muted, #8b93a5); }
.hn ol { margin: 8px 0 0; padding: 0 0 0 1.6em; font-size: 12px; line-height: 1.35; }
.hn li { margin: 3px 0; cursor: pointer; }
.hn li:hover { color: #ffb066; }
.hn li.selected { color: #ff6600; font-weight: 600; }
.hn li small { color: var(--muted, #8b93a5); }
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export interface PanelActions {
  refresh(): void;
  select(id: number): void;
  close(): void;
  tier(): string;
}

export function createHnPanel(container: HTMLElement, ctx: PanelContext, actions: PanelActions): AppPanel {
  const style = el("style");
  style.textContent = CSS;
  const root = el("div", "hn");
  root.append(style, el("h2", undefined, "Hacker News"), el("p", "sub", "The front page on a curved wall around you. Point the wand at a story and press the primary button for its comments; B closes them."));
  const row = el("div", "row");
  const refresh = el("button", undefined, "Refresh");
  const close = el("button", undefined, "Close comments");
  refresh.addEventListener("click", () => actions.refresh());
  close.addEventListener("click", () => actions.close());
  row.append(refresh, close);
  root.append(row);
  const status = el("div", "status");
  root.append(status);
  const list = el("ol");
  root.append(list);
  container.append(root);

  let renderedKey = "";
  return {
    update(state: FrameState) {
      const hn = hnStateOf(state.appState);
      status.textContent = hn.stories.length
        ? `${hn.stories.length} stories · fetched ${ago(hn.fetchedAt, Math.floor(Date.now() / 1000))} · cards: ${actions.tier()}`
        : `no stories yet · cards: ${actions.tier()}`;
      const key = `${hn.fetchedAt}|${hn.selected}`;
      if (key === renderedKey) return;
      renderedKey = key;
      list.replaceChildren();
      hn.stories.forEach((s) => {
        const li = el("li", s.id === hn.selected ? "selected" : undefined);
        li.append(document.createTextNode(s.title + " "));
        li.append(el("small", undefined, `${s.score} · ${s.descendants} comments`));
        li.addEventListener("click", () => actions.select(s.id));
        list.append(li);
      });
      close.classList.toggle("active", hn.selected !== 0);
    },
    dispose() {
      root.remove();
    },
  };
}
