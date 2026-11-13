import type { ScannedColorInput } from "./types";
import type { CatalogColor } from "./catalog.svelte";

// Analysis tuning (see CameraFeed.svelte: 64x80 offscreen canvas, 1.5s interval)
const SAMPLE_STRIDE = 40; // sample every 10th pixel (4 channels * 10)
export const TOP_DOMINANT_COLORS = 3;

// Flat lookup table so the per-pixel loop allocates nothing and compares
// squared distances (no Math.sqrt needed for a minimum search).
export interface RgbLookupEntry {
  id: number;
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!hex.startsWith("#") || hex.length !== 7) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };
}

export function buildRgbLookup(colors: Record<number, CatalogColor>): RgbLookupEntry[] {
  const lookup: RgbLookupEntry[] = [];
  for (const idStr in colors) {
    const rgb = hexToRgb(colors[idStr].hex);
    if (rgb) lookup.push({ id: Number(idStr), ...rgb });
  }
  return lookup;
}

// Map sampled pixels to their nearest catalog color and return the normalized
// weights of the dominant colors (descending).
export function analyzeDominantColors(
  data: Uint8ClampedArray,
  lookup: RgbLookupEntry[]
): ScannedColorInput[] {
  if (lookup.length === 0) return [];

  const colorCounts: Record<number, number> = {};
  let totalCount = 0;

  for (let i = 0; i < data.length; i += SAMPLE_STRIDE) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    let nearestColorId = -1;
    let minDistance = Infinity;

    for (let c = 0; c < lookup.length; c++) {
      const entry = lookup[c];
      const dr = r - entry.r;
      const dg = g - entry.g;
      const db = b - entry.b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < minDistance) {
        minDistance = dist;
        nearestColorId = entry.id;
      }
    }

    if (nearestColorId !== -1) {
      colorCounts[nearestColorId] = (colorCounts[nearestColorId] || 0) + 1;
      totalCount++;
    }
  }

  if (totalCount === 0) return [];

  const detectedColors: ScannedColorInput[] = Object.keys(colorCounts)
    .map((idStr) => {
      const id = Number(idStr);
      return {
        color_id: id,
        weight: parseFloat((colorCounts[id] / totalCount).toFixed(2))
      };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, TOP_DOMINANT_COLORS);

  const sum = detectedColors.reduce((acc, c) => acc + c.weight, 0);
  if (sum <= 0) return [];

  detectedColors.forEach((c) => {
    c.weight = parseFloat((c.weight / sum).toFixed(2));
  });

  return detectedColors;
}

// True when both lists describe the same dominant colors with (near-)identical
// weights — used to skip redundant match runs on unchanged camera frames.
export function sameDominantColors(a: ScannedColorInput[], b: ScannedColorInput[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].color_id !== b[i].color_id) return false;
    if (Math.abs(a[i].weight - b[i].weight) > 0.02) return false;
  }
  return true;
}
