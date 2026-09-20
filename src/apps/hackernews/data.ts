/**
 * Hacker News data through the public Firebase API (no key, CORS enabled):
 *   https://hacker-news.firebaseio.com/v0/topstories.json   -> [id, ...]
 *   https://hacker-news.firebaseio.com/v0/item/<id>.json     -> story or comment
 *
 * Only the controller fetches. It publishes a compact snapshot into
 * appState.hn, and every node builds its cards from that, so all screens
 * show the same stories and nobody but the controller talks to the API.
 */

const API = "https://hacker-news.firebaseio.com/v0";

export interface Story {
  id: number;
  title: string;
  by: string;
  score: number;
  /** Comment count. */
  descendants: number;
  /** Unix seconds. */
  time: number;
  /** Hostname of the link, or "" for Ask / Show HN text posts. */
  domain: string;
}

export interface Comment {
  id: number;
  by: string;
  time: number;
  /** Plain text, HTML stripped, truncated. */
  text: string;
  depth: number;
}

/** What travels in appState.hn. */
export interface HnState {
  /** Unix seconds when the snapshot was taken (for "3 hours ago"). */
  fetchedAt: number;
  stories: Story[];
  /** Selected story id, or 0. */
  selected: number;
  /** Comments of the selected story, when loaded. */
  comments?: { story: number; list: Comment[] };
}

export const EMPTY_STATE: HnState = { fetchedAt: 0, stories: [], selected: 0 };

export function hnStateOf(appState: Record<string, unknown> | undefined): HnState {
  const s = appState?.hn as Partial<HnState> | undefined;
  if (!s || !Array.isArray(s.stories)) return EMPTY_STATE;
  return { fetchedAt: s.fetchedAt ?? 0, stories: s.stories, selected: s.selected ?? 0, comments: s.comments };
}

async function item<T>(id: number): Promise<T | null> {
  const r = await fetch(`${API}/item/${id}.json`);
  return r.ok ? ((await r.json()) as T) : null;
}

interface RawItem {
  id: number;
  type?: string;
  title?: string;
  by?: string;
  score?: number;
  descendants?: number;
  time?: number;
  url?: string;
  text?: string;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
}

export async function fetchTopStories(count = 30): Promise<Story[]> {
  const r = await fetch(`${API}/topstories.json`);
  if (!r.ok) throw new Error(`topstories ${r.status}`);
  const ids = ((await r.json()) as number[]).slice(0, count);
  const items = await Promise.all(ids.map((id) => item<RawItem>(id)));
  return items
    .filter((it): it is RawItem => !!it && !it.deleted && !it.dead && !!it.title)
    .map((it) => ({
      id: it.id,
      title: it.title ?? "",
      by: it.by ?? "",
      score: it.score ?? 0,
      descendants: it.descendants ?? 0,
      time: it.time ?? 0,
      domain: it.url ? new URL(it.url).hostname.replace(/^www\./, "") : "",
    }));
}

/** Strip HN's comment HTML to plain text, keeping paragraph breaks. */
export function stripHtml(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html.replace(/<p>/g, "\n\n");
  return (el.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The first `max` comments of a story, breadth-first two levels deep, texts truncated. */
export async function fetchComments(storyId: number, max = 24, maxChars = 480): Promise<Comment[]> {
  const story = await item<RawItem>(storyId);
  const out: Comment[] = [];
  const queue: { id: number; depth: number }[] = (story?.kids ?? []).map((id) => ({ id, depth: 0 }));
  while (queue.length && out.length < max) {
    const batch = queue.splice(0, Math.min(8, max - out.length));
    const items = await Promise.all(batch.map((b) => item<RawItem>(b.id).then((it) => ({ it, depth: b.depth }))));
    for (const { it, depth } of items) {
      if (!it || it.deleted || it.dead || !it.text) continue;
      const text = stripHtml(it.text);
      out.push({ id: it.id, by: it.by ?? "", time: it.time ?? 0, text: text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text, depth });
      if (depth < 1) for (const k of (it.kids ?? []).slice(0, 2)) queue.push({ id: k, depth: depth + 1 });
    }
  }
  return out;
}

/** "5 minutes ago", from unix seconds, relative to the snapshot time (deterministic on every node). */
export function ago(time: number, now: number): string {
  const s = Math.max(0, now - time);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} minutes ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}
