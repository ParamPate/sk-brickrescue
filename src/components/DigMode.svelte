<script lang="ts">
  import { resolveColor } from "../services/catalog.svelte";
  import PartImage from "./PartImage.svelte";
  import type { MatchResult, BrickPart } from "../services/types";

  // --- PROPS (Svelte 5 Runes) ---
  interface Props {
    matchResult: MatchResult;
    onBack: () => void;
    onFindPartManually: (part: BrickPart) => void;
    onUnmarkPart: (part: BrickPart) => void;
  }
  let {
    matchResult,
    onBack,
    onFindPartManually,
    onUnmarkPart
  }: Props = $props();

  // --- DERIVED STATE ---
  let totalKeyParts = $derived(matchResult.matchedParts.length + matchResult.missingParts.length);
  let progressPercent = $derived(totalKeyParts > 0 ? Math.round((matchResult.matchedParts.length / totalKeyParts) * 100) : 0);

  // One combined list drives a single card template (found parts first)
  let checklistItems = $derived([
    ...matchResult.matchedParts.map((part) => ({ part, found: true })),
    ...matchResult.missingParts.map((part) => ({ part, found: false }))
  ]);

  // Format raw rarity (0..1) into a dressed, labelled value.
  const formatRarity = (score: number): string =>
    score >= 1 ? "Unique" : `Rarity ${Math.round(score * 100)}%`;
</script>

<div class="dig-panel">
  <!-- Header -->
  <header class="app-header">
    <button class="header-back-btn" onclick={onBack} title="Back to Radar">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
      <span>Back</span>
    </button>
    <h1 class="brand-title"><img src="/brickrescue-logo.png" alt="SK BrickRescue" /></h1>
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
      </p>
    </div>

    <!-- Progress Gauge -->
    <div class="dig-progress-gauge">
      <div class="dig-progress-header">
        <span>Key artifacts unearthed:</span>
        <span>{matchResult.matchedParts.length} of {totalKeyParts} ({progressPercent}%)</span>
      </div>
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
      <span class="panel-section-title">Diagnostic Parts</span>
      <span class="checklist-subtitle">
        {progressPercent === 100 ? "Relic fully reconstructed!" : "Excavate remaining parts"}
      </span>
    </div>

    <div class="checklist-items">
      {#each checklistItems as item (item.part.part_num + '_' + item.part.color_id)}
        {@const colorInfo = resolveColor(item.part.color_id)}
        <div class="check-item-card {item.found ? 'found' : ''}">
          <PartImage
            src={item.part.imageUrl}
            alt={item.part.name}
            wrapperClass="check-item-img-wrapper"
            imgClass="check-item-img"
            colorHex={colorInfo?.hex || '#777'}
            fallbackClass="check-item-color-chip"
          />
          <div class="check-item-details">
            <span class="check-item-name">{item.part.name}</span>
            <div class="check-item-meta">
              <span class="color-dot" style="background-color: {colorInfo?.hex || '#777'}"></span>
              <span>{item.part.part_num} · {colorInfo?.name}</span>
              <span class="rarity-indicator">{formatRarity(item.part.rarity_score)}</span>
            </div>
          </div>
          <div class="item-action-wrapper">
            {#if item.found}
              <!-- Found is a toggle: tap to undo a mis-tap and return the part to "not found". -->
              <button
                class="badge-found"
                onclick={() => onUnmarkPart(item.part)}
                title="Mark as not found"
              >
                <!-- Check Icon -->
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Found
              </button>
            {:else}
              <button
                class="btn-action"
                onclick={() => onFindPartManually(item.part)}
              >
                <!-- Plus Icon -->
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>
                Found
              </button>
            {/if}
          </div>
        </div>
      {/each}

      {#if totalKeyParts === 0}
        <div class="checklist-empty">
          No specific key parts cataloged for this set.
        </div>
      {/if}
    </div>
  </div>
</div>
