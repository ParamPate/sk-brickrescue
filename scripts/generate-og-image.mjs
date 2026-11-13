// Renders public/og-image.png (1200x630) for social sharing previews.
// Reproducible via: node scripts/generate-og-image.mjs (requires @playwright/test chromium)
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'Poppins'; font-weight: 800; src: url('file://${root}/public/fonts/poppins-800-latin.woff2') format('woff2'); }
  @font-face { font-family: 'Poppins'; font-weight: 300; src: url('file://${root}/public/fonts/poppins-300-latin.woff2') format('woff2'); }
  @font-face { font-family: 'Mulish'; font-weight: 400; src: url('file://${root}/public/fonts/mulish-400-latin.woff2') format('woff2'); }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background: radial-gradient(circle at 50% 35%, rgba(245,179,1,0.10) 0%, rgba(16,22,42,0) 55%), #10162A;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: 'Mulish', sans-serif; color: #C7D0E0; gap: 28px;
  }
  .logo-badge {
    width: 148px; height: 148px; border-radius: 36px;
    background: rgba(255,255,255,0.02); border: 2px solid #232B42;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 60px rgba(245,179,1,0.25);
  }
  .logo-badge svg { width: 84px; height: 84px; color: #F5B301; }
  h1 { font-family: 'Poppins', sans-serif; font-weight: 800; font-size: 88px; color: #fff; letter-spacing: -1px; }
  h1 span { font-weight: 300; color: #F5B301; }
  p { font-size: 30px; max-width: 760px; text-align: center; line-height: 1.5; }
</style></head><body>
  <div class="logo-badge">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/>
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>
    </svg>
  </div>
  <h1>Brick<span>Relic</span></h1>
  <p>AI LEGO® brick scanner &amp; set identifier — point your camera at mixed bricks and discover which sets they belong to.</p>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: "networkidle" });
await page.screenshot({ path: join(root, "public", "og-image.png") });
await browser.close();
console.log("public/og-image.png written (1200x630)");
