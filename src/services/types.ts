export interface BrickColor {
  id: number;
  name: string;
  hex: string;
}

export interface BrickPart {
  part_num: string;
  name: string;
  color_id: number;
  rarity_score: number;
  imageUrl: string;
  brickognizeUrl?: string;
  photoBox?: number;
}

// One scanned part/color with how many pieces of it are on the shelf.
export interface PileItem {
  part: string; // Rebrickable part number
  color: number; // Rebrickable color ID
  qty: number;
}

// One line of a set's inventory in the Dig Mode checklist.
export interface ChecklistPart extends BrickPart {
  quantity: number; // pieces the set needs
  found: number; // pieces covered by the scanned pile
  // Some found pieces were scanned in another color (recognition often
  // misreads colors under poor light), so the color is worth a look.
  colorMismatch: boolean;
  // Scanned pieces of the same physical part (mold group) in another color
  // counted toward this line — these can be recolored to the set's color.
  borrowed: { color: number; qty: number; part: string }[];
}

export interface ScannedColorInput {
  color_id: number;
  weight: number; // 0.0 to 1.0 (share of the pile)
}

export interface MatchResult {
  set_num: string;
  name: string;
  year: string;
  imageUrl: string;
  total_parts: number;
  colorMatchScore: number; // 0.0 to 1.0
  combinedScore: number; // 0.0 to 1.0
  pileCoverage: number; // share of the scanned pile this set contains (0..1)
  setCoverage: number; // share of the set found in the pile (0..1)
  checklist: ChecklistPart[]; // missing lines first, then complete ones
  foundPieces: number;
  totalPieces: number;
}
