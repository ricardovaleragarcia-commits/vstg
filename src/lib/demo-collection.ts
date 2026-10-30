import { VSTG } from "@/data/vstg";
import COLORS from "@/data/colors.json"; // predominant colour of each image, made by `npm run colors`

// The plane is a tile of pieces, packed once with no holes. The tile repeats in every direction.
// Each repetition rotates its columns and shifts which archive entry sits where.
export const COLUMN_WIDTH = 420;
export const COLUMN_STEP = 480; // distance between column starts (60 px clear beside a 420 px column)
export const TILE_COUNT = VSTG.length;
export const COLUMNS_PER_TILE = Math.max(4, Math.round(Math.sqrt(TILE_COUNT)));
export const BLOCK_WIDTH = COLUMNS_PER_TILE * COLUMN_STEP;
export const LONGEST_SIDES = [260, 320, 380, 420];
const FILL_SIDES = [160, 200, 240, 280];

const LABEL_SPACE = 50; // room for the [vstg–####] code under each piece
const GAP_MIN = 60;
const GAP_RANGE = 60;

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

// ---- The tile layout: packed once, shared by every repetition ----

type Slot = { col: number; x: number; y: number; w: number; h: number; ratio: number };

function buildTile(seed: number): { slots: Slot[]; height: number } {
  const random = rng(seed);

  const cols = Array.from({ length: COLUMNS_PER_TILE }, (_, i) => ({
    index: i,
    y: GAP_MIN + random() * GAP_RANGE,
    items: [] as Slot[],
  }));

  // Each new piece goes to the column with the most room left.
  for (let n = 0; n < TILE_COUNT; n++) {
    const col = cols.reduce((a, b) => (b.y < a.y ? b : a));
    const ratio = pick(random, RATIOS);
    const longest = pick(random, LONGEST_SIDES);
    const { w, h } = sizeFromLongest(ratio, longest);

    col.items.push({ col: col.index, x: col.index * COLUMN_STEP + (COLUMN_WIDTH - w) / 2, y: col.y, w, h, ratio });
    col.y += h + LABEL_SPACE + GAP_MIN + random() * GAP_RANGE;
  }

  // The tile is as tall as its tallest column needs.
  const height =
    Math.max(
      ...cols.map((c) => {
        const last = c.items[c.items.length - 1];
        return last.y + last.h;
      })
    ) +
    LABEL_SPACE +
    GAP_MIN;
  const bottomLine = height - GAP_MIN - LABEL_SPACE;

  // Fill each shorter column with smaller pieces until nothing else fits.
  for (const col of cols) {
    for (let guard = 0; guard < 20; guard++) {
      const last = col.items[col.items.length - 1];
      const nextTop = last.y + last.h + LABEL_SPACE + GAP_MIN;
      const avail = bottomLine - nextTop;
      const ratio = pick(random, RATIOS);
      const fitting = FILL_SIDES.filter((L) => sizeFromLongest(ratio, L).h <= avail);
      if (fitting.length === 0) break;
      const { w, h } = sizeFromLongest(ratio, Math.max(...fitting));
      col.items.push({ col: col.index, x: col.index * COLUMN_STEP + (COLUMN_WIDTH - w) / 2, y: nextTop, w, h, ratio });
    }
  }

  // Close the last few pixels: stretch each column's last piece to the bottom line.
  for (const col of cols) {
    const last = col.items[col.items.length - 1];
    if (bottomLine <= last.y + last.h) continue;

    let h = bottomLine - last.y;
    let w = h * last.ratio;
    if (w > COLUMN_WIDTH) {
      w = COLUMN_WIDTH;
      h = w / last.ratio;
    }
    last.h = h;
    last.w = w;
    last.x = last.col * COLUMN_STEP + (COLUMN_WIDTH - w) / 2;
  }

  return { slots: cols.flatMap((c) => c.items), height };
}

let TILE: { slots: Slot[]; height: number };
export let BLOCK_HEIGHT = 0;
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

// Each repetition rotates its columns by a shift. The shift grows by 2 with every repetition,
// so the last column of one repetition never sits next to an identical column from the next.
function columnShift(cx: number): number {
  const shift = 2 * cx + (SEED % COLUMNS_PER_TILE);
  return ((shift % COLUMNS_PER_TILE) + COLUMNS_PER_TILE) % COLUMNS_PER_TILE;
}

// The pieces of one repetition. Odd rows are flipped vertically, so the layout does not look stamped.
export function piecesForBlock(cx: number, cy: number): Piece[] {
  const shift = columnShift(cx);
  const flipY = (cy & 1) !== 0;
  const offset = offsetFor(cx, cy);
  const ox = cx * BLOCK_WIDTH;
  const oy = cy * BLOCK_HEIGHT;

  return TILE.slots.map((slot, i) => {
    const content = CONTENT[(i + offset) % CONTENT.length];
    const column = (((slot.col - shift) % COLUMNS_PER_TILE) + COLUMNS_PER_TILE) % COLUMNS_PER_TILE;
    const localX = column * COLUMN_STEP + (COLUMN_WIDTH - slot.w) / 2;
    const localY = flipY ? BLOCK_HEIGHT - (slot.y + slot.h) : slot.y;

    return {
      id: `${cx}:${cy}:${i}`,
      code: content.code,
      kind: "image",
      visibility: "public",
      x: Math.round(ox + localX),
      y: Math.round(oy + localY),
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
  });
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
  BLOCK_HEIGHT = TILE.height;
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
