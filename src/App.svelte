<script lang="ts">
  import { tick } from "svelte";
  import CameraFeed from "./components/CameraFeed.svelte";
  import SetRadar from "./components/SetRadar.svelte";
  import DigMode from "./components/DigMode.svelte";
  import PartImage from "./components/PartImage.svelte";
  import { fetchMatchSets, getBasePartNum } from "./services/api";
  import { loadCatalogIndex, loadColors, resolveColor } from "./services/catalog.svelte";
  import type { BrickPart, ScannedColorInput, MatchResult } from "./services/types";

  let scannedColors = $state<ScannedColorInput[]>([]);
  let inspectedPart = $state<BrickPart | null>(null);
  let colorOptions = $state<Awaited<ReturnType<typeof loadColors>>>({});
  loadColors().then((colors) => { colorOptions = colors; });
  let sortedColors = $derived(Object.entries(colorOptions).sort(([, a], [, b]) => a.name.localeCompare(b.name)));
  let inspectionDialog = $state<HTMLDialogElement>();

  async function inspectPart(part: BrickPart) {
    inspectedPart = part;
    await tick();
    inspectionDialog?.showModal();
  }

  let foundParts = $state<(BrickPart & { quantity: number })[]>([]);
  let totalPieces = $derived(foundParts.reduce((total, part) => total + part.quantity, 0));
  let selectedSetNum = $state<string | null>(null);
  let matchResults = $state<MatchResult[]>([]);
  let matchError = $state<boolean>(false);

  // Prefetch the catalog so it is ready for the first scan.
  loadCatalogIndex().catch(() => {});

  // --- DERIVED STATE / MATCHING ---
  const partKey = (part: BrickPart) => `${part.part_num}_${part.color_id}`;
  // The base+color key a scan is matched by (mirrors the checklist matching in api.ts).
  const scanKey = (part: BrickPart) => `${getBasePartNum(part.part_num).toLowerCase()}_${part.color_id}`;
  let scannedPartKeys = $derived(foundParts.map(partKey));

  let selectedSetMatch = $derived(
    selectedSetNum ? (matchResults.find((res) => res.set_num === selectedSetNum) || null) : null
  );

  // --- EFFECTS ---
  $effect(() => {
    let active = true;
    async function loadMatches() {
      const colorsSnapshot = $state.snapshot(scannedColors);
      const keysSnapshot = $state.snapshot(scannedPartKeys);
      const ensureSetNum = selectedSetNum;

      // Radar bleibt leer, wenn noch nichts gescannt oder erfasst wurde
      if (colorsSnapshot.length === 0 && keysSnapshot.length === 0) {
        if (active) {
          matchResults = [];
          matchError = false;
        }
        return;
      }

      try {
        const data = await fetchMatchSets(colorsSnapshot, keysSnapshot, ensureSetNum);
        if (active) {
          matchResults = data;
          matchError = false;
        }
      } catch (err) {
        console.error("Matching failed:", err);
        if (active) {
          matchResults = [];
          matchError = true;
        }
      }
    }
    loadMatches();
    return () => {
      active = false;
    };
  });

  // --- ACTIONS ---
  const handlePartIdentified = (part: BrickPart, countRepeat = false) => {
    const existing = foundParts.find((entry) => partKey(entry) === partKey(part));
    if (!existing) {
      foundParts.unshift({ ...part, quantity: 1 });
    } else if (countRepeat) {
      existing.quantity++;
    }
  };

  function correctPartColor(colorId: number) {
    if (!inspectedPart) return;
    const key = partKey(inspectedPart);
    const part = foundParts.find((entry) => partKey(entry) === key);
    if (!part || part.color_id === colorId || !colorOptions[colorId]) return;
    const matching = foundParts.find((entry) =>
      entry.part_num === part.part_num && entry.color_id === colorId
    );
    if (matching) {
      matching.quantity += part.quantity;
      foundParts.splice(foundParts.indexOf(part), 1);
      inspectedPart = matching;
    } else {
      part.color_id = colorId;
    }
  }

  const handleRemovePart = (part: BrickPart) => {
    // Found Shelf "×" passes a real foundParts entry → exact identity removes it.
    let index = foundParts.findIndex((p) => partKey(p) === partKey(part));
    // DigMode's "Found" un-mark passes the catalog checklist part. When the color-independent
    // fallback matched it (REQ-RAD-006a), its own key is NOT in foundParts — remove the scanned
    // entry the checklist actually consumed instead (matchedScanKey), else the mis-tap sticks.
    if (index === -1 && part.matchedScanKey) {
      index = foundParts.findIndex((p) => scanKey(p) === part.matchedScanKey);
    }
    if (index !== -1) {
      foundParts.splice(index, 1);
    }
  };

  let scanSession = $state(0);

  const handleReset = () => {
    scanSession++;
    foundParts = [];
    selectedSetNum = null;
    scannedColors = [];
  };
</script>

<div class="app-container">

  {#if selectedSetMatch}
    <!-- Excavation (Dig) Screen -->
    <DigMode
      matchResult={selectedSetMatch}
      onBack={() => { selectedSetNum = null; }}
      onFindPartManually={handlePartIdentified}
      onUnmarkPart={handleRemovePart}
    />
  {:else}
    <!-- Main Search Dashboard -->
    <!-- Header -->
    <header class="app-header">
      <button class="header-back-btn" onclick={handleReset}>Reset scan</button>

      <h1 class="brand-title">SK Brickhouse</h1>

      <!-- Right Spacer (keeps title centered) -->
      <div class="header-actions"></div>
    </header>

    <main class="scan-dashboard">
      <!-- Main scanner view -->
      {#key scanSession}
        <CameraFeed
          bind:scannedColors
          onPartIdentified={(part) => handlePartIdentified(part, true)}
        />
      {/key}

      <!-- Found Parts Shelf -->
      <div class="found-items-container">
        <h2 class="panel-section-title">Scanned Bricks ({foundParts.length} unique · {totalPieces} total)</h2>
        {#if foundParts.length > 0}
          <div class="found-items-list">
            {#each foundParts as part (partKey(part))}
              {@const color = resolveColor(part.color_id)}
              <div class="found-item-card">
                <div class="found-item-main">
                  <button class="inspect-part-btn" onclick={() => inspectPart(part)}
                    aria-label={`Enlarge ${part.name}`}>
                    <PartImage
                      src={part.imageUrl}
                      alt={part.name}
                      wrapperClass="found-item-img-container"
                      imgClass="found-item-img"
                      colorHex={color.hex}
                      fallbackClass="found-item-color-dot"
                    />
                    <div class="found-item-info">
                      <span class="found-item-name">{part.name}</span>
                      <!-- Disambiguate duplicate IDs by color. -->
                      <span class="found-item-meta">{part.part_num}</span>
                      <span class="found-item-meta found-item-color">
                        <span class="color-dot" style:background-color={color.hex} aria-hidden="true"></span>
                        {color.name}
                      </span>
                    </div>
                  </button>
                  <div class="part-quantity" role="group" aria-label={`Quantity for ${part.name}, ${color.name}`}>
                    <button type="button" disabled={part.quantity === 1}
                      onclick={() => { part.quantity--; }} aria-label="Decrease quantity">−</button>
                    <span aria-live="polite">{part.quantity}</span>
                    <button type="button" onclick={() => { part.quantity++; }}
                      aria-label="Increase quantity">+</button>
                  </div>
                </div>
                <button
                  class="remove-item-btn"
                  onclick={() => handleRemovePart(part)}
                  aria-label={`Remove ${part.name}`}
                >
                  ×
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <div class="found-items-empty">
            No bricks scanned yet. Scan a photo or tap the camera viewfinder.
          </div>
        {/if}
      </div>

      <aside class="set-matches" aria-label="Set matches">
        {#if matchError}
          <div class="match-error-banner">
            The set catalog could not be loaded. Check your connection — matching retries automatically on the next scan.
          </div>
        {/if}

        <!-- Match Radar -->
        <SetRadar
          results={matchResults}
          onSelectSet={(set_num) => {
            selectedSetNum = set_num;
          }}
        />
      </aside>
    </main>

  {/if}
</div>

<dialog bind:this={inspectionDialog} class="part-inspection" aria-labelledby="inspection-title"
  onclose={() => { inspectedPart = null; }}>
  {#if inspectedPart}
    <header>
      <div>
        <h2 id="inspection-title">{inspectedPart.name}</h2>
        <p>{inspectedPart.part_num}</p>
        {#if inspectedPart.brickognizeUrl}
          <a class="inspection-result-link" href={inspectedPart.brickognizeUrl}
            target="_blank" rel="noopener noreferrer">Open in Brickognize ↗</a>
        {/if}
        <details class="inspection-colors">
          <summary>
            Color
            <span class="color-swatch" style:background-color={resolveColor(inspectedPart.color_id).hex} aria-hidden="true"></span>
            {resolveColor(inspectedPart.color_id).name}
          </summary>
          <ul aria-label="Available colors">
            {#each sortedColors as [id, color] (id)}
              <li>
                <button type="button" aria-pressed={Number(id) === inspectedPart.color_id}
                  onclick={(event) => {
                    const picker = event.currentTarget.closest("details");
                    correctPartColor(Number(id));
                    if (picker) {
                      picker.open = false;
                      picker.querySelector("summary")?.focus();
                    }
                  }}>
                  <span class="color-swatch" style:background-color={color.hex} aria-hidden="true"></span>
                  {color.name}
                </button>
              </li>
            {/each}
          </ul>
        </details>
      </div>
      <button type="button" onclick={() => inspectionDialog?.close()}>Close</button>
    </header>
    <PartImage src={inspectedPart.imageUrl} alt={inspectedPart.name}
      wrapperClass="inspection-image" imgClass="inspection-crop" />
  {/if}
</dialog>
