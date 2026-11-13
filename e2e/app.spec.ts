import { test, expect, type Page } from "@playwright/test";

// Full user flow against the real generated catalog with a fake camera device.
// Only the Brickognize API is mocked — everything else runs like production.

const SCANNED_PART = {
  id: "3001",
  name: "Brick 2 x 4",
  score: "0.95",
  img_url: "https://cdn.rebrickable.com/media/parts/photos/1/3001-1-large.jpg"
};

async function mockBrickognize(page: Page, items: unknown[] = [SCANNED_PART]) {
  await page.route("https://api.brickognize.com/**", (route) =>
    route.fulfill({ json: { items } })
  );
}

async function enterScanner(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start Camera" }).click();
  // Fake camera device: wait until the stream is live (video shown, HUD hint visible)
  await expect(page.locator("video.camera-video:not(.hidden)")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".hud-hint")).toContainText("Tap to scan");
}

test("opens the branded scanner directly with the camera off", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "SK Brickhouse" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan Photo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
  await expect(page.locator("video.camera-video")).toBeHidden();
});

test("tap-to-scan adds the recognized part to the Found Shelf and populates the radar (REQ-RAD-003/004/005)", async ({ page }) => {
  await mockBrickognize(page);
  await enterScanner(page);

  await page.locator(".scanner-viewport").click({ position: { x: 150, y: 150 } });

  // Recognized part lands on the Found Shelf with its catalogue name
  await expect(page.locator(".found-item-card")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".found-item-name")).toHaveText("Brick 2 x 4");

  // Set Radar shows at most the top 3 matches once the catalog index is loaded
  await expect(page.locator(".radar-set-card").first()).toBeVisible({ timeout: 20_000 });
  expect(await page.locator(".radar-set-card").count()).toBeLessThanOrEqual(3);
});

test("failed recognition surfaces distinguishable HUD feedback (REQ-SYS-005)", async ({ page }) => {
  await mockBrickognize(page, []); // API answers, but recognizes nothing
  await enterScanner(page);

  await page.locator(".scanner-viewport").click({ position: { x: 150, y: 150 } });
  await expect(page.locator(".hud-hint")).toContainText("No part recognized", { timeout: 10_000 });
  await expect(page.locator(".found-item-card")).toHaveCount(0);
});

test("excavation mode: unearth boosts progress, found badge un-marks, set stays open (REQ-RAD-006/007)", async ({ page }) => {
  await mockBrickognize(page);
  await enterScanner(page);

  // Populate the radar via color analysis of the fake camera stream
  await expect(page.locator(".radar-set-card").first()).toBeVisible({ timeout: 20_000 });
  await page.locator(".radar-set-card").first().click();

  // Dig panel with hero, progress gauge and found-first checklist
  await expect(page.locator(".dig-panel")).toBeVisible();
  await expect(page.locator(".dig-progress-header")).toContainText("Key artifacts unearthed");
  const markFoundButtons = page.locator(".btn-action", { hasText: "Found" });
  await expect(markFoundButtons.first()).toBeVisible({ timeout: 15_000 });

  // Mark one part as found → it flips to the green Found state; the set stays open
  // even though the re-match may change the top 3 (FIND-033 regression)
  await markFoundButtons.first().click();
  await expect(page.locator(".badge-found").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".dig-panel")).toBeVisible();

  // Found is a toggle: un-marking returns the part to the missing state
  const foundCount = await page.locator(".badge-found").count();
  await page.locator(".badge-found").first().click();
  await expect(page.locator(".badge-found")).toHaveCount(foundCount - 1, { timeout: 10_000 });
  await expect(page.locator(".dig-panel")).toBeVisible();
});

test("Reset scan clears search progress", async ({ page }) => {
  await mockBrickognize(page);
  await enterScanner(page);

  await page.locator(".scanner-viewport").click({ position: { x: 150, y: 150 } });
  await expect(page.locator(".found-item-card")).toHaveCount(1, { timeout: 10_000 });

  await page.getByRole("button", { name: "Reset scan" }).click();
  await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
  await expect(page.locator(".found-item-card")).toHaveCount(0);
  await expect(page.locator(".found-items-empty")).toBeVisible();
});

test("scanned bricks with long names never overflow the page horizontally (FIND-047)", async ({ page }) => {
  // Return a DIFFERENT part on each call so scans don't dedupe — fills the shelf past its width.
  let n = 0;
  await page.route("https://api.brickognize.com/**", (route) => {
    n += 1;
    route.fulfill({
      json: {
        items: [{ id: `300${n}`, name: `Test Brick Number ${n} Long Name`, score: "0.9",
          img_url: "https://cdn.rebrickable.com/media/parts/photos/1/3001-1-large.jpg" }]
      }
    });
  });
  await enterScanner(page);

  for (let i = 1; i <= 4; i++) {
    await page.locator(".scanner-viewport").click({ position: { x: 150, y: 150 } });
    await expect(page.locator(".found-item-card")).toHaveCount(i, { timeout: 10_000 });
  }

  // The mobile frame must fit the viewport and the page must not scroll sideways,
  // even though the shelf itself scrolls horizontally internally.
  const { winW, docScrollW, appW } = await page.evaluate(() => ({
    winW: window.innerWidth,
    docScrollW: document.documentElement.scrollWidth,
    appW: Math.round(document.querySelector(".app-container")!.getBoundingClientRect().width)
  }));
  expect(appW).toBeLessThanOrEqual(winW);
  expect(docScrollW).toBeLessThanOrEqual(winW);
});

test("photo scanning works with camera access denied", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Camera denied", "NotAllowedError");
    };
  });
  await mockBrickognize(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();

  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 100;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 100, 100);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("invalid image")
  });
  await expect(page.getByRole("status")).toContainText("Could not read that photo");
  await input.setInputFiles({
    name: "brick.png",
    mimeType: "image/png",
    buffer: Buffer.from(image, "base64")
  });

  await expect(page.locator(".found-item-name")).toHaveText("Brick 2 x 4");
  await expect(page.locator(".color-bar")).toHaveCount(1);
  await expect(page.locator(".radar-set-card").first()).toBeVisible();
});
