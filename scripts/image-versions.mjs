// Prepares the images of the collection so the plane loads fast.
//
// For every public/vstg/<code>.webp it makes:
//   public/vstg/b/<code>.webp   a tiny, already blurred copy (under 1 KB): what the plane shows by default
//   public/vstg/m/<code>.webp   a medium copy (600 px): shown on hover
// The original (capped at 1600 px) is only loaded when a piece is opened.
//
// Originals larger than needed are shrunk in place. Copies are only remade when the original is newer.
// Runs before `dev` and `build`; run by hand with:   npm run images
import { readdir, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "public", "vstg");

const FULL_MAX = 1600; // longest side of an original
const FULL_QUALITY = 80;
const FULL_MAX_BYTES = 350 * 1024;
const HEAVY_MAX = 1200; // longest side for originals that are still heavier than FULL_MAX_BYTES
const MEDIUM = { dir: "m", size: 600, quality: 74 };
const BLURRED = { dir: "b", size: 96, quality: 72, sigma: 4.5 };

async function mtime(file) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

const files = (await readdir(dir)).filter((f) => /\.(webp|jpe?g)$/i.test(f)).sort();
await mkdir(path.join(dir, MEDIUM.dir), { recursive: true });
await mkdir(path.join(dir, BLURRED.dir), { recursive: true });

let shrunk = 0;
let made = 0;
for (const f of files) {
  const src = path.join(dir, f);

  // 1. Shrink the original if it is bigger than the largest size it is ever shown at.
  const meta = await sharp(src).metadata();
  // Very heavy files (fine grain, noise) also go down to a smaller size, so they stay light.
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  const heavy = (await stat(src)).size > FULL_MAX_BYTES;
  const cap = heavy ? HEAVY_MAX : FULL_MAX;
  if (longest > cap) {
    const buf = await sharp(src)
      .rotate()
      .resize(cap, cap, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: FULL_QUALITY })
      .toBuffer();
    await writeFile(src, buf);
    shrunk++;
  }

  const name = f.replace(/\.[^.]+$/, ".webp");
  const srcTime = await mtime(src);

  // 2. Medium copy, for hover.
  const medium = path.join(dir, MEDIUM.dir, name);
  if ((await mtime(medium)) < srcTime) {
    await sharp(src)
      .rotate()
      .resize(MEDIUM.size, MEDIUM.size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: MEDIUM.quality })
      .toFile(medium);
    made++;
  }

  // 3. Tiny blurred copy: the blur is baked in, so the browser does not compute it.
  const blurred = path.join(dir, BLURRED.dir, name);
  if ((await mtime(blurred)) < srcTime) {
    await sharp(src)
      .rotate()
      .resize(BLURRED.size, BLURRED.size, { fit: "inside" })
      .blur(BLURRED.sigma)
      .webp({ quality: BLURRED.quality })
      .toFile(blurred);
    made++;
  }
}

console.log(`${files.length} images: ${shrunk} originals shrunk, ${made} copies made`);
