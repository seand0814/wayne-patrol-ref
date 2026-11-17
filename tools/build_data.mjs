#!/usr/bin/env node
// Parses WayneOrdinanceGuide.md into site/data/ordinances.json, validates the
// result against the source, then stamps site/sw.js with a cache version and
// the full precache list. Node built-ins only.
//
// Usage: node tools/build_data.mjs [--check]
//   --check  parse and validate only; do not write any files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'WayneOrdinanceGuide.md');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(SITE, 'data', 'ordinances.json');
const SW = path.join(SITE, 'sw.js');

const S = require(path.join(SITE, 'search.js'));

// Non-category H2 sections.
const H2_HOWTO = 'How to use this guide';
const H2_QUICKFIND = 'Quick-Find Index';
const H2_NOTVERIFIED = 'Not Verified / Not Found in the Code';

// ---------------------------------------------------------------- helpers

/** Markdown emphasis -> plain text. Everything else is kept byte for byte. */
export function stripEmphasis(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

/** Italic spans (after bold removal) — candidates for "see *Category*" links. */
function italicSpans(raw) {
  const noBold = raw.replace(/\*\*(.+?)\*\*/g, '$1');
  return [...noBold.matchAll(/\*([^*]+)\*/g)].map((m) => m[1]);
}

function slug(s) {
  return s.toLowerCase().replace(/§/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

function splitLabel(raw) {
  const m = /^\*\*(.+?)\*\*\s*/.exec(raw);
  if (!m) return { label: null, colon: false, value: stripEmphasis(raw) };
  let label = m[1];
  let colon = false;
  if (label.endsWith(':')) { colon = true; label = label.slice(0, -1); }
  return { label: stripEmphasis(label), colon, value: stripEmphasis(raw.slice(m[0].length)) };
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => stripEmphasis(c.trim()));
}

/** Plain text of a block exactly as it reads in the source (emphasis removed). */
export function blockText(b) {
  if (b.kind === 'table') return null;
  if (!b.label) return b.value;
  return b.label + (b.colon ? ':' : '') + (b.value ? ' ' + b.value : '');
}

// ---------------------------------------------------------------- parse

/**
 * Split markdown into headings and blocks. Each block remembers the source
 * line numbers it consumed so validation can prove nothing was dropped.
 */
function tokenize(md, log) {
  const lines = md.split(/\r?\n/);
  const items = [];
  let cur = null;
  const flush = () => { if (cur) items.push(cur); cur = null; };
  lines.forEach((line, i) => {
    const ln = i + 1;
    if (/^\s*$/.test(line)) { flush(); return; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); items.push({ type: 'heading', level: h[1].length, text: h[2].trim(), lines: [ln] }); return; }
    if (/^- /.test(line)) {
      if (!cur || cur.type !== 'list') { flush(); cur = { type: 'list', bullets: [], lines: [] }; }
      cur.bullets.push({ raw: line.slice(2), line: ln });
      cur.lines.push(ln);
      return;
    }
    if (/^\s*\|/.test(line)) {
      if (!cur || cur.type !== 'table') { flush(); cur = { type: 'table', rows: [], lines: [] }; }
      cur.rows.push(line);
      cur.lines.push(ln);
      return;
    }
    if (cur && cur.type === 'list' && /^\s+\S/.test(line)) {
      const b = cur.bullets[cur.bullets.length - 1];
      b.raw += ' ' + line.trim();
      cur.lines.push(ln);
      log.push(`line ${ln}: continuation line joined to the bullet above`);
      return;
    }
    if (cur && cur.type === 'paragraph') {
      cur.raw += ' ' + line.trim();
      cur.lines.push(ln);
      log.push(`line ${ln}: continuation line joined to the paragraph above`);
      return;
    }
    flush();
    cur = { type: 'paragraph', raw: line, lines: [ln] };
  });
  flush();
  return items;
}

/**
 * Turn a raw block into one or more JSON blocks.
 * ctx: 'entry' | 'intro' | 'about'
 */
function toBlocks(item, ctx, where, catRef, log) {
  const refsFor = (raw) => {
    const refs = [];
    for (const t of italicSpans(raw)) {
      const c = catRef(t);
      if (c && !refs.some((r) => r.text === t)) refs.push({ text: t, categoryId: c });
    }
    return refs;
  };
  if (item.type === 'list') {
    return item.bullets.map((b) => {
      const out = { kind: 'bullet', ...splitLabel(b.raw), line: b.line };
      const refs = refsFor(b.raw);
      if (refs.length) out.refs = refs;
      if (ctx === 'entry' && !out.label) {
        out.kind = 'note';
        log.push(`line ${b.line}: [${where}] bullet without a bold label -> kept as unlabeled "note"`);
      }
      return out;
    });
  }
  if (item.type === 'table') {
    const rows = item.rows.filter((r) => !/^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(r)).map(splitRow);
    if (ctx === 'entry') log.push(`line ${item.lines[0]}: [${where}] table kept as a "table" field`);
    return [{ kind: 'table', header: rows[0], rows: rows.slice(1), line: item.lines[0] }];
  }
  // paragraph
  const out = { kind: 'paragraph', ...splitLabel(item.raw), line: item.lines[0] };
  const refs = refsFor(item.raw);
  if (refs.length) out.refs = refs;
  if (ctx === 'entry') {
    if (!out.label && /^See\s/.test(out.value)) {
      out.kind = 'see';
    } else if (out.label) {
      log.push(`line ${item.lines[0]}: [${where}] bold-labeled paragraph after the bullets -> kept as a labeled "paragraph" field`);
    } else {
      out.kind = 'note';
      log.push(`line ${item.lines[0]}: [${where}] unclassified paragraph -> kept as unlabeled "note"`);
    }
  }
  return [out];
}

export function parseGuide(md) {
  const log = [];
  const items = tokenize(md, log);
  const consumed = new Set();
  items.forEach((it) => it.lines.forEach((l) => consumed.add(l)));

  const h2Titles = items.filter((i) => i.type === 'heading' && i.level === 2).map((i) => i.text);
  const catTitles = h2Titles.filter((t) => ![H2_HOWTO, H2_QUICKFIND, H2_NOTVERIFIED].includes(t));
  const categories = catTitles.map((t) => ({ id: slug(t.split(' — ')[0]), title: t, intro: [], entryIds: [] }));
  const catRef = (text) => {
    const t = text.toLowerCase();
    if (t.length < 4) return null;
    const c = categories.find((c) => c.title.toLowerCase().startsWith(t));
    return c ? c.id : null;
  };

  const data = {
    title: null,
    subtitle: null,
    howToUse: [],
    quickFindIntro: [],
    quickFind: [],
    categories,
    entries: [],
    notVerified: [],
  };
  // The § 1-15 general penalty is an H2 category; record its sections too.
  categories.forEach((c) => {
    const m = / — Wayne Code (.*)$/.exec(c.title);
    c.sections = m ? S.extractSections(m[1]) : [];
  });

  let section = null; // current H2 title
  let cat = null;
  let entry = null;
  const usedIds = new Set();

  for (const it of items) {
    if (it.type === 'heading') {
      if (it.level === 1) { data.title = stripEmphasis(it.text); continue; }
      if (it.level === 2) {
        section = it.text;
        entry = null;
        cat = categories.find((c) => c.title === it.text) || null;
        continue;
      }
      if (it.level === 3) {
        if (!cat) { log.push(`line ${it.lines[0]}: H3 outside a category: ${it.text}`); }
        const title = stripEmphasis(it.text);
        const parts = title.split(' — Wayne Code ');
        const name = parts[0];
        const citeTail = parts.length > 1 ? parts.slice(1).join(' — Wayne Code ') : null;
        const sections = citeTail ? S.extractSections(citeTail) : [];
        const ranges = citeTail
          ? [...citeTail.matchAll(new RegExp(`(${S.TOKEN_SRC})\\s+to\\s+§?\\s*(${S.TOKEN_SRC})`, 'g'))].map((m) => ({ from: m[1], to: m[2] }))
          : [];
        let id = sections.length ? slug(sections[0].replace(/[()]/g, '-')) : slug(name);
        id = id.replace(/-+$/, '').replace(/-+/g, '-');
        let n = 2;
        const base = id;
        while (usedIds.has(id)) id = `${base}-${n++}`;
        usedIds.add(id);
        if (!citeTail) log.push(`line ${it.lines[0]}: entry "${title}" has no "— Wayne Code §" citation in its heading`);
        entry = {
          id,
          categoryId: cat ? cat.id : null,
          title,
          name,
          citation: citeTail ? 'Wayne Code ' + citeTail : null,
          sections,
          ranges,
          line: it.lines[0],
          fields: [],
        };
        if (!ranges.length) delete entry.ranges;
        data.entries.push(entry);
        if (cat) cat.entryIds.push(id);
        continue;
      }
      log.push(`line ${it.lines[0]}: unexpected heading level ${it.level}: ${it.text}`);
      continue;
    }

    if (section === null) {
      // Lines between the H1 and the first H2.
      if (it.type === 'paragraph' && data.subtitle === null) data.subtitle = stripEmphasis(it.raw);
      else {
        log.push(`line ${it.lines[0]}: text before first section -> kept at the top of "howToUse"`);
        data.howToUse.push(...toBlocks(it, 'about', 'preamble', catRef, log));
      }
      continue;
    }
    if (section === H2_HOWTO) { data.howToUse.push(...toBlocks(it, 'about', H2_HOWTO, catRef, log)); continue; }
    if (section === H2_NOTVERIFIED) { data.notVerified.push(...toBlocks(it, 'about', H2_NOTVERIFIED, catRef, log)); continue; }
    if (section === H2_QUICKFIND) {
      if (it.type === 'table') {
        const rows = it.rows.filter((r) => !/^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(r)).map(splitRow);
        data.quickFindHeader = rows[0];
        rows.slice(1).forEach((r, i) => {
          if (r.length !== 3) log.push(`line ${it.lines[i + 2]}: Quick-Find row with ${r.length} cells`);
          data.quickFind.push({ category: r[0], situation: r[1], sectionText: r[2], sections: S.extractSections(r[2]), line: it.lines[i + 2] });
        });
      } else {
        data.quickFindIntro.push(...toBlocks(it, 'about', H2_QUICKFIND, catRef, log));
      }
      continue;
    }
    if (cat && !entry) { cat.intro.push(...toBlocks(it, 'intro', cat.title, catRef, log)); continue; }
    if (entry) { entry.fields.push(...toBlocks(it, 'entry', entry.title, catRef, log)); continue; }
    log.push(`line ${it.lines[0]}: block outside any known section -> dropped?!`);
  }

  // Enforcer flag: "Enforced by" text that does not name police, or says to refer.
  for (const e of data.entries) {
    const f = e.fields.find((f) => f.label === 'Enforced by');
    if (!f) { e.enforcer = null; continue; }
    const police = /police|\bNCIs?\b|peace officer|\bPD\b/i.test(f.value);
    const refer = /\bRefer it\b|document and refer/i.test(f.value);
    e.enforcer = { police: police && !refer, refer };
  }

  // Resolve sections: Quick-Find rows, and every token anywhere in the data.
  const entriesForResolve = data.entries.map((e) => ({ id: e.id, sections: e.sections, ranges: e.ranges }));
  const resolve = (tok) => S.resolveToken(tok, entriesForResolve);
  for (const row of data.quickFind) {
    const ids = [];
    row.unresolved = [];
    for (const t of row.sections) {
      const r = resolve(t);
      if (!r.length) row.unresolved.push(t);
      r.forEach((id) => { if (!ids.includes(id)) ids.push(id); });
    }
    row.entryIds = ids;
  }

  const sectionIndex = {};
  const categorySections = {};
  for (const tok of allTokens(data)) {
    if (sectionIndex[tok] !== undefined || categorySections[tok] !== undefined) continue;
    const gp = categories.find((c) => c.sections.some((s) => S.tokenMatchesSection(tok, s) || S.canonicalSection(tok).startsWith(S.canonicalSection(s) + '.')));
    if (gp) { categorySections[tok] = gp.id; continue; }
    sectionIndex[tok] = resolve(tok);
  }
  data.sectionIndex = sectionIndex;
  data.categorySections = categorySections;

  // Per-entry cross-references (tappable list under each entry).
  for (const e of data.entries) {
    const refs = [];
    const add = (r) => { if (!refs.some((x) => x.type === r.type && x.id === r.id)) refs.push(r); };
    for (const f of e.fields) {
      for (const tok of S.extractSections(fieldStrings(f).join('\n'))) {
        if (categorySections[tok]) { add({ type: 'category', id: categorySections[tok], via: '§ ' + tok }); continue; }
        for (const id of sectionIndex[tok] || []) if (id !== e.id) add({ type: 'entry', id, via: '§ ' + tok });
      }
      for (const r of f.refs || []) add({ type: 'category', id: r.categoryId, via: r.text });
    }
    e.crossRefs = refs;
  }

  return { data, log, consumed, items };
}

function fieldStrings(b) {
  if (b.kind === 'table') return [...b.header, ...b.rows.flat()];
  return [blockText(b)];
}

/** Every content string in the data, in document order (for validation). */
export function contentStrings(data) {
  const out = [data.title, data.subtitle];
  const blocks = (arr) => arr.forEach((b) => out.push(...fieldStrings(b)));
  blocks(data.howToUse);
  blocks(data.quickFindIntro);
  out.push(...(data.quickFindHeader || []));
  data.quickFind.forEach((r) => out.push(r.category, r.situation, r.sectionText));
  data.categories.forEach((c) => {
    out.push(c.title);
    blocks(c.intro);
    c.entryIds.forEach((id) => {
      const e = data.entries.find((x) => x.id === id);
      out.push(e.title);
      blocks(e.fields);
    });
  });
  blocks(data.notVerified);
  return out.filter((s) => s !== null && s !== undefined);
}

function allTokens(data) {
  return S.extractSections(contentStrings(data).join('\n'));
}

// ---------------------------------------------------------------- validate

export function validate(md, parsed) {
  const { data, consumed } = parsed;
  const errors = [];
  const report = [];
  const lines = md.split(/\r?\n/);

  // 1. Entry count == H3 headings.
  const h3 = lines.filter((l) => /^### /.test(l)).length;
  report.push(`H3 entry headings in source: ${h3}; entries in JSON: ${data.entries.length}`);
  if (h3 !== data.entries.length) errors.push(`entry count ${data.entries.length} != H3 count ${h3}`);

  // 2. Category count == H2 headings minus the 3 non-category sections.
  const h2 = lines.filter((l) => /^## /.test(l)).length;
  report.push(`H2 headings in source: ${h2}; categories: ${data.categories.length} (+3 non-category: How to use, Quick-Find, Not Verified)`);
  if (h2 - 3 !== data.categories.length) errors.push(`category count ${data.categories.length} != H2 count ${h2} - 3`);

  // 3. Every non-blank source line was consumed by the parser.
  const missed = [];
  lines.forEach((l, i) => { if (l.trim() && !consumed.has(i + 1)) missed.push(i + 1); });
  report.push(`non-blank source lines not consumed by the parser: ${missed.length}`);
  if (missed.length) errors.push(`lines not consumed: ${missed.join(', ')}`);

  // 4. § tokens: same multiset in source and JSON, both directions.
  const srcTokens = S.extractSections(md);
  const jsonTokens = allTokens(data);
  const count = (arr) => arr.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
  const cs = count(srcTokens);
  const cj = count(jsonTokens);
  const notInJson = [...cs.keys()].filter((t) => !cj.has(t));
  const notInSrc = [...cj.keys()].filter((t) => !cs.has(t));
  const countDiff = [...cs.keys()].filter((t) => cj.has(t) && cj.get(t) !== cs.get(t)).map((t) => `${t} (source ${cs.get(t)}, json ${cj.get(t)})`);
  const entrySecNotInSrc = data.entries.flatMap((e) => e.sections).filter((t) => !cs.has(t));
  const qfSecNotInSrc = data.quickFind.flatMap((r) => r.sections).filter((t) => !cs.has(t));
  report.push(`§ section citations in source: ${srcTokens.length} (${cs.size} distinct); in JSON: ${jsonTokens.length} (${cj.size} distinct)`);
  report.push(`  in source but missing from JSON: ${notInJson.length ? notInJson.join(', ') : 'none'}`);
  report.push(`  in JSON but not in source: ${notInSrc.length ? notInSrc.join(', ') : 'none'}`);
  report.push(`  occurrence-count mismatches: ${countDiff.length ? countDiff.join(', ') : 'none'}`);
  report.push(`  entry/Quick-Find section numbers not in source: ${[...entrySecNotInSrc, ...qfSecNotInSrc].join(', ') || 'none'}`);
  if (notInJson.length) errors.push(`sections in source missing from JSON: ${notInJson.join(', ')}`);
  if (notInSrc.length) errors.push(`sections in JSON not in source: ${notInSrc.join(', ')}`);
  if (countDiff.length) errors.push(`section occurrence counts differ: ${countDiff.join('; ')}`);
  if (entrySecNotInSrc.length || qfSecNotInSrc.length) errors.push(`entry/Quick-Find sections not in source: ${[...entrySecNotInSrc, ...qfSecNotInSrc].join(', ')}`);

  // 5. Verbatim: each text block equals its source line with only emphasis removed.
  const plainLines = lines.map((l) => stripEmphasis(l.replace(/^(#{1,6} |- )/, '')));
  const plainMd = stripEmphasis(md);
  let checked = 0;
  const notVerbatim = [];
  const checkBlock = (b) => {
    if (b.kind === 'table') {
      [...b.header, ...b.rows.flat()].forEach((c) => { checked++; if (!plainMd.includes(c)) notVerbatim.push(`line ${b.line}: cell "${c}"`); });
      return;
    }
    checked++;
    const t = blockText(b);
    if (plainLines[b.line - 1] !== t) notVerbatim.push(`line ${b.line}: "${t.slice(0, 80)}"`);
  };
  data.howToUse.forEach(checkBlock);
  data.quickFindIntro.forEach(checkBlock);
  data.notVerified.forEach(checkBlock);
  data.categories.forEach((c) => c.intro.forEach(checkBlock));
  data.entries.forEach((e) => {
    checked++;
    if (plainLines[e.line - 1] !== e.title) notVerbatim.push(`line ${e.line}: title "${e.title}"`);
    e.fields.forEach(checkBlock);
  });
  data.quickFind.forEach((r) => {
    checked++;
    if (plainLines[r.line - 1] !== `| ${r.category} | ${r.situation} | ${r.sectionText} |`) notVerbatim.push(`line ${r.line}: Quick-Find row`);
  });
  report.push(`verbatim check: ${checked} text blocks/cells compared to source; mismatches: ${notVerbatim.length}`);
  if (notVerbatim.length) errors.push(`not verbatim:\n    ${notVerbatim.join('\n    ')}`);

  // 6. Quick-Find rows resolve to entries.
  const unresolvedRows = data.quickFind.filter((r) => r.entryIds.length === 0);
  const partial = data.quickFind.filter((r) => r.entryIds.length && r.unresolved.length);
  report.push(`Quick-Find rows: ${data.quickFind.length}; resolving to no entry: ${unresolvedRows.length}; with some unresolved section: ${partial.length}`);
  unresolvedRows.forEach((r) => report.push(`  UNRESOLVED row line ${r.line}: ${r.situation} | ${r.sectionText}`));
  partial.forEach((r) => report.push(`  partly unresolved line ${r.line}: ${r.sectionText} -> no entry for ${r.unresolved.join(', ')}`));
  if (unresolvedRows.length) errors.push(`${unresolvedRows.length} Quick-Find row(s) resolve to no entry`);

  return { errors, report };
}

// ---------------------------------------------------------------- site stamping

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return listFiles(p, base);
    return [path.relative(base, p).split(path.sep).join('/')];
  }).sort();
}

export function siteFiles() { return listFiles(SITE); }

/** Hash of every site file except sw.js; changes whenever data or app changes. */
export function computeCacheVersion() {
  const h = crypto.createHash('sha256');
  for (const f of siteFiles()) {
    if (f === 'sw.js') continue;
    h.update(f + '\0');
    h.update(fs.readFileSync(path.join(SITE, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

export function stampServiceWorker(swSource, version, files) {
  const list = ['./', ...files.map((f) => './' + f)];
  const block = `// BUILD:START (written by tools/build_data.mjs — do not edit by hand)\n` +
    `const VERSION = '${version}';\n` +
    `const PRECACHE = ${JSON.stringify(list, null, 2)};\n` +
    `// BUILD:END`;
  if (!/\/\/ BUILD:START[\s\S]*?\/\/ BUILD:END/.test(swSource)) throw new Error('sw.js is missing BUILD:START/BUILD:END markers');
  return swSource.replace(/\/\/ BUILD:START[\s\S]*?\/\/ BUILD:END/, block);
}

/** Serialise data for the site (drops parser-only bookkeeping). */
export function serialise(data) {
  const clean = JSON.parse(JSON.stringify(data, (k, v) => (k === 'line' ? undefined : v)));
  const body = JSON.stringify(clean);
  const dataVersion = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  return JSON.stringify({ dataVersion, ...clean }, null, 1) + '\n';
}

// ---------------------------------------------------------------- main

function main() {
  const checkOnly = process.argv.includes('--check');
  const md = fs.readFileSync(SOURCE, 'utf8');
  const parsed = parseGuide(md);
  const { data, log } = parsed;
  const { errors, report } = validate(md, parsed);

  console.log(`Source: ${path.relative(ROOT, SOURCE)}`);
  console.log(`Counts: categories=${data.categories.length} entries=${data.entries.length} quickFind=${data.quickFind.length}`);
  console.log('\nValidation:');
  report.forEach((r) => console.log('  ' + r));
  console.log(`\nParser log (${log.length} item(s) — blocks that are not plain labeled bullets):`);
  log.forEach((l) => console.log('  ' + l));
  const nonPolice = data.entries.filter((e) => e.enforcer && !e.enforcer.police);
  console.log(`\nEntries flagged non-police enforcer: ${nonPolice.length}`);

  if (errors.length) {
    console.error('\nVALIDATION FAILED:');
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  if (checkOnly) { console.log('\n--check: validation passed; no files written.'); return; }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, serialise(data));
  const version = computeCacheVersion();
  const sw = fs.readFileSync(SW, 'utf8');
  fs.writeFileSync(SW, stampServiceWorker(sw, version, siteFiles()));
  console.log(`\nWrote ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)`);
  console.log(`Stamped ${path.relative(ROOT, SW)}: cache version ${version}, ${siteFiles().length + 1} precache URLs`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
