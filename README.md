# Wayne Township Ordinance Field Guide — offline web app

An iPhone home-screen reference for `WayneOrdinanceGuide.md`. Search by call type, keyword or section number, then read the elements, penalty and enforcing authority. Works offline once it has been opened with signal.

**Live:** https://seand0814.github.io/wayne-patrol-ref/

## Install on an iPhone
1. Open the link above in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Open it once from the home screen while you have signal, so it saves for offline use. About → "This app" says "Saved for offline use" when it's ready.

## How it works
- `WayneOrdinanceGuide.md` is the only source and is never edited by the tools.
- `tools/build_data.mjs` (Node built-ins only) parses it into `site/data/ordinances.json` and validates it. Validation fails the build if:
  - the entry count differs from the number of `###` headings
  - any non-blank source line is not used
  - any `§` section citation is missing, added, or appears a different number of times
  - any text block or table cell differs from the source (only `**`/`*` emphasis is removed)
  - any Quick-Find row resolves to no entry
  Blocks the parser can't classify are kept as unlabeled `note` fields and listed in its log.
- The build also writes a cache version into `site/sw.js` (a hash of every site file) along with the list of files to precache. Any change to the data or the app gets a new cache, which the phone picks up the next time it's online.
- `site/` is plain HTML, CSS and JS: no framework, no build step, no packages, and no network calls after the first load.

## Updating the guide
1. Replace `WayneOrdinanceGuide.md`.
2. Run `node tools/build_data.mjs`, then `node --test tests/`.
3. Commit and push to `main`. The workflow in `.github/workflows/pages.yml` validates, tests and deploys `site/`.
