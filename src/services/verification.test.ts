import { describe, expect, it } from "vitest";
import { buildReport, haveFromRecords, proposalKey, reportCsv, wantedListXml, type HaveLine, type Variations } from "./verification";
import { normalizeSetNum, type SetInventory, type SetLine } from "./rebrickable";
import type { PieceRecord } from "./batch.svelte";
import { buildManualRow } from "./recognition";

const line = (part: string, color: number, qty: number, extra: Partial<SetLine> = {}): SetLine => ({
  part, name: `Part ${part}`, color, colorName: `Color ${color}`, colorHex: "#000000", qty, image: "",
  blParts: [part], blColors: [String(color + 100)], category: "", ...extra
});

const inventory: SetInventory = {
  setNum: "40611-1", name: "Year of the Dragon", year: 2024, numParts: 0, image: "", fetchedAt: 0, source: "Rebrickable API",
  lines: [
    line("2555", 0, 4), // 1x1 tile with clip, black
    line("3001", 15, 2),
    line("6141", 4, 3)
  ]
};

const have = (part: string, color: number, qty: number): HaveLine => ({
  part, color, qty, name: `Part ${part}`, image: "", blPart: part, blColor: "", recordIds: [], manualIds: []
});

// Slide example: clip tiles are mold variations; round plate vs round tile has no relation.
const variations: Variations = {
  "2555": [["15712", "M"], ["12825", "M"]],
  "15712": [["2555", "M"]],
  "12825": [["2555", "M"]],
  "6141": [["85861", "A"]],
  "85861": [["6141", "A"]]
};

describe("normalizeSetNum", () => {
  it("adds the default -1 version", () => {
    expect(normalizeSetNum(" 40611 ")).toBe("40611-1");
    expect(normalizeSetNum("40611-2")).toBe("40611-2");
  });
});

describe("buildReport", () => {
  it("classifies missing, extra, not-in-set and complete lines", () => {
    const report = buildReport(inventory, [have("3001", 15, 3), have("6141", 4, 3), have("98138", 4, 2)], {});
    const byPart = Object.fromEntries(report.rows.map((row) => [row.part, row]));
    expect(byPart["2555"]).toMatchObject({ status: "Missing", missing: 4 });
    expect(byPart["3001"]).toMatchObject({ status: "Extra", extra: 1 });
    expect(byPart["6141"]).toMatchObject({ status: "Complete" });
    expect(byPart["98138"]).toMatchObject({ status: "Not in set", extra: 2 }); // round tile never replaces round plate
    expect(report).toMatchObject({ requiredPieces: 9, foundPieces: 5, missingPieces: 4, extraPieces: 3 });
    expect(report.rows[0].status).toBe("Missing");
  });

  it("proposes same-color mold variations only, and counts nothing until accepted", () => {
    const pile = [have("15712", 0, 3), have("12825", 0, 2), have("15712", 4, 1)];
    const report = buildReport(inventory, pile, variations);
    expect(report.proposals.map((p) => p.key).sort()).toEqual([proposalKey("12825", 0, "2555"), proposalKey("15712", 0, "2555")]);
    expect(report.rows.find((r) => r.part === "2555")!.missing).toBe(4);
    // The red variation cannot fill a black slot: it stays surplus with an explanation
    const red = report.rows.find((r) => r.part === "15712" && r.color === 4)!;
    expect(red.status).toBe("Not in set");
    expect(red.note).toContain("Mold variation of 2555");
  });

  it("never allocates more than the source has or the target is short", () => {
    const pile = [have("15712", 0, 3), have("12825", 0, 2)];
    const report = buildReport(inventory, pile, variations, {
      [proposalKey("15712", 0, "2555")]: 10, // capped at 3 pieces on hand
      [proposalKey("12825", 0, "2555")]: 2 // only 1 shortage left
    });
    const a = report.proposals.find((p) => p.sourcePart === "15712")!;
    const b = report.proposals.find((p) => p.sourcePart === "12825")!;
    expect(a.allocated).toBe(3);
    expect(b.allocated).toBe(1);
    const target = report.rows.find((r) => r.part === "2555")!;
    expect(target).toMatchObject({ status: "Complete", have: 4, substitutedIn: 4 });
    expect(target.note).toContain("3× 15712");
    // The unused 12825 stays on its own row as surplus; the fully used 15712 row disappears
    expect(report.rows.find((r) => r.part === "12825")).toMatchObject({ status: "Not in set", have: 1 });
    expect(report.rows.find((r) => r.part === "15712")).toBeUndefined();
  });

  it("does not propose anything when the target is already complete", () => {
    const report = buildReport(inventory, [have("2555", 0, 4), have("15712", 0, 2)], variations);
    expect(report.proposals).toEqual([]);
  });
});

describe("haveFromRecords", () => {
  it("uses the set's own BrickLink cross-references before the general tables", () => {
    const inv: SetInventory = { ...inventory, lines: [line("61332", 0, 4, { blParts: ["2780"], blColors: ["11"] })] };
    const record = (id: string): PieceRecord => ({
      id, image: `${id}.jpg`, cropUrl: "", status: "done", cached: false, manual: false, isNew: false,
      row: buildManualRow(`${id}.jpg`, "2780", "Technic Pin", "11"), candidates: [], log: {}
    });
    const lines = haveFromRecords([record("a"), record("b")], inv);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ part: "61332", color: 0, qty: 2 });
    expect(buildReport(inv, lines, {}).rows[0]).toMatchObject({ status: "Missing", missing: 2 });
  });
});

describe("exports", () => {
  it("writes the report CSV without complete lines and a BrickLink wanted list for missing pieces", () => {
    const report = buildReport(inventory, [have("3001", 15, 2)], {});
    const csv = reportCsv(report.rows, { "2555|0": "Bag 3, \"left\"" });
    expect(csv.split("\r\n")[0]).toContain("bricklink_part_num");
    expect(csv).not.toContain(",3001,");
    expect(csv).toContain('"Bag 3, ""left"""');
    const { xml, skipped } = wantedListXml(report.rows, { "2555|0": "Bag <3>" });
    expect(xml).toContain("<ITEMID>2555</ITEMID>");
    expect(xml).toContain("<COLOR>100</COLOR>");
    expect(xml).toContain("<MINQTY>4</MINQTY>");
    expect(xml).toContain("<REMARKS>Bag &lt;3&gt;</REMARKS>");
    expect(skipped).toEqual([]);
  });
});
