import type { MatchResult, BrickPart, ScannedColorInput } from "./types";
import {
  loadCatalogIndex,
  loadSetParts,
  resolvePartName,
  type CatalogSetIndexEntry,
  type CatalogSetPart
} from "./catalog.svelte";

// Scoring constants: 70/30 rarity/color weighting, 0.1 mismatch penalty
const RARITY_WEIGHT = 0.7;
const COLOR_WEIGHT = 0.3;
const MISMATCH_PENALTY = 0.1;
const DEFAULT_RARITY = 0.01; // for scanned parts unknown to the catalog
const TOP_MATCHES = 3;
const BRICKOGNIZE_TIMEOUT_MS = 10_000;

// Strip printed/pattern/assembly/sub-part suffixes from a part number, keeping
// the numeric base (with optional mold letter): "3001pr0002" -> "3001",
// "3626cpr0001" -> "3626c". IDs without a numeric base (e.g. "cardupn0015pr0001")
// are returned unchanged — they must never collapse to an empty string
// (a "" base would alias thousands of unrelated parts, see FIND-030).
export function getBasePartNum(partNum: string): string {
  const match = partNum.match(/^(\d+[a-z]?)(?:pr|pat|c|sp)\d.*$/i);
  return match ? match[1] : partNum;
}

function splitScannedKey(key: string): { base: string; colorId: string } | null {
  const idx = key.lastIndexOf("_");
  if (idx === -1) return null;
  return {
    base: getBasePartNum(key.substring(0, idx)).toLowerCase(),
    colorId: key.substring(idx + 1)
  };
}

function toBrickPart(part: CatalogSetPart): BrickPart {
  return {
    part_num: part.p,
    name: resolvePartName(part),
    color_id: part.c,
    rarity_score: part.r,
    imageUrl: part.i || ""
  };
}

// Split a set's diagnostic parts into matched/missing against the scanned keys.
// Pass 1 matches strictly color-dependent; pass 2 falls back color-independently
// for scans whose color does not exist in the set at all (REQ-RAD-006a).
function assembleChecklist(
  setParts: CatalogSetPart[],
  userScannedBaseColorKeys: Set<string>
): { matchedParts: BrickPart[]; missingParts: BrickPart[] } {
  const matchedParts: BrickPart[] = [];
  const tempMissingParts: BrickPart[] = [];

  const setBaseColorKeys = new Set<string>();
  for (const part of setParts) {
    setBaseColorKeys.add(`${getBasePartNum(part.p).toLowerCase()}_${part.c}`);
  }

  // Track consumed scanned keys to prevent matching multiple parts in set to same single scan
  const consumedScannedKeys = new Set<string>();

  // Pass 1: Direct color-dependent match
  for (const part of setParts) {
    const formattedPart = toBrickPart(part);
    const matchKey = `${getBasePartNum(part.p).toLowerCase()}_${part.c}`;
    if (userScannedBaseColorKeys.has(matchKey)) {
      formattedPart.matchedScanKey = matchKey;
      matchedParts.push(formattedPart);
      consumedScannedKeys.add(matchKey);
    } else {
      tempMissingParts.push(formattedPart);
    }
  }

  // Pass 2: Fallback matching for remaining missing parts
  const missingParts: BrickPart[] = [];
  for (const part of tempMissingParts) {
    const catalogBaseNum = getBasePartNum(part.part_num).toLowerCase();
    let matchedByFallback = false;

    for (const scannedKey of userScannedBaseColorKeys) {
      if (consumedScannedKeys.has(scannedKey)) continue;

      const idx = scannedKey.lastIndexOf("_");
      if (idx !== -1) {
        const scannedBase = scannedKey.substring(0, idx);
        const scannedColor = scannedKey.substring(idx + 1);
        if (scannedBase === catalogBaseNum) {
          // Does the set contain this base part in scannedColor?
          const setHasScannedColor = setBaseColorKeys.has(`${catalogBaseNum}_${scannedColor}`);
          if (!setHasScannedColor) {
            matchedByFallback = true;
            // Remember the scanned entry (with its mis-classified colour) so un-marking
            // can later remove exactly this Found Shelf part, not the catalog colour (FIND-046).
            part.matchedScanKey = scannedKey;
            consumedScannedKeys.add(scannedKey);
            break;
          }
        }
      }
    }

    if (matchedByFallback) {
      matchedParts.push(part);
    } else {
      missingParts.push(part);
    }
  }

  return { matchedParts, missingParts };
}

// MATCH SETS SERVICE (Executes matching algorithm in-memory).
// `ensureSetNum` guarantees that this set is part of the result even when it is
// not among the top matches — the Dig Mode stays open while scans change the ranking.
export async function fetchMatchSets(
  scannedColors: ScannedColorInput[],
  scannedPartKeys: string[],
  ensureSetNum: string | null = null
): Promise<MatchResult[]> {
  const { sets, parts } = await loadCatalogIndex();

  const scannedPartsCount = scannedPartKeys.length;

  // 1. Extract unique base scanned part numbers by stripping suffixes
  const userScannedParts = Array.from(new Set(
    (scannedPartKeys || []).map(k => {
      const idx = k.lastIndexOf("_");
      const partNum = idx !== -1 ? k.substring(0, idx) : k;
      return getBasePartNum(partNum);
    })
  ));

  // 2. Find rarity score for each scanned base part
  const scannedPartsRarity: Record<string, number> = {};
  let totalRarity = 0.0;
  for (const baseNum of userScannedParts) {
    const partInfo = parts[baseNum];
    const partRarity = partInfo ? partInfo.r : DEFAULT_RARITY;
    scannedPartsRarity[baseNum] = partRarity;
    totalRarity += partRarity;
  }

  // 3. Calculate matched parts rarity per set
  const setPartRarities: Record<string, { matched_rarity_sum: number; matched_count: number }> = {};
  for (const baseNum of userScannedParts) {
    const partInfo = parts[baseNum];
    if (partInfo && partInfo.s) {
      const partRarity = scannedPartsRarity[baseNum];
      for (const setNum of partInfo.s) {
        if (!setPartRarities[setNum]) {
          setPartRarities[setNum] = { matched_rarity_sum: 0.0, matched_count: 0 };
        }
        setPartRarities[setNum].matched_rarity_sum += partRarity;
        setPartRarities[setNum].matched_count += 1;
      }
    }
  }

  // 4. Single pass over all sets: compute the combined score and keep only the
  // current top matches (no full result array + sort for a top-3 selection).
  const scoreSet = (setNum: string, set: CatalogSetIndexEntry): { colorMatchScore: number; combinedScore: number } => {
    // Color match score: Least-Mismatch sum (REQ-CON-002)
    let colorMatchScore = 0.0;
    for (const uc of scannedColors) {
      const setPercentage = set.c[uc.color_id] || 0.0;
      colorMatchScore += Math.min(setPercentage / 100.0, uc.weight);
    }

    const partInfo = setPartRarities[setNum];
    const matchedCount = partInfo ? partInfo.matched_count : 0;
    const matchedRaritySum = partInfo ? partInfo.matched_rarity_sum : 0.0;

    let combinedScore: number;
    if (scannedPartsCount === 0) {
      // Rounded color weights can sum to slightly above 1.0 — clamp the display score
      combinedScore = Math.min(1.0, colorMatchScore);
    } else if (matchedCount > 0) {
      combinedScore = Math.min(
        1.0,
        (matchedRaritySum / (totalRarity || 1.0)) * RARITY_WEIGHT + colorMatchScore * COLOR_WEIGHT
      );
    } else {
      combinedScore = colorMatchScore * MISMATCH_PENALTY;
    }

    return { colorMatchScore, combinedScore };
  };

  type ScoredSet = { set_num: string; colorMatchScore: number; combinedScore: number };
  const topMatches: ScoredSet[] = [];

  for (const setNum in sets) {
    const { colorMatchScore, combinedScore } = scoreSet(setNum, sets[setNum]);
    if (combinedScore <= 0.0) continue;

    if (topMatches.length < TOP_MATCHES || combinedScore > topMatches[topMatches.length - 1].combinedScore) {
      let insertAt = topMatches.length;
      while (insertAt > 0 && topMatches[insertAt - 1].combinedScore < combinedScore) {
        insertAt--;
      }
      topMatches.splice(insertAt, 0, { set_num: setNum, colorMatchScore, combinedScore });
      if (topMatches.length > TOP_MATCHES) topMatches.pop();
    }
  }

  // Keep the actively opened set in the results even when it drops out of the top matches
  if (ensureSetNum && sets[ensureSetNum] && !topMatches.some(m => m.set_num === ensureSetNum)) {
    const { colorMatchScore, combinedScore } = scoreSet(ensureSetNum, sets[ensureSetNum]);
    topMatches.push({ set_num: ensureSetNum, colorMatchScore, combinedScore });
  }

  // 5. Assemble final results with matched and missing parts lists.
  // We check if the user has scanned this specific base part number IN THIS COLOR for the checklist.
  const userScannedBaseColorKeys = new Set(
    (scannedPartKeys || [])
      .map(splitScannedKey)
      .filter((k): k is { base: string; colorId: string } => k !== null)
      .map(k => `${k.base}_${k.colorId}`)
  );

  const results: MatchResult[] = await Promise.all(topMatches.map(async (setMatch) => {
    const set = sets[setMatch.set_num];
    const setParts = await loadSetParts(setMatch.set_num);
    const { matchedParts, missingParts } = assembleChecklist(setParts, userScannedBaseColorKeys);

    return {
      set_num: setMatch.set_num,
      name: set.n,
      year: String(set.y),
      imageUrl: set.i || "",
      total_parts: set.t,
      colorMatchScore: setMatch.colorMatchScore,
      combinedScore: setMatch.combinedScore,
      matchedParts,
      missingParts
    };
  }));

  return results;
}

export async function fetchMatchSetByNum(setNum: string): Promise<MatchResult | null> {
  try {
    const { sets } = await loadCatalogIndex();
    const set = sets[setNum];
    if (!set) return null;

    const setParts = await loadSetParts(setNum);
    const missingParts: BrickPart[] = setParts.map(toBrickPart);

    return {
      set_num: setNum,
      name: set.n,
      year: String(set.y),
      imageUrl: set.i || "",
      total_parts: set.t,
      colorMatchScore: 0,
      combinedScore: 0,
      matchedParts: [],
      missingParts
    };
  } catch (err) {
    console.error("fetchMatchSetByNum failed:", err);
    return null;
  }
}

// BRICKOGNIZE IMAGE CLASSIFICATION API.
// Untrusted third-party response: every item is validated before it enters app
// state, and image URLs are only accepted over https. Network/HTTP errors are
// thrown (with a timeout) so callers can distinguish "API failed" from
// "no part recognized" (empty array).
export async function predictPartFromImage(imageBlob: Blob): Promise<BrickPart[]> {
  const formData = new FormData();
  formData.append("query_image", imageBlob, "scan.jpg");

  const res = await fetch("https://api.brickognize.com/predict/parts/", {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(BRICKOGNIZE_TIMEOUT_MS)
  });

  if (!res.ok) {
    throw new Error(`Brickognize returned HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.items)) return [];

  const listingId = data.listing_id;
  const brickognizeUrl = typeof listingId === "string" && /^[a-z0-9-]+$/i.test(listingId)
    ? `https://brickognize.com/results/${listingId}/`
    : undefined;

  return data.items
    .filter((item: unknown): item is { id: string; name: string; score?: unknown; img_url?: unknown } => {
      const candidate = item as { id?: unknown; name?: unknown };
      return typeof candidate?.id === "string" && candidate.id.length > 0 && typeof candidate?.name === "string";
    })
    .map((item: { id: string; name: string; score?: unknown; img_url?: unknown }): BrickPart => ({
      part_num: item.id,
      brickognizeUrl,
      name: item.name,
      color_id: 15, // Placeholder — caller overrides with the dominant scanned color
      rarity_score: parseFloat(String(item.score)) || 0.1,
      imageUrl: typeof item.img_url === "string" && item.img_url.startsWith("https://") ? item.img_url : ""
    }));
}
