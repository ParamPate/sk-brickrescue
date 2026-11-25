import { test, expect, type Page } from "@playwright/test";

// Full user flow against the real generated catalog with a fake camera device.
// Only Brickognize (its public endpoint and the same-origin /api/brickognize
// proxy) is mocked — everything else runs like production.

const BRICKOGNIZE = /api\.brickognize\.com|\/api\/brickognize/;

const SCANNED_PART = {
  id: "3001",
  name: "Brick 2 x 4",
  score: "0.95",
  img_url: "https://cdn.rebrickable.com/media/parts/photos/1/3001-1-large.jpg"
};

async function mockBrickognize(page: Page, items: unknown[] = [SCANNED_PART]) {
  await page.route(BRICKOGNIZE, (route) =>
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
  await expect(page.getByRole("button", { name: "Scan Photos" })).toBeVisible();
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

test("excavation mode: counting pieces raises progress, un-counting lowers it, set stays open (REQ-RAD-006/007)", async ({ page }) => {
  await mockBrickognize(page);
  await enterScanner(page);

  // Populate the radar via color analysis of the fake camera stream
  await expect(page.locator(".radar-set-card").first()).toBeVisible({ timeout: 20_000 });
  await page.locator(".radar-set-card").first().click();

  // Dig panel with hero, progress gauge and the set's full inventory
  await expect(page.locator(".dig-panel")).toBeVisible();
  await expect(page.locator(".dig-progress-header")).toContainText("Pieces found:");
  const firstLine = page.locator(".check-item-card").first();
  await expect(firstLine).toBeVisible({ timeout: 15_000 });
  const lineName = await firstLine.locator(".check-item-meta span").nth(1).innerText();
  const line = page.locator(".check-item-card", { hasText: lineName }).first();

  // Count one piece as found; the set stays open even though the re-match may
  // change the top 3 (FIND-033 regression)
  await line.getByRole("button", { name: "Found one more" }).click();
  await expect(line.locator(".check-item-count")).toContainText(/^\s*−?\s*1\//, { timeout: 10_000 });
  await expect(page.locator(".dig-panel")).toBeVisible();

  // Un-counting returns the line to zero found
  await line.getByRole("button", { name: "One fewer found" }).click();
  await expect(line.locator(".check-item-count")).toContainText(/^\s*−?\s*0\//, { timeout: 10_000 });
  await expect(page.locator(".dig-panel")).toBeVisible();
});

test("New batch clears search progress", async ({ page }) => {
  await mockBrickognize(page);
  await enterScanner(page);

  await page.locator(".scanner-viewport").click({ position: { x: 150, y: 150 } });
  await expect(page.locator(".found-item-card")).toHaveCount(1, { timeout: 10_000 });

  await page.getByRole("button", { name: "New batch" }).click();
  await page.getByRole("button", { name: "Discard and start new" }).click();
  await page.getByRole("button", { name: "Discard batch" }).click();
  await expect(page.getByRole("button", { name: "Start Camera" })).toBeVisible();
  await expect(page.locator(".found-item-card")).toHaveCount(0);
  await expect(page.locator(".found-items-empty")).toBeVisible();
});

test("scanned bricks with long names never overflow the page horizontally (FIND-047)", async ({ page }) => {
  // Return a DIFFERENT part on each call so scans don't dedupe — fills the shelf past its width.
  let n = 0;
  await page.route(BRICKOGNIZE, (route) => {
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
  const input = page.locator('.photo-scan input[type="file"]:not([webkitdirectory])');
  await input.setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("invalid image")
  });
  await expect(page.locator(".photo-scan [role=status]")).toContainText("could not be read");
  await input.setInputFiles({
    name: "brick.png",
    mimeType: "image/png",
    buffer: Buffer.from(image, "base64")
  });

  await expect(page.locator(".found-item-name")).toHaveText("Brick 2 x 4");
  await expect(page.locator(".color-bar")).toHaveCount(1);
  await expect(page.locator(".radar-set-card").first()).toBeVisible();
});

test("verify a set: search, load the part list and filter the live report", async ({ page }) => {
  // Mock Rebrickable so the test never uses the real API quota; without an API
  // key the app reads the same set from the local catalog instead.
  await page.route("https://rebrickable.com/api/v3/lego/sets/40611-1/", (route) =>
    route.fulfill({ json: { set_num: "40611-1", name: "Year of the Dragon", year: 2024, num_parts: 3, set_img_url: "" } }));
  await page.route("https://rebrickable.com/api/v3/lego/sets/40611-1/parts/**", (route) =>
    route.fulfill({ json: { next: null, results: [{
      part: { part_num: "15573", name: "Plate Special 1 x 2 Jumper", part_img_url: null, external_ids: { BrickLink: ["15573"] } },
      color: { id: 0, name: "Black", rgb: "05131D", external_ids: { BrickLink: { ext_ids: [11] } } },
      quantity: 3, is_spare: false
    }] } }));
  await page.goto("/");
  await page.getByRole("tab", { name: "Verify set" }).click();
  const search = page.getByRole("combobox", { name: "Set number or name" });
  await search.fill("40611");
  await search.press("Enter");
  await expect(page.locator(".verify-summary")).toContainText("Year of the Dragon", { timeout: 20_000 });
  await expect(page.getByRole("tab", { name: /Missing/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".verify-row").first()).toBeVisible();

  // Counting a piece by hand updates the report immediately
  const firstRow = page.locator(".verify-row").first();
  const before = await page.locator(".verify-tab.tab-missing strong").innerText();
  await firstRow.getByRole("button", { name: "One more" }).click();
  await expect(page.locator(".verify-tab.tab-missing strong")).not.toHaveText(before);
});
