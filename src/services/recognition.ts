import { BL_COLORS, blColor, blColorByName, catalogUrl, referenceImageUrl, REVIEW_COLOR_IDS } from "./bricklink";
import { resolveColor } from "./catalog.svelte";

// Port of the desktop app's recognition backend (part recognition/src/main.py).
// Brickognize's internal search endpoint returns ranked part candidates with
// BrickLink IDs and a color prediction. Browsers cannot call it directly (CORS),
// so it goes through the same-origin /api/brickognize proxy (vite.config.ts in
// development, vercel.json rewrites in production). Without the proxy the public
// parts endpoint is used and color falls back to the in-browser estimate.

const PROXY_URL = "/api/brickognize";
const PUBLIC_URL = "https://api.brickognize.com/predict/parts/";
const REQUEST_TIMEOUT_MS = 30_000;

export const PART_REVIEW_THRESHOLD = 80;
export const COLOR_REVIEW_THRESHOLD = 80;

export interface ColorCandidate {
  name: string;
  colorId: string; // BrickLink color ID ("" when Brickognize gives none)
  score: number; // 0..100
}

export interface PartCandidate {
  partId: string; // BrickLink part ID
  name: string;
  type: string;
  score: number; // 0..100
  bricklinkUrl: string;
  imageUrl: string;
  colors: ColorCandidate[];
}

export interface Recognition {
  responseId: string;
  queryId: string;
  detectedItems: number;
  boundingBoxScore: number | null;
  candidates: PartCandidate[];
  raw: unknown;
}

type Json = Record<string, unknown>;
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : []);
const asString = (value: unknown, fallback = ""): string => (typeof value === "string" || typeof value === "number" ? String(value) : fallback);
const asScore = (value: unknown): number => {
  const score = Number(value);
  return Number.isFinite(score) ? score * 100 : 0;
};
const httpsOnly = (value: unknown): string => (typeof value === "string" && value.startsWith("https://") ? value : "");

function bricklinkEntry(entries: unknown): Json | undefined {
  return asArray(entries).find((entry) => asString(entry.catalog_name).toLowerCase() === "bricklink");
}

// Brickognize's own IDs look like "part-3023-20260330"; keep only the part number.
function internalPartId(id: string): string {
  return id.replace(/^part-/, "").replace(/-\d{8}$/, "") || "Unknown";
}

function parseCandidate(item: Json): PartCandidate {
  const external = bricklinkEntry(item.external_items);
  const colors = asArray(item.candidate_colors).map((color) => {
    const externalColor = bricklinkEntry(color.external_colors);
    return {
      name: asString(color.name, "Unknown"),
      colorId: asString(externalColor?.external_id),
      score: asScore(color.score)
    };
  });
  return {
    partId: asString(external?.external_id) || internalPartId(asString(item.id)),
    name: asString(external?.name) || asString(item.name, "Unknown"),
    type: asString(item.type, "part"),
    score: asScore(item.score),
    bricklinkUrl: httpsOnly(external?.url),
    imageUrl: httpsOnly(item.img_url),
    colors
  };
}

// Accepts both the internal search response (detected_items) and the public
// predict response (items), so the proxy fallback needs no separate path.
export function parseBrickognizeResponse(data: unknown): Recognition {
  const body = (data && typeof data === "object" ? data : {}) as Json;
  const detected = asArray(body.detected_items);
  const first = detected[0];
  const box = first ? asArray(first.bounding_boxes)[0] : undefined;
  const items = first ? asArray(first.candidate_items) : asArray(body.items);
  return {
    responseId: asString(body.id) || asString(body.listing_id) || "Unknown",
    queryId: asString(body.query_id),
    detectedItems: first ? detected.length : items.length ? 1 : 0,
    boundingBoxScore: box ? asScore(box.score) : null,
    candidates: items
      .filter((item) => asString(item.id) && typeof item.name === "string")
      .map(parseCandidate),
    raw: data
  };
}

let proxyUnavailable = false;

async function post(url: string, image: Blob, filename: string): Promise<Response> {
  const form = new FormData();
  form.append("query_image", image, filename);
  return fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

// Throws on network/HTTP failure so callers can tell "request failed" apart
// from "no part recognized" (a Recognition without candidates).
export async function recognizeImage(image: Blob, filename = "scan.jpg"): Promise<Recognition> {
  if (!proxyUnavailable) {
    const res = await post(PROXY_URL, image, filename);
    const isJson = res.headers.get("content-type")?.includes("json");
    if (res.ok && isJson) return parseBrickognizeResponse(await res.json());
    // A JSON error came from Brickognize itself; 404/405/HTML means this host
    // has no proxy, so switch to the public endpoint for the rest of the session.
    if (isJson && res.status !== 404 && res.status !== 405) {
      throw new Error(`Brickognize returned HTTP ${res.status}`);
    }
    proxyUnavailable = true;
  }
  const res = await post(PUBLIC_URL, image, filename);
  if (!res.ok) throw new Error(`Brickognize returned HTTP ${res.status}`);
  return parseBrickognizeResponse(await res.json());
}

// --- Result rows (the desktop app's brickognize_results.csv) ---

export const CSV_FIELDS = [
  "Image", "Response ID", "Part ID", "Part Name", "Type", "Part Confidence", "Part Review Required",
  "Part Approval Status", "LEGO Color", "BrickLink Color ID", "Predicted LEGO Color",
  "Predicted BrickLink Color ID", "Color Confidence", "Color Review Required", "Color Approval Status",
  "Color Method", "Estimated RGB", "Color Distance", "Bounding Box Score", "Reference Image URL",
  "BrickLink URL", "Final Review Status", "Final Part ID", "Final Part Name", "Final Part Confidence",
  "Final LEGO Color", "Final BrickLink Color ID", "Part Review Completed", "Color Review Completed",
  "Final BrickLink URL", "Source Photo", "Photo Box"
] as const;

export type ResultRow = Record<string, string>;

export const percent = (value: number) => `${value.toFixed(2)}%`;
export const percentValue = (value: string | undefined): number | null => {
  const parsed = parseFloat(String(value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export interface EstimatedColor {
  rgb: [number, number, number];
  colorId: string;
  name: string;
  distance: number;
}

// Average-RGB fallback (main.py estimate_color + get_closest_lego_color), run
// only when Brickognize does not predict a color. Compares against the review
// palette using the catalog's color values.
export function estimateColor(pixels: Uint8ClampedArray): EstimatedColor | null {
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
    count++;
  }
  if (!count) return null;
  const rgb: [number, number, number] = [Math.floor(r / count), Math.floor(g / count), Math.floor(b / count)];
  let best: EstimatedColor | null = null;
  for (const id of REVIEW_COLOR_IDS) {
    const color = blColor(id);
    const hex = color ? resolveColor(color.rb).hex : "";
    if (!color || !/^#[0-9a-f]{6}$/i.test(hex)) continue;
    const distance = Math.hypot(
      rgb[0] - parseInt(hex.slice(1, 3), 16),
      rgb[1] - parseInt(hex.slice(3, 5), 16),
      rgb[2] - parseInt(hex.slice(5, 7), 16)
    );
    if (!best || distance < best.distance) best = { rgb, colorId: id, name: color.name, distance };
  }
  return best;
}

export function finalReviewStatus(row: ResultRow): string {
  const part = row["Part Review Required"] === "Yes";
  const color = row["Color Review Required"] === "Yes";
  if (part && color) return "Needs Part and Color Review";
  if (part) return "Needs Part Review";
  if (color) return "Needs Color Review";
  return "Ready";
}

// Recompute the Final columns from the current decision
// (review_manager.py sync_reviewed_result_to_csv).
export function syncFinalFields(row: ResultRow): ResultRow {
  const approval = (required: string, completed: string, current: string) =>
    required === "Yes" ? "Pending Review"
      : completed !== "Yes" ? "Auto-Accepted"
      : current === "Corrected" ? "Corrected" : "Confirmed";
  row["Part Approval Status"] = approval(row["Part Review Required"], row["Part Review Completed"], row["Part Approval Status"]);
  row["Color Approval Status"] = approval(row["Color Review Required"], row["Color Review Completed"], row["Color Approval Status"]);
  row["Reference Image URL"] = referenceImageUrl(row["Part ID"], row["BrickLink Color ID"]);
  row["BrickLink URL"] = catalogUrl(row["Part ID"], row["BrickLink Color ID"], row["BrickLink URL"]);
  row["Final Review Status"] = finalReviewStatus(row);
  row["Final Part ID"] = row["Part ID"];
  row["Final Part Name"] = row["Part Name"];
  row["Final Part Confidence"] = row["Part Confidence"];
  row["Final LEGO Color"] = row["LEGO Color"];
  row["Final BrickLink Color ID"] = row["BrickLink Color ID"];
  row["Final BrickLink URL"] = row["BrickLink URL"];
  return row;
}

// Build one result row from a recognition (main.py identify_part). Returns
// null when Brickognize recognized nothing.
export function buildResultRow(
  image: string,
  recognition: Recognition,
  fallbackColor: EstimatedColor | null,
  source: { photo?: string; box?: number } = {}
): ResultRow | null {
  const best = recognition.candidates[0];
  if (!best) return null;

  let colorName = "Unknown", colorId = "", colorConfidence = 0, method = "", estimatedRgb = "", distance = "";
  const predicted = best.colors[0];
  if (predicted) {
    colorName = predicted.name;
    colorId = predicted.colorId || blColorByName(predicted.name)?.id || "";
    colorConfidence = predicted.score;
    method = "Brickognize Color Prediction";
  } else if (fallbackColor) {
    colorName = fallbackColor.name;
    colorId = fallbackColor.colorId;
    colorConfidence = Math.max(0, 100 - fallbackColor.distance / 3);
    method = "Average RGB Fallback";
    estimatedRgb = `(${fallbackColor.rgb.join(", ")})`;
    distance = String(fallbackColor.distance);
  }

  const partReview = best.score < PART_REVIEW_THRESHOLD ? "Yes" : "No";
  const colorReview = colorConfidence < COLOR_REVIEW_THRESHOLD ? "Yes" : "No";
  return syncFinalFields({
    "Image": image,
    "Response ID": recognition.responseId,
    "Part ID": best.partId,
    "Part Name": best.name,
    "Type": best.type,
    "Part Confidence": percent(best.score),
    "Part Review Required": partReview,
    "Part Approval Status": "",
    "LEGO Color": colorName,
    "BrickLink Color ID": colorId,
    "Predicted LEGO Color": colorName,
    "Predicted BrickLink Color ID": colorId,
    "Color Confidence": percent(colorConfidence),
    "Color Review Required": colorReview,
    "Color Approval Status": "",
    "Color Method": method,
    "Estimated RGB": estimatedRgb,
    "Color Distance": distance,
    "Bounding Box Score": recognition.boundingBoxScore === null ? "" : percent(recognition.boundingBoxScore),
    "Reference Image URL": "",
    "BrickLink URL": best.bricklinkUrl || "N/A",
    "Part Review Completed": "No",
    "Color Review Completed": "No",
    "Source Photo": source.photo ?? "",
    "Photo Box": source.box ? String(source.box) : ""
  });
}

// A piece added by hand (shelf "+" or Dig Mode "Found") so the CSV keeps one
// row per physical piece, which is how the verification app counts quantities.
export function buildManualRow(image: string, partId: string, partName: string, colorId: string): ResultRow {
  const color = blColor(colorId);
  return syncFinalFields({
    "Image": image,
    "Response ID": "",
    "Part ID": partId,
    "Part Name": partName,
    "Type": "part",
    "Part Confidence": "",
    "Part Review Required": "No",
    "Part Approval Status": "Confirmed",
    "LEGO Color": color?.name ?? "Unknown",
    "BrickLink Color ID": colorId,
    "Predicted LEGO Color": "",
    "Predicted BrickLink Color ID": "",
    "Color Confidence": "",
    "Color Review Required": "No",
    "Color Approval Status": "Confirmed",
    "Color Method": "Manual Entry",
    "Estimated RGB": "",
    "Color Distance": "",
    "Bounding Box Score": "",
    "Reference Image URL": "",
    "BrickLink URL": "N/A",
    "Part Review Completed": "Yes",
    "Color Review Completed": "Yes",
    "Source Photo": "",
    "Photo Box": ""
  });
}

export const ALL_BL_COLOR_IDS = BL_COLORS.map((color) => color.id);
