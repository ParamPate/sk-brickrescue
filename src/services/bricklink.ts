import { BL_COLOR_MAP } from "../data/blColorMap";
import { resolveColor } from "./catalog.svelte";

// BrickLink IDs are what Brickognize reports and what the desktop verification
// app imports, so recognition results stay in BrickLink terms. Rebrickable IDs
// are only derived for set matching against the local catalog.

export interface BlColor {
  id: string; // BrickLink color ID
  rb: number; // Rebrickable color ID
  name: string;
}

export const BL_COLORS: BlColor[] = BL_COLOR_MAP.map(([bl, rb, name]) => ({ id: String(bl), rb, name }));
const byBlId = new Map(BL_COLORS.map((color) => [color.id, color]));
const byRbId = new Map(BL_COLORS.map((color) => [color.rb, color]));
const byName = new Map(BL_COLORS.map((color) => [color.name.toLowerCase(), color]));

// Common solid colors offered first during review (bricklink_colors.py).
export const REVIEW_COLOR_IDS = [
  "1", "86", "85", "11", "59", "5", "167", "220", "120", "88", "69", "2", "90", "28", "150",
  "68", "4", "110", "3", "103", "34", "155", "80", "6", "36", "48", "39", "41", "152", "63",
  "7", "153", "156", "42", "105", "62", "55", "89", "24", "157", "154", "71", "47", "104", "23"
];

export function blColor(id: string | number | undefined | null): BlColor | undefined {
  return id === undefined || id === null || id === "" ? undefined : byBlId.get(String(id));
}

export function blColorByName(name: string): BlColor | undefined {
  return byName.get(name.trim().toLowerCase());
}

export function rbToBlColor(rbId: number): BlColor | undefined {
  return byRbId.get(rbId);
}

export function blColorHex(id: string | undefined): string {
  const color = blColor(id);
  return color ? resolveColor(color.rb).hex : "#777777";
}

// Rebrickable color for set matching; -1 when BrickLink's color has no mapping.
export function blToRbColorId(id: string | undefined): number {
  return blColor(id)?.rb ?? -1;
}

export function referenceImageUrl(partId: string, colorId: string): string {
  if (!partId || partId === "Unknown") return "";
  const part = encodeURIComponent(partId);
  return colorId
    ? `https://img.bricklink.com/ItemImage/PN/${encodeURIComponent(colorId)}/${part}.png`
    : `https://img.bricklink.com/ItemImage/P/${part}.png`;
}

export function catalogUrl(partId: string, colorId: string, baseUrl = ""): string {
  if (!partId || partId === "Unknown") return "N/A";
  const base = (baseUrl && baseUrl !== "N/A" ? baseUrl : `https://www.bricklink.com/v2/catalog/catalogitem.page?P=${encodeURIComponent(partId)}`)
    .split("&idColor=")[0];
  return colorId ? `${base}&idColor=${colorId}` : base;
}

// --- BrickLink part -> Rebrickable part (for set matching) ---
let partMap: Record<string, string> = {};
const partMapReady = fetch("/data/bl-part-map.json")
  .then((res) => (res.ok ? res.json() : {}))
  .then((map) => { partMap = map; })
  .catch(() => {});

export function whenPartMapReady(): Promise<void> {
  return partMapReady;
}

export function blToRbPart(partId: string): string {
  return partMap[partId] ?? partId;
}

export function rbToBlPart(partNum: string): string {
  for (const bl in partMap) if (partMap[bl] === partNum) return bl;
  return partNum;
}

// --- Colors a part is cataloged in (part_color_service.py) ---
// Lookup order: this browser's cache, the desktop app's cache, a live BrickLink
// lookup through the same-origin proxy, then the full review list as fallback.
export type ColorSource = "BrickLink" | "Cache" | "Fallback";
const LOCAL_CACHE_KEY = "sk-part-colors";
const LOOKUP_TIMEOUT_MS = 8000;
const pending = new Map<string, Promise<{ ids: string[]; source: ColorSource }>>();
let seedCache: Promise<Record<string, string[]>> | null = null;

function readLocalCache(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeLocalCache(partId: string, ids: string[]) {
  try {
    const cache = readLocalCache();
    cache[partId] = ids;
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: the lookup still works for this session.
  }
}

export function extractColorIds(html: string, partId: string): string[] {
  const escaped = partId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ids = new Set<string>();
  for (const match of html.matchAll(new RegExp(`ItemImage/PN/(\\d+)/${escaped}\\.png`, "gi"))) ids.add(match[1]);
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

export function getPartColorOptions(partId: string): Promise<{ ids: string[]; source: ColorSource }> {
  const clean = partId.trim();
  if (!clean || clean === "Unknown") return Promise.resolve({ ids: REVIEW_COLOR_IDS, source: "Fallback" });
  const local = readLocalCache()[clean];
  if (local?.length) return Promise.resolve({ ids: local, source: "Cache" });

  let lookup = pending.get(clean);
  if (lookup) return lookup;
  lookup = (async () => {
    seedCache ??= fetch("/data/part-colors.json").then((res) => (res.ok ? res.json() : {})).catch(() => ({}));
    const seeded = (await seedCache)[clean];
    if (seeded?.length) return { ids: seeded, source: "Cache" as const };
    try {
      const res = await fetch(`/api/bricklink-colors?itemType=P&itemNo=${encodeURIComponent(clean)}`, {
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
      });
      if (res.ok) {
        const ids = extractColorIds(await res.text(), clean).filter((id) => byBlId.has(id));
        if (ids.length) {
          writeLocalCache(clean, ids);
          return { ids, source: "BrickLink" as const };
        }
      }
    } catch {
      // BrickLink unreachable or in maintenance: fall through to the review list.
    }
    pending.delete(clean); // allow a retry later
    return { ids: REVIEW_COLOR_IDS, source: "Fallback" as const };
  })();
  pending.set(clean, lookup);
  return lookup;
}
