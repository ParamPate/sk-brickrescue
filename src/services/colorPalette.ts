import type { BrickColor } from "./types";

// Static fallback color palette (Rebrickable Color IDs mapped to CSS Hex and Names).
// Used by the camera color analyzer (CameraFeed.svelte) and as an offline fallback in api.ts
// when colors.json cannot be fetched. NOTE: this is production data, not mock/test data.
export const COLORS: Record<number, BrickColor> = {
  11: { id: 11, name: "Purple / Medium Violet", hex: "#8a3399" },
  0: { id: 0, name: "Black", hex: "#1b1b1b" },
  86: { id: 86, name: "Light Bluish Gray", hex: "#a0a5a9" },
  15: { id: 15, name: "White", hex: "#f2f3f2" },
  1: { id: 1, name: "Blue", hex: "#0055a5" },
  182: { id: 182, name: "Trans-Neon Green", hex: "#39ff14" },
  4: { id: 4, name: "Red", hex: "#c91a09" },
  70: { id: 70, name: "Reddish Brown", hex: "#5c4033" },
  14: { id: 14, name: "Yellow", hex: "#f5cd2f" },
};
