import type { PieceRecord } from "./batch.svelte";
import { blColor, blColorHex, blToRbColorId, blToRbPart, referenceImageUrl } from "./bricklink";
import { resolveColor } from "./catalog.svelte";
import type { SetInventory } from "./rebrickable";

// Set verification: compare the scanned pieces with a set's part list
// (port of the desktop app's comparison.py and the variation substitution
// rules in relationships.py, recomputed live instead of on "Compare Parts").

export type RowStatus = "Missing" | "Extra" | "Not in set" | "Complete";
export type Variations = Record<string, [string, "M" | "A"][]>;

export interface HaveLine {
  part: string; // Rebrickable part number
  color: number; // Rebrickable color ID
  qty: number;
  name: string;
  image: string;
  blPart: string;
  blColor: string;
  recordIds: string[];
  manualIds: string[];
}

export interface ReportRow {
  key: string;
  part: string;
  color: number;
  name: string;
  colorName: string;
  colorHex: string;
  image: string;
  blPart: string;
  blColor: string;
  required: number;
  have: number; // after accepted substitutions
  substitutedIn: number;
  category: string; // part category, e.g. "Plates" ("" when unknown)
  missing: number;
  extra: number;
  status: RowStatus;
  note: string;
  recordIds: string[];
  manualIds: string[];
}

export interface Proposal {
  key: string; // "source|color>target"
  sourcePart: string;
  sourceName: string;
  sourceImage: string;
  color: number;
  colorName: string;
  colorHex: string;
  sourceQty: number;
  targetPart: string;
  targetName: string;
  targetImage: string;
  targetShortage: number; // before substitutions
  relType: "M" | "A";
  allocated: number; // accepted, after limits
  max: number; // most that can still be allocated here
}

export interface Report {
  rows: ReportRow[];
  proposals: Proposal[];
  counts: Record<RowStatus, number>; // lines per status
  requiredPieces: number;
  foundPieces: number;
  missingPieces: number;
  extraPieces: number;
}

const lineKey = (part: string, color: number) => `${part}|${color}`;
export const proposalKey = (source: string, color: number, target: string) => `${source}|${color}>${target}`;

// Group the scanned pieces by Rebrickable part and color. BrickLink IDs are
// translated with the set's own cross-references first (exact for this set),
// then with the general mapping tables.
export function haveFromRecords(records: PieceRecord[], inventory: SetInventory): HaveLine[] {
  const setPartByBl = new Map<string, string>();
  const setColorByBl = new Map<string, number>();
  for (const line of inventory.lines) {
    for (const id of line.blParts) if (!setPartByBl.has(id)) setPartByBl.set(id, line.part);
    for (const id of line.blColors) setColorByBl.set(id, line.color);
  }
  const lines = new Map<string, HaveLine>();
  for (const record of records) {
    const row = record.row;
    if (record.status !== "done" || !row) continue;
    const blPart = row["Part ID"];
    const blColorId = row["BrickLink Color ID"];
    const part = record.rb?.part ?? setPartByBl.get(blPart) ?? blToRbPart(blPart);
    const color = record.rb?.color ?? setColorByBl.get(blColorId) ?? blToRbColorId(blColorId);
    const key = lineKey(part, color);
    let line = lines.get(key);
    if (!line) {
      line = {
        part, color, qty: 0, name: row["Part Name"],
        image: record.cropUrl || row["Reference Image URL"] || referenceImageUrl(blPart, blColorId),
        blPart, blColor: blColorId, recordIds: [], manualIds: []
      };
      lines.set(key, line);
    }
    line.qty++;
    line.recordIds.push(record.id);
    if (record.manual) line.manualIds.push(record.id);
  }
  return [...lines.values()];
}

// allocations: proposal key -> pieces the operator accepted
export function buildReport(
  inventory: SetInventory,
  have: HaveLine[],
  variations: Variations,
  allocations: Record<string, number> = {},
  // Category for parts the set does not contain (the set's own lines carry theirs)
  categoryOf: (part: string) => string = () => ""
): Report {
  const required = new Map(inventory.lines.map((line) => [lineKey(line.part, line.color), line]));
  const haveByKey = new Map(have.map((line) => [lineKey(line.part, line.color), line]));

  // Proposals: a scanned part the set does not need in that color, directly
  // related (mold variation or alternative) to a part the set is short of in
  // the SAME color. Nothing is substituted until the operator accepts it.
  const shortage = (key: string) => Math.max(0, (required.get(key)?.qty ?? 0) - (haveByKey.get(key)?.qty ?? 0));
  const proposals: Proposal[] = [];
  for (const source of have) {
    if (required.has(lineKey(source.part, source.color))) continue;
    for (const [targetPart, relType] of variations[source.part] ?? []) {
      const targetKey = lineKey(targetPart, source.color);
      const target = required.get(targetKey);
      if (!target || shortage(targetKey) === 0) continue;
      proposals.push({
        key: proposalKey(source.part, source.color, targetPart),
        sourcePart: source.part, sourceName: source.name, sourceImage: source.image,
        color: source.color, colorName: target.colorName, colorHex: target.colorHex,
        sourceQty: source.qty,
        targetPart, targetName: target.name, targetImage: target.image,
        targetShortage: shortage(targetKey),
        relType, allocated: 0, max: 0
      });
    }
  }

  // Apply accepted allocations within both limits: a source piece is used once,
  // and a target is never filled beyond its shortage.
  const sourceUsed = new Map<string, number>();
  const targetFilled = new Map<string, number>();
  for (const proposal of proposals) {
    const sourceKey = lineKey(proposal.sourcePart, proposal.color);
    const targetKey = lineKey(proposal.targetPart, proposal.color);
    const sourceLeft = proposal.sourceQty - (sourceUsed.get(sourceKey) ?? 0);
    const targetLeft = proposal.targetShortage - (targetFilled.get(targetKey) ?? 0);
    proposal.allocated = Math.max(0, Math.min(Math.floor(allocations[proposal.key] ?? 0), sourceLeft, targetLeft));
    sourceUsed.set(sourceKey, (sourceUsed.get(sourceKey) ?? 0) + proposal.allocated);
    targetFilled.set(targetKey, (targetFilled.get(targetKey) ?? 0) + proposal.allocated);
  }
  for (const proposal of proposals) {
    const sourceKey = lineKey(proposal.sourcePart, proposal.color);
    const targetKey = lineKey(proposal.targetPart, proposal.color);
    proposal.max = proposal.allocated + Math.min(
      proposal.sourceQty - (sourceUsed.get(sourceKey) ?? 0),
      proposal.targetShortage - (targetFilled.get(targetKey) ?? 0)
    );
  }

  const rows: ReportRow[] = [];
  const counts: Record<RowStatus, number> = { Missing: 0, Extra: 0, "Not in set": 0, Complete: 0 };
  let requiredPieces = 0, foundPieces = 0, missingPieces = 0, extraPieces = 0;
  const keys = new Set([...required.keys(), ...haveByKey.keys()]);
  for (const key of keys) {
    const need = required.get(key);
    const got = haveByKey.get(key);
    const substitutedIn = targetFilled.get(key) ?? 0;
    const have = (got?.qty ?? 0) - (sourceUsed.get(key) ?? 0) + substitutedIn;
    const req = need?.qty ?? 0;
    if (req === 0 && have === 0) continue; // a fully used substitute
    const missing = Math.max(0, req - have);
    const extra = Math.max(0, have - req);
    const status: RowStatus = req === 0 ? "Not in set" : missing > 0 ? "Missing" : extra > 0 ? "Extra" : "Complete";
    const part = need?.part ?? got!.part;
    const color = need?.color ?? got!.color;
    const fallbackColor = blColor(got?.blColor);
    const notes: string[] = [];
    if (substitutedIn) {
      const sources = proposals.filter((p) => lineKey(p.targetPart, p.color) === key && p.allocated)
        .map((p) => `${p.allocated}× ${p.sourcePart}`);
      notes.push(`Includes ${sources.join(", ")} as substitute${substitutedIn === 1 ? "" : "s"}`);
    }
    if (status === "Not in set") {
      // A variation in a color the set does not need stays surplus (relationships.py)
      for (const [related, relType] of variations[part] ?? []) {
        const colors = inventory.lines.filter((line) => line.part === related).map((line) => line.colorName);
        if (colors.length) {
          notes.push(`${relType === "M" ? "Mold variation" : "Alternative"} of ${related}, which this set needs in ${[...new Set(colors)].join(", ")}`);
        }
      }
    }
    rows.push({
      key, part, color,
      name: need?.name ?? got!.name,
      colorName: need?.colorName ?? fallbackColor?.name ?? resolveColor(color).name,
      colorHex: need?.colorHex ?? (got?.blColor ? blColorHex(got.blColor) : resolveColor(color).hex),
      image: need?.image || got?.image || "",
      blPart: need?.blParts[0] ?? got?.blPart ?? "",
      blColor: need?.blColors[0] ?? got?.blColor ?? "",
      required: req, have, substitutedIn, missing, extra, status,
      category: need?.category || categoryOf(part),
      note: notes.join(" · "),
      recordIds: got?.recordIds ?? [],
      manualIds: got?.manualIds ?? []
    });
    counts[status]++;
    requiredPieces += req;
    foundPieces += Math.min(req, have);
    missingPieces += missing;
    extraPieces += extra;
  }
  const order: Record<RowStatus, number> = { Missing: 0, "Not in set": 1, Extra: 2, Complete: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || (b.missing + b.extra) - (a.missing + a.extra) || a.name.localeCompare(b.name));
  return { rows, proposals, counts, requiredPieces, foundPieces, missingPieces, extraPieces };
}

// --- Exports (comparison.py build_full_report / report_to_bricklink_xml_bytes) ---

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function reportCsv(rows: ReportRow[], remarks: Record<string, string> = {}): string {
  const header = ["image_url", "bricklink_part_num", "bricklink_color_id", "part_num", "part_name", "color_id", "color_name",
    "quantity_required", "quantity_have", "quantity_missing", "quantity_extra", "status", "wanted_list_remark", "variation_note"];
  const lines = [header.join(",")];
  for (const row of rows) {
    if (row.status === "Complete") continue;
    lines.push([row.image.startsWith("blob:") ? "" : row.image, row.blPart, row.blColor, row.part, row.name, row.color, row.colorName,
      row.required, row.have, row.missing, row.extra, row.status, remarks[row.key] ?? "", row.note].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

const xmlText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// BrickLink wanted list for the missing pieces. Rows without a BrickLink part
// and color are skipped and returned so the UI can say so.
export function wantedListXml(rows: ReportRow[], remarks: Record<string, string> = {}, condition = "U"): { xml: string; skipped: ReportRow[] } {
  const missing = rows.filter((row) => row.missing > 0);
  const exportable = missing.filter((row) => row.blPart && row.blColor);
  const items = exportable.map((row) => [
    "  <ITEM>",
    "    <ITEMTYPE>P</ITEMTYPE>",
    `    <ITEMID>${xmlText(row.blPart)}</ITEMID>`,
    `    <COLOR>${xmlText(row.blColor)}</COLOR>`,
    `    <MINQTY>${row.missing}</MINQTY>`,
    `    <CONDITION>${condition}</CONDITION>`,
    `    <REMARKS>${xmlText(remarks[row.key] ?? "")}</REMARKS>`,
    "  </ITEM>"
  ].join("\n"));
  return { xml: `<INVENTORY>\n${items.join("\n")}\n</INVENTORY>\n`, skipped: missing.filter((row) => !exportable.includes(row)) };
}
