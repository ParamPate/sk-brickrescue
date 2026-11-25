<script lang="ts">
  import { onMount, tick } from "svelte";
  import PartImage from "./PartImage.svelte";
  import { addManualPiece, batch, removePieces } from "../services/batch.svelte";
  import { loadCatalogIndex, loadPartCategories, setImageUrl, type CatalogSetIndexEntry } from "../services/catalog.svelte";
  import { askConfirm, showNotice } from "../services/confirm.svelte";
  import { downloadFile, timestamp } from "../services/exporters";
  import { hasApiKey, loadSetInventory, normalizeSetNum, SetNotFoundError, type SetInventory } from "../services/rebrickable";
  import { buildReport, haveFromRecords, reportCsv, wantedListXml, type ReportRow, type RowStatus, type Variations } from "../services/verification";

  // Verify a set against the scanned pieces (the desktop Set Verification
  // workflow): the report recomputes instantly as pieces are scanned, counted
  // or substituted — there is no separate "Compare" step.

  const RECENT_KEY = "sk-verify-recent";
  const STATE_KEY = (setNum: string) => `sk-verify:${setNum}`;
  const MAX_SUGGESTIONS = 8;

  // --- Set search with instant suggestions from the local catalog ---
  let query = $state("");
  let searchInput = $state<HTMLInputElement>();
  let sets = $state<Record<string, CatalogSetIndexEntry>>({});
  let setNums: string[] = [];
  let highlighted = $state(0);
  let showSuggestions = $state(false);
  let recent = $state<string[]>(readJson(RECENT_KEY, []));

  loadCatalogIndex().then((index) => {
    sets = index.sets;
    setNums = Object.keys(index.sets);
  }).catch(() => {});

  let suggestions = $derived.by(() => {
    const text = query.trim().toLowerCase();
    if (!text || !setNums.length) return [];
    const starts: string[] = [], contains: string[] = [];
    const byNumber = /^\d/.test(text);
    for (const setNum of setNums) {
      if (byNumber ? setNum.startsWith(text) : sets[setNum].n.toLowerCase().startsWith(text)) starts.push(setNum);
      else if (!byNumber && sets[setNum].n.toLowerCase().includes(text)) contains.push(setNum);
      if (starts.length >= MAX_SUGGESTIONS) break;
    }
    // Exact number first, then newest sets
    const byYear = (a: string, b: string) => sets[b].y - sets[a].y;
    return [...starts.sort((a, b) => Number(b === normalizeSetNum(text)) - Number(a === normalizeSetNum(text)) || byYear(a, b)),
      ...contains.sort(byYear)].slice(0, MAX_SUGGESTIONS);
  });

  function readJson<T>(key: string, fallback: T): T {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage blocked: the session still works.
    }
  }

  function onSearchKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      showSuggestions = true;
      highlighted = Math.min(highlighted + 1, suggestions.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
    } else if (event.key === "Escape") {
      showSuggestions = false;
    }
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    const pick = showSuggestions && suggestions[highlighted] && !/^\d+(-\d+)?$/.test(query.trim())
      ? suggestions[highlighted]
      : normalizeSetNum(query);
    open(pick);
  }

  // --- Loaded set and per-set decisions (persisted per set) ---
  let inventory = $state<SetInventory | null>(null);
  let loading = $state(false);
  let error = $state("");
  let allocations = $state<Record<string, number>>({});
  let remarks = $state<Record<string, string>>({});
  let removed = $state<Record<string, boolean>>({});
  let controller: AbortController | null = null;

  let variations = $state<Variations>({});
  let variationsPromise: Promise<void> | null = null;
  function loadVariations() {
    variationsPromise ??= fetch("/catalog/variations.json")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => { variations = data; })
      .catch(() => { variationsPromise = null; });
    return variationsPromise;
  }

  async function open(input: string, refresh = false) {
    const setNum = normalizeSetNum(input);
    if (!setNum) return;
    showSuggestions = false;
    query = setNum;
    controller?.abort();
    controller = new AbortController();
    loading = true;
    error = "";
    loadVariations();
    try {
      const result = await loadSetInventory(setNum, { signal: controller.signal, refresh });
      inventory = result;
      const saved = readJson(STATE_KEY(result.setNum), { allocations: {}, remarks: {}, removed: {} });
      allocations = saved.allocations ?? {};
      remarks = saved.remarks ?? {};
      removed = saved.removed ?? {};
      recent = [result.setNum, ...recent.filter((entry) => entry !== result.setNum)].slice(0, 6);
      writeJson(RECENT_KEY, recent);
      writeJson("sk-verify-last", result.setNum);
      filter = "Missing";
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      error = err instanceof SetNotFoundError
        ? `Set ${setNum} was not found. Check the number (for example 40611 or 40611-1).`
        : "The set's part list could not be loaded. Check your connection and try again.";
    } finally {
      loading = false;
    }
  }

  function persist() {
    if (inventory) writeJson(STATE_KEY(inventory.setNum), { allocations, remarks, removed });
  }

  onMount(() => {
    const last = readJson<string | null>("sk-verify-last", null);
    if (last) open(last);
    else searchInput?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, dialog"))) {
        event.preventDefault();
        searchInput?.focus();
        searchInput?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      controller?.abort();
    };
  });

  // --- Live report ---
  let categories = $state<{ names: Record<number, string>; parts: Record<string, number> }>({ names: {}, parts: {} });
  loadPartCategories().then((data) => { categories = data; });
  const categoryOf = (part: string) => categories.names[categories.parts[part] ?? -1] ?? "";

  let report = $derived(inventory ? buildReport(inventory, haveFromRecords(batch.records, inventory), variations, allocations, categoryOf) : null);
  let percent = $derived(report && report.requiredPieces ? Math.round((report.foundPieces / report.requiredPieces) * 100) : 0);
  let pendingIdentification = $derived(batch.records.filter((r) => r.status === "queued" || r.status === "processing").length);

  type Filter = RowStatus | "All";
  let filter = $state<Filter>("Missing");
  let rowSearch = $state("");
  const FILTERS: Filter[] = ["Missing", "Extra", "Not in set", "Complete", "All"];

  let visibleRows = $derived.by(() => {
    if (!report) return [];
    const text = rowSearch.trim().toLowerCase();
    return report.rows.filter((row) =>
      (filter === "All" || row.status === filter) &&
      (!text || row.name.toLowerCase().includes(text) || row.part.toLowerCase().includes(text) ||
        row.blPart.toLowerCase().includes(text) || row.colorName.toLowerCase().includes(text) ||
        row.category.toLowerCase().includes(text)));
  });

  // --- Sorting (remembered between visits) ---
  const SORTS = {
    missing: "Most missing",
    color: "Color",
    category: "Category",
    name: "Part name",
    part: "Part number"
  } as const;
  type Sort = keyof typeof SORTS;
  let sort = $state<Sort>(readJson<Sort>("sk-verify-sort", "missing"));
  $effect(() => writeJson("sk-verify-sort", sort));

  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const amount = (row: ReportRow) => row.missing + row.extra;

  // Sorted rows, with group headings when sorting by color or category
  type Item = { kind: "group"; key: string; label: string; hex?: string; pieces: number } | { kind: "row"; key: string; row: ReportRow };
  let sortedItems = $derived.by((): Item[] => {
    const rows = [...visibleRows];
    const groupOf = sort === "color" ? (row: ReportRow) => row.colorName
      : sort === "category" ? (row: ReportRow) => row.category || "Other" : null;
    const compare: Record<Sort, (a: ReportRow, b: ReportRow) => number> = {
      missing: (a, b) => amount(b) - amount(a) || natural(a.name, b.name),
      color: (a, b) => natural(a.colorName, b.colorName) || amount(b) - amount(a) || natural(a.name, b.name),
      category: (a, b) => natural(a.category || "~", b.category || "~") || natural(a.name, b.name),
      name: (a, b) => natural(a.name, b.name) || natural(a.colorName, b.colorName),
      part: (a, b) => natural(a.part, b.part) || natural(a.colorName, b.colorName)
    };
    rows.sort(compare[sort]);
    if (!groupOf) return rows.map((row) => ({ kind: "row", key: row.key, row }));
    type Group = Extract<Item, { kind: "group" }>;
    const items: Item[] = [];
    const groups: Group[] = [];
    for (const row of rows) {
      const label = groupOf(row);
      let group = groups.at(-1);
      if (!group || group.label !== label) {
        group = { kind: "group", key: `group:${label}`, label, hex: sort === "color" ? row.colorHex : undefined, pieces: 0 };
        groups.push(group);
        items.push(group);
      }
      group.pieces += filter === "Complete" || filter === "All" ? row.required : amount(row);
      items.push({ kind: "row", key: row.key, row });
    }
    return items;
  });

  let removalLeft = $derived(report ? report.rows.filter((row) => row.extra > 0 && !removed[row.key]).length : 0);

  // --- Actions ---
  function setAllocation(key: string, value: number) {
    allocations = { ...allocations, [key]: Math.max(0, value) };
    persist();
  }

  function addPiece(row: ReportRow) {
    addManualPiece(row.blPart || row.part, row.name, row.blColor, { part: row.part, color: row.color });
  }

  async function removePiece(row: ReportRow) {
    const id = row.manualIds.at(-1) ?? row.recordIds.at(-1);
    if (!id) return;
    if (!row.manualIds.length && !await askConfirm(`Remove one scanned ${row.name} and its recognition result?`, { confirmLabel: "Remove", danger: true })) return;
    removePieces([id]);
  }

  function exportCsv() {
    if (!inventory || !report) return;
    downloadFile(`verification_${inventory.setNum}_${timestamp()}.csv`, reportCsv(report.rows, remarks), "text/csv;charset=utf-8");
  }

  function exportXml() {
    if (!inventory || !report) return;
    const { xml, skipped } = wantedListXml(report.rows, remarks);
    if (!report.missingPieces) {
      showNotice("Nothing is missing, so there is no wanted list to export.");
      return;
    }
    downloadFile(`wanted_list_${inventory.setNum}_${timestamp()}.xml`, xml, "application/xml");
    if (skipped.length) {
      showNotice(`${skipped.length} missing part${skipped.length === 1 ? " has" : "s have"} no BrickLink ID and ${skipped.length === 1 ? "was" : "were"} left out of the wanted list. They are still in the CSV report.`);
    }
  }

  async function chooseRecent(setNum: string) {
    query = setNum;
    await tick();
    open(setNum);
  }
</script>

<section class="verify" aria-labelledby="verify-title">
  <div class="verify-search-card">
    <h2 id="verify-title" class="panel-section-title">Verify a set</h2>
    <form class="verify-search" onsubmit={submitSearch} role="search">
      <div class="verify-search-box">
        <input bind:this={searchInput} bind:value={query} type="search" inputmode="search" autocomplete="off"
          placeholder="Set number or name, e.g. 40611 or dragon" aria-label="Set number or name"
          role="combobox" aria-expanded={showSuggestions && suggestions.length > 0} aria-controls="verify-suggestions"
          oninput={() => { showSuggestions = true; highlighted = 0; }} onkeydown={onSearchKey}
          onfocus={() => { showSuggestions = true; }} onblur={() => setTimeout(() => { showSuggestions = false; }, 150)} />
        {#if showSuggestions && suggestions.length}
          <ul id="verify-suggestions" class="verify-suggestions" role="listbox">
            {#each suggestions as setNum, index (setNum)}
              <li role="option" aria-selected={index === highlighted}>
                <button type="button" class:active={index === highlighted} onmousedown={(e) => e.preventDefault()} onclick={() => open(setNum)}>
                  <img src={setImageUrl(setNum, sets[setNum])} alt="" loading="lazy" />
                  <span><strong class="mono">{setNum}</strong> {sets[setNum].n}</span>
                  <span class="muted">{sets[setNum].y} · {sets[setNum].t} pcs</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      <button type="submit" class="btn primary" disabled={loading || !query.trim()}>{loading ? "Loading…" : "Load set"}</button>
    </form>
    {#if recent.length}
      <div class="verify-recent" aria-label="Recent sets">
        {#each recent as setNum (setNum)}
          <button type="button" class="chip" aria-pressed={inventory?.setNum === setNum} onclick={() => chooseRecent(setNum)}>{setNum}</button>
        {/each}
      </div>
    {/if}
    {#if !hasApiKey()}
      <p class="muted">No Rebrickable API key is set, so part lists come from the local catalog (without minifigure parts).</p>
    {/if}
    {#if error}<p class="review-error" role="alert">{error}</p>{/if}
  </div>

  {#if loading && !inventory}
    <div class="verify-skeleton" aria-hidden="true"></div>
  {/if}

  {#if inventory && report}
    <div class="verify-summary" class:refreshing={loading}>
      <PartImage src={inventory.image} alt={inventory.name} wrapperClass="verify-set-img" imgClass="verify-set-img-el" iconSize={28} />
      <div class="verify-set-info">
        <span class="mono muted">{inventory.setNum}</span>
        <h3>{inventory.name}</h3>
        <span class="muted">{inventory.year} · {report.requiredPieces} pieces · {inventory.source}
          <button type="button" class="link-btn" onclick={() => open(inventory!.setNum, true)} title="Reload from Rebrickable">Refresh</button></span>
      </div>
      <div class="verify-progress">
        <div class="verify-progress-head"><strong>{percent}%</strong> <span>{report.foundPieces} of {report.requiredPieces} pieces</span></div>
        <div class="dig-progress-track"><div class="dig-progress-fill" class:complete={percent === 100} style:width="{percent}%"></div></div>
        {#if pendingIdentification}<span class="muted">{pendingIdentification} piece{pendingIdentification === 1 ? "" : "s"} still being identified…</span>{/if}
      </div>
      <div class="verify-exports">
        <button type="button" class="btn" onclick={exportCsv}>Report CSV</button>
        <button type="button" class="btn" onclick={exportXml} disabled={!report.missingPieces}>BrickLink wanted list</button>
      </div>
    </div>

    <div class="verify-tabs" role="tablist" aria-label="Filter parts">
      {#each FILTERS as option (option)}
        {@const lines = option === "All" ? report.rows.length : report.counts[option]}
        <button type="button" role="tab" class="verify-tab tab-{option.replace(/ /g, '-').toLowerCase()}" aria-selected={filter === option}
          onclick={() => { filter = option; }}>
          <span>{option}</span>
          <strong>{option === "Missing" ? report.missingPieces : option === "Extra" ? report.rows.filter((r) => r.status === "Extra").reduce((s, r) => s + r.extra, 0) : option === "Not in set" ? report.rows.filter((r) => r.status === "Not in set").reduce((s, r) => s + r.extra, 0) : lines}</strong>
          <small>{option === "Complete" || option === "All" ? "lines" : `pcs · ${lines} lines`}</small>
        </button>
      {/each}
    </div>

    {#if report.proposals.length}
      <section class="verify-subs" aria-labelledby="subs-title">
        <h3 id="subs-title">Possible substitutes <span class="muted">— same color, related part. Nothing counts until you accept it.</span></h3>
        <ul>
          {#each report.proposals as proposal (proposal.key)}
            <li class="sub-card" class:accepted={proposal.allocated > 0}>
              <div class="sub-parts">
                <PartImage src={proposal.sourceImage} alt="" wrapperClass="sub-img" imgClass="sub-img-el" colorHex={proposal.colorHex} fallbackClass="check-item-color-chip" />
                <div class="sub-text">
                  <span class="sub-label">You have {proposal.sourceQty}×</span>
                  <strong>{proposal.sourceName}</strong>
                  <span class="mono muted">{proposal.sourcePart} · <span class="color-dot" style:background-color={proposal.colorHex}></span> {proposal.colorName}</span>
                </div>
                <span class="sub-arrow" aria-hidden="true">→</span>
                <PartImage src={proposal.targetImage} alt="" wrapperClass="sub-img" imgClass="sub-img-el" colorHex={proposal.colorHex} fallbackClass="check-item-color-chip" />
                <div class="sub-text">
                  <span class="sub-label">Set needs {proposal.targetShortage} more</span>
                  <strong>{proposal.targetName}</strong>
                  <span class="mono muted">{proposal.targetPart}</span>
                </div>
              </div>
              <div class="sub-actions">
                <span class="sub-kind" class:alt={proposal.relType === "A"}
                  title={proposal.relType === "M" ? "Same part from a different mold: same function" : "Rebrickable lists it as an alternative: check it fits the build"}>
                  {proposal.relType === "M" ? "Mold variation" : "Alternative · check fit"}
                </span>
                <div class="check-item-count" role="group" aria-label="Pieces to use as substitutes">
                  <button type="button" class="btn-action" disabled={proposal.allocated === 0} onclick={() => setAllocation(proposal.key, proposal.allocated - 1)} aria-label="Use one fewer">−</button>
                  <span>{proposal.allocated}/{proposal.max}</span>
                  <button type="button" class="btn-action" disabled={proposal.allocated >= proposal.max} onclick={() => setAllocation(proposal.key, proposal.allocated + 1)} aria-label="Use one more">+</button>
                </div>
                {#if proposal.allocated < proposal.max}
                  <button type="button" class="btn" onclick={() => setAllocation(proposal.key, proposal.max)}>Use {proposal.max}</button>
                {:else if proposal.allocated > 0}
                  <button type="button" class="btn" onclick={() => setAllocation(proposal.key, 0)}>Undo</button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if (filter === "Extra" || filter === "Not in set") && removalLeft > 0}
      <p class="verify-hint">Take the surplus pieces off the table and tick them off: {removalLeft} line{removalLeft === 1 ? "" : "s"} left.</p>
    {/if}

    <div class="verify-toolbar">
      <input type="search" bind:value={rowSearch} placeholder="Filter by part, number, color or category" aria-label="Filter parts" />
      <label class="verify-sort">Sort by
        <select bind:value={sort}>
          {#each Object.entries(SORTS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      <span class="muted">{visibleRows.length} line{visibleRows.length === 1 ? "" : "s"}</span>
    </div>

    {#if visibleRows.length}
      <ul class="verify-rows">
        {#each sortedItems as item (item.key)}
          {#if item.kind === "group"}
            <li class="verify-group">
              {#if item.hex}<span class="color-dot" style:background-color={item.hex} aria-hidden="true"></span>{/if}
              <strong>{item.label}</strong>
              <span class="muted">{item.pieces} pc{item.pieces === 1 ? "" : "s"}</span>
            </li>
          {:else}
          {@const row = item.row}
          <li class="verify-row status-{row.status.replace(/ /g, '-').toLowerCase()}" class:done={removed[row.key] && row.extra > 0}>
            <PartImage src={row.image} alt="" wrapperClass="verify-row-img" imgClass="verify-row-img-el" colorHex={row.colorHex} fallbackClass="check-item-color-chip" />
            <div class="verify-row-main">
              <span class="verify-row-name">{row.name}</span>
              <span class="verify-row-meta">
                <span class="mono">{row.part}</span>{#if row.blPart && row.blPart !== row.part}<span class="mono muted"> (BL {row.blPart})</span>{/if}
                · <span class="color-dot" style:background-color={row.colorHex} aria-hidden="true"></span> {row.colorName}
                {#if row.category && sort !== "category"}<span class="muted"> · {row.category}</span>{/if}
              </span>
              {#if row.note}<span class="verify-row-note">{row.note}</span>{/if}
              {#if row.missing > 0}
                <input class="verify-remark" type="text" placeholder="Bag / wanted-list remark" value={remarks[row.key] ?? ""}
                  aria-label={`Remark for ${row.name}`}
                  onchange={(e) => { remarks = { ...remarks, [row.key]: e.currentTarget.value }; persist(); }} />
              {/if}
            </div>
            <div class="verify-row-qty">
              <span class="qty-need" title="Needed by the set">{row.required}</span>
              <div class="check-item-count" role="group" aria-label={`Pieces you have of ${row.name}`}>
                <button type="button" class="btn-action" disabled={!row.recordIds.length} onclick={() => removePiece(row)} aria-label="One fewer">−</button>
                <span title="You have">{row.have}</span>
                <button type="button" class="btn-action" onclick={() => addPiece(row)} aria-label="One more">+</button>
              </div>
              <span class="status-chip">{row.status === "Missing" ? `−${row.missing}` : row.extra > 0 ? `+${row.extra}` : "✓"}</span>
              {#if row.extra > 0}
                <label class="removed-toggle" title="Surplus taken off the table">
                  <input type="checkbox" checked={!!removed[row.key]} onchange={(e) => { removed = { ...removed, [row.key]: e.currentTarget.checked }; persist(); }} />
                  Removed
                </label>
              {/if}
            </div>
          </li>
          {/if}
        {/each}
      </ul>
    {:else}
      <p class="results-empty">
        {rowSearch ? "No parts match that filter." : filter === "Missing" ? "Nothing is missing. 🎉" : `No ${filter.toLowerCase()} parts.`}
      </p>
    {/if}
  {:else if !loading && !error}
    <p class="results-empty">Enter a set number to compare it with the pieces you scanned. Press <kbd>/</kbd> to jump to the search box.</p>
  {/if}
</section>
