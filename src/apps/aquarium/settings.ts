/** Shared settings of the aquarium, under appState.aquarium; mirrors the original's settings page. */
export interface AquariumSettings {
  /** Index into the fish counts [1, 100, 500, 1000, 5000, 10000, 15000, 20000, 25000, 30000]. */
  fishSetting: number;
  /** Time multiplier for the fish. */
  speed: number;
  /** Fog and ambient preset: inside, outside, original. */
  view: "inside" | "outside" | "original";
  drawLasers: boolean;
  options: { normalMaps: boolean; reflection: boolean; tank: boolean; museum: boolean; fog: boolean; bubbles: boolean; lightRays: boolean };
}

export const FISH_COUNTS = [1, 100, 500, 1000, 5000, 10000, 15000, 20000, 25000, 30000];
export const OPTION_LABELS: Record<keyof AquariumSettings["options"], string> = {
  normalMaps: "Normal maps",
  reflection: "Reflection",
  tank: "Tank",
  museum: "Museum",
  fog: "Fog",
  bubbles: "Bubbles",
  lightRays: "Light rays",
};

export const DEFAULT_SETTINGS: AquariumSettings = {
  fishSetting: 2,
  speed: 1,
  view: "inside",
  drawLasers: false,
  options: { normalMaps: true, reflection: true, tank: true, museum: true, fog: true, bubbles: true, lightRays: true },
};

export function settingsOf(appState: Record<string, unknown> | undefined): AquariumSettings {
  const s = (appState?.aquarium ?? {}) as Partial<AquariumSettings> & { options?: Partial<AquariumSettings["options"]> };
  const options = { ...DEFAULT_SETTINGS.options };
  for (const k of Object.keys(options) as (keyof AquariumSettings["options"])[]) if (typeof s.options?.[k] === "boolean") options[k] = s.options[k]!;
  return {
    fishSetting: typeof s.fishSetting === "number" ? Math.max(0, Math.min(FISH_COUNTS.length - 1, s.fishSetting | 0)) : DEFAULT_SETTINGS.fishSetting,
    speed: typeof s.speed === "number" ? s.speed : DEFAULT_SETTINGS.speed,
    view: s.view === "outside" || s.view === "original" ? s.view : "inside",
    drawLasers: typeof s.drawLasers === "boolean" ? s.drawLasers : DEFAULT_SETTINGS.drawLasers,
    options,
  };
}
