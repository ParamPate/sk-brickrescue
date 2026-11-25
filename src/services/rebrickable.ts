import { idbGet, idbSet } from "./idb";
import { loadCatalogIndex, loadPartCategories, loadPartNames, loadSetParts, partImageUrl, resolveColor, resolvePartName, setImageUrl } from "./catalog.svelte";
import { rbToBlColor, rbToBlPart } from "./bricklink";

// Set part lists for verification, from the Rebrickable API (the desktop
// verification app's source, api_rebrickable.py). Responses are cached for a
// day so reopening a set is instant. Without a key, or when the API cannot be
// reached, the local catalog is used instead (no minifigure parts).

const API_BASE = "https://rebrickable.com/api/v3/lego";
const API_KEY = (import.meta.env.VITE_REBRICKABLE_API_KEY as string | undefined)?.trim() ?? "";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

export interface SetLine {
  part: string; // Rebrickable part number
  name: string;
  color: number; // Rebrickable color ID
  colorName: string;
  colorHex: string;
  qty: number;
  image: string;
  blParts: string[]; // BrickLink part numbers for this part
  blColors: string[]; // BrickLink color IDs for this color
  category: string; // part category name, e.g. "Plates" ("" when unknown)
}

export interface SetInventory {
  setNum: string;
  name: string;
  year: number;
  numParts: number;
  image: string;
  lines: SetLine[];
  fetchedAt: number;
  source: "Rebrickable API" | "Local catalog";
}

export class SetNotFoundError extends Error {}

export const hasApiKey = () => API_KEY.length > 0;

// "40611" -> "40611-1" (normalize_set_num in the desktop app)
export function normalizeSetNum(input: string): string {
  const setNum = input.trim();
  return !setNum || setNum.includes("-") ? setNum : `${setNum}-1`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiGet(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `key ${API_KEY}`, Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (res.status === 404) throw new SetNotFoundError("Set not found");
    // Rebrickable allows about one request per second; wait and retry when throttled.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep((Number(res.headers.get("Retry-After")) || 1.2) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Rebrickable returned HTTP ${res.status}`);
    return res.json();
  }
}

type ApiPart = {
  part?: { part_num?: string; name?: string; part_cat_id?: number; part_img_url?: string | null; external_ids?: { BrickLink?: string[] } };
  color?: { id?: number; name?: string; rgb?: string; external_ids?: { BrickLink?: { ext_ids?: (number | null)[] } } };
  quantity?: number;
  is_spare?: boolean;
};

async function fetchFromApi(setNum: string, signal?: AbortSignal): Promise<SetInventory> {
  const [details, categories] = await Promise.all([apiGet(`${API_BASE}/sets/${encodeURIComponent(setNum)}/`, signal), loadPartCategories()]);
  const lines = new Map<string, SetLine>();
  let next: string | null = `${API_BASE}/sets/${encodeURIComponent(setNum)}/parts/?page_size=1000&inc_minifig_parts=1`;
  while (next) {
    const page = await apiGet(next, signal);
    for (const item of (page.results as ApiPart[]) ?? []) {
      if (item.is_spare || !item.part?.part_num || item.color?.id === undefined) continue;
      const key = `${item.part.part_num}|${item.color.id}`;
      const existing = lines.get(key);
      if (existing) {
        existing.qty += item.quantity ?? 1;
        continue;
      }
      lines.set(key, {
        part: item.part.part_num,
        name: item.part.name ?? `Part ${item.part.part_num}`,
        color: item.color.id,
        colorName: item.color.name ?? resolveColor(item.color.id).name,
        colorHex: item.color.rgb ? `#${item.color.rgb}` : resolveColor(item.color.id).hex,
        qty: item.quantity ?? 1,
        image: item.part.part_img_url ?? "",
        blParts: item.part.external_ids?.BrickLink ?? [],
        blColors: (item.color.external_ids?.BrickLink?.ext_ids ?? []).filter((id): id is number => id !== null).map(String),
        category: categories.names[item.part.part_cat_id ?? -1] ?? ""
      });
    }
    next = typeof page.next === "string" ? page.next : null;
  }
  return {
    setNum,
    name: String(details.name ?? setNum),
    year: Number(details.year) || 0,
    numParts: Number(details.num_parts) || 0,
    image: typeof details.set_img_url === "string" ? details.set_img_url : "",
    lines: [...lines.values()],
    fetchedAt: Date.now(),
    source: "Rebrickable API"
  };
}

async function loadFromCatalog(setNum: string): Promise<SetInventory> {
  const { sets } = await loadCatalogIndex();
  const set = sets[setNum];
  if (!set) throw new SetNotFoundError("Set not found");
  const [rows, names, categories] = await Promise.all([loadSetParts(setNum), loadPartNames(), loadPartCategories()]);
  return {
    setNum,
    name: set.n,
    year: set.y,
    numParts: set.t,
    image: setImageUrl(setNum, set),
    lines: rows.map(([part, color, qty, image]) => {
      const blColor = rbToBlColor(color);
      return {
        part,
        name: resolvePartName(part, names),
        color,
        colorName: resolveColor(color).name,
        colorHex: resolveColor(color).hex,
        qty,
        image: partImageUrl(image),
        blParts: [rbToBlPart(part)],
        blColors: blColor ? [blColor.id] : [],
        category: categories.names[categories.parts[part] ?? -1] ?? ""
      };
    }),
    fetchedAt: Date.now(),
    source: "Local catalog"
  };
}

// Load a set's part list (spares excluded, minifigure parts included).
export async function loadSetInventory(input: string, options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<SetInventory> {
  const setNum = normalizeSetNum(input);
  if (!setNum) throw new SetNotFoundError("Enter a set number");
  const cacheKey = `rebrickable-set-v2:${setNum}`; // v2: lines carry their category
  if (!options.refresh) {
    const cached = await idbGet<SetInventory>(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }
  if (hasApiKey()) {
    try {
      const inventory = await fetchFromApi(setNum, options.signal);
      idbSet(cacheKey, inventory);
      return inventory;
    } catch (err) {
      if (err instanceof SetNotFoundError || (err as Error)?.name === "AbortError") throw err;
      console.warn("Rebrickable API unavailable, using the local catalog:", err);
    }
  }
  return loadFromCatalog(setNum);
}
