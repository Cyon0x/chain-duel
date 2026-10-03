export const THEMES = ["neon", "void", "circuit", "ember"] as const;
export type ThemeId = (typeof THEMES)[number];

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  tagline: string;
  accent: string;
  accentSoft: string;
}

export const THEME_DEFINITIONS: Record<ThemeId, ThemeDefinition> = {
  neon: {
    id: "neon",
    name: "Neon",
    tagline: "Electric cyan on deep space",
    accent: "#4ff0ff",
    accentSoft: "rgba(79, 240, 255, 0.16)",
  },
  void: {
    id: "void",
    name: "Void",
    tagline: "Violet singularity",
    accent: "#a78bfa",
    accentSoft: "rgba(167, 139, 250, 0.16)",
  },
  circuit: {
    id: "circuit",
    name: "Circuit",
    tagline: "Signal green mainframe",
    accent: "#4ade80",
    accentSoft: "rgba(74, 222, 128, 0.16)",
  },
  ember: {
    id: "ember",
    name: "Ember",
    tagline: "Molten amber forge",
    accent: "#fb923c",
    accentSoft: "rgba(251, 146, 60, 0.16)",
  },
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}
