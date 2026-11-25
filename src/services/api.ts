import type { ChecklistPart, MatchResult, PileItem, ScannedColorInput } from "./types";
import {
  canonicalPart,
  getBasePartNum,
  loadCatalogIndex,
  loadPartNames,
  loadSetParts,
  moldGroup,
  partImageUrl,
  resolveColor,
  resolvePartName,
  setImageUrl,
  type CatalogSetIndexEntry,
  type SetPartRow
} from "./catalog.svelte";

export { getBasePartNum };

// Set matching against full set inventories.
//
// Parts are compared by canonical part group and ignore color: recognition
// reads part shapes far more reliably than colors under room lighting. Each
// part is weighted by how rare it is across all sets (common pins count little,
// distinctive pieces a lot), and quantities are capped by what the set holds:
//   pileCoverage P = weighted pieces of the pile the set contains / whole pile
//   setCoverage  R = weighted pieces of the set found in the pile / whole set
//   partScore      = P^0.75 · R^0.25
// P dominates because a scan is usually a partial set mixed with strays; R
// keeps huge sets from winning just by containing every common piece. Tuned on
// a real 555-piece SPIKE Prime scan and 300 simulated partial scans
// (top-1 94%, top-3 97%).
const PILE_EXPONENT = 0.75;
const SET_EXPONENT = 0.25;
// Photo colors only break ties once parts are known.
const COLOR_WEIGHT_WITH_PARTS = 0.05;
const TOP_MATCHES = 3;

function colorScore(scannedColors: ScannedColorInput[], set: CatalogSetIndexEntry): number {
  let score = 0;
  for (const color of scannedColors) score += Math.min((set.c[color.color_id] || 0) / 100, color.weight);
  return score;
}

function colorDistance(a: number, b: number): number {
  const hexA = resolveColor(a).hex, hexB = resolveColor(b).hex;
  let distance = 0;
  for (const offset of [1, 3, 5]) distance += (parseInt(hexA.slice(offset, offset + 2), 16) - parseInt(hexB.slice(offset, offset + 2), 16)) ** 2;
  return Number.isFinite(distance) ? distance : Infinity;
}

// Assign scanned pieces to a set's inventory lines: same part group and color
// first, then the same part group in the nearest other color. Pieces taken in
// another color are listed in `borrowed` so they can be recolored to the set's color.
export function buildChecklist(
  rows: SetPartRow[],
  pile: PileItem[],
  names: Record<string, string>
): { checklist: ChecklistPart[]; foundPieces: number; totalPieces: number } {
  // canonical group -> unassigned scanned pieces by color and mold group
  type Source = { color: number; mold: string; qty: number };
  const remaining = new Map<string, Source[]>();
  for (const item of pile) {
    const sources = remaining.get(canonicalPart(item.part)) ?? [];
    const mold = moldGroup(item.part);
    const existing = sources.find((source) => source.color === item.color && source.mold === mold);
    if (existing) existing.qty += item.qty;
    else sources.push({ color: item.color, mold, qty: item.qty });
    remaining.set(canonicalPart(item.part), sources);
  }

  const lines = rows.map(([part, color, quantity, image]) => ({
    part, color, quantity, image, canonical: canonicalPart(part), mold: moldGroup(part), found: 0, colorMismatch: false,
    borrowed: [] as { color: number; qty: number; part: string }[]
  }));
  // Pass 1: same color (same mold group preferred)
  for (const line of lines) {
    const sources = (remaining.get(line.canonical) ?? [])
      .filter((source) => source.color === line.color && source.qty > 0)
      .sort((a, b) => Number(b.mold === line.mold) - Number(a.mold === line.mold));
    for (const source of sources) {
      const take = Math.min(source.qty, line.quantity - line.found);
      source.qty -= take;
      line.found += take;
      if (line.found >= line.quantity) break;
    }
  }
  // Pass 2: another color — same mold group first, then the nearest color
  for (const line of lines) {
    if (line.found >= line.quantity) continue;
    const sources = (remaining.get(line.canonical) ?? [])
      .filter((source) => source.qty > 0)
      .sort((a, b) => Number(b.mold === line.mold) - Number(a.mold === line.mold) ||
        colorDistance(a.color, line.color) - colorDistance(b.color, line.color));
    for (const source of sources) {
      const take = Math.min(source.qty, line.quantity - line.found);
      source.qty -= take;
      line.found += take;
      line.colorMismatch = true;
      // Only the same physical part can be recolored to the set's color
      if (source.mold === line.mold) line.borrowed.push({ color: source.color, qty: take, part: source.mold });
      if (line.found >= line.quantity) break;
    }
  }

  let foundPieces = 0, totalPieces = 0;
  const checklist: ChecklistPart[] = lines.map((line) => {
    foundPieces += line.found;
    totalPieces += line.quantity;
    return {
      part_num: line.part,
      name: resolvePartName(line.part, names),
      color_id: line.color,
      rarity_score: 0,
      imageUrl: partImageUrl(line.image),
      quantity: line.quantity,
      found: line.found,
      colorMismatch: line.colorMismatch,
      borrowed: line.borrowed
    };
  });
  // Lines still missing pieces first (most needed first), complete lines after
  checklist.sort((a, b) =>
    Number(a.found >= a.quantity) - Number(b.found >= b.quantity) || (b.quantity - b.found) - (a.quantity - a.found));
  return { checklist, foundPieces, totalPieces };
}

// MATCH SETS SERVICE (runs in memory against the local catalog).
// `ensureSetNum` keeps that set in the results even when it is not among the
// top matches — Dig Mode stays open while scans change the ranking.
export async function fetchMatchSets(
  scannedColors: ScannedColorInput[],
  pile: PileItem[],
  ensureSetNum: string | null = null
): Promise<MatchResult[]> {
  const { sets, match } = await loadCatalogIndex();

  // Scanned pile by canonical part group
  const pileByPart = new Map<string, number>();
  for (const item of pile) {
    if (item.qty > 0) pileByPart.set(canonicalPart(item.part), (pileByPart.get(canonicalPart(item.part)) || 0) + item.qty);
  }

  type Scored = { set_num: string; colorMatchScore: number; combinedScore: number; pileCoverage: number; setCoverage: number };
  const scored: Scored[] = [];

  if (pileByPart.size === 0) {
    // Color-only search (live camera before any part is identified)
    for (const set_num in sets) {
      const color = colorScore(scannedColors, sets[set_num]);
      // Rounded color weights can sum to slightly above 1.0 — clamp the display score
      if (color > 0) scored.push({ set_num, colorMatchScore: color, combinedScore: Math.min(1, color), pileCoverage: 0, setCoverage: 0 });
    }
  } else {
    let pileWeight = 0;
    const overlap = new Float64Array(match.setNums.length);
    const touched: number[] = [];
    for (const [part, qty] of pileByPart) {
      const weight = match.idf(part);
      pileWeight += weight * qty;
      const postings = match.parts[part];
      if (!postings) continue;
      for (let i = 0; i < postings.length; i += 2) {
        const setIndex = postings[i];
        if (overlap[setIndex] === 0) touched.push(setIndex);
        overlap[setIndex] += weight * Math.min(qty, postings[i + 1]);
      }
    }
    for (const setIndex of touched) {
      const set_num = match.setNums[setIndex];
      const set = sets[set_num];
      if (!set) continue;
      const pileCoverage = overlap[setIndex] / pileWeight;
      const setCoverage = overlap[setIndex] / (match.setWeights[setIndex] || 1);
      const partScore = pileCoverage ** PILE_EXPONENT * setCoverage ** SET_EXPONENT;
      const color = colorScore(scannedColors, set);
      scored.push({
        set_num,
        colorMatchScore: color,
        combinedScore: Math.min(1, partScore * (1 - COLOR_WEIGHT_WITH_PARTS) + Math.min(1, color) * COLOR_WEIGHT_WITH_PARTS),
        pileCoverage,
        setCoverage
      });
    }
  }

  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  const top = scored.slice(0, TOP_MATCHES);
  if (ensureSetNum && sets[ensureSetNum] && !top.some((entry) => entry.set_num === ensureSetNum)) {
    top.push(scored.find((entry) => entry.set_num === ensureSetNum) ??
      { set_num: ensureSetNum, colorMatchScore: 0, combinedScore: 0, pileCoverage: 0, setCoverage: 0 });
  }

  const names = await loadPartNames();
  return Promise.all(top.map(async (entry) => {
    const set = sets[entry.set_num];
    const { checklist, foundPieces, totalPieces } = buildChecklist(await loadSetParts(entry.set_num), pile, names);
    return {
      ...entry,
      name: set.n,
      year: String(set.y),
      imageUrl: setImageUrl(entry.set_num, set),
      total_parts: set.t,
      checklist,
      foundPieces,
      totalPieces
    };
  }));
}
