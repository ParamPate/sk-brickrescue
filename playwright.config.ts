import { defineConfig, devices } from "@playwright/test";

// E2E suite (TASK-011): runs against the Vite dev server with a fake camera
// device, so the full Start → Scan → Radar → Dig Mode flow is exercised without
// real hardware. The Brickognize API is mocked per test via page.route().
// Requires a generated catalog in public/catalog/ (npm run catalog).
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5199",
    trace: "retain-on-failure",
    permissions: ["camera"],
    launchOptions: {
      // Deterministic synthetic camera stream instead of real hardware
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream"
      ]
    }
  },
  projects: [
    {
      name: "chromium-mobile",
      use: { ...devices["Pixel 7"], defaultBrowserType: "chromium" }
    }
  ],
  webServer: {
    command: "npx vite --port 5199 --strictPort",
    url: "http://localhost:5199",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
