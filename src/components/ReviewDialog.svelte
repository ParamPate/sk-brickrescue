<script lang="ts">
  import { tick, untrack } from "svelte";
  import CameraCapture from "./CameraCapture.svelte";
  import { askConfirm } from "../services/confirm.svelte";
  import { batch, removePieces, retryPiece, scheduleSave } from "../services/batch.svelte";
  import { BL_COLORS, blColor, blColorHex, getPartColorOptions, referenceImageUrl, type ColorSource } from "../services/bricklink";
  import { buildResultRow, recognizeImage, type PartCandidate, type ResultRow } from "../services/recognition";
  import { approve, saveColorReview, saveRescanDecision, useCandidate, type RescanDecision, type ReviewLog } from "../services/reviews";
  import { canvasToBlob, estimateImageColor, fileToCanvas } from "../services/imageTools";

  // Review one piece (gui.py): compare the photo with the BrickLink reference,
  // confirm or change the color, pick another candidate, rescan from another
  // angle, then Approve & Next. Every decision autosaves.
  interface Props {
    ids: string[]; // navigation order
    startId: string;
    onClose: () => void;
  }
  let { ids, startId, onClose }: Props = $props();

  let dialog = $state<HTMLDialogElement>();
  let currentId = $state(untrack(() => startId));
  let record = $derived(batch.records.find((entry) => entry.id === currentId));
  let row = $derived(record?.row ?? null);
  let position = $derived(ids.indexOf(currentId));
  let notice = $state("");
  // BrickLink's image server can be down; show a message instead of a broken image.
  let failedImages = $state<string[]>([]);
  const imageFailed = (url: string) => { if (!failedImages.includes(url)) failedImages.push(url); };

  $effect(() => {
    dialog?.showModal();
  });

  // --- Color choice ---
  let colorOptions = $state<string[]>([]);
  let colorSource = $state<ColorSource>("Fallback");
  let showAllColors = $state(false);
  let colorSearch = $state("");
  let pendingColor = $state<string | null>(null);
  let partForColors = $derived(row?.["Part ID"] ?? "");

  $effect(() => {
    const partId = partForColors;
    colorOptions = [];
    let cancelled = false;
    getPartColorOptions(partId).then((result) => {
      if (cancelled) return;
      colorOptions = result.ids;
      colorSource = result.source;
    });
    return () => { cancelled = true; };
  });

  let visibleColors = $derived.by(() => {
    const search = colorSearch.trim().toLowerCase();
    const ids = showAllColors || search ? BL_COLORS.map((color) => color.id) : colorOptions;
    const current = row?.["BrickLink Color ID"];
    const predicted = row?.["Predicted BrickLink Color ID"];
    const list = [...new Set([current, predicted, ...ids].filter((id): id is string => !!id && !!blColor(id)))];
    return search ? list.filter((id) => blColor(id)!.name.toLowerCase().includes(search)) : list;
  });

  function go(offset: number) {
    const next = ids[position + offset];
    if (!next) return;
    currentId = next;
    resetPanels();
  }

  function resetPanels() {
    pendingColor = null;
    colorSearch = "";
    showAllColors = false;
    rescan = null;
    rescanError = "";
    showCamera = false;
    notice = "";
  }

  function commit(change: (row: ResultRow, log: ReviewLog) => void, message: string) {
    if (!record?.row) return;
    change(record.row, record.log);
    scheduleSave();
    notice = message;
  }

  function saveColor() {
    if (!pendingColor) return;
    const name = blColor(pendingColor)?.name;
    commit((row, log) => saveColorReview(row, log, pendingColor!), `✓ Saved color: ${name}`);
    pendingColor = null;
  }

  async function approveAndNext() {
    if (!record?.row) return;
    // A color chosen but not yet saved is the employee's decision (gui.py).
    if (pendingColor) saveColor();
    commit((row, log) => approve(row, log), "✓ Approved");
    if (position + 1 < ids.length) {
      go(1);
    } else {
      notice = "✓ Last piece approved.";
    }
  }

  function chooseCandidate(candidate: PartCandidate) {
    commit((row) => useCandidate(row, candidate), `✓ Changed part to ${candidate.partId}`);
  }

  async function deletePiece() {
    if (!record) return;
    if (!await askConfirm(`Remove ${record.image} and its recognition result from this batch?`, { confirmLabel: "Delete", danger: true })) return;
    if (!record) return;
    const removed = record.id;
    const next = ids[position + 1] ?? ids[position - 1];
    ids = ids.filter((id) => id !== removed);
    removePieces([removed]);
    if (next) {
      currentId = next;
      resetPanels();
    } else {
      dialog?.close();
    }
  }

  // --- Rescan from another photo ---
  let rescanInput = $state<HTMLInputElement>();
  let showCamera = $state(false);
  let rescanBusy = $state(false);
  let rescanError = $state("");
  let rescan = $state<{ url: string; name: string; row: ResultRow; candidates: PartCandidate[] } | null>(null);
  let rescanCount = 0;

  async function runRescan(file: Blob, name: string) {
    showCamera = false;
    rescanBusy = true;
    rescanError = "";
    rescan = null;
    try {
      const canvas = await fileToCanvas(file);
      const blob = await canvasToBlob(canvas);
      const recognition = await recognizeImage(blob, name);
      const rescanRow = buildResultRow(name, recognition, estimateImageColor(canvas));
      if (!rescanRow) {
        rescanError = "No part was recognized in that photo. Try another angle or a closer photo.";
        return;
      }
      rescan = { url: URL.createObjectURL(blob), name, row: rescanRow, candidates: recognition.candidates };
    } catch (err) {
      console.error("Rescan failed:", err);
      rescanError = "The alternate image could not be processed. Check your connection and try again.";
    } finally {
      rescanBusy = false;
    }
  }

  function onRescanFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file && record) runRescan(file, `rescan_${++rescanCount}_${record.image.replace(/\.[^.]+$/, "")}.jpg`);
  }

  function decideRescan(decision: RescanDecision) {
    if (!rescan || !record) return;
    const result = rescan;
    commit((row, log) => saveRescanDecision(row, log, result.row, result.name, decision),
      decision === "Use Rescan Result" ? "✓ Saved the rescan result" : "✓ Kept the original result");
    if (decision === "Use Rescan Result") record.candidates = result.candidates;
    URL.revokeObjectURL(result.url);
    rescan = null;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) return;
    if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
    else if (event.key === "Enter" && !(event.target instanceof HTMLElement && event.target.closest("button, a"))) {
      event.preventDefault();
      approveAndNext();
    }
  }

  const badge = (value: string | undefined) => {
    const number = parseFloat(String(value ?? ""));
    if (!Number.isFinite(number)) return "";
    return number >= 80 ? "good" : number >= 50 ? "warn" : "bad";
  };

  $effect(() => {
    // Keep the dialog open on the current item when it disappears from a filtered list.
    if (!record && batch.restored) tick().then(() => dialog?.close());
  });
</script>

<dialog bind:this={dialog} class="review-dialog" aria-labelledby="review-title" onclose={onClose} onkeydown={onKeydown}>
  {#if record}
    <header class="review-header">
      <div>
        <h2 id="review-title">{row?.["Part Name"] ?? record.image}</h2>
        <p class="review-sub">{record.image}{#if record.box} · Photo #{record.box}{/if} · {position + 1} of {ids.length}</p>
      </div>
      <div class="review-nav">
        <button type="button" class="btn" disabled={position <= 0} onclick={() => go(-1)} aria-label="Previous piece">←</button>
        <button type="button" class="btn" disabled={position >= ids.length - 1} onclick={() => go(1)} aria-label="Next piece">→</button>
        <button type="button" class="btn" onclick={() => dialog?.close()}>Close</button>
      </div>
    </header>

    <div class="review-images">
      <figure>
        <figcaption>Uploaded image</figcaption>
        {#if record.cropUrl}
          <a href={record.cropUrl} target="_blank" rel="noopener" title="Open full size"><img src={record.cropUrl} alt={`Photographed piece ${record.image}`} /></a>
        {:else}
          <div class="review-image-empty">{record.manual ? "Added by hand" : "No photo (imported)"}</div>
        {/if}
      </figure>
      <figure>
        <figcaption>BrickLink catalog reference</figcaption>
        {#if row?.["Reference Image URL"] && failedImages.includes(row["Reference Image URL"])}
          <div class="review-image-empty">Catalog reference image could not be loaded. BrickLink may be unavailable.</div>
        {:else if row?.["Reference Image URL"]}
          <a href={row["Reference Image URL"]} target="_blank" rel="noopener" title="Open full size">
            {#key row["Reference Image URL"]}<img src={row["Reference Image URL"]} alt={`Catalog image of ${row["Part ID"]}`} onerror={() => imageFailed(row!["Reference Image URL"])} />{/key}
          </a>
        {:else}
          <div class="review-image-empty">Reference image will appear after processing</div>
        {/if}
      </figure>
    </div>

    {#if record.status !== "done" || !row}
      <div class="review-unidentified" role="status">
        {#if record.status === "queued" || record.status === "processing"}
          Identifying…
        {:else}
          <p>{record.status === "failed" ? (record.error ?? "The request failed.") : "No match found. Rescan from another angle or retry."}</p>
          <button type="button" class="btn primary" onclick={() => retryPiece(record!.id)}>Retry</button>
        {/if}
      </div>
    {:else}
      <dl class="review-details">
        <div><dt>Part ID</dt><dd class="mono">{row["Part ID"]}</dd></div>
        <div><dt>Type</dt><dd>{row["Type"]}</dd></div>
        <div><dt>LEGO color</dt><dd><span class="color-swatch" style:background-color={blColorHex(row["BrickLink Color ID"])} aria-hidden="true"></span> {row["LEGO Color"]} <span class="mono muted">#{row["BrickLink Color ID"] || "—"}</span></dd></div>
        <div><dt>Part confidence</dt><dd><span class="conf {badge(row['Part Confidence'])}">{row["Part Confidence"] || "—"}</span></dd></div>
        <div><dt>Color confidence</dt><dd><span class="conf {badge(row['Color Confidence'])}">{row["Color Confidence"] || "—"}</span></dd></div>
        <div><dt>Color method</dt><dd>{row["Color Method"] || "—"}</dd></div>
        <div><dt>Part check suggested</dt><dd class:flag={row["Part Review Required"] === "Yes"}>{row["Part Review Required"]} · {row["Part Approval Status"]}</dd></div>
        <div><dt>Color check suggested</dt><dd class:flag={row["Color Review Required"] === "Yes"}>{row["Color Review Required"]} · {row["Color Approval Status"]}</dd></div>
        <div><dt>Status</dt><dd><strong>{row["Final Review Status"]}</strong></dd></div>
        {#if row["Bounding Box Score"]}<div><dt>Detection score</dt><dd>{row["Bounding Box Score"]}</dd></div>{/if}
      </dl>

      <section class="review-section" aria-labelledby="color-heading">
        <div class="review-section-head">
          <h3 id="color-heading">Verify or change color</h3>
          <span class="muted">{colorSource === "Fallback" ? "Common colors (BrickLink list unavailable)" : `Colors this part comes in · ${colorSource}`}</span>
        </div>
        <div class="color-tools">
          <input type="search" placeholder="Search colors" bind:value={colorSearch} aria-label="Search colors" />
          <label><input type="checkbox" bind:checked={showAllColors} /> All colors</label>
        </div>
        <ul class="color-grid" aria-label="Colors">
          {#each visibleColors as id (id)}
            {@const color = blColor(id)!}
            <li>
              <button type="button" aria-pressed={(pendingColor ?? row["BrickLink Color ID"]) === id}
                class:predicted={row["Predicted BrickLink Color ID"] === id}
                onclick={() => { pendingColor = id === row!["BrickLink Color ID"] ? null : id; }}>
                <span class="color-swatch" style:background-color={blColorHex(id)} aria-hidden="true"></span>
                {color.name}
              </button>
            </li>
          {/each}
        </ul>
        <div class="review-row">
          <button type="button" class="btn" disabled={!pendingColor && row["Color Review Completed"] === "Yes"}
            onclick={() => { if (pendingColor) saveColor(); else commit((r, l) => saveColorReview(r, l, r["BrickLink Color ID"]), `✓ Confirmed ${row!["LEGO Color"]}`); }}>
            {pendingColor ? `Save color: ${blColor(pendingColor)?.name}` : "Confirm color"}
          </button>
        </div>
      </section>

      {#if record.candidates.length > 1}
        <details class="review-section">
          <summary><h3>Choose similar part ({record.candidates.length} candidates)</h3></summary>
          <ul class="candidate-list">
            {#each record.candidates as candidate, rank (rank)}
              <li>
                <button type="button" aria-pressed={candidate.partId === row["Part ID"]} onclick={() => chooseCandidate(candidate)}>
                  <img loading="lazy" src={referenceImageUrl(candidate.partId, row["BrickLink Color ID"]) || candidate.imageUrl} alt=""
                    onerror={(event) => { (event.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
                  <span><strong class="mono">{rank + 1}. {candidate.partId}</strong> {candidate.name}</span>
                  <span class="conf {badge(String(candidate.score))}">{candidate.score.toFixed(1)}%</span>
                </button>
              </li>
            {/each}
          </ul>
        </details>
      {:else if !record.manual}
        <p class="muted">Brickognize did not return alternative part candidates for this image. Use Rescan Part to try another angle.</p>
      {/if}

      <section class="review-section" aria-labelledby="rescan-heading">
        <h3 id="rescan-heading">Rescan part</h3>
        {#if showCamera}
          <CameraCapture onCapture={(blob) => runRescan(blob, `rescan_${++rescanCount}_${record!.image.replace(/\.[^.]+$/, "")}.jpg`)} onCancel={() => { showCamera = false; }} />
        {:else if rescan}
          <div class="rescan-compare">
            {#each [{ title: "Original", url: record.cropUrl, r: row }, { title: "Rescan", url: rescan.url, r: rescan.row }] as side (side.title)}
              <div class="rescan-card">
                <h4>{side.title}</h4>
                {#if side.url}<img src={side.url} alt={`${side.title} photo`} />{/if}
                <p><strong class="mono">{side.r["Part ID"]}</strong> {side.r["Part Name"]}</p>
                <p>{side.r["LEGO Color"]} · part {side.r["Part Confidence"]} · color {side.r["Color Confidence"]}</p>
              </div>
            {/each}
          </div>
          <div class="review-row">
            <button type="button" class="btn" onclick={() => decideRescan("Keep Original")}>Keep Original</button>
            <button type="button" class="btn primary" onclick={() => decideRescan("Use Rescan Result")}>Use Rescan Result</button>
            <button type="button" class="btn" onclick={() => { URL.revokeObjectURL(rescan!.url); rescan = null; }}>Try Another Image</button>
          </div>
        {:else}
          <div class="review-row">
            <button type="button" class="btn" disabled={rescanBusy} onclick={() => { showCamera = true; }}>Take Photo Now</button>
            <button type="button" class="btn" disabled={rescanBusy} onclick={() => rescanInput?.click()}>Upload Existing Photo</button>
            {#if rescanBusy}<span role="status">Processing…</span>{/if}
          </div>
          {#if rescanError}<p class="review-error" role="alert">{rescanError}</p>{/if}
        {/if}
        <input bind:this={rescanInput} type="file" accept="image/*" hidden onchange={onRescanFile} />
      </section>
    {/if}

    <footer class="review-footer">
      <div class="review-row">
        {#if row?.["BrickLink URL"] && row["BrickLink URL"] !== "N/A"}
          <a class="btn" href={row["BrickLink URL"]} target="_blank" rel="noopener noreferrer">Open BrickLink ↗</a>
        {/if}
        <button type="button" class="btn danger" onclick={deletePiece}>Delete piece</button>
      </div>
      <div class="review-row">
        {#if notice}<span class="review-notice" role="status">{notice}</span>{/if}
        <button type="button" class="btn primary" disabled={!row} onclick={approveAndNext} title="Enter">Approve &amp; Next</button>
      </div>
    </footer>
  {/if}
</dialog>
