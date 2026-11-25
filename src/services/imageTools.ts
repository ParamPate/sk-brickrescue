import { findPhotoParts } from "./photoParts";
import { estimateColor, type EstimatedColor } from "./recognition";

const DETECTION_SIDE = 800;

// Decode an image file onto a white canvas, scaled so the long side is at most maxSide.
export async function fileToCanvas(file: Blob, maxSide = 2048): Promise<HTMLCanvasElement> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D context from canvas");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    image.close();
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.9): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode image"))), "image/jpeg", quality)
  );
}

// Detect separate pieces on a downscaled copy (shortcut: plain, pale background).
export function detectPieces(canvas: HTMLCanvasElement) {
  const detection = document.createElement("canvas");
  const scale = Math.min(1, DETECTION_SIDE / Math.max(canvas.width, canvas.height));
  detection.width = Math.max(1, Math.round(canvas.width * scale));
  detection.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = detection.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get 2D context for detecting pieces");
  ctx.drawImage(canvas, 0, 0, detection.width, detection.height);
  return { parts: findPhotoParts(ctx.getImageData(0, 0, detection.width, detection.height)), width: detection.width, height: detection.height };
}

// Fallback color for a single-piece image: average of the largest detected
// piece, or of the whole image when nothing separates from the background.
export function estimateImageColor(canvas: HTMLCanvasElement): EstimatedColor | null {
  const { parts } = detectPieces(canvas);
  const largest = parts.reduce<(typeof parts)[number] | null>(
    (best, part) => (!best || part.pixels.length > best.pixels.length ? part : best), null);
  if (largest) return estimateColor(largest.pixels);
  const sample = document.createElement("canvas");
  sample.width = 64;
  sample.height = 64;
  const ctx = sample.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, 64, 64);
  return estimateColor(ctx.getImageData(0, 0, 64, 64).data);
}

export const fileStem = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_") || "image";
