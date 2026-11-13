import { describe, it, expect, vi, beforeEach } from "vitest";
import { COLORS } from "./colorPalette";
import { fetchMatchSets, fetchMatchSetByNum, predictPartFromImage, getBasePartNum } from "./api";
import { clearCatalogCache, shardKeyForSet, type CatalogSetPart } from "./catalog.svelte";

describe("BrickRelic - Color Metadata", () => {
  it("should contain standard colors", () => {
    expect(COLORS[11]).toEqual({ id: 11, name: "Purple / Medium Violet", hex: "#8a3399" });
    expect(COLORS[0]).toEqual({ id: 0, name: "Black", hex: "#1b1b1b" });
    expect(COLORS[15]).toEqual({ id: 15, name: "White", hex: "#f2f3f2" });
  });
});

describe("BrickRelic - Base Part Number Stripping", () => {
  it("strips printed suffixes from numeric bases", () => {
    expect(getBasePartNum("3001pr0002")).toBe("3001");
    expect(getBasePartNum("973pat0123")).toBe("973");
    expect(getBasePartNum("3004sp01")).toBe("3004");
  });

  it("keeps mold letters as part of the base", () => {
    expect(getBasePartNum("3626cpr0001")).toBe("3626c");
    expect(getBasePartNum("3004c01")).toBe("3004");
  });

  it("returns plain part numbers unchanged", () => {
    expect(getBasePartNum("3001")).toBe("3001");
    expect(getBasePartNum("3001A")).toBe("3001A");
  });

  it("never collapses non-numeric IDs to an empty string (FIND-030 phantom part)", () => {
    expect(getBasePartNum("cardupn0015pr0001")).toBe("cardupn0015pr0001");
    expect(getBasePartNum("sp0042")).toBe("sp0042");
    expect(getBasePartNum("card01")).toBe("card01");
  });
});

// --- Mock catalog helpers (new split format: sets-index + set-parts shards) ---

type MockSet = {
  n: string;
  y: number;
  t: number;
  i: string | null;
  d: number;
  c: Record<string, number>;
  p: CatalogSetPart[];
};

const mockColors = {
  "0": { "name": "Black", "hex": "#1b1b1b" },
  "15": { "name": "White", "hex": "#f2f3f2" },
  "4": { "name": "Red", "hex": "#c91a09" }
};

function makeCatalogFetchMock(sets: Record<string, MockSet>, parts: Record<string, { r: number; s: string[] }>) {
  return vi.fn((url: string) => {
    let data: unknown = {};
    if (url.endsWith("colors.json")) {
      data = mockColors;
    } else if (url.endsWith("sets-index.json")) {
      const index: Record<string, unknown> = {};
      for (const setNum in sets) {
        const { p: _p, ...rest } = sets[setNum];
        index[setNum] = rest;
      }
      data = index;
    } else if (url.endsWith("parts.json")) {
      data = parts;
    } else if (url.includes("/set-parts/")) {
      const shard = url.substring(url.lastIndexOf("/") + 1).replace(".json", "");
      const shardData: Record<string, CatalogSetPart[]> = {};
      for (const setNum in sets) {
        if (shardKeyForSet(setNum) === shard) shardData[setNum] = sets[setNum].p;
      }
      data = shardData;
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data)
    });
  });
}

const defaultSets: Record<string, MockSet> = {
  "6285-1": {
    n: "Black Seas Barracuda",
    y: 1989,
    t: 909,
    i: "https://example.com/6285.jpg",
    d: 0.20, // Sum of diagnostic rarities (0.05 for 3001 + 0.15 for 3002)
    c: { "0": 50.0, "15": 50.0 }, // 50% Black, 50% White
    p: [
      { p: "3001", c: 15, r: 0.05, i: "3001.jpg", nm: "Brick 2 x 4" },
      { p: "3002", c: 0, r: 0.15, i: "3002.jpg" }
    ]
  },
  "6286-1": {
    n: "Skull's Eye Schooner",
    y: 1993,
    t: 912,
    i: "https://example.com/6286.jpg",
    d: 0.15,
    c: { "0": 100.0 }, // 100% Black
    p: [
      { p: "3002", c: 0, r: 0.15, i: "3002.jpg" }
    ]
  }
};

const defaultParts = {
  "3001": { r: 0.05, s: ["6285-1"] },
  "3002": { r: 0.15, s: ["6285-1", "6286-1"] }
};

describe("BrickRelic - Client-Side Matching Algorithm", () => {
  beforeEach(() => {
    clearCatalogCache();
    vi.stubGlobal("fetch", makeCatalogFetchMock(defaultSets, defaultParts));
  });

  it("should match sets based purely on color profile if no parts are scanned", async () => {
    const scannedColors = [
      { color_id: 0, weight: 0.5 },
      { color_id: 15, weight: 0.5 }
    ];
    const results = await fetchMatchSets(scannedColors, []);

    expect(results.length).toBeGreaterThan(0);
    // Black Seas Barracuda has 50% Black and 50% White, so it should match 100% (1.0 score)
    const barracuda = results.find(r => r.set_num === "6285-1");
    expect(barracuda).toBeDefined();
    expect(barracuda?.colorMatchScore).toBeCloseTo(1.0, 2);
    expect(barracuda?.combinedScore).toBeCloseTo(1.0, 2);

    // Skull's Eye Schooner has 100% Black, so matching weight of 0.5 Black should yield 0.5 score
    const schooner = results.find(r => r.set_num === "6286-1");
    expect(schooner).toBeDefined();
    expect(schooner?.colorMatchScore).toBeCloseTo(0.5, 2);
  });

  it("should clamp the color-only combined score to 1.0 when rounded weights sum above 1", async () => {
    // toFixed(2)-rounded camera weights can sum to 1.01 — the display score must not exceed 100%
    const scannedColors = [
      { color_id: 0, weight: 0.51 },
      { color_id: 15, weight: 0.5 }
    ];
    const results = await fetchMatchSets(scannedColors, []);
    const barracuda = results.find(r => r.set_num === "6285-1");
    expect(barracuda?.combinedScore).toBeLessThanOrEqual(1.0);
  });

  it("should match sets based on 70% part rarity and 30% color profile when parts are scanned", async () => {
    const scannedColors = [
      { color_id: 0, weight: 0.5 },
      { color_id: 15, weight: 0.5 }
    ];
    // Scan part 3001 (White color key)
    const scannedPartKeys = ["3001_15"];
    const results = await fetchMatchSets(scannedColors, scannedPartKeys);

    const barracuda = results.find(r => r.set_num === "6285-1");
    expect(barracuda).toBeDefined();

    // Matched rarity sum for Barracuda: 0.05
    // Total scanned rarity: 0.05
    // Part match ratio: 0.05 / 0.05 = 1.0
    // Color match: 1.0
    // Combined score: 1.0 * 0.7 + 1.0 * 0.3 = 1.0
    expect(barracuda?.combinedScore).toBeCloseTo(1.0, 2);

    // Skull's Eye Schooner does NOT contain part 3001, so it gets penalized (color score * 0.1)
    const schooner = results.find(r => r.set_num === "6286-1");
    expect(schooner).toBeDefined();
    expect(schooner?.combinedScore).toBeCloseTo(0.05, 2); // 0.5 * 0.1
  });

  it("should support suffix stripping for printed part suffixes and color suffixes", async () => {
    const scannedColors = [
      { color_id: 0, weight: 0.5 },
      { color_id: 15, weight: 0.5 }
    ];
    // Scan part 3001 with a printed suffix "pr0002" and color suffix "_15"
    const scannedPartKeys = ["3001pr0002_15"];
    const results = await fetchMatchSets(scannedColors, scannedPartKeys);

    const barracuda = results.find(r => r.set_num === "6285-1");
    expect(barracuda).toBeDefined();
    // It should strip the suffixes to "3001", identify it as a match, and compute score 1.0
    expect(barracuda?.combinedScore).toBeCloseTo(1.0, 2);
    expect(barracuda?.matchedParts.map(p => p.part_num)).toContain("3001");
  });

  it("should not crash or over-match when scanning a non-numeric ID (phantom part regression)", async () => {
    const scannedColors = [{ color_id: 15, weight: 1.0 }];
    // Previously "cardupn0015pr0001" collapsed to "" and matched a phantom part
    // with rarity 1.0 across 118 sets.
    const results = await fetchMatchSets(scannedColors, ["cardupn0015pr0001_15"]);

    // The scanned card is unknown to the catalog: every set is a part mismatch
    // and gets the color penalty, never a rarity boost.
    for (const res of results) {
      expect(res.combinedScore).toBeLessThanOrEqual(0.1);
    }
  });

  it("should match parts color-dependently in checklist while keeping overall set matching color-independent", async () => {
    const scannedColors = [
      { color_id: 0, weight: 0.5 },
      { color_id: 15, weight: 0.5 }
    ];
    // REQ-RAD-006a: Scan part 3001 in Black (color 0) instead of White (color 15).
    // Set 6285-1 contains 3001 only in White (15) — NOT in Black (0). Because the set does
    // not contain 3001 in the (mis-)classified color 0, the checklist MUST fall back to
    // matching 3001_15 color-independently.
    const scannedPartKeys = ["3001_0"];
    const results = await fetchMatchSets(scannedColors, scannedPartKeys);

    const barracuda = results.find(r => r.set_num === "6285-1");
    expect(barracuda).toBeDefined();

    // Part match for set scoring is base-part-independent (still matches base part 3001 to set scoring)
    expect(barracuda?.combinedScore).toBeCloseTo(1.0, 2);

    // checklist matching: Since 3001_0 doesn't exist in set (only 3001_15), it falls back to 3001_15!
    expect(barracuda?.matchedParts.map(p => p.part_num + "_" + p.color_id)).toContain("3001_15");
    expect(barracuda?.missingParts.map(p => p.part_num + "_" + p.color_id)).not.toContain("3001_15");

    // FIND-046: the fallback-matched part must carry the ACTUAL scanned key (3001_0),
    // not its own catalog key (3001_15) — otherwise un-marking cannot find the scanned
    // entry in foundParts and the mis-tap sticks (REQ-RAD-007).
    const fallbackMatched = barracuda?.matchedParts.find(p => p.part_num === "3001");
    expect(fallbackMatched?.matchedScanKey).toBe("3001_0");
  });

  it("should enforce color-dependent matching when the set contains the part in both colors", async () => {
    // REQ-RAD-006a: "If a set contains the part in multiple colors (including the classified
    // color), the matching MUST remain strictly color-dependent."
    const scannedColors = [
      { color_id: 0, weight: 0.5 },
      { color_id: 15, weight: 0.5 }
    ];
    vi.stubGlobal("fetch", makeCatalogFetchMock({
      "6285-1": {
        n: "Black Seas Barracuda",
        y: 1989,
        t: 909,
        i: "https://example.com/6285.jpg",
        d: 0.10,
        c: { "0": 50.0, "15": 50.0 },
        p: [
          { p: "3001", c: 0, r: 0.05, i: "3001.jpg" },
          { p: "3001", c: 15, r: 0.05, i: "3001.jpg" }
        ]
      }
    }, { "3001": { r: 0.05, s: ["6285-1"] } }));

    // Scan 3001 in Black (0). Since the set DOES contain 3001 in Black, the fallback MUST NOT
    // fire: 3001_0 matches directly, but 3001_15 stays missing (strict color-dependence).
    const scannedPartKeys = ["3001_0"];
    const results = await fetchMatchSets(scannedColors, scannedPartKeys);
    const barracuda = results.find(r => r.set_num === "6285-1");

    expect(barracuda?.matchedParts.map(p => p.part_num + "_" + p.color_id)).toContain("3001_0");
    expect(barracuda?.matchedParts.map(p => p.part_num + "_" + p.color_id)).not.toContain("3001_15");
    expect(barracuda?.missingParts.map(p => p.part_num + "_" + p.color_id)).toContain("3001_15");

    // Direct color match: matchedScanKey equals the part's own key (3001_0).
    const directMatched = barracuda?.matchedParts.find(p => p.part_num === "3001");
    expect(directMatched?.matchedScanKey).toBe("3001_0");
  });

  it("should be case-insensitive when matching parts in the checklist", async () => {
    const scannedColors = [
      { color_id: 15, weight: 1.0 }
    ];
    // Scan lowercase part key "3001a_15"; the set stores the base part uppercase as "3001A".
    const scannedPartKeys = ["3001a_15"];

    vi.stubGlobal("fetch", makeCatalogFetchMock({
      "6285-1": {
        n: "Black Seas Barracuda",
        y: 1989,
        t: 909,
        i: "https://example.com/6285.jpg",
        d: 0.20,
        c: { "15": 100.0 },
        p: [
          { p: "3001A", c: 15, r: 0.05, i: "3001.jpg" }
        ]
      }
    }, { "3001A": { r: 0.05, s: ["6285-1"] } }));

    const results = await fetchMatchSets(scannedColors, scannedPartKeys);
    const barracuda = results.find(r => r.set_num === "6285-1");
    expect(barracuda?.matchedParts.map(p => p.part_num)).toContain("3001A");
  });

  it("should always include the ensured set even when it is not a top match", async () => {
    // Four sets with a perfect color match push the weak set out of the top 3
    const sets: Record<string, MockSet> = {};
    for (const num of ["1001-1", "1002-1", "1003-1"]) {
      sets[num] = {
        n: `Strong ${num}`, y: 2000, t: 100, i: null, d: 0.1,
        c: { "0": 100.0 },
        p: [{ p: "3002", c: 0, r: 0.15, i: null }]
      };
    }
    sets["9999-1"] = {
      n: "Weak Set", y: 2001, t: 50, i: null, d: 0.1,
      c: { "0": 1.0 },
      p: [{ p: "3010", c: 0, r: 0.2, i: null }]
    };
    vi.stubGlobal("fetch", makeCatalogFetchMock(sets, { "3002": { r: 0.15, s: ["1001-1", "1002-1", "1003-1"] } }));

    const scannedColors = [{ color_id: 0, weight: 1.0 }];

    const withoutEnsure = await fetchMatchSets(scannedColors, []);
    expect(withoutEnsure.map(r => r.set_num)).not.toContain("9999-1");

    const withEnsure = await fetchMatchSets(scannedColors, [], "9999-1");
    expect(withEnsure.map(r => r.set_num)).toContain("9999-1");
    // The top matches themselves stay unchanged
    expect(withEnsure.filter(r => r.set_num !== "9999-1")).toHaveLength(3);
  });

  it("should retry after a failed catalog load instead of caching the rejection forever", async () => {
    let failing = true;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (failing && url.endsWith("sets-index.json")) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      }
      return makeCatalogFetchMock(defaultSets, defaultParts)(url);
    }));

    const scannedColors = [{ color_id: 0, weight: 1.0 }];
    await expect(fetchMatchSets(scannedColors, [])).rejects.toThrow();

    // Network recovers: the same call must now succeed without a page reload
    failing = false;
    const results = await fetchMatchSets(scannedColors, []);
    expect(results.length).toBeGreaterThan(0);
  });

  it("should resolve a single set with all parts missing via fetchMatchSetByNum", async () => {
    const result = await fetchMatchSetByNum("6285-1");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Black Seas Barracuda");
    expect(result?.matchedParts).toHaveLength(0);
    expect(result?.missingParts.map(p => p.part_num)).toEqual(["3001", "3002"]);

    const unknown = await fetchMatchSetByNum("0000-0");
    expect(unknown).toBeNull();
  });
});

describe("BrickRelic - Brickognize API Hardening", () => {
  const makeBlob = () => new Blob(["fake-image"], { type: "image/jpeg" });

  beforeEach(() => {
    clearCatalogCache();
  });

  it("throws on HTTP errors instead of swallowing them", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 503 })));
    await expect(predictPartFromImage(makeBlob())).rejects.toThrow("HTTP 503");
  });

  it("returns an empty list for malformed payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ unexpected: true })
    })));
    await expect(predictPartFromImage(makeBlob())).resolves.toEqual([]);
  });

  it("filters invalid items and rejects non-https image URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        listing_id: "res-d492bca0",
        items: [
          { id: "3001", name: "Brick 2 x 4", score: "0.92", img_url: "https://cdn.example.com/3001.png" },
          { id: "3002", name: "Brick 2 x 2", score: 0.5, img_url: "http://insecure.example.com/3002.png" },
          { id: 12345, name: "Numeric id — invalid" },
          { name: "Missing id — invalid" },
          { id: "", name: "Empty id — invalid" }
        ]
      })
    })));

    const parts = await predictPartFromImage(makeBlob());
    expect(parts.map(p => p.part_num)).toEqual(["3001", "3002"]);
    expect(parts[0].brickognizeUrl).toBe("https://brickognize.com/results/res-d492bca0/");
    expect(parts[0].imageUrl).toBe("https://cdn.example.com/3001.png");
    expect(parts[0].rarity_score).toBeCloseTo(0.92);
    expect(parts[1].imageUrl).toBe(""); // http:// URL dropped
  });
});
