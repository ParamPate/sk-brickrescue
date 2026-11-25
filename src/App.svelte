<script lang="ts">
  import CameraFeed from "./components/CameraFeed.svelte";
  import SetRadar from "./components/SetRadar.svelte";
  import DigMode from "./components/DigMode.svelte";
  import PartImage from "./components/PartImage.svelte";
  import ResultsPanel from "./components/ResultsPanel.svelte";
  import ReviewDialog from "./components/ReviewDialog.svelte";
  import { fetchMatchSets } from "./services/api";
  import { canonicalPart, loadCatalogIndex, moldGroup } from "./services/catalog.svelte";
  import { addManualPiece, batch, clearBatch, getRawResponse, removePieces, scheduleSave } from "./services/batch.svelte";
  import { saveColorReview } from "./services/reviews";
  import { askConfirm, showNotice } from "./services/confirm.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import VerifySet from "./components/VerifySet.svelte";
  import { blColorHex, blToRbColorId, blToRbPart, rbToBlColor, rbToBlPart, whenPartMapReady } from "./services/bricklink";
  import { buildCsv, buildExcelReport, downloadFile, resultRows, timestamp } from "./services/exporters";
  import type { BrickPart, ChecklistPart, ScannedColorInput, MatchResult, PileItem } from "./services/types";

  let scannedColors = $state<ScannedColorInput[]>([]);
  let selectedPhotoBox = $state<number | null>(null);
  let review = $state<{ ids: string[]; startId: string } | null>(null);
  // "scan" = scanner, results and set matches; "verify" = check a chosen set
  let view = $state<"scan" | "verify">((() => {
    try { return localStorage.getItem("sk-view") === "verify" ? "verify" : "scan"; } catch { return "scan"; }
  })());
  $effect(() => {
    try { localStorage.setItem("sk-view", view); } catch { /* storage blocked */ }
  });

  type ShelfPart = BrickPart & {
    quantity: number;
    photoBoxes: number[];
    recordIds: string[];
    manualIds: string[];
    blPartId: string;
    blColorId: string;
    colorName: string;
  };

  // BrickLink -> Rebrickable part numbers load asynchronously; regroup once ready.
  let partMapLoaded = $state(false);
  whenPartMapReady().then(() => { partMapLoaded = true; });

  // The shelf groups identified pieces by part and color. Each batch record is
  // one physical piece, so the CSV row count always equals the shelf quantity.
  let foundParts = $derived.by(() => {
    void partMapLoaded;
    const groups = new Map<string, ShelfPart>();
    for (const record of batch.records) {
      const row = record.row;
      if (record.status !== "done" || !row) continue;
      const part_num = record.rb?.part ?? blToRbPart(row["Part ID"]);
      const color_id = record.rb?.color ?? blToRbColorId(row["BrickLink Color ID"]);
      const key = `${part_num}_${color_id}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          part_num, color_id, name: row["Part Name"], rarity_score: 0,
          imageUrl: record.cropUrl || row["Reference Image URL"],
          quantity: 0, photoBoxes: [], recordIds: [], manualIds: [],
          blPartId: row["Part ID"], blColorId: row["BrickLink Color ID"], colorName: row["LEGO Color"]
        };
        groups.set(key, group);
      }
      group.quantity++;
      group.recordIds.push(record.id);
      if (record.manual) group.manualIds.push(record.id);
      if (!group.imageUrl && record.cropUrl) group.imageUrl = record.cropUrl;
      if (record.box && record.photoId === batch.currentPhotoId) group.photoBoxes.push(record.box);
    }
    return [...groups.values()].reverse();
  });
  let totalPieces = $derived(foundParts.reduce((total, part) => total + part.quantity, 0));
  let selectedSetNum = $state<string | null>(null);
  let matchResults = $state<MatchResult[]>([]);
  let matchError = $state<boolean>(false);

  // Prefetch the catalog so it is ready for the first scan.
  loadCatalogIndex().catch(() => {});

  // --- DERIVED STATE / MATCHING ---
  const partKey = (part: BrickPart) => `${part.part_num}_${part.color_id}`;
  // A string signature so matching reruns only when the identified pieces change,
  // not on every status update while pieces are being identified.
  let pileSignature = $derived(foundParts.map((part) => `${partKey(part)}_${part.quantity}`).join("|"));

  let selectedSetMatch = $derived(
    selectedSetNum ? (matchResults.find((res) => res.set_num === selectedSetNum) || null) : null
  );

  // --- EFFECTS ---
  $effect(() => {
    let active = true;
    async function loadMatches() {
      const colorsSnapshot = $state.snapshot(scannedColors);
      const pile: PileItem[] = pileSignature ? pileSignature.split("|").map((entry) => {
        const [qty, color, ...part] = entry.split("_").reverse();
        return { part: part.reverse().join("_"), color: Number(color), qty: Number(qty) };
      }) : [];
      const ensureSetNum = selectedSetNum;

      // Radar stays empty until something has been scanned
      if (colorsSnapshot.length === 0 && pile.length === 0) {
        if (active) {
          matchResults = [];
          matchError = false;
        }
        return;
      }

      try {
        const data = await fetchMatchSets(colorsSnapshot, pile, ensureSetNum);
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
  // Dig Mode "+": count one more hand-found piece of this inventory line.
  const handleFindManually = (part: ChecklistPart) => {
    addManualPiece(rbToBlPart(part.part_num), part.name, rbToBlColor(part.color_id)?.id ?? "",
      { part: part.part_num, color: part.color_id });
  };

  // Dig Mode "−": remove one piece of this part group, preferring hand-added
  // pieces and the same color (REQ-RAD-007).
  const handleUnmarkPart = async (part: ChecklistPart) => {
    const group = canonicalPart(part.part_num);
    const candidates = foundParts.filter((entry) => canonicalPart(entry.part_num) === group)
      .sort((a, b) => Number(b.color_id === part.color_id) - Number(a.color_id === part.color_id));
    const manual = candidates.find((entry) => entry.manualIds.length);
    const id = manual?.manualIds.at(-1) ?? candidates[0]?.recordIds.at(-1);
    if (!id) return;
    if (!manual && !await askConfirm(`Remove one identified ${part.name} and its recognition result?`, { confirmLabel: "Remove", danger: true })) return;
    removePieces([id]);
  };

  // Recolor scanned pieces that the set's checklist counted in another color
  // to the color the set actually uses (saved as corrected color reviews).
  function handleFixColors(match: MatchResult): number {
    let changed = 0;
    const used = new Set<string>();
    for (const line of match.checklist) {
      const target = rbToBlColor(line.color_id);
      if (!target) continue;
      for (const { color, qty, part: mold } of line.borrowed) {
        let remaining = qty;
        for (const record of batch.records) {
          if (!remaining) break;
          const row = record.row;
          if (record.status !== "done" || !row || used.has(record.id)) continue;
          const part = record.rb?.part ?? blToRbPart(row["Part ID"]);
          const recordColor = record.rb?.color ?? blToRbColorId(row["BrickLink Color ID"]);
          if (recordColor !== color || moldGroup(part) !== mold) continue;
          saveColorReview(row, record.log, target.id);
          if (record.rb) record.rb.color = line.color_id;
          used.add(record.id);
          remaining--;
          changed++;
        }
      }
    }
    if (changed) scheduleSave();
    return changed;
  }

  const increase = (part: ShelfPart) =>
    addManualPiece(part.blPartId, part.name, part.blColorId, { part: part.part_num, color: part.color_id });

  async function decrease(part: ShelfPart) {
    const id = part.manualIds.at(-1) ?? part.recordIds.at(-1);
    if (!id) return;
    if (!part.manualIds.length && !await askConfirm(`Remove one identified ${part.name} and its recognition result?`, { confirmLabel: "Remove", danger: true })) return;
    removePieces([id]);
  }

  async function removeGroup(part: ShelfPart) {
    const identified = part.quantity - part.manualIds.length;
    if (identified && !await askConfirm(`Remove ${part.quantity} × ${part.name} and their recognition results from this batch?`, { confirmLabel: "Remove", danger: true })) return;
    removePieces(part.recordIds);
  }

  const openReview = (startId: string, ids: string[]) => { review = { ids: [...ids], startId }; };

  // --- NEW BATCH (gui.py Start New Batch) ---
  let newBatchDialog = $state<HTMLDialogElement>();
  let scanSession = $state(0);
  let exporting = $state(false);

  function resetWorkspace() {
    clearBatch();
    scanSession++;
    selectedPhotoBox = null;
    selectedSetNum = null;
    scannedColors = [];
    newBatchDialog?.close();
  }

  async function finishBatch() {
    exporting = true;
    try {
      const stamp = timestamp();
      if (resultRows(batch.records).length) {
        downloadFile(`brickognize_results_${stamp}.csv`, buildCsv(resultRows(batch.records)), "text/csv;charset=utf-8");
        downloadFile(`SK_BrickRescue_Batch_Report_${stamp}.xlsx`, await buildExcelReport(batch.records, getRawResponse),
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      }
      resetWorkspace();
    } catch (err) {
      console.error("Batch export failed:", err);
      showNotice("The batch files could not be created, so the batch was kept.");
    } finally {
      exporting = false;
    }
  }

  const handleNewBatch = () => {
    if (batch.records.length) newBatchDialog?.showModal();
    else resetWorkspace();
  };
</script>

<div class="app-container">

  {#if selectedSetMatch}
    <!-- Excavation (Dig) Screen -->
    <DigMode
      matchResult={selectedSetMatch}
      onBack={() => { selectedSetNum = null; }}
      onFindPartManually={handleFindManually}
      onUnmarkPart={handleUnmarkPart}
      onFixColors={handleFixColors}
    />
  {:else}
    <header class="app-header">
      <button class="header-back-btn" onclick={handleNewBatch}>New batch</button>

      <h1 class="brand-title">SK Brickhouse</h1>

      <div class="header-actions">
        <div class="view-switch" role="tablist" aria-label="Mode">
          <button type="button" role="tab" aria-selected={view === "scan"} onclick={() => { view = "scan"; }}>Scan</button>
          <button type="button" role="tab" aria-selected={view === "verify"} onclick={() => { view = "verify"; }}>Verify set</button>
        </div>
      </div>
    </header>

    {#if view === "verify"}
      <main class="verify-page">
        <VerifySet />
      </main>
    {:else}
    <main class="scan-dashboard">
      {#key scanSession}
        <CameraFeed
          bind:scannedColors
          {selectedPhotoBox}
          onSelectPhotoBox={(box) => { selectedPhotoBox = box; }}
          onOpenPiece={(id) => {
            const ids = batch.records.filter((r) => r.photoId === batch.currentPhotoId).map((r) => r.id);
            openReview(id, ids);
          }}
        />
      {/key}

      <!-- Found Parts Shelf -->
      <div class="found-items-container">
        <h2 class="panel-section-title">Scanned Bricks ({foundParts.length} unique · {totalPieces} total)</h2>
        {#if foundParts.length > 0}
          <div class="found-items-list">
            {#each foundParts as part (partKey(part))}
              {@const hex = blColorHex(part.blColorId)}
              <div class="found-item-card">
                <div class="found-item-main">
                  <button class="inspect-part-btn" onclick={() => openReview(part.recordIds[0], part.recordIds)}
                    aria-label={`Review ${part.name}`}>
                    <PartImage
                      src={part.imageUrl}
                      alt={part.name}
                      wrapperClass="found-item-img-container"
                      imgClass="found-item-img"
                      colorHex={hex}
                      fallbackClass="found-item-color-dot"
                    />
                    <div class="found-item-info">
                      <span class="found-item-name">{part.name}</span>
                      <span class="found-item-meta">{part.blPartId}</span>
                      <span class="found-item-meta found-item-color">
                        <span class="color-dot" style:background-color={hex} aria-hidden="true"></span>
                        {part.colorName}
                      </span>
                    </div>
                  </button>
                  {#if part.photoBoxes.length}
                    <div class="photo-box-references" aria-label="Source photo boxes">
                      {#each part.photoBoxes as box (box)}
                        <button class="found-item-source" class:active={selectedPhotoBox === box}
                          aria-pressed={selectedPhotoBox === box}
                          onclick={() => {
                            selectedPhotoBox = box;
                            document.querySelector(".scanner-viewport")?.scrollIntoView({ behavior: "smooth", block: "center" });
                          }}>Photo #{box}</button>
                      {/each}
                    </div>
                  {/if}
                  <div class="part-quantity" role="group" aria-label={`Quantity for ${part.name}, ${part.colorName}`}>
                    <button type="button" disabled={part.quantity === 1}
                      onclick={() => decrease(part)} aria-label="Decrease quantity">−</button>
                    <span aria-live="polite">{part.quantity}</span>
                    <button type="button" onclick={() => increase(part)}
                      aria-label="Increase quantity">+</button>
                  </div>
                </div>
                <button
                  class="remove-item-btn"
                  onclick={() => removeGroup(part)}
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

        <SetRadar
          results={matchResults}
          onSelectSet={(set_num) => {
            selectedSetNum = set_num;
          }}
        />
      </aside>

      <ResultsPanel onOpen={openReview} onNewBatch={handleNewBatch} />
    </main>
    {/if}

  {/if}
</div>

{#if review}
  {#key review}
    <ReviewDialog ids={review.ids} startId={review.startId} onClose={() => { review = null; }} />
  {/key}
{/if}

<ConfirmDialog />

<dialog bind:this={newBatchDialog} class="part-inspection new-batch-dialog" aria-labelledby="new-batch-title">
  <h2 id="new-batch-title">Start a new batch?</h2>
  <p>This batch has {batch.records.length} piece{batch.records.length === 1 ? "" : "s"}. Saved results stay in this browser only until you start a new batch.</p>
  <div class="review-row">
    <button type="button" class="btn primary" disabled={exporting} onclick={finishBatch}>
      {exporting ? "Preparing files…" : "Download CSV & Excel, then start new"}
    </button>
    <button type="button" class="btn danger" disabled={exporting} onclick={async () => {
      const count = batch.records.length;
      if (await askConfirm(`Discard all ${count} piece${count === 1 ? "" : "s"} without downloading the results? This cannot be undone.`,
        { confirmLabel: "Discard batch", danger: true })) resetWorkspace();
    }}>Discard and start new</button>
    <button type="button" class="btn" onclick={() => newBatchDialog?.close()}>Cancel</button>
  </div>
</dialog>
