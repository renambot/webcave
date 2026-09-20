/**
 * Rasterizing Hacker News cards to canvases, two ways.
 *
 * HTML-in-canvas tier: the card is real DOM inside a <canvas layoutsubtree>
 * element; the browser lays it out with CSS and fonts and
 * drawElementImage() paints it into the canvas. Used when the browser has
 * the API (Chrome's HTML-in-Canvas feature).
 *
 * Canvas 2D tier: the same card drawn by hand with fillText and a small
 * word-wrapper. Cruder typography, works everywhere. The app picks the tier
 * at start and says which in its status.
 *
 * Both produce a canvas of the requested pixel size; the caller wraps it in
 * a CanvasTexture. Cards re-render only when their content or highlight
 * changes, never per frame.
 */
import type { Comment, Story } from "./data";
import { ago } from "./data";

export type Tier = "html" | "canvas2d";

export interface CardLook {
  pointed: boolean;
  selected: boolean;
}

const HN_ORANGE = "#ff6600";
const BG = "#f6f6ef";
const TEXT = "#000000";
const MUTED = "#828282";

interface Ctx2D extends CanvasRenderingContext2D {
  drawElementImage?(el: Element, dx: number, dy: number): void;
}

/** Whether the HTML-in-canvas API is present. */
export function detectTier(): Tier {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d") as Ctx2D | null;
  return ctx && typeof ctx.drawElementImage === "function" && "layoutsubtree" in c ? "html" : "canvas2d";
}

// ---- HTML tier ----------------------------------------------------------------------------

const CARD_CSS = `
.hn-card { box-sizing: border-box; width: 100%; height: 100%; padding: 6% 7%; background: ${BG}; color: ${TEXT};
  font: 500 34px/1.25 "Verdana", "Geneva", sans-serif; display: flex; flex-direction: column; gap: 3%; border: 6px solid transparent; }
.hn-card.pointed { border-color: #ffb066; }
.hn-card.selected { border-color: ${HN_ORANGE}; }
.hn-card .rank { color: ${MUTED}; font-size: 0.8em; }
.hn-card .title { font-weight: 600; overflow: hidden; }
.hn-card .domain { color: ${MUTED}; font-size: 0.7em; }
.hn-card .sub { color: ${MUTED}; font-size: 0.7em; margin-top: auto; }
.hn-comments { box-sizing: border-box; width: 100%; height: 100%; padding: 3% 4%; background: ${BG}; color: ${TEXT};
  font: 400 26px/1.3 "Verdana", "Geneva", sans-serif; overflow: hidden; }
.hn-comments h1 { font-size: 1.15em; margin: 0 0 0.5em; padding-bottom: 0.4em; border-bottom: 3px solid ${HN_ORANGE}; }
.hn-comments .c { margin: 0 0 0.6em; }
.hn-comments .c.d1 { margin-left: 5%; }
.hn-comments .by { color: ${MUTED}; font-size: 0.8em; }
.hn-comments .t { white-space: pre-wrap; }
`;

/** A hidden host for layoutsubtree canvases, so the DOM cards are in the document and get laid out. */
let host: HTMLElement | null = null;
function hostEl(): HTMLElement {
  if (!host) {
    host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-20000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
    const style = document.createElement("style");
    style.textContent = CARD_CSS;
    host.append(style);
    document.body.append(host);
  }
  return host;
}

function htmlCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx2D } {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("layoutsubtree", "");
  canvas.width = w;
  canvas.height = h;
  canvas.style.cssText = `width:${w}px;height:${h}px;display:block;`;
  hostEl().append(canvas);
  return { canvas, ctx: canvas.getContext("2d") as Ctx2D };
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function renderCardHtml(story: Story, rank: number, now: number, look: CardLook, w: number, h: number): HTMLCanvasElement {
  const { canvas, ctx } = htmlCanvas(w, h);
  const el = document.createElement("div");
  el.className = `hn-card${look.pointed ? " pointed" : ""}${look.selected ? " selected" : ""}`;
  el.innerHTML = `<div class="rank">${rank}.</div><div class="title">${esc(story.title)}</div>${story.domain ? `<div class="domain">(${esc(story.domain)})</div>` : ""}<div class="sub">${story.score} points by ${esc(story.by)} · ${ago(story.time, now)} · ${story.descendants} comments</div>`;
  canvas.append(el);
  ctx.drawElementImage!(el, 0, 0);
  canvas.remove();
  return canvas;
}

export function renderCommentsHtml(story: Story, comments: Comment[], now: number, w: number, h: number): HTMLCanvasElement {
  const { canvas, ctx } = htmlCanvas(w, h);
  const el = document.createElement("div");
  el.className = "hn-comments";
  el.innerHTML = `<h1>${esc(story.title)}</h1>` + comments.map((c) => `<div class="c d${c.depth}"><div class="by">${esc(c.by)} · ${ago(c.time, now)}</div><div class="t">${esc(c.text)}</div></div>`).join("");
  canvas.append(el);
  ctx.drawElementImage!(el, 0, 0);
  canvas.remove();
  return canvas;
}

// ---- Canvas 2D tier -------------------------------------------------------------------------

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

export function renderCard2d(story: Story, rank: number, now: number, look: CardLook, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  if (look.pointed || look.selected) {
    ctx.strokeStyle = look.selected ? HN_ORANGE : "#ffb066";
    ctx.lineWidth = Math.max(4, w * 0.012);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  }
  const pad = w * 0.07;
  const base = Math.round(h * 0.11);
  let y = pad + base * 0.9;
  ctx.fillStyle = MUTED;
  ctx.font = `${Math.round(base * 0.8)}px Verdana, Geneva, sans-serif`;
  ctx.fillText(`${rank}.`, pad, y);
  y += base * 1.15;
  ctx.fillStyle = TEXT;
  ctx.font = `600 ${base}px Verdana, Geneva, sans-serif`;
  const titleLines = wrap(ctx, story.title, w - 2 * pad).slice(0, 3);
  for (const line of titleLines) {
    ctx.fillText(line, pad, y);
    y += base * 1.25;
  }
  ctx.fillStyle = MUTED;
  ctx.font = `${Math.round(base * 0.7)}px Verdana, Geneva, sans-serif`;
  if (story.domain) ctx.fillText(`(${story.domain})`, pad, y);
  const sub = `${story.score} points by ${story.by} · ${ago(story.time, now)} · ${story.descendants} comments`;
  const subLines = wrap(ctx, sub, w - 2 * pad).slice(0, 2);
  let sy = h - pad - (subLines.length - 1) * base * 0.9;
  for (const line of subLines) {
    ctx.fillText(line, pad, sy);
    sy += base * 0.9;
  }
  return canvas;
}

export function renderComments2d(story: Story, comments: Comment[], now: number, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  const pad = w * 0.04;
  const base = Math.round(w * 0.024);
  let y = pad + base;
  ctx.fillStyle = TEXT;
  ctx.font = `600 ${Math.round(base * 1.15)}px Verdana, Geneva, sans-serif`;
  for (const line of wrap(ctx, story.title, w - 2 * pad).slice(0, 2)) {
    ctx.fillText(line, pad, y);
    y += base * 1.4;
  }
  ctx.fillStyle = HN_ORANGE;
  ctx.fillRect(pad, y - base * 0.6, w - 2 * pad, 3);
  y += base * 0.8;
  for (const c of comments) {
    const x = pad + (c.depth ? w * 0.05 : 0);
    if (y > h - pad) break;
    ctx.fillStyle = MUTED;
    ctx.font = `${Math.round(base * 0.8)}px Verdana, Geneva, sans-serif`;
    ctx.fillText(`${c.by} · ${ago(c.time, now)}`, x, y);
    y += base * 1.2;
    ctx.fillStyle = TEXT;
    ctx.font = `${base}px Verdana, Geneva, sans-serif`;
    for (const line of wrap(ctx, c.text, w - pad - x).slice(0, 8)) {
      if (y > h - pad) break;
      ctx.fillText(line, x, y);
      y += base * 1.3;
    }
    y += base * 0.6;
  }
  return canvas;
}

export function renderCard(tier: Tier, story: Story, rank: number, now: number, look: CardLook, w: number, h: number): HTMLCanvasElement {
  if (tier === "html") {
    try {
      return renderCardHtml(story, rank, now, look, w, h);
    } catch {
      /* fall through to 2D */
    }
  }
  return renderCard2d(story, rank, now, look, w, h);
}

export function renderComments(tier: Tier, story: Story, comments: Comment[], now: number, w: number, h: number): HTMLCanvasElement {
  if (tier === "html") {
    try {
      return renderCommentsHtml(story, comments, now, w, h);
    } catch {
      /* fall through */
    }
  }
  return renderComments2d(story, comments, now, w, h);
}
