/**
 * Fields, categories, colours and labels of the Toronto dot-density map, from
 * the School of Cities project (colorSchemes.js and the legend components).
 * Each CSV row is one dot standing for ten people; every field is a category
 * code per person. Alpha 0 hides a category (unknown, other).
 */
export type RGBA = [number, number, number, number];

export const FIELDS = ["people", "gender", "ethnicity", "income", "immigration", "journey_mode", "commute_time", "age"] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_LABELS: Record<Field, string> = {
  people: "People",
  gender: "Gender",
  ethnicity: "Ethnicity",
  income: "Income",
  immigration: "Immigration",
  journey_mode: "Commute mode",
  commute_time: "Commute time",
  age: "Age",
};

/** Category code -> colour, per field; the empty "people" scheme is one colour set by the theme. */
export const SCHEMES: Record<Exclude<Field, "people">, Record<string, RGBA>> = {
  gender: { m: [111, 199, 234, 255], f: [220, 70, 51, 255], o: [208, 209, 217, 0], unknown: [208, 209, 217, 0] },
  ethnicity: {
    a: [111, 199, 234, 255], wa: [111, 199, 234, 255], sa: [241, 197, 0, 255], sea: [220, 70, 51, 255], ea: [171, 19, 104, 255],
    la: [141, 191, 46, 255], m: [13, 83, 77, 255], i: [109, 36, 122, 255], b: [0, 127, 163, 255], w: [180, 180, 180, 255],
    o: [255, 255, 255, 0], unknown: [208, 209, 217, 0],
  },
  income: {
    no_income: [180, 180, 180, 255], under_30k: [110, 77, 142, 255], "30k_60k": [64, 144, 177, 255], "60k_90k": [44, 99, 97, 255],
    "90k_150k": [0, 161, 137, 255], over_150k: [141, 191, 46, 255], unknown: [208, 209, 217, 0],
  },
  immigration: {
    non_immigrant: [180, 180, 180, 255], before_1990: [111, 199, 234, 255], "1991_2000": [64, 144, 177, 255], "2001_2010": [0, 161, 137, 255],
    "2011_2021": [241, 197, 0, 255], unknown: [208, 209, 217, 0],
  },
  journey_mode: {
    car: [171, 19, 104, 255], public_transit: [111, 199, 234, 255], walked: [141, 191, 46, 255], bicycle: [241, 197, 0, 255],
    other: [220, 70, 15, 255], no_journey: [191, 191, 191, 255], unknown: [208, 209, 217, 0],
  },
  commute_time: {
    "15_less": [111, 199, 234, 255], "15_29": [80, 168, 195, 255], "30_44": [147, 118, 168, 255], "45_59": [194, 65, 118, 255],
    "60_plus": [220, 70, 51, 255], no_journey: [191, 191, 191, 0], unknown: [208, 209, 217, 0],
  },
  age: { "0_19": [241, 197, 0, 255], "20_39": [171, 19, 104, 255], "40_64": [141, 191, 46, 255], "65plus": [111, 199, 234, 255], unknown: [208, 209, 217, 0] },
};

export const CATEGORY_LABELS: Record<string, Record<string, string>> = {
  gender: { m: "Men", f: "Women" },
  ethnicity: { a: "Arab", wa: "West Asian", sa: "South Asian", sea: "Southeast Asian", ea: "East Asian", la: "Latin American", m: "Multiple", i: "Indigenous", b: "Black", w: "White", o: "Other" },
  income: { no_income: "No income", under_30k: "≤ $30,000", "30k_60k": "$30,000 to $60,000", "60k_90k": "$60,000 to $90,000", "90k_150k": "$90,000 to $150,000", over_150k: "≥ $150,000" },
  immigration: { non_immigrant: "Non-immigrant", before_1990: "Immigrated before 1990", "1991_2000": "1991 to 2000", "2001_2010": "2001 to 2010", "2011_2021": "2011 to 2021" },
  journey_mode: { car: "Car", public_transit: "Public transit", walked: "Walked", bicycle: "Bicycle", other: "Other", no_journey: "No commute" },
  commute_time: { "15_less": "Under 15 min", "15_29": "15 to 29 min", "30_44": "30 to 44 min", "45_59": "45 to 59 min", "60_plus": "60 min and more", no_journey: "No commute" },
  age: { "0_19": "0 to 19", "20_39": "20 to 39", "40_64": "40 to 64", "65plus": "65 and over" },
};

/** The shared state this app keeps under appState.dotDensity. */
export interface DotDensityState {
  field: Field;
  /** Dot size in wall pixels at the reference zoom. */
  pointSize: number;
  /** Inverted (dark) basemap, white dots for "people". */
  dark: boolean;
  /** 3D mode: dots lifted by their building height; `since` is when it was toggled, for the 0.6 s ease. */
  extruded: boolean;
  since: number;
}

export const DEFAULT_STATE: DotDensityState = { field: "people", pointSize: 0.6, dark: true, extruded: false, since: 0 };

export function stateOf(appState: Record<string, unknown> | undefined): DotDensityState {
  const s = (appState?.dotDensity ?? {}) as Partial<DotDensityState>;
  return {
    field: FIELDS.includes(s.field as Field) ? (s.field as Field) : DEFAULT_STATE.field,
    pointSize: typeof s.pointSize === "number" ? s.pointSize : DEFAULT_STATE.pointSize,
    dark: typeof s.dark === "boolean" ? s.dark : DEFAULT_STATE.dark,
    extruded: typeof s.extruded === "boolean" ? s.extruded : DEFAULT_STATE.extruded,
    since: typeof s.since === "number" ? s.since : DEFAULT_STATE.since,
  };
}
