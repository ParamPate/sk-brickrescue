import { idbDelete, idbGet, idbSet } from "./idb";
import {
  buildManualRow,
  buildResultRow,
  parseBrickognizeResponse,
  recognizeImage,
  type EstimatedColor,
  type PartCandidate,
  type Recognition,
  type ResultRow
} from "./recognition";
import type { ReviewLog } from "./reviews";

// The active recognition batch: one record per photographed piece, mirroring
// the desktop app's results folder (CSV rows, raw API responses, review log).
// Pieces are identified several at a time, identical images reuse their saved
// Brickognize response, and the batch autosaves to IndexedDB so a reload keeps
// the work.

const CONCURRENCY = 4;
const SAVE_DELAY_MS = 400;

export type PieceStatus = "queued" | "processing" | "done" | "nomatch" | "failed";

export interface PieceRecord {
  id: string;
  image: string; // unique name; the CSV "Image" key
  photoId?: string;
  box?: number;
  cropUrl: string;
  status: PieceStatus;
  cached: boolean; // reused a saved response for an identical image
  manual: boolean;
  isNew: boolean; // identified during this browser session
  error?: string;
  row: ResultRow | null;
  candidates: PartCandidate[];
  log: ReviewLog;
  // Set-matching override for manual pieces taken from the Rebrickable catalog.
  rb?: { part: string; color: number };
}

export interface PhotoBox { left: number; top: number; width: number; height: number }

export interface PhotoEntry {
  id: string;
  name: string;
  url: string;
  boxes: PhotoBox[];
}

type SavedRecord = Omit<PieceRecord, "cropUrl" | "isNew">;
interface SavedBatch {
  records: SavedRecord[];
  photos: Omit<PhotoEntry, "url">[];
  currentPhotoId: string | null;
  raw: Record<string, unknown>;
  fallback: Record<string, EstimatedColor | null>;
}

export const batch = $state({
  records: [] as PieceRecord[],
  photos: [] as PhotoEntry[],
  currentPhotoId: null as string | null,
  restored: false
});

// Large or binary data stays outside the reactive state.
const cropBlobs = new Map<string, Blob>();
const rawResponses = new Map<string, unknown>();
const fallbackColors = new Map<string, EstimatedColor | null>();
const waiters = new Map<string, (record: PieceRecord) => void>();
const queue: string[] = [];
let active = 0;
let counter = 0;

const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const find = (id: string) => batch.records.find((record) => record.id === id);

export function uniqueImageName(name: string): string {
  const taken = new Set(batch.records.map((record) => record.image));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) if (!taken.has(`${stem}_${n}${ext}`)) return `${stem}_${n}${ext}`;
}

// --- Persistence ---
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

function save() {
  saveTimer = null;
  const records = $state.snapshot(batch.records).map(({ cropUrl: _url, isNew: _new, ...rest }) => rest);
  const ids = new Set(records.map((record) => record.id));
  const data: SavedBatch = {
    records,
    photos: $state.snapshot(batch.photos).map(({ url: _url, ...rest }) => rest),
    currentPhotoId: batch.currentPhotoId,
    raw: Object.fromEntries([...rawResponses].filter(([id]) => ids.has(id))),
    fallback: Object.fromEntries([...fallbackColors].filter(([id]) => ids.has(id)))
  };
  idbSet("batch", data);
}

export const restoreBatch: Promise<void> = (async () => {
  const saved = await idbGet<SavedBatch>("batch");
  if (saved?.records?.length) {
    const blobs = await Promise.all(saved.records.map((record) => idbGet<Blob>(`crop:${record.id}`)));
    const photoBlobs = await Promise.all(saved.photos.map((photo) => idbGet<Blob>(`photo:${photo.id}`)));
    for (const [id, raw] of Object.entries(saved.raw ?? {})) rawResponses.set(id, raw);
    for (const [id, color] of Object.entries(saved.fallback ?? {})) fallbackColors.set(id, color);
    batch.photos = saved.photos.map((photo, index) => ({
      ...photo,
      url: photoBlobs[index] ? URL.createObjectURL(photoBlobs[index]) : ""
    }));
    batch.currentPhotoId = saved.currentPhotoId;
    batch.records = saved.records.map((record, index) => {
      const blob = blobs[index];
      if (blob) cropBlobs.set(record.id, blob);
      const interrupted = record.status === "queued" || record.status === "processing";
      return { ...record, cropUrl: blob ? URL.createObjectURL(blob) : "", isNew: false, status: interrupted ? "queued" : record.status };
    });
    for (const record of batch.records) if (record.status === "queued") queue.push(record.id);
    pump();
  }
  batch.restored = true;
})();

// --- Recognition queue ---
async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    active++;
    identify(id).finally(() => {
      active--;
      pump();
    });
  }
}

async function identify(id: string) {
  const record = find(id);
  const blob = cropBlobs.get(id);
  if (!record || record.status !== "queued") return;
  if (!blob) {
    record.status = "failed";
    record.error = "The image for this piece is no longer available.";
    settle(id);
    return;
  }
  record.status = "processing";
  record.error = undefined;
  try {
    const hash = await sha256(blob);
    let recognition: Recognition;
    const saved = await idbGet<unknown>(`response:${hash}`);
    if (saved) {
      recognition = parseBrickognizeResponse(saved);
    } else {
      recognition = await recognizeImage(blob, record.image);
      if (recognition.candidates.length) idbSet(`response:${hash}`, recognition.raw);
    }
    const current = find(id);
    if (!current) return; // removed while identifying
    rawResponses.set(id, recognition.raw);
    current.cached = !!saved;
    current.isNew = !saved;
    current.candidates = recognition.candidates;
    const photo = batch.photos.find((entry) => entry.id === current.photoId);
    current.row = buildResultRow(current.image, recognition, fallbackColors.get(id) ?? null, { photo: photo?.name, box: current.box });
    current.status = current.row ? "done" : "nomatch";
  } catch (err) {
    console.error("Brickognize request failed:", err);
    const current = find(id);
    if (current) {
      current.status = "failed";
      current.error = (err as Error)?.name === "TimeoutError"
        ? "Brickognize did not answer in time."
        : "Brickognize could not be reached.";
    }
  }
  settle(id);
}

function settle(id: string) {
  scheduleSave();
  const record = find(id);
  const resolve = waiters.get(id);
  waiters.delete(id);
  if (record && resolve) resolve(record);
}

// --- Mutations ---
export function addPhoto(name: string, preview: Blob, boxes: PhotoBox[]): string {
  const id = newId();
  idbSet(`photo:${id}`, preview);
  batch.photos.push({ id, name, url: URL.createObjectURL(preview), boxes });
  batch.currentPhotoId = id;
  scheduleSave();
  return id;
}

// Queue one piece image; resolves with the record once it has been identified.
export function addPiece(options: {
  image: string;
  blob: Blob;
  photoId?: string;
  box?: number;
  fallbackColor?: EstimatedColor | null;
}): Promise<PieceRecord> {
  const id = newId();
  cropBlobs.set(id, options.blob);
  fallbackColors.set(id, options.fallbackColor ?? null);
  idbSet(`crop:${id}`, options.blob);
  batch.records.push({
    id,
    image: uniqueImageName(options.image),
    photoId: options.photoId,
    box: options.box,
    cropUrl: URL.createObjectURL(options.blob),
    status: "queued",
    cached: false,
    manual: false,
    isNew: false,
    row: null,
    candidates: [],
    log: {}
  });
  const done = new Promise<PieceRecord>((resolve) => waiters.set(id, resolve));
  queue.push(id);
  pump();
  return done;
}

export function retryPiece(id: string) {
  const record = find(id);
  if (!record || (record.status !== "failed" && record.status !== "nomatch")) return;
  record.status = "queued";
  queue.push(id);
  pump();
}

export function retryAllFailed() {
  for (const record of batch.records) if (record.status === "failed") retryPiece(record.id);
}

let manualCount = 0;
export function addManualPiece(partId: string, partName: string, colorId: string, rb?: { part: string; color: number }) {
  const image = uniqueImageName(`manual_${String(++manualCount).padStart(3, "0")}`);
  batch.records.push({
    id: newId(),
    image,
    cropUrl: "",
    status: "done",
    cached: false,
    manual: true,
    isNew: true,
    row: buildManualRow(image, partId, partName, colorId),
    candidates: [],
    log: {},
    rb
  });
  scheduleSave();
}

// Imported CSV rows (a saved batch from this app or the desktop app).
export function addImportedRows(rows: ResultRow[]) {
  for (const row of rows) {
    const image = uniqueImageName(row["Image"] || "imported");
    batch.records.push({
      id: newId(),
      image,
      cropUrl: "",
      status: "done",
      cached: true,
      manual: false,
      isNew: false,
      row: { ...row, "Image": image },
      candidates: [],
      log: {}
    });
  }
  scheduleSave();
}

export function removePieces(ids: string[]) {
  const remove = new Set(ids);
  for (const id of remove) {
    const record = find(id);
    if (record?.cropUrl) URL.revokeObjectURL(record.cropUrl);
    cropBlobs.delete(id);
    rawResponses.delete(id);
    fallbackColors.delete(id);
    idbDelete(`crop:${id}`);
  }
  batch.records = batch.records.filter((record) => !remove.has(record.id));
  scheduleSave();
}

export function clearBatch() {
  queue.length = 0;
  for (const record of batch.records) {
    if (record.cropUrl) URL.revokeObjectURL(record.cropUrl);
    idbDelete(`crop:${record.id}`);
  }
  for (const photo of batch.photos) {
    if (photo.url) URL.revokeObjectURL(photo.url);
    idbDelete(`photo:${photo.id}`);
  }
  for (const resolve of waiters.values()) resolve({ status: "failed" } as PieceRecord);
  waiters.clear();
  cropBlobs.clear();
  rawResponses.clear();
  fallbackColors.clear();
  batch.records = [];
  batch.photos = [];
  batch.currentPhotoId = null;
  scheduleSave();
}

export const getRawResponse = (id: string) => rawResponses.get(id);
export const getCropBlob = (id: string) => cropBlobs.get(id);
export const getFallbackColor = (id: string) => fallbackColors.get(id) ?? null;

// Batch counters (gui.py update_batch_summary).
export function summarize(records: PieceRecord[]) {
  let ready = 0, verified = 0, partCheck = 0, colorCheck = 0, pending = 0, unidentified = 0, isNew = 0;
  for (const record of records) {
    if (record.status === "queued" || record.status === "processing") pending++;
    else if (record.status !== "done") unidentified++;
    if (record.isNew && record.status === "done" && !record.manual) isNew++;
    const row = record.row;
    if (!row || record.status !== "done") continue;
    const part = row["Part Review Required"] === "Yes";
    const color = row["Color Review Required"] === "Yes";
    if (part) partCheck++;
    if (color) colorCheck++;
    if (!part && !color) ready++;
    if (row["Part Review Completed"] === "Yes" && row["Color Review Completed"] === "Yes") verified++;
  }
  return { total: records.length, ready, verified, partCheck, colorCheck, pending, unidentified, isNew };
}
