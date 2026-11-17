// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  parseGuide, validate, serialise, siteFiles, computeCacheVersion, blockText, stripEmphasis,
} from '../tools/build_data.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const S = require(path.join(SITE, 'search.js'));
const MD = fs.readFileSync(path.join(ROOT, 'WayneOrdinanceGuide.md'), 'utf8');
const DATA = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'ordinances.json'), 'utf8'));
const PREPARED = S.prepare(DATA);
const find = (q) => S.search(PREPARED, q).map((r) => r.entry);

// ---------------------------------------------------------------- required cases

test('searching "121 9f" returns § 121-9F first', () => {
  const r = find('121 9f');
  assert.ok(r.length > 0);
  assert.deepEqual(r[0].sections, ['121-9F']);
});

test('section search ignores format: 121-9F, 121 9f, §121-9F, § 121-9F', () => {
  for (const q of ['121-9F', '121 9f', '§121-9F', '§ 121-9F', 'Wayne Code § 121-9F', '121-9 f']) {
    assert.deepEqual(find(q)[0].sections, ['121-9F'], q);
  }
});

test('section-number matches rank ahead of text matches', () => {
  // § 121-11 is mentioned in many entries' Penalty text; no entry is titled with it.
  const r = S.search(PREPARED, '205-38B');
  assert.deepEqual(r[0].entry.sections, ['205-38B']);
  assert.ok(r[0].score >= 1000);
  assert.ok(r.slice(1).every((x) => x.score < r[0].score));
  // A subsection resolves to its parent entry ahead of mere mentions.
  assert.deepEqual(find('60-7G')[0].sections, ['60-7']);
});

test('searching "hydrant" returns § 205-38B', () => {
  const r = find('hydrant');
  assert.ok(r.some((e) => e.sections.includes('205-38B')), r.map((e) => e.title).join('\n'));
});

test('citation for the overnight parking entry is "Wayne Code § 200-5B"', () => {
  const e = DATA.entries.find((x) => x.name.startsWith('Overnight parking'));
  assert.ok(e);
  assert.equal(e.citation, 'Wayne Code § 200-5B');
  assert.deepEqual(S.citationsFor(e), ['Wayne Code § 200-5B']);
});

test('sw.js precaches every file in site/', () => {
  const sw = fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8');
  const m = /const PRECACHE = (\[[\s\S]*?\]);/.exec(sw);
  assert.ok(m, 'PRECACHE list not found');
  const list = JSON.parse(m[1]);
  const files = siteFiles().map((f) => './' + f);
  for (const f of files) assert.ok(list.includes(f), `not precached: ${f}`);
  for (const u of list) assert.ok(u === './' || files.includes(u), `precache entry with no file: ${u}`);
  assert.ok(list.includes('./data/ordinances.json'));
});

// ---------------------------------------------------------------- build + validation

test('build_data.mjs --check exits 0 and prints counts matching the H3 headings', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build_data.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const h3 = MD.split('\n').filter((l) => l.startsWith('### ')).length;
  assert.match(r.stdout, new RegExp(`Counts: categories=13 entries=${h3} quickFind=\\d+`));
  assert.equal(DATA.entries.length, h3);
});

test('committed ordinances.json and sw.js version are up to date with the source', () => {
  const fresh = serialise(parseGuide(MD).data);
  assert.equal(fs.readFileSync(path.join(SITE, 'data', 'ordinances.json'), 'utf8'), fresh, 'run: node tools/build_data.mjs');
  const sw = fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8');
  assert.match(sw, new RegExp(`const VERSION = '${computeCacheVersion()}';`), 'sw.js VERSION is stale; run: node tools/build_data.mjs');
});

test('validation fails when a block is dropped or text is altered', () => {
  // Drop one bullet from the source copy the parser sees.
  const parsed = parseGuide(MD);
  const e = parsed.data.entries.find((x) => x.sections[0] === '112-14');
  const i = e.fields.findIndex((x) => x.label === 'Penalty'); // "...cleanup cost (§ 112-16C)."
  const [dropped] = e.fields.splice(i, 1);
  parsed.consumed.delete(dropped.line);
  const v1 = validate(MD, parsed);
  assert.ok(v1.errors.some((x) => /not consumed/.test(x)));
  assert.ok(v1.errors.some((x) => /sections in source missing|occurrence counts differ/.test(x)));

  // Change a fine amount.
  const p2 = parseGuide(MD);
  const f = p2.data.entries.find((x) => x.sections[0] === '200-10.2').fields.find((x) => x.label === 'Penalty');
  f.value = f.value.replace('$250', '$200');
  assert.ok(validate(MD, p2).errors.some((x) => /not verbatim/.test(x)));
});

test('every quickFind row resolves to at least one entry', () => {
  const bad = DATA.quickFind.filter((r) => r.entryIds.length === 0 || r.unresolved.length);
  assert.deepEqual(bad.map((r) => r.sectionText), []);
});

test('field text is verbatim: § and en dashes kept, emphasis removed', () => {
  const lines = MD.split('\n').map((l) => stripEmphasis(l.replace(/^(#{1,6} |- )/, '')));
  for (const e of DATA.entries) {
    assert.ok(lines.includes(e.title), e.title);
    for (const f of e.fields) {
      if (f.kind === 'table') continue;
      const t = blockText(f);
      assert.ok(lines.includes(t), t);
      assert.ok(!/\*\*|(^|\s)\*\S/.test(t), `emphasis left in: ${t}`);
    }
  }
  const nov = DATA.entries.find((e) => e.sections[0] === '112-4B');
  assert.ok(nov.title.includes('§ 112-4B to § 112-4E'));
  const pen = DATA.entries.find((e) => e.sections[0] === '83-10').fields.find((f) => f.label === 'Penalty');
  assert.ok(pen.value.includes('$500–$10,000')); // en dash preserved
});

test('fields keep source order and labels', () => {
  const e = DATA.entries.find((x) => x.sections[0] === '123-4');
  assert.deepEqual(e.fields.map((f) => f.label), ['Prohibits', 'Elements', 'Penalty', 'Enforced by', 'Warning first', 'Officer tip', 'State overlap — verify']);
});

test('unclassified blocks are kept as unlabeled notes, not dropped', () => {
  const alarms = DATA.entries.find((x) => x.sections[0] === '36-3');
  assert.ok(alarms.fields.some((f) => f.kind === 'table'));
  assert.ok(alarms.fields.some((f) => f.kind === 'note' && !f.label && f.value.startsWith("The code's tables skip the 7th alarm")));
});

test('non-police enforcers are flagged; police enforcers are not', () => {
  const byFirst = (s) => DATA.entries.find((x) => x.sections[0] === s);
  assert.equal(byFirst('134-67.1A').enforcer.police, false); // "Refer it"
  assert.equal(byFirst('14-10').enforcer.police, false);     // Fire Bureau
  assert.equal(byFirst('200-5B').enforcer.police, true);
  assert.equal(byFirst('121-9F').enforcer.police, true);     // police as NCIs
});

test('cross-references resolve to entries', () => {
  const e = DATA.entries.find((x) => x.sections[0] === '14-15');
  assert.ok(e.crossRefs.some((r) => r.type === 'entry' && DATA.entries.find((x) => x.id === r.id).sections.includes('205-38B')));
  const see = DATA.entries.find((x) => x.name === 'Barking');
  assert.ok(see.fields[0].kind === 'see');
  assert.ok(see.crossRefs.some((r) => r.type === 'category' && r.id === 'noise'));
  assert.equal(DATA.categorySections['1-15'], 'general-penalty-provision');
});

// ---------------------------------------------------------------- site shell

test('index.html has the iPhone install tags and only local resources', () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="icons\/apple-touch-icon.png">/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="apple-mobile-web-app-status-bar-style"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /rel="manifest" href="manifest.webmanifest"/);
  const png = fs.readFileSync(path.join(SITE, 'icons', 'apple-touch-icon.png'));
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  for (const ref of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
    assert.ok(fs.existsSync(path.join(SITE, ref[1])), `missing ${ref[1]}`);
  }
});

test('manifest is valid and its icons exist', () => {
  const m = JSON.parse(fs.readFileSync(path.join(SITE, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(SITE, i.src)), i.src);
});

test('no third-party URLs, analytics or cookies in site code', () => {
  for (const f of ['index.html', 'app.js', 'app.css', 'sw.js', 'search.js', 'manifest.webmanifest']) {
    const s = fs.readFileSync(path.join(SITE, f), 'utf8');
    assert.ok(!/https?:\/\//.test(s), `${f} references an absolute URL`);
    assert.ok(!/document\.cookie|analytics|gtag\(/.test(s), `${f} uses cookies/analytics`);
  }
});

test('localStorage access is wrapped in try/catch', () => {
  const js = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');
  const uses = [...js.matchAll(/localStorage/g)].length;
  const guarded = [...js.matchAll(/try \{[^}]*localStorage[^}]*\}/g)].length;
  assert.ok(uses > 0);
  assert.equal(guarded, uses);
});

test('CSS meets the size rules: body >= 17px, 44px tap targets, dark mode, safe areas', () => {
  const css = fs.readFileSync(path.join(SITE, 'app.css'), 'utf8');
  assert.match(css, /font-size: max\(17px, 1rem\)/);
  assert.match(css, /font: -apple-system-body/);
  assert.match(css, /--tap: 44px/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
});
