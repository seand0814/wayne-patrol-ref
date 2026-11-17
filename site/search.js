/*
 * Shared section-number and search logic.
 * Loaded as a classic <script> in the browser (window.WayneSearch) and with
 * require() by tools/build_data.mjs and the tests, so both use one rule set.
 */
(function (root) {
  'use strict';

  // A Wayne Code section token: chapter-section, optional .decimal, optional
  // subsection letters, optional (n) / (x) paragraph markers.
  // Examples: 121-9F, 200-10.2, 134-67.1A(1), 134-68.1I(2)(b), 1-15.1A
  var TOKEN_SRC = '\\d+-\\d+(?:\\.\\d+)?[A-Z]*(?:\\((?:\\d+|[a-z])\\))*';
  // A "§" or "§§" run: the first token, then list continuations that name
  // another full token without repeating the § sign ("§§ 200-5A, 200-6").
  var RUN_SRC = '§§?\\s*(' + TOKEN_SRC + ')((?:(?:\\s*,\\s*|\\s+(?:and|to|or)\\s+)' + TOKEN_SRC + ')*)';

  function runRegex() { return new RegExp(RUN_SRC, 'g'); }
  function tokenRegex() { return new RegExp(TOKEN_SRC, 'g'); }

  /** All section tokens cited with § / §§ in a text, in order, with their offsets. */
  function findSections(text) {
    var out = [];
    if (!text) return out;
    var re = runRegex();
    var m;
    while ((m = re.exec(text)) !== null) {
      var run = m[0];
      var tre = tokenRegex();
      var t;
      while ((t = tre.exec(run)) !== null) {
        out.push({ token: t[0], start: m.index + t.index, end: m.index + t.index + t[0].length });
      }
    }
    return out;
  }

  function extractSections(text) {
    return findSections(text).map(function (f) { return f.token; });
  }

  /**
   * Canonical form for comparing section numbers regardless of format.
   * "121-9F", "121 9f", "§121-9F", "Wayne Code § 121-9F" -> "121-9f"
   * Returns null when the text does not start like a section number.
   */
  function canonicalSection(s) {
    if (s == null) return null;
    var q = String(s).toLowerCase().replace(/wayne\s*code/g, '').replace(/§/g, '').trim();
    var m = /^(\d+)(?:\s*[-\s–]\s*([0-9][0-9a-z.()\s\-–]*))?$/.exec(q);
    if (!m) return null;
    if (m[2] === undefined) return m[1]; // chapter only, e.g. "121"
    var rest = m[2].replace(/[\s\-–()]/g, '');
    return m[1] + '-' + rest;
  }

  function chapterOf(token) { return String(token).split('-')[0]; }

  /** Numeric section within a chapter for range tests ("200-35.70" -> 35.7). */
  function sectionNumber(token) {
    var m = /^\d+-(\d+(?:\.\d+)?)/.exec(token);
    return m ? parseFloat(m[1]) : NaN;
  }

  /**
   * Does a cited token point at an entry whose title lists `entrySection`?
   * Exact match, or the cited token is a subsection of the entry section
   * ("60-7G" -> "60-7", "134-67.1A(1)" -> "134-67.1A").
   */
  function tokenMatchesSection(token, entrySection) {
    var t = canonicalSection(token);
    var e = canonicalSection(entrySection);
    if (!t || !e) return false;
    if (t === e) return true;
    if (t.indexOf(e) === 0) {
      var next = t.charAt(e.length);
      return /[a-z]/.test(next) || (/\d/.test(next) && /[a-z]$/.test(e));
    }
    return false;
  }

  /** Does the token fall inside an entry's "X to Y" range ("§§ 200-52 to 200-60")? */
  function tokenInRange(token, range) {
    if (!range) return false;
    if (chapterOf(token) !== chapterOf(range.from) || chapterOf(token) !== chapterOf(range.to)) return false;
    var n = sectionNumber(token);
    var lo = sectionNumber(range.from);
    var hi = sectionNumber(range.to);
    if (lo !== hi) return n >= lo && n <= hi;
    // Same section, subsection letters ("§ 112-4B to § 112-4E").
    var sub = function (t) { var m = /^\d+-\d+(?:\.\d+)?([A-Z]*)/.exec(t); return m ? m[1] : ''; };
    var s = sub(token);
    return n === lo && s !== '' && s >= sub(range.from) && s <= sub(range.to);
  }

  /**
   * Entries a cited token resolves to. Entries that list the exact section win;
   * otherwise entries whose heading covers it (parent section or "X to Y" range).
   */
  function resolveToken(token, entries) {
    var exact = [];
    var broad = [];
    var tc = canonicalSection(token);
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.sections.some(function (s) { return canonicalSection(s) === tc; })) exact.push(e.id);
      else if (e.sections.some(function (s) { return tokenMatchesSection(token, s); }) ||
        (e.ranges || []).some(function (r) { return tokenInRange(token, r); })) broad.push(e.id);
    }
    return exact.length ? exact : broad;
  }

  // ---------- citations ----------

  /** Citation strings offered by the "Copy citation" buttons. */
  /**
   * The heading's own citation comes first, exactly as written. When the
   * heading names several sections (and is not a "X to Y" range), each one is
   * also offered on its own, so a single section can be written on a summons.
   */
  function citationsFor(entry) {
    var list = [];
    var add = function (c) { if (c && list.indexOf(c) === -1) list.push(c); };
    if (!entry.citation) return list;
    add(entry.citation);
    if (!(entry.ranges && entry.ranges.length) && entry.sections.length > 1) {
      entry.sections.forEach(function (s) { add('Wayne Code § ' + s); });
    }
    return list;
  }

  // ---------- full-text search ----------

  function fieldText(f) {
    if (f.kind === 'table') {
      return [].concat(f.header || [], [].concat.apply([], f.rows || [])).join(' ');
    }
    var s = '';
    if (f.label) s += f.label + (f.colon ? ':' : '') + ' ';
    return s + (f.value || '');
  }

  function prepare(data) {
    var situations = {};
    (data.quickFind || []).forEach(function (row) {
      row.entryIds.forEach(function (id) {
        (situations[id] = situations[id] || []).push(row.situation);
      });
    });
    return data.entries.map(function (e, idx) {
      var fields = e.fields.map(fieldText).join('\n');
      var allTokens = extractSections(e.title + '\n' + fields);
      return {
        entry: e,
        order: idx,
        title: e.title.toLowerCase(),
        fields: fields.toLowerCase(),
        situations: (situations[e.id] || []).join('\n').toLowerCase(),
        canon: e.sections.map(canonicalSection),
        mentioned: allTokens.map(canonicalSection)
      };
    });
  }

  function scoreSection(p, qc) {
    var best = 0;
    var chapterOnly = qc.indexOf('-') === -1;
    p.canon.forEach(function (c) {
      if (!c) return;
      if (chapterOnly) {
        if (c.split('-')[0] === qc) best = Math.max(best, 300);
        return;
      }
      if (c === qc) best = Math.max(best, 1000);
      else if (tokenMatchesSection(qc, c)) best = Math.max(best, 800); // query is a subsection of the entry
      else if (c.indexOf(qc) === 0) best = Math.max(best, 600);       // query is a prefix ("121-9")
    });
    if (best === 0 && !chapterOnly) {
      p.mentioned.forEach(function (c) {
        if (c === qc || tokenMatchesSection(qc, c) || tokenMatchesSection(c, qc)) best = Math.max(best, 100);
      });
    }
    return best;
  }

  /**
   * Search entries by section number, title and all field text.
   * Section-number matches rank first. Returns [{entry, score}] best first.
   */
  function search(prepared, query) {
    var q = String(query || '').trim();
    if (!q) return [];
    var results = [];
    var qc = canonicalSection(q);
    var words = q.toLowerCase().replace(/§/g, ' ').split(/\s+/).filter(Boolean);
    prepared.forEach(function (p) {
      var score = 0;
      if (qc) score = scoreSection(p, qc);
      if (words.length) {
        var all = true;
        var text = 0;
        words.forEach(function (w) {
          var inTitle = p.title.indexOf(w) !== -1;
          var inSit = p.situations.indexOf(w) !== -1;
          var inField = p.fields.indexOf(w) !== -1;
          if (!inTitle && !inSit && !inField) all = false;
          text += (inTitle ? 50 : 0) + (inSit ? 30 : 0) + (inField ? 10 : 0);
        });
        if (all) score += Math.min(text, 99); // text never outranks a section match
      }
      if (score > 0) results.push({ entry: p.entry, score: score, order: p.order });
    });
    results.sort(function (a, b) { return b.score - a.score || a.order - b.order; });
    return results;
  }

  var api = {
    TOKEN_SRC: TOKEN_SRC,
    findSections: findSections,
    extractSections: extractSections,
    canonicalSection: canonicalSection,
    tokenMatchesSection: tokenMatchesSection,
    tokenInRange: tokenInRange,
    resolveToken: resolveToken,
    citationsFor: citationsFor,
    fieldText: fieldText,
    prepare: prepare,
    search: search
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WayneSearch = api;
})(this);
