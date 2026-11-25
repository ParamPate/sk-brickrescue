import * as fs from "fs";
import * as https from "https";
import * as zlib from "zlib";
import { join } from "path";

const DOWNLOAD_DIR = join(process.cwd(), "tmp_downloads");
const OUTPUT_DIR = join(process.cwd(), "public", "catalog");
const IMG_PREFIX = "https://cdn.rebrickable.com/media/parts/";

// Helper to download and gunzip a .csv.gz file
function downloadAndGunzip(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`📥 Downloading: ${url}...`);
    const file = fs.createWriteStream(destPath);

    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status: ${response.statusCode}`));
        return;
      }

      const gunzip = zlib.createGunzip();
      response.pipe(gunzip).pipe(file);

      file.on("finish", () => {
        file.close();
        console.log(`   Saved: ${destPath}`);
        resolve();
      });
    }).on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// Strip printed/pattern/assembly/sub-part suffixes, keeping the numeric base
// (with optional mold letter): "3001pr0002" -> "3001", "3626cpr0001" -> "3626c",
// BrickLink's "39367pb01" -> "39367". IDs without a numeric base (e.g.
// "cardupn0015pr0001") are returned unchanged — they must never collapse to ""
// (FIND-030). Must mirror getBasePartNum in src/services/api.ts.
function getBasePartNum(partNum: string): string {
  const match = partNum.match(/^(\d+[a-z]?)(?:pr|pat|pb|c|sp)\d.*$/i);
  return match ? match[1] : partNum;
}

// Shard key for lazy-loaded set part lists: FNV-1a hash of the set number into
// 512 buckets, so big themes do not pile into one file. Must mirror
// shardKeyForSet in src/services/catalog.svelte.ts.
function shardKeyForSet(setNum: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < setNum.length; i++) {
    hash ^= setNum.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 512).toString(16).padStart(3, "0");
}

// CSV line parser supporting quoted fields (quotes are removed)
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Data lines of a downloaded CSV (header and blank lines skipped)
function readLines(path: string): string[] {
  return fs.readFileSync(path, "utf-8").replace(/\r/g, "").split("\n").slice(1).filter((line) => line.trim());
}

async function main() {
  try {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    console.log("🚀 Starting Local Catalog Generation...");

    // 1. Colors
    const colorsPath = join(DOWNLOAD_DIR, "colors.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/colors.csv.gz", colorsPath);
    const colorsMap: Record<number, { name: string; hex: string }> = {};
    for (const line of readLines(colorsPath)) {
      const [id, name, rgb] = parseCSVLine(line);
      colorsMap[parseInt(id)] = { name, hex: `#${rgb}` };
    }
    console.log(`   Processed ${Object.keys(colorsMap).length} colors.`);

    // 2. Part names (part_num -> real English catalogue name)
    const partsMasterPath = join(DOWNLOAD_DIR, "parts.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/parts.csv.gz", partsMasterPath);
    const partNames: Record<string, string> = {};
    const partCategory: Record<string, number> = {};
    for (const line of readLines(partsMasterPath)) {
      const [part_num, name, part_cat_id] = parseCSVLine(line);
      if (!part_num) continue;
      partNames[part_num] = name;
      if (part_cat_id) partCategory[part_num] = parseInt(part_cat_id);
    }

    // Part categories (Plates, Bricks, Technic…) for sorting verification lists
    const categoriesPath = join(DOWNLOAD_DIR, "part_categories.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/part_categories.csv.gz", categoriesPath);
    const categoryNames: Record<number, string> = {};
    for (const line of readLines(categoriesPath)) {
      const [id, name] = parseCSVLine(line);
      if (id) categoryNames[parseInt(id)] = name;
    }
    console.log(`   Processed ${Object.keys(partNames).length} part names.`);

    // 3. Sets
    const setsPath = join(DOWNLOAD_DIR, "sets.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/sets.csv.gz", setsPath);
    const setsMap: Record<string, { name: string; year: number; total_parts: number; image_url: string }> = {};
    for (const line of readLines(setsPath)) {
      const [set_num, name, year, _theme_id, num_parts, img_url] = parseCSVLine(line);
      if (parseInt(year) < 1980 || !(parseInt(num_parts) > 0)) continue;
      setsMap[set_num] = { name, year: parseInt(year), total_parts: parseInt(num_parts), image_url: img_url };
    }
    console.log(`   Processed ${Object.keys(setsMap).length} sets (released since 1980).`);

    // 4. Part relationships: mold variants (M), alternates (A), prints (P) and
    // patterns (T) merge into one canonical part for matching, because
    // recognition often reports a sibling mold (e.g. pin 2780 vs 61332).
    const relPath = join(DOWNLOAD_DIR, "part_relationships.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/part_relationships.csv.gz", relPath);
    // A second, stricter grouping without alternates (M, P, T only) decides
    // which pieces are the same physical part and may be recolored.
    const relations = readLines(relPath).map(parseCSVLine);
    const groupParts = (types: string[]) => {
      const parentOf = new Map<string, string>();
      const findRoot = (part: string): string => {
        let root = part;
        while (parentOf.has(root) && parentOf.get(root) !== root) root = parentOf.get(root)!;
        return root;
      };
      for (const [relType, child, parent] of relations) {
        if (!types.includes(relType)) continue;
        const a = findRoot(getBasePartNum(child));
        const b = findRoot(getBasePartNum(parent));
        if (a === b) continue;
        // The shortest (then alphabetically first) ID names the group
        const [root, other] = [a, b].sort((x, y) => x.length - y.length || x.localeCompare(y));
        parentOf.set(other, root);
        parentOf.set(root, root);
      }
      return (partNum: string) => findRoot(getBasePartNum(partNum));
    };
    const canonicalPart = groupParts(["M", "A", "P", "T"]);
    const moldGroup = groupParts(["M", "P", "T"]);

    // 5. Inventories: only the latest inventory version of each set
    const invPath = join(DOWNLOAD_DIR, "inventories.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/inventories.csv.gz", invPath);
    const latestInventory: Record<string, { id: string; version: number }> = {};
    for (const line of readLines(invPath)) {
      const [id, version, set_num] = parseCSVLine(line);
      if (!setsMap[set_num]) continue;
      if (!latestInventory[set_num] || parseInt(version) > latestInventory[set_num].version) {
        latestInventory[set_num] = { id, version: parseInt(version) };
      }
    }
    const inventoryIdToSetNum: Record<string, string> = {};
    for (const set_num in latestInventory) inventoryIdToSetNum[latestInventory[set_num].id] = set_num;
    console.log(`   Processed ${Object.keys(inventoryIdToSetNum).length} set inventories.`);

    // 6. Inventory parts: full part lists per set (spares excluded)
    const invPartsPath = join(DOWNLOAD_DIR, "inventory_parts.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/inventory_parts.csv.gz", invPartsPath);
    console.log("📊 Building full set inventories...");
    const inventories: Record<string, Map<string, { p: string; c: number; q: number; i: string }>> = {};
    for (const line of readLines(invPartsPath)) {
      const [inventory_id, part_num, color_id, quantity, is_spare, img_url] = parseCSVLine(line);
      const set_num = inventoryIdToSetNum[inventory_id];
      if (!set_num || /^(t|true)$/i.test(is_spare)) continue;
      const color = parseInt(color_id);
      const qty = parseInt(quantity) || 1;
      const rows = (inventories[set_num] ??= new Map());
      const row = rows.get(`${part_num}_${color}`);
      if (row) {
        row.q += qty;
      } else {
        rows.set(`${part_num}_${color}`, {
          p: part_num,
          c: color,
          q: qty,
          i: img_url.startsWith(IMG_PREFIX) ? img_url.slice(IMG_PREFIX.length) : img_url
        });
      }
    }

    // 7. Matching index (canonical part -> [setIndex, quantity, ...]), set
    // index (name, year, size, color profile) and per-set part lists.
    const setNums = Object.keys(inventories).sort();
    const postings: Record<string, number[]> = {};
    const aliases: Record<string, string> = {};
    const molds: Record<string, string> = {};
    const usedParts = new Set<string>();
    const setsIndex: Record<string, { n: string; y: number; t: number; i?: string; c: Record<number, number> }> = {};
    const setPartsShards: Record<string, Record<string, (string | number)[][]>> = {};

    setNums.forEach((set_num, setIndex) => {
      const rows = [...inventories[set_num].values()].sort((a, b) => b.q - a.q || a.p.localeCompare(b.p));
      const byCanonical = new Map<string, number>();
      const colorCounts: Record<number, number> = {};
      let pieces = 0;
      for (const row of rows) {
        const base = getBasePartNum(row.p);
        const canonical = canonicalPart(row.p);
        if (canonical !== base) aliases[base] = canonical;
        if (moldGroup(row.p) !== base) molds[base] = moldGroup(row.p);
        byCanonical.set(canonical, (byCanonical.get(canonical) || 0) + row.q);
        colorCounts[row.c] = (colorCounts[row.c] || 0) + row.q;
        pieces += row.q;
        usedParts.add(row.p);
      }
      for (const [canonical, qty] of byCanonical) (postings[canonical] ??= []).push(setIndex, qty);

      // Color profile in percent (0..100); colors below 0.5% are dropped
      const profile: Record<number, number> = {};
      for (const color in colorCounts) {
        const percent = (colorCounts[color] / pieces) * 100;
        if (percent >= 0.5) profile[parseInt(color)] = Math.round(percent * 10) / 10;
      }
      const set = setsMap[set_num];
      const defaultImage = `https://cdn.rebrickable.com/media/sets/${set_num.toLowerCase()}.jpg`;
      setsIndex[set_num] = {
        n: set.name,
        y: set.year,
        t: set.total_parts,
        ...(set.image_url && set.image_url !== defaultImage ? { i: set.image_url } : {}),
        c: profile
      };
      (setPartsShards[shardKeyForSet(set_num)] ??= {})[set_num] = rows.map((row) => [row.p, row.c, row.q, row.i]);
    });
    console.log(`   ${setNums.length} sets, ${Object.keys(postings).length} canonical parts, ${Object.keys(aliases).length} aliases.`);

    // 8. Write outputs
    console.log("💾 Writing catalog files to public directory...");
    fs.writeFileSync(join(OUTPUT_DIR, "colors.json"), JSON.stringify(colorsMap));
    fs.writeFileSync(join(OUTPUT_DIR, "sets-index.json"), JSON.stringify(setsIndex));
    fs.writeFileSync(join(OUTPUT_DIR, "match-index.json"), JSON.stringify({ sets: setNums, parts: postings, aliases, molds }));
    const names: Record<string, string> = {};
    for (const part of usedParts) if (partNames[part]) names[part] = partNames[part];
    fs.writeFileSync(join(OUTPUT_DIR, "part-names.json"), JSON.stringify(names));
    const categoryOfPart: Record<string, number> = {};
    for (const part of usedParts) if (partCategory[part] !== undefined) categoryOfPart[part] = partCategory[part];
    fs.writeFileSync(join(OUTPUT_DIR, "part-categories.json"), JSON.stringify({ names: categoryNames, parts: categoryOfPart }));

    // Substitution candidates for set verification: direct mold variations (M)
    // and alternatives (A), both directions — the same rule as the desktop
    // verification app (relationships.py variation_rel_types).
    const variations: Record<string, [string, "M" | "A"][]> = {};
    for (const [relType, child, parent] of relations) {
      if (relType !== "M" && relType !== "A") continue;
      (variations[child] ??= []).push([parent, relType]);
      (variations[parent] ??= []).push([child, relType]);
    }
    fs.writeFileSync(join(OUTPUT_DIR, "variations.json"), JSON.stringify(variations));

    const shardsDir = join(OUTPUT_DIR, "set-parts");
    fs.rmSync(shardsDir, { recursive: true, force: true });
    fs.mkdirSync(shardsDir, { recursive: true });
    for (const shard in setPartsShards) {
      fs.writeFileSync(join(shardsDir, `${shard}.json`), JSON.stringify(setPartsShards[shard]));
    }
    console.log(`   set-parts/ created with ${Object.keys(setPartsShards).length} shard files.`);

    // Remove files from previous generator versions
    fs.rmSync(join(OUTPUT_DIR, "sets.json"), { force: true });
    fs.rmSync(join(OUTPUT_DIR, "parts.json"), { force: true });

    // Catalog metadata so the app can display the real database version (REQ-START-002)
    const generatedDate = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      join(OUTPUT_DIR, "meta.json"),
      JSON.stringify({
        version: `Rebrickable Catalog v${generatedDate}`,
        generated: generatedDate,
        source: "rebrickable.com database dumps",
        sets: setNums.length
      })
    );
    console.log("   meta.json created.");

    console.log("🧹 Cleaning up downloads folder...");
    fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });

    console.log("🎉 Local catalog files successfully generated!");
  } catch (error) {
    console.error("❌ Fatal error in catalog generation:", error);
    process.exit(1);
  }
}

main();
