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

1. Spread the pieces apart on a plain, light surface and take a photo. Choose **Scan Photo** to upload it, or choose **Start Camera** to scan a live view.
2. Check the numbered boxes on the uploaded photo. Click a scanned brick to enlarge its crop, correct its color, or open its Brickognize result when available.
3. Use the quantity controls to correct the count. Each card groups pieces with the same part number and color. Open **Review unidentified pieces** to inspect or download crops that did not return a match.
4. Select a suggested set to check its parts. Choose **Reset scan** to start over.

## How the scan works

- **Find pieces.** The browser uses brightness and saturation to pick out foreground pixels, groups connected pixels, and crops the resulting regions. Touching pieces can land in the same box, and pale pieces can blend into the background.
- **Identify parts and estimate colors.** Brickognize returns candidates for each crop. The app uses the first candidate and estimates color in the browser by comparing sampled pixels with catalog colors.
- **Rank sets.** The browser compares identified part numbers and the photo’s color profile with the local Rebrickable catalog. Rarer matched parts carry more weight. Quantity edits update the scanned list.

Run `npm run check` for Svelte and TypeScript checks and `npm test` for unit tests.
