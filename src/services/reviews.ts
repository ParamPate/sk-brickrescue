import { blColor } from "./bricklink";
import { percent, syncFinalFields, type PartCandidate, type ResultRow } from "./recognition";

// Employee review decisions (part recognition/src/review_manager.py and the
// review actions in gui.py). Predictions stay in their original columns; the
// decision lands in the current/Final columns and in a review log that exports
// as brickognize_reviews.json.

export type ReviewLog = { "Color Review"?: Record<string, string>; "Part Review"?: Record<string, string> };
export type RescanDecision = "Keep Original" | "Use Rescan Result";

const now = () => {
  // ISO 8601 with the local offset, like Python's datetime.now().astimezone().isoformat()
  const date = new Date();
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (value: number) => String(Math.floor(Math.abs(value))).padStart(2, "0");
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
};

// Remember the first prediction before a part correction replaces it.
function keepOriginalPart(row: ResultRow) {
  row["Original Part ID"] ??= row["Part ID"];
  row["Original Part Name"] ??= row["Part Name"];
  row["Original Part Confidence"] ??= row["Part Confidence"];
}

const originalColor = (row: ResultRow) => row["Original LEGO Color"] || row["Predicted LEGO Color"] || row["LEGO Color"] || "Unknown";

export function saveColorReview(row: ResultRow, log: ReviewLog, colorId: string): void {
  const color = blColor(colorId);
  if (!color) return;
  const original = originalColor(row);
  const status = color.name === original ? "Confirmed" : "Corrected";
  log["Color Review"] = {
    "Image": row["Image"],
    "Part ID": row["Part ID"],
    "Part Name": row["Part Name"],
    "Original Color": original,
    "Original BrickLink Color ID": row["Predicted BrickLink Color ID"] || row["BrickLink Color ID"],
    "Confirmed Color": color.name,
    "Confirmed BrickLink Color ID": color.id,
    "Original Color Confidence": row["Color Confidence"] || "Unknown",
    "Color Review Completed": "Yes",
    "Color Approval Status": status,
    "Reviewed At": now()
  };
  row["Original LEGO Color"] = original;
  row["LEGO Color"] = color.name;
  row["BrickLink Color ID"] = color.id;
  row["Color Review Required"] = "No";
  row["Color Review Completed"] = "Yes";
  row["Color Approval Status"] = status;
  syncFinalFields(row);
}

// "Choose similar part": accept another ranked Brickognize candidate.
export function useCandidate(row: ResultRow, candidate: PartCandidate): void {
  keepOriginalPart(row);
  row["Part ID"] = candidate.partId;
  row["Part Name"] = candidate.name;
  row["Part Confidence"] = percent(candidate.score);
  row["Part Review Required"] = "No";
  row["Part Review Completed"] = "Yes";
  row["Part Approval Status"] = "Corrected";
  row["BrickLink URL"] = candidate.bricklinkUrl || "N/A";
  syncFinalFields(row);
}

// Approve & Next: accept the displayed part and color.
export function approve(row: ResultRow, log: ReviewLog): void {
  if (row["BrickLink Color ID"] && row["Color Review Completed"] !== "Yes") {
    saveColorReview(row, log, row["BrickLink Color ID"]);
  }
  row["Part Review Required"] = "No";
  row["Color Review Required"] = "No";
  row["Part Review Completed"] = "Yes";
  row["Color Review Completed"] = "Yes";
  if (row["Part Approval Status"] !== "Corrected") row["Part Approval Status"] = "Confirmed";
  if (row["Color Approval Status"] !== "Corrected") row["Color Approval Status"] = "Confirmed";
  syncFinalFields(row);
}

// Compare an alternate photo of the same piece and keep one result.
export function saveRescanDecision(
  row: ResultRow,
  log: ReviewLog,
  rescan: ResultRow,
  rescanImage: string,
  decision: RescanDecision
): void {
  const useRescan = decision === "Use Rescan Result";
  const final = useRescan ? rescan : row;
  log["Part Review"] = {
    "Original Image": row["Image"],
    "Original Part ID": row["Part ID"],
    "Original Part Name": row["Part Name"],
    "Original Part Confidence": row["Part Confidence"],
    "Rescan Image": rescanImage,
    "Rescan Part ID": rescan["Part ID"],
    "Rescan Part Name": rescan["Part Name"],
    "Rescan Part Confidence": rescan["Part Confidence"],
    "Decision": decision,
    "Final Part ID": final["Part ID"],
    "Final Part Name": final["Part Name"],
    "Final Part Confidence": final["Part Confidence"],
    "Part Review Completed": "Yes",
    "Part Approval Status": useRescan ? "Corrected" : "Confirmed",
    "Rescan LEGO Color": rescan["LEGO Color"],
    "Rescan BrickLink Color ID": rescan["BrickLink Color ID"],
    "Rescan Color Confidence": rescan["Color Confidence"],
    "Reviewed At": now()
  };
  if (useRescan) {
    keepOriginalPart(row);
    for (const field of ["Part ID", "Part Name", "Type", "Part Confidence", "BrickLink URL",
      "LEGO Color", "BrickLink Color ID", "Predicted LEGO Color", "Predicted BrickLink Color ID",
      "Color Confidence", "Color Review Required", "Color Method", "Estimated RGB", "Color Distance"]) {
      row[field] = rescan[field] ?? "";
    }
    // The earlier color decision belonged to the old photo (clear_color_review).
    delete log["Color Review"];
    delete row["Original LEGO Color"];
    row["Color Review Completed"] = "No";
  }
  row["Part Review Required"] = "No";
  row["Part Review Completed"] = "Yes";
  row["Part Approval Status"] = useRescan ? "Corrected" : "Confirmed";
  syncFinalFields(row);
}
