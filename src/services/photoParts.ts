// shortcut: thresholding expects separated pieces on a plain, pale background; use an instance detector for clutter or touching parts.
export function findPhotoParts({ data, width, height }: ImageData) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const brightest = Math.max(r, g, b);
    const darkest = Math.min(r, g, b);
    mask[i] = Number(0.299 * r + 0.587 * g + 0.114 * b <= 125 ||
      (brightest > 0 && (brightest - darkest) * 3 >= brightest));
  }

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
    if (count < mask.length * 0.0004 || left === 0 || top === 0 ||
      right === width - 1 || bottom === height - 1) continue;

    const pixels = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      const source = queue[i] * 4;
      pixels.set(data.subarray(source, source + 4), i * 4);
    }
    parts.push({ left, top, right, bottom, pixels });
  }
  return parts;
}
