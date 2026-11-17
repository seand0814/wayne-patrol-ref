/* Wayne Township Ordinance Field Guide — single-page app, hash routing. */
(function () {
  'use strict';

  var S = window.WayneSearch;
  var BANNER = 'Code current through 06-17-2026 — confirm unusual charges on eCode360 or with the municipal prosecutor.';
  var FAV_KEY = 'wayne.favorites.v1';

  var data = null;
  var prepared = null;
  var entryById = {};
  var catById = {};

  var view = document.getElementById('view');
  var input = document.getElementById('q');
  var backBtn = document.getElementById('back');
  var statusEl = document.getElementById('status');
  var header = document.querySelector('.topbar');

  // ---------------------------------------------------------------- storage

  function loadFavs() {
    try {
      var v = JSON.parse(window.localStorage.getItem(FAV_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function saveFavs(list) {
    try { window.localStorage.setItem(FAV_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function isFav(id) { return loadFavs().indexOf(id) !== -1; }
  function toggleFav(id) {
    var list = loadFavs();
    var i = list.indexOf(id);
    if (i === -1) list.push(id); else list.splice(i, 1);
    var ok = saveFavs(list);
    return { on: i === -1, saved: ok };
  }

  // ---------------------------------------------------------------- DOM helpers

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function announce(msg) {
    statusEl.textContent = '';
    setTimeout(function () { statusEl.textContent = msg; }, 30);
  }

  // ---------------------------------------------------------------- cross-reference links

  function sectionHref(token, ctx) {
    var cat = data.categorySections[token];
    if (cat) return ctx.categoryId === cat ? null : '#/cat/' + cat;
    var ids = (data.sectionIndex[token] || []).filter(function (id) { return id !== ctx.entryId; });
    if (ids.length === 1) return '#/entry/' + ids[0];
    if (ids.length > 1) return '#/sec/' + encodeURIComponent(token);
    return null;
  }

  /** Text with § sections and "see Category" references turned into links. */
  function linkify(text, ctx, refs) {
    var spans = [];
    S.findSections(text).forEach(function (f) {
      var href = sectionHref(f.token, ctx);
      if (href) spans.push({ start: f.start, end: f.end, href: href });
    });
    (refs || []).forEach(function (r) {
      if (r.categoryId === ctx.categoryId) return;
      var i = text.indexOf(r.text);
      if (i !== -1) spans.push({ start: i, end: i + r.text.length, href: '#/cat/' + r.categoryId });
    });
    spans.sort(function (a, b) { return a.start - b.start; });
    var frag = document.createDocumentFragment();
    var pos = 0;
    spans.forEach(function (s) {
      if (s.start < pos) return; // overlapping
      if (s.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, s.start)));
      frag.appendChild(h('a', { href: s.href, class: 'xref' }, [text.slice(s.start, s.end)]));
      pos = s.end;
    });
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    return frag;
  }

  function labelNode(b) {
    if (!b.label) return null;
    return h('span', { class: 'label' }, [b.label + (b.colon ? ':' : '')]);
  }

  function blockContent(b, ctx) {
    var kids = [];
    var lab = labelNode(b);
    if (lab) { kids.push(lab); if (b.value) kids.push(' '); }
    if (b.value) kids.push(linkify(b.value, ctx, b.refs));
    return kids;
  }

  function tableNode(b, ctx) {
    return h('div', { class: 'table-wrap' }, [
      h('table', null, [
        h('thead', null, [h('tr', null, b.header.map(function (c) { return h('th', { scope: 'col' }, [linkify(c, ctx)]); }))]),
        h('tbody', null, b.rows.map(function (r) {
          return h('tr', null, r.map(function (c) { return h('td', null, [linkify(c, ctx)]); }));
        }))
      ])
    ]);
  }

  /** Render intro/about blocks; consecutive bullets become one list. */
  function renderBlocks(blocks, ctx) {
    var frag = document.createDocumentFragment();
    var ul = null;
    blocks.forEach(function (b) {
      if (b.kind === 'bullet') {
        if (!ul) { ul = h('ul', { class: 'blocks' }); frag.appendChild(ul); }
        ul.appendChild(h('li', null, blockContent(b, ctx)));
        return;
      }
      ul = null;
      if (b.kind === 'table') frag.appendChild(tableNode(b, ctx));
      else frag.appendChild(h('p', null, blockContent(b, ctx)));
    });
    return frag;
  }

  // ---------------------------------------------------------------- shared pieces

  function nonPolice(e) { return e.enforcer && !e.enforcer.police; }

  function entryRow(e, extra) {
    var meta = [];
    if (e.citation) meta.push(h('span', { class: 'row-cite' }, [e.citation]));
    if (nonPolice(e)) meta.push(h('span', { class: 'badge badge-warn' }, ['Non-police enforcer']));
    if (isFav(e.id)) meta.push(h('span', { class: 'badge badge-star', 'aria-label': 'Favorite' }, ['★']));
    return h('li', null, [
      h('a', { class: 'row', href: '#/entry/' + e.id }, [
        h('span', { class: 'row-main' }, [e.name]),
        meta.length ? h('span', { class: 'row-meta' }, meta) : null,
        extra || null
      ])
    ]);
  }

  function entryList(entries, extraFn) {
    return h('ul', { class: 'rows' }, entries.map(function (e) { return entryRow(e, extraFn ? extraFn(e) : null); }));
  }

  function qfHref(row, i) {
    if (row.entryIds.length === 1) return '#/entry/' + row.entryIds[0];
    if (row.entryIds.length > 1) return '#/qf/' + i;
    return null;
  }

  // ---------------------------------------------------------------- screens

  function renderHome() {
    var groups = [];
    data.quickFind.forEach(function (row, i) {
      var g = groups[groups.length - 1];
      if (!g || g.name !== row.category) { g = { name: row.category, rows: [] }; groups.push(g); }
      g.rows.push({ row: row, i: i });
    });
    var catsHeading = h('h2', { id: 'cats', tabindex: '-1' }, ['Categories']);
    var qfHeading = h('h2', { id: 'qf', tabindex: '-1' }, [data.quickFindHeader ? 'Quick-Find Index' : 'Quick-Find']);
    return [
      h('div', { class: 'jump' }, [
        h('button', { type: 'button', class: 'chip-btn', onclick: function () { qfHeading.scrollIntoView(); } }, ['Quick-Find']),
        h('button', { type: 'button', class: 'chip-btn', onclick: function () { catsHeading.scrollIntoView(); } }, ['Categories'])
      ]),
      qfHeading,
      renderBlocks(data.quickFindIntro, {}),
      h('div', null, groups.map(function (g) {
        return h('section', null, [
          h('h3', null, [g.name]),
          h('ul', { class: 'rows' }, g.rows.map(function (x) {
            var href = qfHref(x.row, x.i);
            var kids = [
              h('span', { class: 'row-main' }, [x.row.situation]),
              h('span', { class: 'row-cite' }, [x.row.sectionText])
            ];
            if (!href) kids.push(h('span', { class: 'unlinked' }, ['No matching entry in this guide']));
            return h('li', null, [href ? h('a', { class: 'row', href: href }, kids) : h('div', { class: 'row' }, kids)]);
          }))
        ]);
      })),
      catsHeading,
      h('ul', { class: 'rows' }, data.categories.map(function (c) {
        return h('li', null, [h('a', { class: 'row', href: '#/cat/' + c.id }, [
          h('span', { class: 'row-main' }, [c.title]),
          c.entryIds.length ? h('span', { class: 'row-sub' }, [c.entryIds.length + (c.entryIds.length === 1 ? ' entry' : ' entries')]) : null
        ])]);
      }))
    ];
  }

  function snippetFor(e, q) {
    var words = q.toLowerCase().replace(/§/g, ' ').split(/\s+/).filter(Boolean);
    for (var i = 0; i < e.fields.length; i++) {
      var t = S.fieldText(e.fields[i]);
      var low = t.toLowerCase();
      if (words.some(function (w) { return low.indexOf(w) !== -1; })) return t;
    }
    return null;
  }

  function renderSearch(q) {
    var results = S.search(prepared, q);
    var out = [h('h1', null, ['Search'])];
    out.push(h('p', { class: 'muted' }, [results.length + (results.length === 1 ? ' match for “' : ' matches for “') + q + '”']));
    if (!results.length) {
      out.push(h('p', { class: 'empty' }, ['No entries match. Try a shorter word, or a section number like 121-9F.']));
      return out;
    }
    out.push(entryList(results.map(function (r) { return r.entry; }), function (e) {
      var s = snippetFor(e, q);
      return s ? h('span', { class: 'snippet' }, [s]) : null;
    }));
    return out;
  }

  function renderCategory(id) {
    var c = catById[id];
    if (!c) return notFound();
    var ctx = { categoryId: c.id };
    var out = [h('h1', null, [c.title]), renderBlocks(c.intro, ctx)];
    if (c.entryIds.length) {
      out.push(h('h2', null, ['Entries']));
      out.push(entryList(c.entryIds.map(function (eid) { return entryById[eid]; })));
    }
    return out;
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.fontSize = '16px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (!ok) throw new Error('copy failed');
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { fallback(); });
    }
    return new Promise(function (resolve) { fallback(); resolve(); });
  }

  function copyButton(citation) {
    var btn = h('button', { type: 'button', class: 'btn btn-copy' }, ['Copy citation: ' + citation]);
    btn.addEventListener('click', function () {
      copyText(citation).then(function () {
        btn.textContent = 'Copied ✓ ' + citation;
        btn.classList.add('copied');
        announce('Copied ' + citation);
      }).catch(function () {
        btn.textContent = 'Copy failed — press and hold to select: ' + citation;
        announce('Copy failed');
      });
      setTimeout(function () {
        btn.textContent = 'Copy citation: ' + citation;
        btn.classList.remove('copied');
      }, 2500);
    });
    return btn;
  }

  function starButton(e) {
    var on = isFav(e.id);
    var btn = h('button', { type: 'button', class: 'btn btn-star', 'aria-pressed': on ? 'true' : 'false' },
      [on ? '★ Favorite' : '☆ Add to favorites']);
    btn.addEventListener('click', function () {
      var r = toggleFav(e.id);
      btn.setAttribute('aria-pressed', r.on ? 'true' : 'false');
      btn.textContent = r.on ? '★ Favorite' : '☆ Add to favorites';
      announce(!r.saved ? 'Could not save favorites on this device' : r.on ? 'Added to favorites' : 'Removed from favorites');
    });
    return btn;
  }

  function renderEntry(id) {
    var e = entryById[id];
    if (!e) return notFound();
    var c = catById[e.categoryId];
    var ctx = { entryId: e.id, categoryId: null };
    var out = [];
    if (c) out.push(h('a', { class: 'crumb', href: '#/cat/' + c.id }, ['‹ ' + c.title]));
    out.push(h('h1', null, [e.name]));
    if (e.citation) out.push(h('p', { class: 'cite-line' }, [e.citation]));
    if (nonPolice(e)) {
      out.push(h('div', { class: 'alert', role: 'note' }, [
        h('strong', null, ['Non-police enforcer. ']),
        'The code names someone other than police for this entry — see “Enforced by” below.'
      ]));
    }
    var actions = [starButton(e)];
    S.citationsFor(e).forEach(function (cit) { actions.push(copyButton(cit)); });
    out.push(h('div', { class: 'actions' }, actions));

    var fields = h('div', { class: 'fields' });
    e.fields.forEach(function (f) {
      var cls = 'field field-' + f.kind;
      if (f.label === 'Enforced by') cls += ' field-enforced' + (nonPolice(e) ? ' nonpolice' : '');
      if (f.label === 'Caution') cls += ' field-caution';
      if (f.kind === 'table') { fields.appendChild(h('div', { class: cls }, [tableNode(f, ctx)])); return; }
      fields.appendChild(h('div', { class: cls }, blockContent(f, ctx)));
    });
    out.push(fields);

    if (e.crossRefs && e.crossRefs.length) {
      out.push(h('h2', null, ['Cross-references']));
      out.push(h('ul', { class: 'rows' }, e.crossRefs.map(function (r) {
        var target = r.type === 'entry' ? entryById[r.id] : catById[r.id];
        if (!target) return null;
        var name = r.type === 'entry' ? target.title : target.title;
        return h('li', null, [h('a', { class: 'row', href: '#/' + (r.type === 'entry' ? 'entry' : 'cat') + '/' + r.id }, [
          h('span', { class: 'row-main' }, [name]),
          h('span', { class: 'row-sub' }, ['Referenced as ' + r.via])
        ])]);
      })));
    }
    return out;
  }

  function renderQuickFindRow(i) {
    var row = data.quickFind[i];
    if (!row) return notFound();
    return [
      h('h1', null, [row.situation]),
      h('p', { class: 'cite-line' }, [row.sectionText]),
      h('p', { class: 'muted' }, ['Quick-Find: ' + row.category]),
      entryList(row.entryIds.map(function (id) { return entryById[id]; }))
    ];
  }

  function renderSection(token) {
    var ids = data.sectionIndex[token] || [];
    return [
      h('h1', null, ['§ ' + token]),
      ids.length ? entryList(ids.map(function (id) { return entryById[id]; })) : h('p', { class: 'empty' }, ['No entry in this guide.'])
    ];
  }

  function renderFavorites() {
    var favs = loadFavs().map(function (id) { return entryById[id]; }).filter(Boolean);
    var out = [h('h1', null, ['Favorites'])];
    if (!favs.length) {
      out.push(h('p', { class: 'empty' }, ['No favorites yet. Open an entry and tap “☆ Add to favorites”.']));
      return out;
    }
    out.push(entryList(favs));
    return out;
  }

  function renderAbout() {
    var gp = data.categories.filter(function (c) { return c.sections && c.sections.length; });
    var offline = h('p', { class: 'muted small' }, ['Checking offline status…']);
    checkOffline(offline);
    var out = [
      h('div', { class: 'banner', role: 'note' }, [BANNER]),
      h('h1', null, [data.title]),
      h('p', { class: 'muted' }, [data.subtitle]),
      h('section', { class: 'about-section' }, [h('h2', null, ['How to use this guide']), renderBlocks(data.howToUse, {})])
    ];
    gp.forEach(function (c) {
      out.push(h('section', { class: 'about-section' }, [h('h2', null, [c.title]), renderBlocks(c.intro, { categoryId: c.id })]));
    });
    out.push(h('section', { class: 'about-section' }, [h('h2', null, ['Not Verified / Not Found in the Code']), renderBlocks(data.notVerified, {})]));
    out.push(h('section', { class: 'about-section' }, [
      h('h2', null, ['This app']),
      h('p', { class: 'small muted' }, ['Data version ' + data.dataVersion + ' · ' + data.entries.length + ' entries · ' + data.categories.length + ' categories · ' + data.quickFind.length + ' Quick-Find rows.']),
      offline
    ]));
    return out;
  }

  function checkOffline(node) {
    if (!('serviceWorker' in navigator) || !window.caches) {
      node.textContent = 'Offline storage is not available in this browser.';
      return;
    }
    navigator.serviceWorker.getRegistration().then(function (reg) {
      return window.caches.keys().then(function (keys) {
        var mine = keys.filter(function (k) { return k.indexOf('wayne-ordinances-') === 0; });
        if (reg && reg.active && mine.length) node.textContent = 'Saved for offline use (cache ' + mine.join(', ') + ').';
        else node.textContent = 'Not yet saved for offline use. Open the app once with signal.';
      });
    }).catch(function () { node.textContent = 'Offline status unknown.'; });
  }

  function notFound() {
    return [h('h1', null, ['Not found']), h('p', null, [h('a', { href: '#/' }, ['Go to Home'])])];
  }

  // ---------------------------------------------------------------- routing

  function parseRoute() {
    var hash = location.hash.replace(/^#/, '') || '/';
    var qi = hash.indexOf('?');
    var pathPart = qi === -1 ? hash : hash.slice(0, qi);
    var params = {};
    if (qi !== -1) {
      hash.slice(qi + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        try { params[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); } catch (e) { /* ignore */ }
      });
    }
    var seg = pathPart.split('/').filter(Boolean).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
    return { name: seg[0] || 'home', arg: seg[1], params: params };
  }

  var scrollPos = {};
  var freshNav = false;
  var lastHash = null;

  function render() {
    if (!data) return;
    var r = parseRoute();
    var nodes;
    var tab = null;
    switch (r.name) {
      case 'home': nodes = renderHome(); tab = 'home'; break;
      case 'search': nodes = renderSearch(r.params.q || ''); break;
      case 'cat': nodes = renderCategory(r.arg); break;
      case 'entry': nodes = renderEntry(r.arg); break;
      case 'qf': nodes = renderQuickFindRow(parseInt(r.arg, 10)); break;
      case 'sec': nodes = renderSection(r.arg); break;
      case 'favorites': nodes = renderFavorites(); tab = 'favorites'; break;
      case 'about': nodes = renderAbout(); tab = 'about'; break;
      default: nodes = notFound();
    }
    view.textContent = '';
    nodes.forEach(function (n) { if (n) view.appendChild(n); });

    backBtn.hidden = r.name === 'home';
    document.querySelectorAll('.tabbar a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (r.name === 'search') {
      if (document.activeElement !== input) input.value = r.params.q || '';
    } else if (document.activeElement !== input) {
      input.value = '';
    }
    var titles = { entry: entryById[r.arg] && entryById[r.arg].name, cat: catById[r.arg] && catById[r.arg].title };
    document.title = (titles[r.name] ? titles[r.name] + ' · ' : '') + 'Wayne Code';
  }

  function onHashChange() {
    if (lastHash !== null) scrollPos[lastHash] = window.scrollY;
    var key = location.hash || '#/';
    render();
    var y = (!freshNav && scrollPos[key]) || 0;
    window.scrollTo(0, y);
    freshNav = false;
    lastHash = key;
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href^="#/"]');
    if (a) freshNav = true;
  });

  backBtn.addEventListener('click', function () {
    if (window.history.length > 1) window.history.back();
    else location.hash = '#/';
  });

  input.addEventListener('input', function () {
    var q = input.value;
    var target = q.trim() ? '#/search?q=' + encodeURIComponent(q) : '#/';
    var onSearch = parseRoute().name === 'search';
    if (onSearch) {
      window.history.replaceState(null, '', target);
      render();
      lastHash = target;
    } else if (q.trim()) {
      freshNav = true;
      location.hash = target;
    }
  });
  document.getElementById('searchform').addEventListener('submit', function (ev) {
    ev.preventDefault();
    input.blur(); // hides the keyboard so results are visible
  });

  // Keep the About banner just under the sticky header.
  function syncHeaderHeight() {
    document.documentElement.style.setProperty('--header-h', header.getBoundingClientRect().height + 'px');
  }
  window.addEventListener('resize', syncHeaderHeight);
  if (window.ResizeObserver) new ResizeObserver(syncHeaderHeight).observe(header);
  syncHeaderHeight();

  // ---------------------------------------------------------------- start

  function start(json) {
    data = json;
    data.entries.forEach(function (e) { entryById[e.id] = e; });
    data.categories.forEach(function (c) { catById[c.id] = c; });
    prepared = S.prepare(data);
    window.addEventListener('hashchange', onHashChange);
    onHashChange();
  }

  fetch('data/ordinances.json')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(start)
    .catch(function (err) {
      view.textContent = '';
      view.appendChild(h('p', { class: 'empty' }, ['Could not load the ordinance data (' + err.message + '). Open the app once with signal so it can be saved for offline use.']));
    });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () { /* offline install unavailable */ });
    });
  }
})();
