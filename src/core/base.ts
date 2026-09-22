/**
 * Where the site lives. Vite's `base` (BASE_PATH at build time, "/" in
 * development) is the prefix of every page and public file, so a deployment
 * behind a reverse proxy at https://host/webcave/ works unchanged: pages link
 * to each other relatively, bundled assets are rewritten by Vite, and the few
 * root-absolute defaults in the apps go through publicUrl().
 */

/** The base path with a trailing slash: "/" or "/webcave/". */
export const BASE: string = import.meta.env.BASE_URL;

/** A site-relative URL ("/models/x.glb") under the base path; other URLs unchanged. */
export function publicUrl(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") ? BASE.replace(/\/$/, "") + url : url;
}

/**
 * The Manager's WebSocket when a page gives none. In development the Manager
 * listens on its own port next to the dev server (through the dev server's
 * /manager proxy when the page is https, which WebXR needs). Deployed, the same
 * origin serves both: the reverse proxy forwards <base>/manager to the Manager.
 */
export function defaultManagerUrl(): string {
  if (import.meta.env.DEV) return location.protocol === "https:" ? `wss://${location.host}/manager` : `ws://${location.hostname}:8765`;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${BASE}manager`;
}
