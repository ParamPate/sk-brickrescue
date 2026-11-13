import { expect, test } from "vitest";
import { findPhotoParts } from "./photoParts";

test("separates colored and neutral pieces and ignores a dark frame edge", () => {
  const width = 100;
  const height = 100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (y < 4 || (x >= 60 && x < 75 && y >= 55 && y < 70)) {
        data.fill(70, i, i + 3);
      } else if (x >= 20 && x < 30 && y >= 10 && y < 20) {
        data.set([255, 210, 40], i);
      }
    }
  }
  expect(findPhotoParts({ data, width, height } as ImageData).map(({ left, top, right, bottom }) =>
    [left, top, right, bottom]
  )).toEqual([[20, 10, 29, 19], [60, 55, 74, 69]]);
});
