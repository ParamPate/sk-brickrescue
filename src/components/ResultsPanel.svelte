<script lang="ts">
  import { showNotice } from "../services/confirm.svelte";
  import { addImportedRows, batch, getRawResponse, retryAllFailed, summarize, type PieceRecord } from "../services/batch.svelte";
  import { blColorHex } from "../services/bricklink";
  import {
    buildCsv,
    buildExcelReport,
    downloadFile,
    normalizeImportedRows,
    parseCsv,
    responsesJson,
    resultRows,
    reviewsJson,
    timestamp
  } from "../services/exporters";

  // The desktop app's batch list, counters, filters and file exports.
  interface Props {
    onOpen: (id: string, ids: string[]) => void;
    onNewBatch: () => void;
  }
  let { onOpen, onNewBatch }: Props = $props();

  const FILTERS = {
    all: "All pieces",
    checks: "Suggested checks",
    part: "Part check",
    color: "Color check",
    ready: "Ready",
    unidentified: "Unidentified / failed"
  } as const;
  type Filter = keyof typeof FILTERS;
  let filter = $state<Filter>("all");

  let stats = $derived(summarize(batch.records));
  const needsPart = (r: PieceRecord) => r.row?.["Part Review Required"] === "Yes";
  const needsColor = (r: PieceRecord) => r.row?.["Color Review Required"] === "Yes";
  let visible = $derived(batch.records.filter((record) => {
    const done = record.status === "done";
    switch (filter) {
      case "checks": return done && (needsPart(record) || needsColor(record));
      case "part": return done && needsPart(record);
      case "color": return done && needsColor(record);
      case "ready": return done && !needsPart(record) && !needsColor(record);
      case "unidentified": return record.status === "nomatch" || record.status === "failed";
      default: return true;
    }
  }));
  let visibleIds = $derived(visible.map((record) => record.id));
  let processed = $derived(stats.total - stats.pending);
  let canExport = $derived(stats.pending === 0 && resultRows(batch.records).length > 0);

  function status(record: PieceRecord): { icon: string; label: string; tone: string } {
    if (record.status === "queued") return { icon: "…", label: "Queued", tone: "info" };
    if (record.status === "processing") return { icon: "…", label: "Identifying", tone: "info" };
    if (record.status === "failed") return { icon: "✕", label: "Request failed", tone: "bad" };
    if (record.status === "nomatch") return { icon: "✕", label: "No match", tone: "bad" };
    const row = record.row!;
    if (needsPart(record) || needsColor(record)) {
      return { icon: "⚠", label: needsPart(record) && needsColor(record) ? "Part & color check" : needsPart(record) ? "Part check" : "Color check", tone: "warn" };
    }
    if (row["Part Review Completed"] === "Yes" && row["Color Review Completed"] === "Yes") return { icon: "✓", label: "Verified", tone: "good" };
    if (record.cached) return { icon: "↻", label: "Saved result", tone: "info" };
    return { icon: "✓", label: "Ready", tone: "good" };
  }

  let busy = $state("");
  const stamp = () => timestamp();

  async function exportExcel() {
    busy = "Building Excel report…";
    try {
      const buffer = await buildExcelReport(batch.records, getRawResponse);
      downloadFile(`SK_BrickRescue_Batch_Report_${stamp()}.xlsx`, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (err) {
      console.error("Excel export failed:", err);
      showNotice("The Excel report could not be created.");
    } finally {
      busy = "";
    }
  }

  let importInput = $state<HTMLInputElement>();
  let importMessage = $state("");
  async function importCsv(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    let added = 0;
    for (const file of files) {
      const rows = normalizeImportedRows(parseCsv(await file.text()));
      addImportedRows(rows);
      added += rows.length;
    }
    importMessage = added ? `Imported ${added} piece${added === 1 ? "" : "s"}.` : "No result rows found in that CSV.";
    setTimeout(() => { importMessage = ""; }, 4000);
  }
</script>

<section class="results-panel" aria-labelledby="results-title">
  <header class="results-head">
    <h2 id="results-title" class="panel-section-title">Recognition Results</h2>
    <div class="results-actions">
      <button type="button" class="btn" disabled={!canExport} title={canExport ? "" : "Available when results exist and processing has finished"}
        onclick={() => downloadFile(`brickognize_results_${stamp()}.csv`, buildCsv(resultRows(batch.records)), "text/csv;charset=utf-8")}>Export CSV</button>
      <button type="button" class="btn excel" disabled={!canExport || !!busy} onclick={exportExcel}>Export Excel</button>
      <details class="results-more">
        <summary class="btn">More</summary>
        <div class="results-menu">
          <button type="button" disabled={!canExport}
            onclick={() => downloadFile(`brickognize_responses_${stamp()}.json`, responsesJson(batch.records, getRawResponse), "application/json")}>Download API responses (JSON)</button>
          <button type="button" disabled={!canExport}
            onclick={() => downloadFile(`brickognize_reviews_${stamp()}.json`, reviewsJson(batch.records), "application/json")}>Download review decisions (JSON)</button>
          <button type="button" onclick={() => importInput?.click()}>Import results CSV…</button>
          <button type="button" disabled={!batch.records.length} onclick={onNewBatch}>Start new batch…</button>
        </div>
      </details>
      <input bind:this={importInput} type="file" accept=".csv,text/csv" multiple hidden onchange={importCsv} />
    </div>
  </header>

  <div class="results-stats" aria-label="Batch summary">
    <span><strong>{stats.total}</strong> pieces</span>
    <span><strong>{stats.isNew}</strong> newly processed</span>
    <span class="good"><strong>{stats.ready}</strong> ready</span>
    <span class="good"><strong>{stats.verified}</strong> verified</span>
    <span class="warn"><strong>{stats.partCheck}</strong> part check</span>
    <span class="warn"><strong>{stats.colorCheck}</strong> color check</span>
    <span class="bad"><strong>{stats.unidentified}</strong> unidentified</span>
  </div>

  {#if stats.pending > 0}
    <div class="results-progress" role="status">
      <span>Identifying pieces… {processed} of {stats.total}</span>
      <progress max={stats.total} value={processed}></progress>
    </div>
  {/if}
  {#if busy || importMessage}<p class="results-message" role="status">{busy || importMessage}</p>{/if}

  <div class="results-toolbar">
    <label>Show
      <select bind:value={filter}>
        {#each Object.entries(FILTERS) as [value, label] (value)}<option {value}>{label}</option>{/each}
      </select>
    </label>
    {#if stats.unidentified && batch.records.some((r) => r.status === "failed")}
      <button type="button" class="btn" onclick={retryAllFailed}>Retry failed</button>
    {/if}
    {#if visible.length}
      <button type="button" class="btn primary" onclick={() => {
        const first = visible.find((r) => r.status === "done" && (needsPart(r) || needsColor(r))) ?? visible[0];
        onOpen(first.id, visibleIds);
      }}>Review {filter === "all" ? "pieces" : FILTERS[filter].toLowerCase()}</button>
    {/if}
  </div>

  {#if visible.length}
    <ul class="results-list">
      {#each visible as record (record.id)}
        {@const s = status(record)}
        {@const row = record.row}
        <li>
          <button type="button" class="result-row" onclick={() => onOpen(record.id, visibleIds)}>
            <span class="result-status {s.tone}" title={s.label} aria-label={s.label}>{s.icon}</span>
            <span class="result-thumbs">
              {#if record.cropUrl}<img loading="lazy" src={record.cropUrl} alt="" />{:else}<span class="thumb-empty"></span>{/if}
              {#if row?.["Reference Image URL"]}<img loading="lazy" src={row["Reference Image URL"]} alt=""
                onerror={(event) => { (event.currentTarget as HTMLImageElement).style.display = "none"; }} />{/if}
            </span>
            <span class="result-main">
              <span class="result-name">{row?.["Part Name"] ?? (record.status === "processing" || record.status === "queued" ? "Identifying…" : s.label)}</span>
              <span class="result-meta">
                {#if row}<span class="mono">{row["Part ID"]}</span> ·
                  <span class="color-dot" style:background-color={blColorHex(row["BrickLink Color ID"])} aria-hidden="true"></span>
                  {row["LEGO Color"]} ·{/if}
                {record.image}
              </span>
            </span>
            {#if row}
              <span class="result-conf">
                <span title="Part confidence">P {row["Part Confidence"] || "—"}</span>
                <span title="Color confidence">C {row["Color Confidence"] || "—"}</span>
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="results-empty">
      {batch.records.length ? `No pieces match: ${FILTERS[filter]}.` : "Scan photos to see each piece's part, color and confidence here. You can also import a results CSV."}
    </p>
  {/if}
</section>
