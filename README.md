# SK Brickhouse

Scan a photo of loose LEGO pieces and see which sets they might belong to. The browser finds and crops individual pieces, then sends each crop to Brickognize for a part ID. SK Brickhouse shows the original photo, the parts it identified, and up to three set matches side by side.

## Run it locally

Use Node.js 20.19+ (within the 20.x line) or 22.12+.

```sh
git clone https://github.com/ParamPate/sk-brickrescue.git
cd sk-brickrescue
npm ci
npm run catalog
npm run dev -- --port 5174
```

Open [localhost:5174](http://localhost:5174/). Run the catalog command on a fresh checkout to download Rebrickable data and generate the local JSON files.

## Scan and review

1. Spread the pieces apart on a plain, light surface and take photos. Choose **Scan Photos** to upload one or more photos, **Add Folder** to load a whole folder, or **Start Camera** to scan a live view (tap or press Space). Close-ups of a single piece are sent as one image.
2. Every detected piece appears under **Recognition Results** with its part, color, part confidence and color confidence. Pieces below 80% confidence are marked for a part or color check, like the desktop Part Recognition app. Filter the list by Suggested checks, Part check, Color check, Ready or Unidentified.
3. Click a piece (in the list, on the shelf, or its numbered box on the photo) to review it:
   - compare the photo with the BrickLink catalog image;
   - verify or change the color (limited to the colors BrickLink lists for that part when available);
   - pick another Brickognize candidate when there is one;
   - **Rescan Part** with a camera photo or an uploaded photo, then keep the original or use the rescan;
   - **Approve & Next** (Enter; arrow keys move between pieces), **Open BrickLink**, or **Delete piece**.
4. Export the batch with **Export CSV** (same columns as the desktop `brickognize_results.csv`, ready for the Set Verification app's Brickognize import) or **Export Excel** (Dashboard, Batch Results, Manual Reviews, API Audit, Instructions). **More** also downloads the raw API responses and the review decisions as JSON and imports a results CSV from this app or the desktop app.
5. Select a suggested set to open its full inventory: every part line shows found/needed pieces, missing lines first. Use **+** and **−** to count pieces by hand. When scanned pieces match the set's parts in another color (common under dim light), **Fix colors using this set** recolors them to the set's color and logs each change as a corrected color review, so the CSV is right for the Set Verification app.
6. Choose **New batch** to download the results and start over, or discard them.

The batch is saved in the browser as you work, so a reload keeps it. A photo you scanned before is identified again from the saved Brickognize responses instead of re-uploading it.

## Verify a set

Choose **Verify set** in the header to check your scanned pieces against one set (the web version of the desktop Set Verification app).

1. Type a set number (`40611` means `40611-1`) or part of a name and pick it from the suggestions. Press <kbd>/</kbd> to jump to the search box.
2. The set's part list comes from the Rebrickable API (minifigure parts included, spares excluded) and is cached for a day. Without an API key, or offline, the local catalog is used.
3. The report updates live as you scan or change counts: **Missing**, **Extra** (more than the set needs), **Not in set**, and **Complete**. Use **+ / −** on a line to fix a count, add a bag remark to missing lines, and tick **Removed** on surplus lines as you clear them off the table.
4. **Possible substitutes** lists pieces you have that the set does not need in that color but that are a mold variation or an alternative of a part the set is short of in the same color (Rebrickable relationship types M and A, the same rule as the desktop app). Parts that only look alike, such as a round plate and a round tile, are never offered. Nothing counts until you accept it, and you can never use more pieces than you have or fill more than the set is missing.
5. Export the **Report CSV** or a **BrickLink wanted list** (XML) for the missing pieces.

Put your Rebrickable API key in `.env.local` (gitignored):

```sh
VITE_REBRICKABLE_API_KEY=your_key
```

`VITE_` variables are bundled into the browser code, so anyone who can open the site can read the key.

## How the scan works

- **Find pieces.** The browser uses brightness and saturation to pick out foreground pixels, groups connected pixels, and crops the resulting regions. Touching pieces can land in the same box, and pale pieces can blend into the background.
- **Identify parts and colors.** Up to four pieces are sent at once to Brickognize's search endpoint, which returns BrickLink part and color IDs with confidences. Browsers cannot call that endpoint directly, so it goes through a same-origin proxy: `/api/brickognize` (and `/api/bricklink-colors` for part color lists) are proxied by Vite in development and by the rewrites in `vercel.json` in production. On a host without those rewrites the app falls back to Brickognize's public parts endpoint and estimates color in the browser.
- **Rank sets.** The browser compares the scanned pieces with every set's full Rebrickable inventory, ignoring color (recognition reads shapes far better than colors). Mold variants, prints and alternates count as the same part, rarer parts weigh more, and quantities are capped at what each set holds. The score combines how much of your pile the set contains with how much of the set you found, so a big set does not win just by containing common pins.

Run `npm run check` for Svelte and TypeScript checks and `npm test` for unit tests.
