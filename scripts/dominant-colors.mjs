// Computes the predominant colour of every image in public/vstg and writes src/data/colors.json.
// The site paints that colour in each frame while the photograph loads, then dissolves into the photo.
//
// Run it again whenever images are added or replaced:   npm run colors
//
// "Predominant" means the colour range that covers the most pixels, not the average of the whole picture
// (an average of a black-and-white photo with a bright sky turns into a muddy grey nobody sees in it).
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "public", "vstg");
const out = path.join(root, "src", "data", "colors.json");

const STEP = 32; // 8 ranges per channel: 512 ranges in total
const SIZE = 64; // analysed at thumbnail size, which is plenty and fast

async function dominant(file) {
  const { data, info } = await sharp(file)
    .resize(SIZE, SIZE, { fit: "inside" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r / STEP) | 0) * 64 + ((g / STEP) | 0) * 8 + ((b / STEP) | 0);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += r; bin.g += g; bin.b += b;
    bins.set(key, bin);
  }
  // Each range also counts half of its direct neighbours, so a smooth gradient is not split
  // between two ranges and beaten by a small flat patch.
  let best = null, bestScore = -1;
  for (const [key, bin] of bins) {
    let score = bin.n;
    const kr = (key / 64) | 0, kg = ((key / 8) | 0) % 8, kb = key % 8;
    for (const [dr, dg, db] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nr = kr + dr, ng = kg + dg, nb = kb + db;
      if (nr < 0 || ng < 0 || nb < 0 || nr > 7 || ng > 7 || nb > 7) continue;
      score += (bins.get(nr * 64 + ng * 8 + nb)?.n ?? 0) * 0.5;
    }
    if (score > bestScore) { bestScore = score; best = bin; }
  }
  const hex = [best.r, best.g, best.b].map((v) => Math.round(v / best.n).toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

const files = (await readdir(dir)).filter((f) => /\.(webp|jpe?g|png)$/i.test(f)).sort();
const colors = {};
for (const f of files) colors[f.replace(/\.[^.]+$/, "")] = await dominant(path.join(dir, f));
await writeFile(out, JSON.stringify(colors, null, 2) + "\n");
console.log(`${files.length} colours written to src/data/colors.json`);
