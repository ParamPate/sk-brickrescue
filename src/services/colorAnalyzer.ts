import type { ScannedColorInput } from "./types";
import type { CatalogColor } from "./catalog.svelte";
import type { Rgb } from "./photoParts";

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

// Transparent, metallic, legacy-line and placeholder colors either can't be told apart by a camera
// or duplicate a modern solid color, and they soaked up shadow and glare pixels.
const NON_SOLID_COLOR = /^(trans|chrome|metallic|pearl|glitter|opal|speckle|glow|two-tone|modulex|ho |duplo|fabuland|vintage|clikits|\[)|^(metal|copper|flat silver|flat dark gold)$/i;

export function buildRgbLookup(colors: Record<number, CatalogColor>): RgbLookupEntry[] {
  const lookup: RgbLookupEntry[] = [];
  for (const idStr in colors) {
    if (NON_SOLID_COLOR.test(colors[idStr].name)) continue;
    const rgb = hexToRgb(colors[idStr].hex);
    if (rgb) lookup.push({ id: Number(idStr), ...rgb });
  }
  return lookup;
}

// Map sampled pixels to their nearest catalog color and return the normalized
// weights of the dominant colors (descending). With a background color, pixels are
// white-balanced first so the background reads as neutral gray (removes warm/cool light casts).
export function analyzeDominantColors(
  data: Uint8ClampedArray,
  lookup: RgbLookupEntry[],
  background?: Rgb
): ScannedColorInput[] {
  if (lookup.length === 0) return [];
  // Only a near-neutral background (paper, gray mat) is a trustworthy white reference;
  // balancing against orange wood would turn brown bricks gray.
  const neutral = background && Math.max(...background) - Math.min(...background) <= 0.3 * Math.max(...background);
  const mean = neutral ? (background[0] + background[1] + background[2]) / 3 : 1;
  const gains = neutral ? background.map((c) => mean / Math.max(1, c)) : [1, 1, 1];

  const colorCounts: Record<number, number> = {};
  let totalCount = 0;

  for (let i = 0; i < data.length; i += SAMPLE_STRIDE) {
    const r = Math.min(255, data[i] * gains[0]);
    const g = Math.min(255, data[i + 1] * gains[1]);
    const b = Math.min(255, data[i + 2] * gains[2]);

    let nearestColorId = -1;
    let minDistance = Infinity;

    for (let c = 0; c < lookup.length; c++) {
      const entry = lookup[c];
      const dr = r - entry.r;
      const dg = g - entry.g;
      const db = b - entry.b;
      // "Redmean" weighting tracks perceived difference far better than plain RGB distance.
      const redMean = (r + entry.r) / 2;
      const dist = (512 + redMean) * dr * dr + 1024 * dg * dg + (767 - redMean) * db * db;
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
