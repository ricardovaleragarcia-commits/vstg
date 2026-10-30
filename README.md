# VSTG

Digital archive of traces from failed futures: historical objects, plans and projects that never happened and still remain.

Each piece has:
- **[vstg–####]**: its code
- **[desc.]**: what the object is
- **[f.f. expl.]**: the future it points to, and how it still reaches the present
- **Source**: the reference where the object is documented
- **Licence**: the conditions for reusing the image

## Stack
- Next.js + TypeScript
- PixiJS (the free-moving plane)
- STIX Two Text (type)
- GitHub Pages (static hosting)

No database and no accounts. All content lives in `src/data/vstg.ts` and `public/vstg/`.

## Adding a piece
1. Download the image with a licence that allows reuse, and save it in `public/vstg/`.
2. Add an entry to `src/data/vstg.ts`, with its source and licence.
3. Commit and push. The site rebuilds, and the colour each frame shows while its photograph loads is recalculated from the image by itself (`npm run colors` does it by hand).

## Publishing
The site is published with GitHub Pages at https://ricardovaleragarcia-commits.github.io/vstg/

Every push to `main` builds the site and publishes it, through `.github/workflows/pages.yml`.

One-time setup: in the repository, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.

## Admin page
The archive can be edited from the browser at `/vstg/admin/`.

1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Under **Repository access**, choose only `vstg`.
3. Under **Permissions**, set **Contents** to *Read and write*.
4. Paste the token in the admin page and press **Load archive**.

Each save is a commit to `main`. GitHub Pages then rebuilds the site.

## Running locally
```bash
npm install
npm run dev
```
