import { describe, it, expect, vi, beforeEach } from "vitest";
import { COLORS } from "./colorPalette";
import { buildChecklist, fetchMatchSets, getBasePartNum } from "./api";
import { canonicalPart, clearCatalogCache, shardKeyForSet, type SetPartRow } from "./catalog.svelte";

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
    expect(getBasePartNum("39367pb01")).toBe("39367"); // BrickLink print suffix
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

// --- Mock catalog (sets-index + match-index + set-parts shards + part names) ---

type MockSet = { n: string; y: number; t: number; c: Record<string, number>; rows: SetPartRow[] };

const mockColors = {
  "0": { name: "Black", hex: "#1b1b1b" },
  "15": { name: "White", hex: "#f2f3f2" },
  "4": { name: "Red", hex: "#c91a09" }
};

function makeCatalogFetchMock(sets: Record<string, MockSet>, aliases: Record<string, string> = {}, molds: Record<string, string> = {}) {
  const setNums = Object.keys(sets).sort();
  const parts: Record<string, number[]> = {};
  setNums.forEach((setNum, index) => {
    const byPart = new Map<string, number>();
    for (const [part, , qty] of sets[setNum].rows) {
      const canonical = aliases[getBasePartNum(part)] ?? getBasePartNum(part);
      byPart.set(canonical, (byPart.get(canonical) || 0) + qty);
    }
    for (const [part, qty] of byPart) (parts[part] ??= []).push(index, qty);
  });
  return vi.fn((url: string) => {
    let data: unknown = {};
    if (url.endsWith("colors.json")) data = mockColors;
    else if (url.endsWith("sets-index.json")) {
      data = Object.fromEntries(setNums.map((setNum) => {
        const { rows: _rows, ...entry } = sets[setNum];
        return [setNum, entry];
      }));
    } else if (url.endsWith("match-index.json")) data = { sets: setNums, parts, aliases, molds };
    else if (url.endsWith("part-names.json")) data = { "3001": "Brick 2 x 4", "3002": "Brick 2 x 3" };
    else if (url.includes("/set-parts/")) {
      const shard = url.substring(url.lastIndexOf("/") + 1).replace(".json", "");
      data = Object.fromEntries(setNums.filter((setNum) => shardKeyForSet(setNum) === shard).map((setNum) => [setNum, sets[setNum].rows]));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  });
}

// A small themed set, a huge set made of common pieces, and a color-only candidate.
const defaultSets: Record<string, MockSet> = {
  "6285-1": {
    n: "Black Seas Barracuda", y: 1989, t: 30, c: { "0": 50, "15": 50 },
    rows: [["3001", 15, 10, "elements/1.jpg"], ["3002", 0, 10, ""], ["rare1", 0, 2, ""], ["pin", 0, 8, ""]]
  },
  "9999-1": {
    n: "Huge Common Set", y: 2020, t: 3000, c: { "4": 100 },
    rows: [["pin", 4, 2000, ""], ["3001", 4, 500, ""], ["3002", 4, 500, ""]]
  },
  "6286-1": {
    n: "Skull's Eye Schooner", y: 1993, t: 20, c: { "0": 100 },
    rows: [["3002", 0, 20, ""]]
  }
};
// Make "pin" appear in many sets so it is a low-weight common part.
for (let i = 0; i < 20; i++) defaultSets[`p${i}-1`] = { n: `Pin pack ${i}`, y: 2000, t: 5, c: { "0": 100 }, rows: [["pin", 0, 5, ""]] };

describe("BrickRelic - Full-inventory set matching", () => {
  beforeEach(() => {
    clearCatalogCache();
    vi.stubGlobal("fetch", makeCatalogFetchMock(defaultSets));
  });

  it("ranks by color profile when no parts are scanned, clamped to 1.0", async () => {
    const results = await fetchMatchSets([{ color_id: 0, weight: 0.6 }, { color_id: 15, weight: 0.5 }], []);
    expect(results[0].set_num).toBe("6285-1");
    expect(results[0].combinedScore).toBeLessThanOrEqual(1);
  });

  it("finds the set that contains the scanned pile, not the biggest set", async () => {
    const results = await fetchMatchSets([], [
      { part: "3001", color: 15, qty: 5 },
      { part: "3002", color: 0, qty: 5 },
      { part: "rare1", color: 0, qty: 1 },
      { part: "pin", color: 0, qty: 4 }
    ]);
    expect(results[0].set_num).toBe("6285-1");
    expect(results[0].pileCoverage).toBeCloseTo(1, 5);
    expect(results.length).toBeLessThanOrEqual(3);
    expect(results.find((r) => r.set_num === "9999-1")?.combinedScore ?? 0).toBeLessThan(results[0].combinedScore);
  });

  it("matches parts regardless of the scanned color", async () => {
    const results = await fetchMatchSets([], [{ part: "rare1", color: 4, qty: 2 }, { part: "3001", color: 4, qty: 10 }]);
    expect(results[0].set_num).toBe("6285-1");
    const line = results[0].checklist.find((part) => part.part_num === "rare1")!;
    expect(line).toMatchObject({ found: 2, quantity: 2, colorMismatch: true });
  });

  it("merges mold variants and prints through the alias table", async () => {
    clearCatalogCache();
    vi.stubGlobal("fetch", makeCatalogFetchMock(defaultSets, { "61332": "pin", "4459": "rare1" }));
    const results = await fetchMatchSets([], [{ part: "4459pr0001", color: 0, qty: 2 }]);
    expect(canonicalPart("61332")).toBe("pin");
    expect(results[0].set_num).toBe("6285-1");
  });

  it("does not crash on unknown or non-numeric IDs (phantom part regression)", async () => {
    const results = await fetchMatchSets([], [{ part: "cardupn0015pr0001", color: 15, qty: 1 }]);
    expect(results).toEqual([]);
  });

  it("always includes the ensured set even when it is not a top match", async () => {
    const results = await fetchMatchSets([], [{ part: "3001", color: 15, qty: 1 }], "p7-1");
    expect(results.some((r) => r.set_num === "p7-1")).toBe(true);
  });

  it("retries after a failed catalog load instead of caching the rejection forever", async () => {
    clearCatalogCache();
    let fail = true;
    const working = makeCatalogFetchMock(defaultSets);
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (fail && url.endsWith("match-index.json")) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return working(url);
    }));
    await expect(fetchMatchSets([], [{ part: "3001", color: 15, qty: 1 }])).rejects.toThrow();
    fail = false;
    const results = await fetchMatchSets([], [{ part: "3001", color: 15, qty: 1 }]);
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("BrickRelic - Recoloring candidates", () => {
  it("offers recoloring only for the same physical part, never for alternates", async () => {
    clearCatalogCache();
    vi.stubGlobal("fetch", makeCatalogFetchMock({
      "45680-1": { n: "Spike", y: 2020, t: 8, c: {}, rows: [["2780", 0, 2, ""], ["3673", 71, 4, ""], ["32524", 73, 2, ""]] }
    }, { "61332": "2780", "3673": "2780" }, { "61332": "2780" }));
    const [result] = await fetchMatchSets([], [
      { part: "61332", color: 0, qty: 6 }, // 2 black friction pins too many
      { part: "32524", color: 3, qty: 2 } // beam read as the wrong color
    ]);
    const smooth = result.checklist.find((p) => p.part_num === "3673")!;
    const beam = result.checklist.find((p) => p.part_num === "32524")!;
    expect(smooth).toMatchObject({ found: 4, colorMismatch: true, borrowed: [] });
    expect(beam.borrowed).toEqual([{ color: 3, qty: 2, part: "32524" }]);
  });
});

describe("BrickRelic - Checklist", () => {
  it("fills the exact color first, caps at the set quantity and lists missing lines first", () => {
    const rows: SetPartRow[] = [["3001", 15, 2, "elements/1.jpg"], ["3001", 0, 2, ""], ["3002", 0, 1, ""]];
    const { checklist, foundPieces, totalPieces } = buildChecklist(rows, [
      { part: "3001", color: 0, qty: 3 },
      { part: "3002", color: 0, qty: 5 }
    ], { "3001": "Brick 2 x 4" });
    expect(totalPieces).toBe(5);
    expect(foundPieces).toBe(4);
    const black = checklist.find((p) => p.part_num === "3001" && p.color_id === 0)!;
    const white = checklist.find((p) => p.part_num === "3001" && p.color_id === 15)!;
    expect(black).toMatchObject({ found: 2, colorMismatch: false, name: "Brick 2 x 4" });
    expect(white).toMatchObject({ found: 1, colorMismatch: true, imageUrl: "https://cdn.rebrickable.com/media/parts/elements/1.jpg" });
    expect(checklist[0]).toBe(white); // still missing one
    expect(checklist.find((p) => p.part_num === "3002")!.name).toBe("Part 3002");
  });
});
