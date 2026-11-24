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

test("a soft shadow between touching pieces does not merge them", () => {
  const width = 100;
  const height = 60;
  // Dim, warm-lit table (cast removed by the background estimate).
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([170, 155, 130, 255], i);
  const paint = (x0: number, x1: number, rgb: number[]) => {
    for (let y = 20; y < 40; y++) for (let x = x0; x < x1; x++) data.set(rgb, (y * width + x) * 4);
  };
  paint(20, 40, [88, 42, 18]); // reddish-brown hat
  paint(40, 50, [134, 122, 103]); // shadow: same tint, ~79% brightness
  paint(50, 70, [200, 30, 20]); // red brick
  expect(findPhotoParts({ data, width, height } as ImageData).map(({ left, right }) => [left, right]))
    .toEqual([[20, 39], [50, 69]]);
});
