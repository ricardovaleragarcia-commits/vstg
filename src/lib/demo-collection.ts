import { VSTG } from "@/data/vstg";
import COLORS from "@/data/colors.json"; // predominant colour of each image, made by `npm run colors`

// The plane is an invisible grid. Each cell holds at most one piece, small and placed at a random
// spot inside it, so the pieces look scattered but never touch. A few cells stay empty.
// The grid repeats in every direction; each repetition rotates its columns and shifts the entries.
export const CELL_W = 320;
export const CELL_H = 310;
export const TILE_COUNT = VSTG.length;
export const COLUMNS_PER_TILE = 16;
export const ROWS_PER_TILE = Math.ceil(TILE_COUNT / COLUMNS_PER_TILE); // the few cells left over stay empty
export const BLOCK_WIDTH = COLUMNS_PER_TILE * CELL_W;
export const BLOCK_HEIGHT = ROWS_PER_TILE * CELL_H;
export const LONGEST_SIDES = [120, 140, 160, 180];

const LABEL_SPACE = 44; // room for the [vstg.####] code under each piece
const MARGIN = 22; // minimum clear space inside each cell, so neighbours never touch

export type Piece = {
  id: string;
  code: string; // shown as [VSTG.YYYY], or [VSTG.NA] when the year is not confirmed
  kind: "image" | "text";
  visibility: "public" | "private";
  x: number; // world position, top-left corner
  y: number;
  w: number;
  h: number;
  color: number;
  text: string | null;
  name: string;
  description: string; // [desc.]
  failedFuture: string; // [f.f. expl.]
  source: string;
  link: string;
  image: string | null;
  conceptionYear: number | null; // year the future was imagined or planned
  closureYear: number | null; // year it was dropped or failed
  anchorYear: number | null; // point of relation, 2020
  distance: number | null; // anchorYear minus conceptionYear
  presentEffect: PresentEffect | null; // how that future still shapes the present
};

export type PresentEffect = {
  text: string;
  kind: "documented" | "attributed" | "interpretation";
  source: string;
  link: string;
};

const PALETTE = [0xb8a99a, 0x8f9a92, 0xd9cfc1, 0x6f7b80, 0xc7b8a6, 0x9aa3a9, 0x4f4a45, 0xe2dccf];
const RATIOS = [0.75, 0.8, 1, 1.25, 1.5];

// Small seeded random generator: the same seed always produces the same values.
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function dominantColor(code: string): number | null {
  const hex = (COLORS as Record<string, string>)[code];
  return hex ? parseInt(hex.slice(1), 16) : null;
}

function pick<T>(random: () => number, items: T[]): T {
  return items[Math.floor(random() * items.length)];
}

// ratio = width / height. The longest side is set; the other side follows the ratio.
export function sizeFromLongest(ratio: number, longest: number) {
  if (ratio >= 1) return { w: longest, h: longest / ratio };
  return { w: longest * ratio, h: longest };
}

// ---- The tile layout: made once per visit, shared by every repetition ----

// Where a piece sits inside its cell, and which entry of the archive it shows (before the shift).
type Slot = { dx: number; dy: number; w: number; h: number; entry: number };

function buildTile(seed: number): (Slot | null)[] {
  const random = rng(seed);
  const cells = COLUMNS_PER_TILE * ROWS_PER_TILE;
  // Which cells hold a piece: every entry once, the rest empty, in random cells.
  const filled = shuffle(
    Array.from({ length: cells }, (_, i) => i < TILE_COUNT),
    random,
  );
  let entry = 0;
  return filled.map((has) => {
    if (!has) return null;
    const { w, h } = sizeFromLongest(pick(random, RATIOS), pick(random, LONGEST_SIDES));
    const roomX = CELL_W - 2 * MARGIN - w;
    const roomY = CELL_H - LABEL_SPACE - 2 * MARGIN - h;
    return {
      dx: MARGIN + random() * roomX,
      dy: MARGIN + random() * roomY,
      w,
      h,
      entry: entry++,
    };
  });
}

let TILE: (Slot | null)[] = [];
// Each column of the grid is pushed down by its own amount, so the rows do not line up.
let COLUMN_OFFSET: number[] = [];
let SEED = 0x5eed;

// ---- The content: the archive, reused by every repetition ----

// [VSTG.YYYY] when the year is known; [VSTG.NA] when it is not.
function displayCode(v: { year: number | null; suffix?: string }): string {
  return v.year ? `vstg.${v.year}${v.suffix ? "." + v.suffix : ""}` : "vstg.NA";
}

type Content = {
  code: string;
  color: number;
  name: string;
  description: string;
  failedFuture: string;
  source: string;
  link: string;
  image: string | null;
  conceptionYear: number | null;
  closureYear: number | null;
  anchorYear: number | null;
  distance: number | null;
  presentEffect: PresentEffect | null;
};

let CONTENT: Content[] = [];

// Which entry each repetition starts with. Different repetitions start at different places.
function offsetFor(cx: number, cy: number): number {
  const h = Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ SEED;
  return (h >>> 0) % Math.max(CONTENT.length, 1);
}

// Each repetition rotates its columns by its own shift, so the edge of one repetition
// never sits next to the same columns of the next one, sideways or above and below.
function columnShift(cx: number, cy: number): number {
  const shift = 3 * cx + 7 * cy + (SEED % COLUMNS_PER_TILE);
  return ((shift % COLUMNS_PER_TILE) + COLUMNS_PER_TILE) % COLUMNS_PER_TILE;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

// The piece in grid cell (gx, gy) of the infinite plane, or null if that cell is empty.
export function pieceAt(gx: number, gy: number): Piece | null {
  const cx = Math.floor(gx / COLUMNS_PER_TILE);
  const cy = Math.floor(gy / ROWS_PER_TILE);
  const col = mod(mod(gx, COLUMNS_PER_TILE) + columnShift(cx, cy), COLUMNS_PER_TILE);
  const row = mod(gy, ROWS_PER_TILE);
  const slot = TILE[row * COLUMNS_PER_TILE + col];
  if (!slot) return null;

  const content = CONTENT[(slot.entry + offsetFor(cx, cy)) % CONTENT.length];

  return {
    id: `${gx}:${gy}`,
    code: content.code,
    kind: "image",
    visibility: "public",
    x: Math.round(gx * CELL_W + slot.dx),
    // The drop follows the column on screen, so it stays the same across repetitions above and below.
    y: Math.round(gy * CELL_H + slot.dy + COLUMN_OFFSET[mod(gx, COLUMNS_PER_TILE)]),
    w: Math.round(slot.w),
    h: Math.round(slot.h),
    color: content.color,
    text: null,
    name: content.name,
    description: content.description,
    failedFuture: content.failedFuture,
    source: content.source,
    link: content.link,
    image: content.image,
    conceptionYear: content.conceptionYear,
    closureYear: content.closureYear,
    anchorYear: content.anchorYear,
    distance: content.distance,
    presentEffect: content.presentEffect,
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Each visit gets its own order: the layout and the placement of the entries come from a seed.
export function initArchive(seed: number) {
  SEED = seed;
  TILE = buildTile(seed);
  const random = rng(seed ^ 0x9e3779b9);
  COLUMN_OFFSET = Array.from({ length: COLUMNS_PER_TILE }, () => Math.round(random() * CELL_H * 0.35));
  const entries: Content[] = VSTG.map((v, k) => ({
    code: displayCode(v),
    // The frame is painted with the predominant colour of its photograph until the photograph arrives.
    color: dominantColor(v.code) ?? PALETTE[k % PALETTE.length],
    name: v.name,
    description: v.description,
    failedFuture: v.failedFuture,
    source: v.source,
    link: v.link,
    image: v.image,
    conceptionYear: v.conceptionYear ?? null,
    closureYear: v.closureYear ?? null,
    anchorYear: v.anchorYear ?? null,
    distance: v.distance ?? null,
    presentEffect: v.presentEffect ?? null,
  }));
  CONTENT = shuffle(entries, rng(seed ^ 0x1234abcd));
}

// Default order, used when the page is pre-rendered. The browser replaces it on every visit.
initArchive(0x5eed);
