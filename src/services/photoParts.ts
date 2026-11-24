export type Rgb = [number, number, number];

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
// Local background = box blur this share of the longer side wide; wide enough to skip over a piece.
const BACKGROUND_RADIUS_SHARE = 0.05;
const LIGHTER = 24; // pale pieces on a darker table
// Soft shadows stay above 72% of the local background; Light Bluish Gray on white sits near 68%.
const DARKER_SHARE = 0.28;
const MIN_DARKER = 24;
const SATURATED = 0.42;
const CHROMA_SHIFT = 0.06; // saturated wood/cloth matches its local background's tint, a piece doesn't

// shortcut: per-channel median assumes the background covers most of the frame; sample a border ring if users fill the frame.
export function backgroundColor({ data }: ImageData): Rgb {
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < data.length; i += 4) {
    histograms[0][data[i]]++;
    histograms[1][data[i + 1]]++;
    histograms[2][data[i + 2]]++;
  }
  const half = data.length / 8;
  return histograms.map((histogram) => {
    let seen = 0;
    for (let value = 0; value < 256; value++) {
      seen += histogram[value];
      if (seen >= half) return value;
    }
    return 255;
  }) as Rgb;
}

// Per-pixel mean RGB of the surrounding square (integral images), skipping `exclude`d pixels;
// windows with nothing left fall back to the frame's median color.
function localBackground(image: ImageData, exclude?: Uint8Array) {
  const { data, width, height } = image;
  const radius = Math.max(16, Math.round(Math.max(width, height) * BACKGROUND_RADIUS_SHARE));
  const stride = width + 1;
  const sums = [0, 1, 2, 3].map(() => new Float64Array(stride * (height + 1)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y + 1) * stride + x + 1;
      const use = exclude?.[y * width + x] ? 0 : 1;
      for (let c = 0; c < 4; c++) {
        const value = c === 3 ? use : data[(y * width + x) * 4 + c] * use;
        sums[c][at] = value + sums[c][at - 1] + sums[c][at - stride] - sums[c][at - stride - 1];
      }
    }
  }
  const fallback = backgroundColor(image);
  const means = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius), bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
      const box = (s: Float64Array) =>
        s[bottom * stride + right] - s[top * stride + right] - s[bottom * stride + left] + s[top * stride + left];
      const count = box(sums[3]);
      for (let c = 0; c < 3; c++) {
        means[(y * width + x) * 3 + c] = count ? box(sums[c]) / count : fallback[c];
      }
    }
  }
  return means;
}

// The plain blur is pulled toward the pieces it covers, which leaves bright halos round dark pieces;
// re-averaging without the first-pass pieces gives the table alone.
function pieceFreeBackground(image: ImageData) {
  const first = foregroundMask(image, localBackground(image));
  return localBackground(image, dilate(first, image.width, image.height, 2));
}

// Foreground = clearly lighter or darker than the local background, or saturated with a tint the
// background doesn't share. Neutral pixels only slightly darker than their surroundings are shadows.
export function foregroundMask(image: ImageData, background = pieceFreeBackground(image)) {
  const { data } = image;
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const br = background[i * 3], bg = background[i * 3 + 1], bb = background[i * 3 + 2];
    const local = luma(br, bg, bb);
    const contrast = luma(r, g, b) - local;
    const brightest = Math.max(r, g, b);
    const saturated = brightest >= 40 && (brightest - Math.min(r, g, b)) / brightest >= SATURATED;
    const sum = r + g + b || 1, backgroundSum = br + bg + bb || 1;
    const chromaShift = Math.abs(r / sum - br / backgroundSum) + Math.abs(g / sum - bg / backgroundSum) +
      Math.abs(b / sum - bb / backgroundSum);
    mask[i] = Number(contrast >= LIGHTER || contrast <= -Math.max(MIN_DARKER, local * DARKER_SHARE) ||
      (saturated && (chromaShift >= CHROMA_SHIFT || Math.abs(contrast) >= 9)));
  }
  return mask;
}

// Square-kernel dilation, separable with running counts. Erosion = dilation of the inverse;
// pixels outside the frame then count as foreground, so pieces cut by the edge still reach it.
function dilate(mask: Uint8Array, width: number, height: number, radius: number) {
  const pass = (source: Uint8Array, lines: number, length: number, step: number, lineStep: number) => {
    const out = new Uint8Array(source.length);
    for (let line = 0; line < lines; line++) {
      const base = line * lineStep;
      let count = 0;
      for (let i = 0; i < Math.min(radius, length); i++) count += source[base + i * step];
      for (let i = 0; i < length; i++) {
        if (i + radius < length) count += source[base + (i + radius) * step];
        if (i - radius - 1 >= 0) count -= source[base + (i - radius - 1) * step];
        out[base + i * step] = Number(count > 0);
      }
    }
    return out;
  };
  return pass(pass(mask, height, width, 1, width), width, height, width, 1);
}
const invert = (mask: Uint8Array) => mask.map((on) => 1 - on);
const erode = (mask: Uint8Array, width: number, height: number, radius: number) =>
  invert(dilate(invert(mask), width, height, radius));

// shortcut: thresholding expects separated pieces on a plain surface; use an instance detector for clutter or touching parts.
export function findPhotoParts(image: ImageData) {
  const { data, width, height } = image;
  // Opening drops grain/noise specks and the thin bridges where neighbouring pieces touch.
  const local = pieceFreeBackground(image);
  const solid = dilate(erode(foregroundMask(image, local), width, height, 1), width, height, 1);
  // Closing fills glare and prints inside a piece so it isn't split into several boxes.
  const mask = erode(dilate(solid, width, height, 2), width, height, 2);

  const parts = [];
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    let left = width, top = height, right = 0, bottom = 0;
    let count = 0;
    function enqueue(index: number) {
      if (mask[index]) {
        mask[index] = 0;
        queue[count++] = index;
      }
    }

    enqueue(start);
    for (let cursor = 0; cursor < count; cursor++) {
      const index = queue[cursor];
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      if (x > 0) enqueue(index - 1);
      if (x < width - 1) enqueue(index + 1);
      if (y > 0) enqueue(index - width);
      if (y < height - 1) enqueue(index + width);
    }
    // Too small = noise; too large = a lit patch of table, not a piece.
    if (count < mask.length * 0.0002 || count > mask.length * 0.12 || left === 0 || top === 0 ||
      right === width - 1 || bottom === height - 1) continue;

    // Only pixels the detector actually saw as plastic; closing-filled ones are background-blended.
    let kept = 0;
    const pixels = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      if (!solid[queue[i]]) continue;
      const source = queue[i] * 4;
      pixels.set(data.subarray(source, source + 4), (kept++) * 4);
    }
    // Background around the piece, for white balance under uneven light.
    const center = (Math.round((top + bottom) / 2) * width + Math.round((left + right) / 2)) * 3;
    const background: Rgb = [local[center], local[center + 1], local[center + 2]];
    parts.push({ left, top, right, bottom, pixels: pixels.subarray(0, kept * 4), background });
  }
  return parts;
}
