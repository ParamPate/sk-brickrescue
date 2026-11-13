<div align="center">

<img src="./public/logo.svg" width="88" height="88" alt="SK Brickhouse Logo" />

# SK Brickhouse

[![Svelte 5](https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)](./LICENSE.md)
[![PRs](https://img.shields.io/badge/PRs-not_accepted-lightgrey)](./CONTRIBUTING.md)

Identify scattered LEGO® bricks and discover matching sets using color analysis and AI object recognition.<br />
By analyzing dominant color distributions and scanning diagnostic key parts, the app calculates and ranks the most likely matching brick sets in real time.

</div>

---

SK Brickhouse is a browser-based LEGO® part scanner and set finder. Param Patel developed the SK Brickhouse photo-scanning workflow and interface, building on [BrickRelic by frank3ling](https://github.com/frank3ling/brick-relic).

## ✨ Features

- **Photo scanning**: Upload a photo to detect and crop multiple pieces. Review numbered boxes and unidentified crops, correct colors, and adjust quantities.
- 📸 **Live Camera Feed & Tap-to-Scan**: Use your smartphone's rear camera (with an automatic webcam fallback on laptops). Tap the viewfinder to freeze a frame and classify the part via the Brickognize API.
- 🎨 **Color Profile Analysis**: Real-time extraction of the dominant color distribution of the scanned brick heap, used as weights for matching.
- 🎯 **Set Radar**: A dynamic, live-ranked probability list of potential matching sets, re-sorted after every color scan and part detection.
- ⛏️ **Excavation Mode (Dig Mode)**: Guided search for a specific set with an interactive checklist of its diagnostic key parts — mark parts as "Uncovered" to boost the set's match score.
- 🗄️ **Fully Client-Side**: All catalog matching runs in-memory in the browser. No backend server, no database, no tracking. Part recognition sends individual crops or camera captures to the Brickognize API.

---

## 🛠️ Tech Stack

- **Frontend**: Svelte 5 (Runes), Vite, TypeScript, vanilla CSS (design tokens; self-hosted `Poppins` / `Mulish` / `JetBrains Mono` fonts — no third-party CDN requests).
- **Data Engine**: Completely client-side in-memory queries over compiled JSON catalog files (`public/catalog/`): a lightweight set index for scoring plus lazily loaded per-set part lists. No backend and no database.
- **Catalog Data**: Complete brick catalog (sets and diagnostic parts released since 1980) compiled from Rebrickable database dumps at build time.
- **Object Recognition API**: Public Brickognize API (`api.brickognize.com`) for classifying brick parts.
- **Deployment**: Static SPA on Vercel, optionally protected with Basic Authentication via Edge Middleware.

---

## 🚀 Local Setup & Development

### 1. Clone Repository & Install Dependencies
```bash
git clone https://github.com/ParamPate/sk-brickrescue.git
cd sk-brickrescue
npm ci
```
*Note: The repository's `.npmrc` enables `legacy-peer-deps` automatically to resolve peer dependency warnings from bleeding-edge Vite versions — no extra flag needed.*

### 2. Generate the Catalog Data
The catalog is **not** checked into the repository (`public/catalog/` is git-ignored), so you must generate it once before the app can run. The generator downloads the compressed Rebrickable CSV dumps, filters them (keeping sets since 1980 and diagnostic key parts with a rarity threshold ≥ 10 %), and compiles them into optimized JSON files inside `public/catalog/`:
```bash
npm run catalog
```
This step also runs automatically as part of `npm run build`.

### 3. Start the Local Development Server
```bash
npm run dev
```

> **Environment variables**: None are required to run the app locally. The only variable is the optional `BASIC_AUTH_PASSWORD`, used solely by the Vercel deployment's Edge Middleware (see below). A template is provided in `.env.example`.

---

## ☁️ Deployment & Vercel Middleware

If you do not have your own hosting infrastructure (like a custom web server), you can deploy the application directly to **Vercel** and protect it using Basic Authentication at the edge.

For a step-by-step guide on deploying to Vercel and setting up the password protection, please see **[VERCEL.md](./docs/VERCEL.md)**.

---

## 🧪 Quality Gate (Tests & Linting)

A local Git pre-commit hook enforces linting and unit tests before every commit:

*   **Linter**: `npm run lint` (oxlint)
*   **Unit Tests**: `npm run test` (vitest)

Additional checks are available on demand:

*   **Svelte Typecheck**: `npm run check` (svelte-check)
*   **Test Coverage**: `npm run coverage` (vitest coverage report)

---

## ❓ FAQ

**Does it work offline?**
Set matching is fully client-side and works offline once the catalog is loaded. Only the tap-to-scan part recognition requires an internet connection, because it calls the Brickognize API.

**Where does the catalog data come from?**
From the public [Rebrickable](https://rebrickable.com) database dumps, downloaded and compiled at build time. The catalog itself is never checked into the repository.

**What happens to my camera images?**
The live camera feed is analyzed locally in your browser for color extraction. Only when you tap to scan is that single frozen frame sent to the Brickognize API for part recognition — nothing is stored or tracked.

**Why does the camera not start?**
Browsers only allow camera access in a secure context: use `https://` (or `localhost` during development) and grant the camera permission when prompted.

---

## 🙌 Credits

- **Catalog data and part images** courtesy of [Rebrickable](https://rebrickable.com) — used with attribution, not affiliated.
- **Part recognition** powered by the public [Brickognize](https://brickognize.com) API — not affiliated.

---

## ⚖️ License & Contributing

- **License**: This project is licensed under the **GNU Affero General Public License, Version 3 (AGPL-3.0)** (see [LICENSE.md](./LICENSE.md)). The source code is public and open source. If you modify the software and run it on a network to offer service to users (SaaS), you are legally required to make the full source code of your modified version available to those users.
- **Contributing**: We do **not** accept external contributions or pull requests. The project is maintained solely by the owner. Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for more details.

---

## ⚠️ Trademark Legal Disclaimer

SK Brickhouse is an unofficial, independent fan project. **LEGO®** is a trademark of the LEGO Group of companies. This software, project, and its developers are **NOT** affiliated with, authorized, sponsored, associated, or endorsed by the LEGO Group. All trademark references are used strictly for compatibility description purposes.
