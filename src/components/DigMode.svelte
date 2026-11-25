<script lang="ts">
  import { resolveColor } from "../services/catalog.svelte";
  import PartImage from "./PartImage.svelte";
  import type { ChecklistPart, MatchResult } from "../services/types";
  import { askConfirm } from "../services/confirm.svelte";

  // --- PROPS (Svelte 5 Runes) ---
  interface Props {
    matchResult: MatchResult;
    onBack: () => void;
    onFindPartManually: (part: ChecklistPart) => void;
    onUnmarkPart: (part: ChecklistPart) => void;
    onFixColors: (match: MatchResult) => number;
  }
  let {
    matchResult,
    onBack,
    onFindPartManually,
    onUnmarkPart,
    onFixColors
  }: Props = $props();

  // --- DERIVED STATE ---
  let progressPercent = $derived(matchResult.totalPieces > 0
    ? Math.round((matchResult.foundPieces / matchResult.totalPieces) * 100) : 0);
  let missingLines = $derived(matchResult.checklist.filter((part) => part.found < part.quantity).length);
  let showComplete = $state(false);
  let recolorable = $derived(matchResult.checklist.reduce((total, part) =>
    total + part.borrowed.reduce((sum, entry) => sum + entry.qty, 0), 0));
  let fixMessage = $state("");

  async function fixColors() {
    if (!await askConfirm(`Change the color of ${recolorable} scanned piece${recolorable === 1 ? "" : "s"} to the color this set uses for that part? Each change is saved as a corrected color review.`,
      { confirmLabel: "Fix colors" })) return;
    const changed = onFixColors(matchResult);
    fixMessage = `✓ Corrected ${changed} piece${changed === 1 ? "" : "s"} to this set's colors.`;
  }

  let visibleLines = $derived(showComplete ? matchResult.checklist : matchResult.checklist.filter((part) => part.found < part.quantity));
</script>

<div class="dig-panel">
  <!-- Header -->
  <header class="app-header">
    <button class="header-back-btn" onclick={onBack} title="Back to Radar">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      <span>Back</span>
    </button>
    <h1 class="brand-title">SK Brickhouse</h1>
    <div class="header-actions"></div>
  </header>

  <!-- Set Hero Banner -->
  <div class="dig-hero">
    <PartImage
      src={matchResult.imageUrl}
      alt={matchResult.name}
      wrapperClass="dig-hero-img-wrapper"
      imgClass="dig-hero-img"
      iconSize={32}
    />
    <div class="dig-hero-details">
      <div class="dig-hero-title-row">
        <span class="dig-hero-num">{matchResult.set_num}</span>
      </div>
      <h1 class="dig-hero-name">{matchResult.name}</h1>
      <p class="dig-hero-meta">
        Year: {matchResult.year} · Total Parts: {matchResult.total_parts}
        {#if matchResult.pileCoverage > 0}
          · {Math.round(matchResult.pileCoverage * 100)}% of your scanned pieces are in this set
        {/if}
      </p>
    </div>

    <!-- Progress Gauge -->
    <div class="dig-progress-gauge">
      <div class="dig-progress-header">
        <span>Pieces found:</span>
        <span>{matchResult.foundPieces} of {matchResult.totalPieces} ({progressPercent}%)</span>
      </div>
      {#if recolorable > 0}
        <div class="dig-fix-colors">
          <span>{recolorable} scanned piece{recolorable === 1 ? " matches" : "s match"} this set's parts in a different color.</span>
          <button type="button" class="btn" onclick={fixColors}>Fix colors using this set</button>
        </div>
      {/if}
      {#if fixMessage}<p class="dig-fix-message" role="status">{fixMessage}</p>{/if}
      <div class="dig-progress-track">
        <div
          class="dig-progress-fill {progressPercent === 100 ? 'complete' : ''}"
          style="width: {progressPercent}%"
        ></div>
      </div>
    </div>
  </div>

  <!-- Checklist section -->
  <div class="dig-checklist-section">
    <div class="checklist-title-bar">
      <span class="panel-section-title">Set Inventory</span>
      <span class="checklist-subtitle">
        {missingLines === 0 ? "Every piece found!" : `${missingLines} part${missingLines === 1 ? "" : "s"} still missing`}
      </span>
      <label class="checklist-toggle">
        <input type="checkbox" bind:checked={showComplete} /> Show found parts
      </label>
    </div>

    <div class="checklist-items">
      {#each visibleLines as part (part.part_num + '_' + part.color_id)}
        {@const colorInfo = resolveColor(part.color_id)}
        {@const complete = part.found >= part.quantity}
        <div class="check-item-card {complete ? 'found' : ''}">
          <PartImage
            src={part.imageUrl}
            alt={part.name}
            wrapperClass="check-item-img-wrapper"
            imgClass="check-item-img"
            colorHex={colorInfo?.hex || '#777'}
            fallbackClass="check-item-color-chip"
          />
          <div class="check-item-details">
            <span class="check-item-name">{part.name}</span>
            <div class="check-item-meta">
              <span class="color-dot" style="background-color: {colorInfo?.hex || '#777'}"></span>
              <span>{part.part_num} · {colorInfo?.name}</span>
              {#if part.colorMismatch}
                <span class="rarity-indicator" title="Some of these pieces were scanned in a different color">color differs</span>
              {/if}
            </div>
          </div>
          <div class="item-action-wrapper check-item-count" role="group" aria-label={`Found ${part.found} of ${part.quantity} ${part.name}`}>
            <button class="btn-action" disabled={part.found === 0} onclick={() => onUnmarkPart(part)}
              aria-label="One fewer found" title="One fewer found">−</button>
            <span class:badge-found={complete}>{part.found}/{part.quantity}</span>
            <button class="btn-action" disabled={complete} onclick={() => onFindPartManually(part)}
              aria-label="Found one more" title="Found one more">+</button>
          </div>
        </div>
      {/each}

      {#if matchResult.checklist.length === 0}
        <div class="checklist-empty">
          No parts list is cataloged for this set.
        </div>
      {:else if visibleLines.length === 0}
        <div class="checklist-empty">
          Every piece of this set has been found.
        </div>
      {/if}
    </div>
  </div>
</div>
