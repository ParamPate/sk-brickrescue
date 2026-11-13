import { describe, it, expect } from "vitest";
import { buildRgbLookup, analyzeDominantColors, sameDominantColors } from "./colorAnalyzer";

const testColors = {
  0: { name: "Black", hex: "#000000" },
  15: { name: "White", hex: "#ffffff" },
  4: { name: "Red", hex: "#ff0000" }
};

// Build pixel data (RGBA) where every 10th pixel (the sampled ones) has the given colors
function makePixels(sampledRgb: Array<[number, number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(sampledRgb.length * 40);
  sampledRgb.forEach(([r, g, b], i) => {
    const offset = i * 40;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  });
  return data;
}

describe("BrickRelic - Color Analyzer", () => {
  it("builds a flat rgb lookup and skips invalid hex values", () => {
    const lookup = buildRgbLookup({ ...testColors, 99: { name: "Broken", hex: "oops" } });
    expect(lookup).toHaveLength(3);
    expect(lookup.find(e => e.id === 4)).toEqual({ id: 4, r: 255, g: 0, b: 0 });
  });

  it("detects dominant colors with normalized weights", () => {
    const lookup = buildRgbLookup(testColors);
    // 3 near-black, 1 near-white sampled pixel
    const data = makePixels([
      [5, 5, 5],
      [10, 10, 10],
      [0, 0, 0],
      [250, 250, 250]
    ]);

    const result = analyzeDominantColors(data, lookup);
    expect(result[0].color_id).toBe(0); // Black dominates
    expect(result[0].weight).toBeCloseTo(0.75, 2);
    expect(result[1].color_id).toBe(15);
    expect(result[1].weight).toBeCloseTo(0.25, 2);
    const sum = result.reduce((acc, c) => acc + c.weight, 0);
    expect(sum).toBeCloseTo(1.0, 1);
  });

  it("returns an empty result for an empty lookup", () => {
    expect(analyzeDominantColors(makePixels([[1, 2, 3]]), [])).toEqual([]);
  });

  it("compares dominant color lists with tolerance", () => {
    const a = [{ color_id: 0, weight: 0.7 }, { color_id: 15, weight: 0.3 }];
    expect(sameDominantColors(a, [{ color_id: 0, weight: 0.71 }, { color_id: 15, weight: 0.29 }])).toBe(true);
    expect(sameDominantColors(a, [{ color_id: 0, weight: 0.5 }, { color_id: 15, weight: 0.5 }])).toBe(false);
    expect(sameDominantColors(a, [{ color_id: 4, weight: 0.7 }, { color_id: 15, weight: 0.3 }])).toBe(false);
    expect(sameDominantColors(a, [{ color_id: 0, weight: 0.7 }])).toBe(false);
  });
});
