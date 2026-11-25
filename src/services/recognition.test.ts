import { describe, expect, it } from "vitest";
import { buildManualRow, buildResultRow, CSV_FIELDS, estimateColor, parseBrickognizeResponse } from "./recognition";
import { approve, saveColorReview, saveRescanDecision, useCandidate, type ReviewLog } from "./reviews";
import { buildCsv, normalizeImportedRows, parseCsv } from "./exporters";
import { blToRbColorId, extractColorIds } from "./bricklink";

// Trimmed real response from Brickognize's internal search endpoint.
const INTERNAL_RESPONSE = {
  id: "res-8775323ccc014ff0",
  query_id: "qry-a1167747e5e74655",
  detected_items: [{
    bounding_boxes: [{ left: 48.5, upper: 48.6, right: 238.5, lower: 226.4, image_width: 287, image_height: 275, score: 0.9844157099723816 }],
    candidate_items: [
      {
        id: "part-3023-20260330", type: "part", name: "Plate 1 x 2",
        external_items: [{ catalog_name: "bricklink", external_id: "3023", external_type: "P", name: "Plate 1 x 2", url: "https://www.bricklink.com/v2/catalog/catalogitem.page?P=3023" }],
        score: 0.8322354555130005,
        candidate_colors: [
          { id: "color-6-20260330", name: "Green", external_colors: [{ catalog_name: "bricklink", external_id: "6", name: "Green" }], score: 0.8006792068481445 },
          { id: "color-36-20260330", name: "Bright Green", external_colors: [{ catalog_name: "bricklink", external_id: "36", name: "Bright Green" }], score: 0.23 }
        ]
      },
      { id: "part-3623-20260330", type: "part", name: "Plate 1 x 3", external_items: [], score: 0.41 }
    ]
  }]
};

describe("parseBrickognizeResponse", () => {
  it("reads BrickLink part and color IDs from the internal endpoint", () => {
    const recognition = parseBrickognizeResponse(INTERNAL_RESPONSE);
    expect(recognition.responseId).toBe("res-8775323ccc014ff0");
    expect(recognition.boundingBoxScore).toBeCloseTo(98.44, 1);
    expect(recognition.candidates[0]).toMatchObject({ partId: "3023", name: "Plate 1 x 2", score: expect.closeTo(83.22, 1) });
    expect(recognition.candidates[0].colors[0]).toMatchObject({ name: "Green", colorId: "6" });
    // No BrickLink entry: fall back to Brickognize's ID without prefix and date suffix.
    expect(recognition.candidates[1].partId).toBe("3623");
  });

  it("reads the public predict endpoint format", () => {
    const recognition = parseBrickognizeResponse({ listing_id: "abc", items: [{ id: "3001", name: "Brick 2 x 4", score: 0.9, img_url: "https://x/3001.png" }] });
    expect(recognition.candidates[0]).toMatchObject({ partId: "3001", score: 90, imageUrl: "https://x/3001.png", colors: [] });
  });

  it("tolerates garbage", () => {
    expect(parseBrickognizeResponse(null).candidates).toEqual([]);
    expect(parseBrickognizeResponse({ detected_items: "x" }).candidates).toEqual([]);
  });
});

describe("buildResultRow", () => {
  it("produces the desktop app's CSV row", () => {
    const row = buildResultRow("photo_piece01.jpg", parseBrickognizeResponse(INTERNAL_RESPONSE), null, { photo: "photo.jpg", box: 1 })!;
    expect(row).toMatchObject({
      "Image": "photo_piece01.jpg",
      "Part ID": "3023",
      "Part Confidence": "83.22%",
      "Part Review Required": "No",
      "Part Approval Status": "Auto-Accepted",
      "LEGO Color": "Green",
      "BrickLink Color ID": "6",
      "Color Confidence": "80.07%",
      "Color Review Required": "No",
      "Color Method": "Brickognize Color Prediction",
      "Bounding Box Score": "98.44%",
      "Reference Image URL": "https://img.bricklink.com/ItemImage/PN/6/3023.png",
      "BrickLink URL": "https://www.bricklink.com/v2/catalog/catalogitem.page?P=3023&idColor=6",
      "Final Review Status": "Ready",
      "Final Part ID": "3023",
      "Final BrickLink Color ID": "6",
      "Photo Box": "1"
    });
  });

  it("flags low confidence and uses the RGB fallback without a color prediction", () => {
    const response = structuredClone(INTERNAL_RESPONSE);
    const item = response.detected_items[0].candidate_items[0] as Record<string, unknown>;
    item.score = 0.5;
    delete item.candidate_colors;
    const pixels = new Uint8ClampedArray([5, 19, 29, 255, 5, 19, 29, 255]); // ~black
    const row = buildResultRow("a.jpg", parseBrickognizeResponse(response), estimateColor(pixels))!;
    expect(row["Color Method"]).toBe("Average RGB Fallback");
    expect(row["LEGO Color"]).toBe("Black");
    expect(row["BrickLink Color ID"]).toBe("11");
    expect(row["Final Review Status"]).toMatch(/^Needs Part/);
    expect(row["Part Approval Status"]).toBe("Pending Review");
  });

  it("returns null when nothing was recognized", () => {
    expect(buildResultRow("a.jpg", parseBrickognizeResponse({ detected_items: [] }), null)).toBeNull();
  });
});

describe("reviews", () => {
  const fresh = () => buildResultRow("a.jpg", parseBrickognizeResponse(INTERNAL_RESPONSE), null)!;

  it("corrects a color but keeps the prediction", () => {
    const row = fresh();
    const log: ReviewLog = {};
    saveColorReview(row, log, "36");
    expect(row["LEGO Color"]).toBe("Bright Green");
    expect(row["Predicted LEGO Color"]).toBe("Green");
    expect(row["Color Approval Status"]).toBe("Corrected");
    expect(row["Final BrickLink Color ID"]).toBe("36");
    expect(row["Reference Image URL"]).toContain("/PN/36/3023.png");
    expect(log["Color Review"]).toMatchObject({ "Original Color": "Green", "Confirmed Color": "Bright Green" });
  });

  it("approves a piece", () => {
    const row = fresh();
    approve(row, {});
    expect(row).toMatchObject({ "Part Approval Status": "Confirmed", "Color Approval Status": "Confirmed", "Part Review Completed": "Yes", "Final Review Status": "Ready" });
  });

  it("switches to another candidate", () => {
    const row = fresh();
    useCandidate(row, parseBrickognizeResponse(INTERNAL_RESPONSE).candidates[1]);
    expect(row["Final Part ID"]).toBe("3623");
    expect(row["Original Part ID"]).toBe("3023");
    expect(row["Part Approval Status"]).toBe("Corrected");
  });

  it("uses a rescan result and drops the old color decision", () => {
    const row = fresh();
    const log: ReviewLog = {};
    saveColorReview(row, log, "36");
    const rescan = buildManualRow("rescan.jpg", "3710", "Plate 1 x 4", "5");
    saveRescanDecision(row, log, rescan, "rescan.jpg", "Use Rescan Result");
    expect(row["Final Part ID"]).toBe("3710");
    expect(row["Final LEGO Color"]).toBe("Red");
    expect(log["Color Review"]).toBeUndefined();
    expect(log["Part Review"]).toMatchObject({ "Decision": "Use Rescan Result", "Original Part ID": "3023" });
  });
});

describe("CSV", () => {
  it("round-trips rows with quoted fields", () => {
    const row = buildManualRow("m.jpg", "32039", "Technic, Axle Connector \"Smooth\"", "11");
    const csv = buildCsv([row]);
    expect(csv.split("\r\n")[0]).toBe(CSV_FIELDS.join(","));
    const [parsed] = parseCsv(csv);
    expect(parsed["Part Name"]).toBe("Technic, Axle Connector \"Smooth\"");
    expect(parsed["Final Review Status"]).toBe("Ready");
  });

  it("imports desktop rows using the Final columns", () => {
    const csv = "Image,Part ID,Part Name,LEGO Color,BrickLink Color ID,Final Part ID,Final Part Name,Final LEGO Color,Final BrickLink Color ID,Part Review Required,Color Review Required\n" +
      "x.png,3001,Brick,White,1,3002,\"Brick 2 x 3\",Black,11,No,Yes\n,,,,,,,,,,\n";
    const rows = normalizeImportedRows(parseCsv(csv));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "Part ID": "3002", "Final LEGO Color": "Black", "Final Review Status": "Needs Color Review" });
  });
});

describe("BrickLink helpers", () => {
  it("maps BrickLink colors to Rebrickable", () => {
    expect(blToRbColorId("11")).toBe(0);
    expect(blToRbColorId("86")).toBe(71);
    expect(blToRbColorId("99999")).toBe(-1);
  });

  it("extracts color IDs from a catalog color page", () => {
    const html = '<img src="//img.bricklink.com/ItemImage/PN/11/3023.png"><img src="/ItemImage/PN/5/3023.png?x"><img src="/ItemImage/PN/7/30230.png">';
    expect(extractColorIds(html, "3023")).toEqual(["5", "11"]);
  });
});
