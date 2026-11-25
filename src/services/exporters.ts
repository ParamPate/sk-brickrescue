import type { PieceRecord } from "./batch.svelte";
import { CSV_FIELDS, percentValue, syncFinalFields, type ResultRow } from "./recognition";

// Batch files matching the desktop app's results folder:
// brickognize_results.csv, brickognize_responses.json, brickognize_reviews.json
// and the SK BrickRescue Excel batch report.

export function timestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function downloadFile(filename: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const resultRows = (records: PieceRecord[]): ResultRow[] =>
  records.filter((record) => record.status === "done" && record.row).map((record) => record.row!);

const escapeCsv = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function buildCsv(rows: ResultRow[]): string {
  const lines = [CSV_FIELDS.join(",")];
  for (const row of rows) lines.push(CSV_FIELDS.map((field) => escapeCsv(row[field] ?? "")).join(","));
  return lines.join("\r\n") + "\r\n";
}

// RFC 4180 parser (quoted fields may contain commas, quotes and newlines).
export function parseCsv(text: string): ResultRow[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell.trim()));
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((name, index) => [name.trim(), cells[index] ?? ""])));
}

// Accept rows exported by this app or the desktop app. Rows without a part ID
// are skipped; Final columns are recomputed from the decision columns.
export function normalizeImportedRows(rows: ResultRow[]): ResultRow[] {
  return rows
    .filter((row) => (row["Final Part ID"] || row["Part ID"] || "").trim())
    .map((row) => {
      const normalized: ResultRow = { ...row };
      normalized["Part ID"] = row["Final Part ID"] || row["Part ID"];
      normalized["Part Name"] = row["Final Part Name"] || row["Part Name"] || "Unknown";
      normalized["Part Confidence"] = row["Final Part Confidence"] || row["Part Confidence"] || "";
      normalized["LEGO Color"] = row["Final LEGO Color"] || row["LEGO Color"] || "Unknown";
      normalized["BrickLink Color ID"] = row["Final BrickLink Color ID"] || row["BrickLink Color ID"] || "";
      normalized["BrickLink URL"] = row["Final BrickLink URL"] || row["BrickLink URL"] || "N/A";
      for (const field of ["Part Review Required", "Color Review Required", "Part Review Completed", "Color Review Completed"]) {
        normalized[field] = normalized[field] === "Yes" ? "Yes" : "No";
      }
      return syncFinalFields(normalized);
    });
}

export function responsesJson(records: PieceRecord[], raw: (id: string) => unknown): string {
  const out: Record<string, unknown> = {};
  for (const record of records) {
    const response = raw(record.id);
    if (response) out[record.image] = response;
  }
  return JSON.stringify(out, null, 4);
}

export function reviewsJson(records: PieceRecord[]): string {
  const out: Record<string, unknown> = {};
  for (const record of records) if (Object.keys(record.log).length) out[record.image] = record.log;
  return JSON.stringify(out, null, 4);
}

// --- Excel report (excel_report.py). exceljs loads only when exporting. ---
const NAVY = "FF1F3A2B";
const GREEN = "FF46674F";
const WHITE = "FFFFFFFF";

const BATCH_HEADERS = [
  "Image", "Final Review Status", "Final Part ID", "Final Part Name", "Final Part Confidence", "Final LEGO Color",
  "Final BrickLink Color ID", "Part Approval Status", "Color Approval Status", "Part Review Completed",
  "Color Review Completed", "Original Part ID", "Original Part Name", "Original Part Confidence",
  "Original LEGO Color", "Predicted BrickLink Color ID", "Color Confidence", "Part Check Suggested",
  "Color Check Suggested", "Color Method", "Bounding Box Score", "Response ID", "Reference Image URL",
  "Final BrickLink URL", "Source Photo", "Photo Box"
];

const REVIEW_HEADERS = [
  "Image", "Review Type", "Decision", "Approval Status", "Original Value", "Alternate Value", "Final Value",
  "Original BrickLink Color ID", "Final BrickLink Color ID", "Original Confidence", "Alternate Confidence", "Reviewed At"
];

const STATUS_LABELS: [string, string][] = [
  ["Ready", "Ready"],
  ["Needs Part Review", "Part Check Suggested"],
  ["Needs Color Review", "Color Check Suggested"],
  ["Needs Part and Color Review", "Part and Color Checks Suggested"]
];

export async function buildExcelReport(records: PieceRecord[], raw: (id: string) => unknown): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SK Brickhouse";
  workbook.created = new Date();
  const rows = resultRows(records);
  const font = { name: "Segoe UI" };

  type Sheet = ReturnType<typeof workbook.addWorksheet>;
  const title = (sheet: Sheet, heading: string, subtitle: string, width: number) => {
    sheet.mergeCells(1, 1, 1, width);
    sheet.mergeCells(2, 1, 2, width);
    Object.assign(sheet.getCell(1, 1), { value: heading, font: { ...font, size: 18, bold: true, color: { argb: NAVY } } });
    Object.assign(sheet.getCell(2, 1), { value: subtitle, font: { ...font, italic: true, color: { argb: "FF516757" } } });
  };
  const table = (sheet: Sheet, headers: string[], data: (string | number)[][], widths: number[]) => {
    const headerRow = sheet.getRow(4);
    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { ...font, bold: true, color: { argb: WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    headerRow.height = 30;
    data.forEach((values, index) => {
      const row = sheet.getRow(5 + index);
      values.forEach((value, column) => { row.getCell(column + 1).value = value; });
      if (index % 2) row.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5EF" } }; });
    });
    sheet.columns.forEach((column, index) => { column.width = widths[index] ?? 18; });
    sheet.views = [{ state: "frozen", ySplit: 4 }];
    if (data.length) sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + data.length, column: headers.length } };
  };

  // Dashboard
  const dashboard = workbook.addWorksheet("Dashboard");
  title(dashboard, "SK BrickRescue Batch Report", `Generated ${new Date().toLocaleString()} · ${rows.length} identified pieces`, 6);
  const partValues = rows.map((row) => percentValue(row["Final Part Confidence"])).filter((v): v is number => v !== null);
  const colorValues = rows.map((row) => percentValue(row["Color Confidence"])).filter((v): v is number => v !== null);
  const average = (values: number[]) => (values.length ? `${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)}%` : "N/A");
  const unidentified = records.filter((record) => record.status === "nomatch" || record.status === "failed").length;
  const summary: [string, string | number][] = [
    ["Identified pieces", rows.length],
    ["Unidentified or failed", unidentified],
    ...STATUS_LABELS.map(([status, label]): [string, number] => [label, rows.filter((row) => row["Final Review Status"] === status).length]),
    ["Verified by employee", rows.filter((row) => row["Part Review Completed"] === "Yes" && row["Color Review Completed"] === "Yes").length],
    ["Average Part Confidence", average(partValues)],
    ["Average Color Confidence", average(colorValues)],
    ["Low Part Confidence (<80%)", partValues.filter((value) => value < 80).length],
    ["Low Color Confidence (<80%)", colorValues.filter((value) => value < 80).length]
  ];
  table(dashboard, ["Measure", "Value"], summary, [36, 18]);

  // Batch Results
  const results = workbook.addWorksheet("Batch Results");
  title(results, "Batch Results", "Final decisions and original Brickognize predictions", 8);
  table(results, BATCH_HEADERS, rows.map((row) => [
    row["Image"], row["Final Review Status"], row["Final Part ID"], row["Final Part Name"], row["Final Part Confidence"],
    row["Final LEGO Color"], row["Final BrickLink Color ID"], row["Part Approval Status"], row["Color Approval Status"],
    row["Part Review Completed"], row["Color Review Completed"],
    row["Original Part ID"] || row["Part ID"], row["Original Part Name"] || row["Part Name"],
    row["Original Part Confidence"] || row["Part Confidence"], row["Predicted LEGO Color"],
    row["Predicted BrickLink Color ID"], row["Color Confidence"],
    row["Part Review Required"], row["Color Review Required"], row["Color Method"], row["Bounding Box Score"],
    row["Response ID"], row["Reference Image URL"], row["Final BrickLink URL"], row["Source Photo"] ?? "", row["Photo Box"] ?? ""
  ]), [24, 26, 14, 38, 14, 22, 12, 18, 18, 12, 12, 14, 38, 14, 22, 12, 14, 12, 12, 26, 14, 24, 48, 60, 24, 10]);

  // Manual Reviews
  const reviews = workbook.addWorksheet("Manual Reviews");
  title(reviews, "Manual Reviews", "Color confirmations and part rescan decisions", 6);
  const reviewRows: string[][] = [];
  for (const record of records) {
    const color = record.log["Color Review"];
    if (color) reviewRows.push([record.image, "Color Review", color["Color Approval Status"], color["Color Approval Status"],
      color["Original Color"], "", color["Confirmed Color"], color["Original BrickLink Color ID"],
      color["Confirmed BrickLink Color ID"], color["Original Color Confidence"], "", color["Reviewed At"]]);
    const part = record.log["Part Review"];
    if (part) reviewRows.push([record.image, "Part Review", part["Decision"], part["Part Approval Status"],
      `${part["Original Part ID"]} ${part["Original Part Name"]}`, `${part["Rescan Part ID"]} ${part["Rescan Part Name"]}`,
      `${part["Final Part ID"]} ${part["Final Part Name"]}`, "", part["Rescan BrickLink Color ID"] ?? "",
      part["Original Part Confidence"], part["Rescan Part Confidence"], part["Reviewed At"]]);
  }
  table(reviews, REVIEW_HEADERS, reviewRows, [24, 16, 20, 18, 36, 36, 36, 14, 14, 14, 14, 26]);

  // API Audit
  const audit = workbook.addWorksheet("API Audit");
  title(audit, "API Audit", "Summary of the saved Brickognize responses", 5);
  table(audit, ["Image", "Response ID", "Query ID", "Detected Items", "Raw Response Available"], records
    .filter((record) => !record.manual)
    .map((record) => {
      const response = raw(record.id) as { id?: string; query_id?: string; detected_items?: unknown[]; items?: unknown[] } | undefined;
      return [record.image, response?.id ?? record.row?.["Response ID"] ?? "", response?.query_id ?? "",
        response ? (response.detected_items ?? response.items ?? []).length : "", response ? "Yes" : "No"];
    }), [24, 26, 26, 14, 20]);

  // Instructions & Key
  const key = workbook.addWorksheet("Instructions & Key");
  title(key, "How to read the SK BrickRescue batch report", "Original predictions are never overwritten; Final columns hold the accepted result.", 2);
  table(key, ["Item", "Meaning"], [
    ["Dashboard", "Batch totals by review status and average confidences."],
    ["Batch Results", "One row per photographed piece: final decision plus the original Brickognize prediction."],
    ["Manual Reviews", "Every saved color confirmation and part rescan decision."],
    ["API Audit", "Which pieces have a stored Brickognize response."],
    ["Ready", "Part and color are accepted (automatically or by an employee)."],
    ["Part / Color Check Suggested", "Confidence was below 80%; a check is recommended but not required."],
    ["Confirmed / Corrected", "An employee kept the prediction / changed it."],
    ["BrickLink Color ID", "A catalog identifier, not a confidence value."],
    ["Important", "This workbook is a snapshot. Export a new report after later changes."]
  ], [30, 100]);

  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
