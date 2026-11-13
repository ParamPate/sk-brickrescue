import * as fs from "fs";
import * as https from "https";
import * as zlib from "zlib";
import { join } from "path";

const DOWNLOAD_DIR = join(process.cwd(), "tmp_downloads");
const OUTPUT_DIR = join(process.cwd(), "public", "catalog");

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
// (with optional mold letter): "3001pr0002" -> "3001", "3626cpr0001" -> "3626c".
// IDs without a numeric base (e.g. "cardupn0015pr0001") are returned unchanged —
// the previous unanchored regex collapsed thousands of such IDs to "" and created
// a phantom base part with rarity 1.0 spanning 118 sets (FIND-030).
// Must mirror getBasePartNum in src/services/api.ts.
function getBasePartNum(partNum: string): string {
  const match = partNum.match(/^(\d+[a-z]?)(?:pr|pat|c|sp)\d.*$/i);
  return match ? match[1] : partNum;
}

// Shard key for lazy-loaded set part lists. Must mirror shardKeyForSet in
// src/services/catalog.svelte.ts.
function shardKeyForSet(setNum: string): string {
  const normalized = setNum.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.slice(0, 2) || "misc";
}

// Simple CSV parser supporting quotes
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

async function main() {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    console.log("🚀 Starting Local Catalog Generation...");

    // 1. Download & Parse Colors
    const colorsPath = join(DOWNLOAD_DIR, "colors.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/colors.csv.gz", colorsPath);
    
    const colorsData = fs.readFileSync(colorsPath, "utf-8").replace(/\r/g, "").split("\n").slice(1);
    const colorsMap: Record<number, { name: string; hex: string }> = {};
    
    for (const line of colorsData) {
      if (!line.trim()) continue;
      const [id, name, rgb] = parseCSVLine(line);
      colorsMap[parseInt(id)] = {
        name: name.replace(/"/g, ""),
        hex: `#${rgb}`
      };
    }
    console.log(`   Processed ${Object.keys(colorsMap).length} colors.`);

    // 1b. Download & Parse Part Names (part_num -> real English catalogue name)
    const partsMasterPath = join(DOWNLOAD_DIR, "parts.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/parts.csv.gz", partsMasterPath);

    const partsMasterData = fs.readFileSync(partsMasterPath, "utf-8").replace(/\r/g, "").split("\n").slice(1);
    const partNames: Record<string, string> = {};

    for (const line of partsMasterData) {
      if (!line.trim()) continue;
      // Columns: part_num,name,part_cat_id,part_material
      const [part_num, name] = parseCSVLine(line);
      if (!part_num) continue;
      partNames[part_num.replace(/"/g, "")] = name.replace(/"/g, "");
    }
    console.log(`   Processed ${Object.keys(partNames).length} part names.`);

    // 2. Download & Parse Sets
    const setsPath = join(DOWNLOAD_DIR, "sets.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/sets.csv.gz", setsPath);
    
    const setsData = fs.readFileSync(setsPath, "utf-8").replace(/\r/g, "").split("\n").slice(1);
    const setsMap: Record<string, { name: string; year: number; total_parts: number; image_url: string | null; diagnostic_rarity_sum: number; color_profile: Record<number, number>; parts: any[] }> = {};
    
    for (const line of setsData) {
      if (!line.trim()) continue;
      const [set_num, name, year, _theme_id, num_parts, img_url] = parseCSVLine(line);
      if (parseInt(year) < 1980) continue;
      
      const cleanSetNum = set_num.replace(/"/g, "");
      setsMap[cleanSetNum] = {
        name: name.replace(/"/g, ""),
        year: parseInt(year),
        total_parts: parseInt(num_parts),
        image_url: img_url ? img_url.replace(/"/g, "") : null,
        diagnostic_rarity_sum: 0.0,
        color_profile: {},
        parts: []
      };
    }
    console.log(`   Processed ${Object.keys(setsMap).length} sets (released since 1980).`);

    // 3. Download & Parse Inventories (Mapping inventory ID to set_num)
    const invPath = join(DOWNLOAD_DIR, "inventories.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/inventories.csv.gz", invPath);
    
    const invData = fs.readFileSync(invPath, "utf-8").replace(/\r/g, "").split("\n").slice(1);
    const inventoryIdToSetNum: Record<string, string> = {};
    
    for (const line of invData) {
      if (!line.trim()) continue;
      const [id, _version, set_num] = parseCSVLine(line);
      if (id && set_num) {
        inventoryIdToSetNum[id.replace(/"/g, "")] = set_num.replace(/"/g, "");
      }
    }
    console.log(`   Processed ${Object.keys(inventoryIdToSetNum).length} inventory mappings.`);

    // 4. Download & Parse Inventory Parts
    const invPartsPath = join(DOWNLOAD_DIR, "inventory_parts.csv");
    await downloadAndGunzip("https://rebrickable.com/media/downloads/inventory_parts.csv.gz", invPartsPath);
    
    const invPartsData = fs.readFileSync(invPartsPath, "utf-8").replace(/\r/g, "").split("\n").slice(1);
    
    console.log("📊 Analyzing part occurrences and color distributions...");
    const partOccurrences: Record<string, number> = {};
    const setsColorCounts: Record<string, Record<number, number>> = {};
    const setsTotalLoadedParts: Record<string, number> = {};
    
    const rawParts: Array<{ set_num: string; part_num: string; color_id: number; img_url: string | null }> = [];
    
    for (const line of invPartsData) {
      if (!line.trim()) continue;
      const [inventory_id, part_num, color_id, quantity, is_spare, img_url] = parseCSVLine(line);
      if (!inventory_id) continue;
      
      const cleanInvId = inventory_id.replace(/"/g, "");
      const set_num = inventoryIdToSetNum[cleanInvId];
      if (!set_num || !setsMap[set_num]) continue;
      
      const cleanIsSpare = is_spare ? is_spare.replace(/"/g, "").toLowerCase() : "";
      if (cleanIsSpare === "t" || cleanIsSpare === "true") continue; // Skip spares for exact matching & profiles
      
      const cleanPartNum = part_num.replace(/"/g, "");
      const cleanColorId = parseInt(color_id.replace(/"/g, ""));
      const qty = parseInt(quantity) || 1;
      
      // Accumulate color counts per set (for color profile percentage calculation)
      if (!setsColorCounts[set_num]) {
        setsColorCounts[set_num] = {};
        setsTotalLoadedParts[set_num] = 0;
      }
      setsColorCounts[set_num][cleanColorId] = (setsColorCounts[set_num][cleanColorId] || 0) + qty;
      setsTotalLoadedParts[set_num] += qty;
      
      const partKey = `${cleanPartNum}_${cleanColorId}`;
      partOccurrences[partKey] = (partOccurrences[partKey] || 0) + 1;
      
      rawParts.push({
        set_num,
        part_num: cleanPartNum,
        color_id: cleanColorId,
        img_url: img_url ? img_url.replace(/"/g, "") : null
      });
    }

    console.log(`   Analyzed color profiles and occurrences for ${rawParts.length} parts.`);

    // 5. Calculate Color Profiles for each Set
    console.log("🎨 Calculating set color percentage profiles...");
    for (const set_num in setsMap) {
      const colorCounts = setsColorCounts[set_num];
      const totalParts = setsTotalLoadedParts[set_num] || 0;
      if (colorCounts && totalParts > 0) {
        const profile: Record<number, number> = {};
        for (const cid in colorCounts) {
          const count = colorCounts[cid];
          // Store percentage value (0.0 to 100.0) rounded to 2 decimals
          profile[parseInt(cid)] = parseFloat(((count / totalParts) * 100.0).toFixed(2));
        }
        setsMap[set_num].color_profile = profile;
      }
    }

    // 6. Filter Diagnostic Key Parts & Generate Rarity Scores
    console.log("⚡ Filtering diagnostic key parts (rarity >= 10%)...");
    const partsIndex: Record<string, { r: number; s: string[] }> = {};
    const seenPartsInSet = new Set<string>();
    
    // We also want to compute max rarity per base part number
    const basePartRarities: Record<string, number> = {};
    
    // First pass: precalculate base part rarities
    for (const part of rawParts) {
      const partKey = `${part.part_num}_${part.color_id}`;
      const occurrences = partOccurrences[partKey] || 1;
      const rarity = parseFloat((1.0 / occurrences).toFixed(4));
      
      const baseNum = getBasePartNum(part.part_num);
      basePartRarities[baseNum] = Math.max(basePartRarities[baseNum] || 0, rarity);
    }
    
    // Second pass: filter and assemble parts list for sets and the lookup index
    for (const part of rawParts) {
      const partKey = `${part.part_num}_${part.color_id}`;
      const uniqueKey = `${part.set_num}_${partKey}`;
      if (seenPartsInSet.has(uniqueKey)) continue;
      seenPartsInSet.add(uniqueKey);
      
      const occurrences = partOccurrences[partKey] || 1;
      const rarity = parseFloat((1.0 / occurrences).toFixed(4));
      const baseNum = getBasePartNum(part.part_num);
      if (!baseNum) continue; // safety net: never index an empty base part
      
      // Filter threshold >= 10% rarity, or specifically whitelist test sets
      const isTestSet = ["75957-1", "6973-1", "6285-1"].includes(part.set_num);
      if (rarity >= 0.10 || isTestSet) {
        // Add part to the set's diagnostic parts list
        // Store using compact keys: p (part_num), c (color_id), r (rarity_score), i (image_url)
        setsMap[part.set_num].parts.push({
          p: part.part_num,
          c: part.color_id,
          r: rarity,
          i: part.img_url,
          nm: partNames[part.part_num] || null
        });
        
        // Sum up diagnostic rarity sum for the set
        setsMap[part.set_num].diagnostic_rarity_sum = parseFloat(
          (setsMap[part.set_num].diagnostic_rarity_sum + rarity).toFixed(4)
        );
        
        // Add to global parts lookup index
        if (!partsIndex[baseNum]) {
          partsIndex[baseNum] = {
            r: basePartRarities[baseNum] || 0.01,
            s: []
          };
        }
        if (!partsIndex[baseNum].s.includes(part.set_num)) {
          partsIndex[baseNum].s.push(part.set_num);
        }
      }
    }

    console.log(`   Diagnostic rarity sums calculated. Parts index contains ${Object.keys(partsIndex).length} base parts.`);

    // 7. Write outputs to public directory
    console.log("💾 Writing catalog files to public directory...");
    
    // Write colors
    fs.writeFileSync(
      join(OUTPUT_DIR, "colors.json"),
      JSON.stringify(colorsMap)
    );
    console.log("   colors.json created.");
    
    // Write parts index
    fs.writeFileSync(
      join(OUTPUT_DIR, "parts.json"),
      JSON.stringify(partsIndex)
    );
    console.log("   parts.json created.");
    
    // Write the sets in two artefacts (omitting sets that ended up with no
    // diagnostic parts unless they are test sets):
    //  - sets-index.json: lightweight scoring data ({n,y,t,i,d,c}) loaded upfront
    //  - set-parts/<shard>.json: part lists, lazily fetched per shard when a set
    //    is shown in detail (Set Radar top matches / Dig Mode)
    const setsIndex: Record<string, any> = {};
    const setPartsShards: Record<string, Record<string, any[]>> = {};
    let setCounter = 0;
    for (const snum in setsMap) {
      const set = setsMap[snum];
      if (set.parts.length > 0 || ["75957-1", "6973-1", "6285-1"].includes(snum)) {
        setsIndex[snum] = {
          n: set.name,
          y: set.year,
          t: set.total_parts,
          i: set.image_url,
          d: set.diagnostic_rarity_sum,
          c: set.color_profile
        };
        const shard = shardKeyForSet(snum);
        if (!setPartsShards[shard]) setPartsShards[shard] = {};
        setPartsShards[shard][snum] = set.parts;
        setCounter++;
      }
    }

    fs.writeFileSync(
      join(OUTPUT_DIR, "sets-index.json"),
      JSON.stringify(setsIndex)
    );
    console.log(`   sets-index.json created containing ${setCounter} sets (with diagnostic parts).`);

    const shardsDir = join(OUTPUT_DIR, "set-parts");
    fs.rmSync(shardsDir, { recursive: true, force: true });
    fs.mkdirSync(shardsDir, { recursive: true });
    for (const shard in setPartsShards) {
      fs.writeFileSync(join(shardsDir, `${shard}.json`), JSON.stringify(setPartsShards[shard]));
    }
    console.log(`   set-parts/ created with ${Object.keys(setPartsShards).length} shard files.`);

    // Remove the legacy monolithic sets.json from previous generator versions
    fs.rmSync(join(OUTPUT_DIR, "sets.json"), { force: true });

    // Write catalog metadata so the app can display the real database version
    // (REQ-START-002) instead of a hardcoded constant.
    const generatedDate = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      join(OUTPUT_DIR, "meta.json"),
      JSON.stringify({
        version: `Rebrickable Catalog v${generatedDate}`,
        generated: generatedDate,
        source: "rebrickable.com database dumps",
        sets: setCounter
      })
    );
    console.log("   meta.json created.");

    // Clean up downloads directory
    console.log("🧹 Cleaning up downloads folder...");
    fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
    
    console.log("🎉 Local catalog files successfully generated!");
    
  } catch (error) {
    console.error("❌ Fatal error in catalog generation:", error);
    process.exit(1);
  }
}

main();
