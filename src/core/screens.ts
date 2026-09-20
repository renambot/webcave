/**
 * Window Management API helpers (Chromium): enumerate the displays attached
 * to this computer and go fullscreen on a chosen one.
 *
 * Rules, learned from FrameSync:
 *  - getScreenDetails() prompts for permission, so call it inside a user
 *    gesture (click or key). Cache the result and listen to "screenschange".
 *  - It exists only in secure contexts: http://localhost is fine, another
 *    host over plain http is not (serve https, or launch Chrome with
 *    --unsafely-treat-insecure-origin-as-secure=http://host:port).
 *  - Fullscreen also needs a gesture; unattended nodes use kiosk mode instead.
 *
 * Used by the node page (fullscreen on ?screen=N and a display line in the
 * HUD) and by the launcher page (display table, one window per display).
 * The `ScreenDetailed` types are not in TypeScript's DOM lib yet, hence the
 * small local interfaces below.
 */

/** Subset of the spec's ScreenDetailed that we use. */
export interface ScreenInfo {
  index: number;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  devicePixelRatio: number;
  isPrimary: boolean;
  isInternal: boolean;
  /** The native object, for requestFullscreen({ screen }). */
  native: unknown;
}

interface ScreenDetailedLike {
  label?: string;
  left: number;
  top: number;
  width: number;
  height: number;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  devicePixelRatio: number;
  isPrimary: boolean;
  isInternal: boolean;
}

interface ScreenDetailsLike extends EventTarget {
  screens: ScreenDetailedLike[];
  currentScreen: ScreenDetailedLike;
}

type WindowWithScreens = Window & { getScreenDetails?: () => Promise<ScreenDetailsLike> };

export const hasWindowManagement = typeof window !== "undefined" && "getScreenDetails" in window;
export const isMultiScreen = typeof window !== "undefined" && (window.screen as Screen & { isExtended?: boolean }).isExtended === true;

let details: ScreenDetailsLike | null = null;
const listeners = new Set<(screens: ScreenInfo[]) => void>();

function toInfo(s: ScreenDetailedLike, index: number): ScreenInfo {
  return {
    index,
    label: s.label || `${s.width}×${s.height}`,
    left: s.left,
    top: s.top,
    width: s.width,
    height: s.height,
    availLeft: s.availLeft,
    availTop: s.availTop,
    availWidth: s.availWidth,
    availHeight: s.availHeight,
    devicePixelRatio: s.devicePixelRatio,
    isPrimary: s.isPrimary,
    isInternal: s.isInternal,
    native: s,
  };
}

/** Current display list, or null when unsupported or permission refused. */
export async function getScreens(): Promise<ScreenInfo[] | null> {
  const w = window as WindowWithScreens;
  if (!w.getScreenDetails) return null;
  if (!details) {
    try {
      details = await w.getScreenDetails();
    } catch {
      return null;
    }
    details.addEventListener("screenschange", () => {
      const list = details!.screens.map(toInfo);
      listeners.forEach((cb) => cb(list));
    });
  }
  return details.screens.map(toInfo);
}

/** Notified when displays are plugged or unplugged (after a successful getScreens). */
export function onScreensChange(cb: (screens: ScreenInfo[]) => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Index of the display this window is currently on, or -1. */
export function currentScreenIndex(screens: ScreenInfo[]): number {
  if (!details) return -1;
  return details.screens.indexOf(details.currentScreen as ScreenDetailedLike);
}

/**
 * Fullscreen `el` on display `index` (or the current display when null).
 * Must run inside a user gesture. Falls back to the current display when the
 * API or permission is unavailable.
 */
export async function requestFullscreenOn(el: Element, index: number | null): Promise<void> {
  let opts: FullscreenOptions | undefined;
  if (index !== null) {
    const screens = await getScreens();
    const target = screens?.[index];
    if (target) opts = { screen: target.native } as FullscreenOptions;
  }
  await el.requestFullscreen(opts);
}

/** Human-readable one-liner for HUDs. */
export function describeScreen(s: ScreenInfo): string {
  return `display ${s.index} ${s.label} ${s.width}×${s.height}@${s.devicePixelRatio}x at ${s.left},${s.top}${s.isPrimary ? " ★" : ""}`;
}
