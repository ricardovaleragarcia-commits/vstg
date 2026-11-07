// Makes a small copy of every image in public/vstg, into public/vstg/t.
// The Collection loads these lightweight copies while browsing (the pieces are blurred anyway)
// and only loads the full-size image of the piece that is opened.
//
// It runs before every build and before `npm run dev`. Images that have not changed are skipped.
// Do not commit public/vstg/t: it is rebuilt from the originals.
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "public", "vstg");
const out = path.join(dir, "t");

const LONGEST = 560; // pieces are at most 420 px on their longest side, so this is plenty for a blurred view
const QUALITY = 70;

await mkdir(out, { recursive: true });
const files = (await readdir(dir)).filter((f) => /\.(webp|jpe?g)$/i.test(f));

let made = 0;
for (const file of files) {
  const src = path.join(dir, file);
  const dest = path.join(out, file.replace(/\.(jpe?g)$/i, ".webp"));
  const [a, b] = await Promise.all([stat(src), stat(dest).catch(() => null)]);
  if (b && b.mtimeMs >= a.mtimeMs) continue;
  await sharp(src)
    .rotate()
    .resize(LONGEST, LONGEST, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toFile(dest);
  made++;
}
console.log(`thumbnails: ${made} made, ${files.length - made} already up to date`);
