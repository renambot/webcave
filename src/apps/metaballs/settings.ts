/** Shared settings of the metaballs app, under appState.metaballs: the two rendering options kept from the original's panel. */
export type MetaballStyle = "lava" | "water" | "slime" | "none";

export interface MetaballSettings {
  style: MetaballStyle;
  /** Marching-cubes cell size in meters; smaller is finer and slower. */
  resolution: number;
}

export const STYLES: MetaballStyle[] = ["lava", "water", "slime", "none"];
/** The original's resolution presets. */
export const RESOLUTIONS: { label: string; step: number }[] = [
  { label: "Low", step: 0.2 },
  { label: "Medium", step: 0.1 },
  { label: "High", step: 0.075 },
  { label: "Ultra", step: 0.05 },
  { label: "CPU melting", step: 0.03 },
];

export const DEFAULT_SETTINGS: MetaballSettings = { style: "lava", resolution: 0.075 };

export function settingsOf(appState: Record<string, unknown> | undefined): MetaballSettings {
  const s = (appState?.metaballs ?? {}) as Partial<MetaballSettings>;
  return {
    style: STYLES.includes(s.style as MetaballStyle) ? (s.style as MetaballStyle) : DEFAULT_SETTINGS.style,
    resolution: typeof s.resolution === "number" && s.resolution > 0 ? s.resolution : DEFAULT_SETTINGS.resolution,
  };
}
