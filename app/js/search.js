/* Hurtigsøk etter topper – combobox (WAI-ARIA 1.2) i #search, rett under tittelen.
   Treff fra RR.state.routes, «Sist sett» (localStorage rr.recent) og forslag når feltet er tomt. */
(function () {
  "use strict";
  var RR = window.RR, U = RR.util, S = RR.state;

  var MAX_RESULTS = 8;
  var MAX_SHOWN_EMPTY = 4;
  var MAX_STORED = 8;
  var STORE_KEY = "rr.recent";
  var DEBOUNCE_MS = 80;

  var collator = new Intl.Collator("nb", { numeric: true });
  var nf = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 });

  /* ------------------------------------------------------------------
     Normalisering: små bokstaver, æ->ae, ø->o, å->a, øvrige diakritika fjernes.
     map[i] = indeks i originalstrengen for tegn i i den normaliserte (map[len] = orig.length),
     slik at treff kan utheves i det originale navnet. */
  function fold(str) {
    var out = "", map = [], i, j, ch, lc, f;
    str = String(str == null ? "" : str);
    for (i = 0; i < str.length; i++) {
      ch = str.charAt(i);
      lc = ch.toLowerCase();
      if (lc === "æ") f = "ae";
      else if (lc === "ø") f = "o";
      else if (lc === "å") f = "a";
      else {
        f = lc;
        if (f.charCodeAt(0) > 127) {
          try { f = f.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) { /* gammel nettleser */ }
        }
      }
      for (j = 0; j < f.length; j++) { out += f.charAt(j); map.push(i); }
    }
    map.push(str.length);
    return { s: out, map: map };
  }

  function words(f) {
    var re = /[a-z0-9]+/g, m, w = [];
    while ((m = re.exec(f))) w.push({ s: m[0], at: m.index });
    return w;
  }

  /* Optimal string alignment (Levenshtein + nabobytte) */
  function osa(a, b) {
    var la = a.length, lb = b.length, d = [], i, j, c;
    if (Math.abs(la - lb) > 1) return 2;
    for (i = 0; i <= la; i++) { d[i] = [i]; }
    for (j = 1; j <= lb; j++) d[0][j] = j;
    for (i = 1; i <= la; i++) {
      for (j = 1; j <= lb; j++) {
        c = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[la][lb];
  }

  /* ------------------------------------------------------------------ indeks */
  var index = [];          // [{ r, f, map, words }]
  var indexSrc = null;     // routes-arrayen indeksen er bygd av
  var indexLen = -1;
  var suggestions = [];    // faste tilfeldige forslag (id-er) for denne økten

  function buildIndex() {
    var routes = S.routes || [];
    indexSrc = routes; indexLen = routes.length;
    index = routes.map(function (r) {
      var fm = fold(r.navn);
      return { r: r, f: fm.s, map: fm.map, words: words(fm.s) };
    });
    // Tilfeldig, men stabilt utvalg gjennom økten
    var ids = routes.map(function (r) { return r.id; }), i, j, t;
    for (i = ids.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    suggestions = ids;
  }
  function ensureIndex() {
    if (indexSrc !== S.routes || indexLen !== (S.routes || []).length) buildIndex();
  }

  function queryTokens(q) {
    var s = fold(q).s.replace(/aa/g, "a");
    return s.match(/[a-z0-9]+/g) || [];
  }

  /* Beste treff for ett søkeord i én oppføring -> { score, s, e } (område i normalisert navn) eller null */
  function matchToken(e, t) {
    var f = e.f, n = t.length, i, w, L, cand, k;
    if (f.indexOf(t) === 0) return { score: 0, s: 0, e: n };
    for (i = 0; i < e.words.length; i++) {
      w = e.words[i];
      if (w.s.indexOf(t) === 0) return { score: 1 + i * 0.01, s: w.at, e: w.at + n };
    }
    if (n >= 2) {
      k = f.indexOf(t);
      if (k !== -1) return { score: 2, s: k, e: k + n };
    }
    if (n >= 4) {
      for (i = 0; i < e.words.length; i++) {
        w = e.words[i];
        for (L = n - 1; L <= n + 1; L++) {
          cand = w.s.slice(0, L);
          if (cand.length >= n - 1 && osa(cand, t) <= 1) return { score: 3 + i * 0.01, s: w.at, e: w.at + cand.length };
        }
      }
    }
    return null;
  }

  function mergeRanges(rs) {
    rs.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    rs.forEach(function (r) {
      var last = out[out.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else out.push([r[0], r[1]]);
    });
    return out;
  }

  /* Rangerte treff: [{ r, ranges:[[start,slutt] i originalnavn] }] */
  function find(q, max) {
    ensureIndex();
    var toks = queryTokens(q);
    if (!toks.length) return [];
    var res = [];
    index.forEach(function (e) {
      var score = 0, rs = [], fz = false, ti, m;
      for (ti = 0; ti < toks.length; ti++) {
        m = matchToken(e, toks[ti]);
        if (!m) return;
        score += m.score;
        if (m.score >= 3) fz = true;
        rs.push([e.map[m.s], e.map[m.e - 1] + 1]);
      }
      res.push({ r: e.r, fuzzy: fz, score: score + e.f.length * 0.001, ranges: mergeRanges(rs) });
    });
    // Skrivefeil-treff vises kun når ingenting treffer direkte
    var exact = res.filter(function (x) { return !x.fuzzy; });
    if (exact.length) res = exact;
    res.sort(function (a, b) { return a.score - b.score || collator.compare(a.r.navn, b.r.navn); });
    return res.slice(0, max || MAX_RESULTS);
  }

  function highlight(name, ranges) {
    if (!ranges || !ranges.length) return U.esc(name);
    var out = "", pos = 0;
    ranges.forEach(function (r) {
      if (r[0] > pos) out += U.esc(name.slice(pos, r[0]));
      out += "<mark>" + U.esc(name.slice(r[0], r[1])) + "</mark>";
      pos = r[1];
    });
    return out + U.esc(name.slice(pos));
  }

  /* ------------------------------------------------------------------ sist sett */
  function loadRecent() {
    var raw = null, arr = [];
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return []; }
    try { arr = JSON.parse(raw || "[]"); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) return [];
    return arr.map(Number).filter(function (id) { return isFinite(id); });
  }
  function saveRecent(id) {
    try {
      var arr = loadRecent().filter(function (x) { return x !== id; });
      arr.unshift(id);
      localStorage.setItem(STORE_KEY, JSON.stringify(arr.slice(0, MAX_STORED)));
    } catch (e) { /* lagring ikke tilgjengelig */ }
  }

  /* ------------------------------------------------------------------ visning */
  var ICON_SEARCH = '<svg class="search-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  var ICON_CLEAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  var inited = false;
  var box, input, clearBtn, list, status, hostEl;
  var items = [];          // valgbare rader i visningsrekkefølge: [{ r, ranges }]
  var active = -1;
  var isOpen = false;
  var loadFailed = false;
  var timer = 0;

  function meta(r) {
    var p = [];
    if (r.topp_moh != null) p.push(nf.format(Math.round(r.topp_moh)) + " moh");
    if (r.tur_km != null) p.push(U.fmtKm(r.tur_km));
    if (r.hoydemeter != null) p.push(U.fmtHm(r.hoydemeter));
    return p.join(" · ");
  }

  function optionHtml(it, i) {
    var r = it.r;
    return '<li id="search-opt-' + i + '" class="search-opt" role="option" aria-selected="false" data-i="' + i + '">' +
      '<span class="lvl-dot" data-niva="' + U.esc(r.niva) + '" aria-hidden="true"></span>' +
      '<span class="search-opt__txt">' +
        '<span class="search-opt__name">' + highlight(r.navn, it.ranges) + '<span class="sr-only">, nivå ' + U.esc(r.niva) + '</span></span>' +
        '<span class="search-opt__meta">' + U.esc(meta(r)) + '</span>' +
      '</span></li>';
  }

  function say(t) { if (status) status.textContent = t; }

  function render() {
    var q = input.value.trim(), html = "", n;
    items = [];
    active = -1;
    input.removeAttribute("aria-activedescendant");

    if (!S.routes || !S.routes.length) {
      html = '<li class="search-msg" role="presentation">' + (loadFailed ? "Fikk ikke hentet turene." : "Laster turer …") + "</li>";
      say("");
    } else if (!queryTokens(q).length) {
      var shown = [], seen = {}, recent = [];
      loadRecent().forEach(function (id) {
        if (S.byId[id] && !seen[id] && recent.length < MAX_SHOWN_EMPTY) { seen[id] = 1; recent.push(S.byId[id]); }
      });
      var sug = [];
      for (var k = 0; k < suggestions.length && recent.length + sug.length < MAX_SHOWN_EMPTY; k++) {
        if (!seen[suggestions[k]] && S.byId[suggestions[k]]) sug.push(S.byId[suggestions[k]]);
      }
      if (recent.length) {
        html += '<li class="search-group" role="presentation">Sist sett</li>';
        recent.forEach(function (r) { items.push({ r: r }); html += optionHtml(items[items.length - 1], items.length - 1); });
      }
      if (sug.length) {
        html += '<li class="search-group" role="presentation">' + (recent.length ? "Forslag" : "Forslag til tur") + "</li>";
        sug.forEach(function (r) { items.push({ r: r }); html += optionHtml(items[items.length - 1], items.length - 1); });
      }
      shown = items;
      say(shown.length ? shown.length + " forslag" : "");
    } else {
      items = find(q, MAX_RESULTS);
      n = items.length;
      if (!n) {
        html = '<li class="search-msg" role="presentation">Ingen topper heter «' + U.esc(q) + '».</li>';
        say("Ingen treff");
      } else {
        html = items.map(optionHtml).join("");
        say(n + " treff");
      }
    }
    list.innerHTML = html;
    list.scrollTop = 0;
    if (items.length && queryTokens(q).length) setActive(0, true);
    position();
  }

  function setActive(i, noScroll) {
    var prev = list.querySelector('.search-opt[aria-selected="true"]');
    if (prev) prev.setAttribute("aria-selected", "false");
    active = i;
    if (i < 0 || i >= items.length) { active = -1; input.removeAttribute("aria-activedescendant"); return; }
    var el = document.getElementById("search-opt-" + i);
    if (!el) return;
    el.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", el.id);
    if (!noScroll && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }

  /* Lista ligger rett under feltet; begrens høyden så den ikke går utenfor panelet/skjermen */
  function position() {
    if (!isOpen || !list || list.hidden) return;
    var left = document.getElementById("left");
    var fr = box.getBoundingClientRect();
    var bottom = left ? left.getBoundingClientRect().bottom : (window.innerHeight || 600);
    var vv = window.visualViewport;
    var vvBottom = vv ? vv.offsetTop + vv.height : (window.innerHeight || bottom);
    var avail = Math.min(bottom, vvBottom) - fr.bottom - 14;
    list.style.maxHeight = Math.max(110, Math.floor(avail)) + "px";
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    list.hidden = false;
    box.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
    render();
  }

  function close() {
    clearTimeout(timer);
    if (!isOpen) return;
    isOpen = false;
    list.hidden = true;
    box.classList.remove("is-open");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function syncClear() {
    var has = input.value.length > 0;
    clearBtn.hidden = !has;
    box.classList.toggle("has-value", has);
  }

  function pick(i) {
    var it = items[i];
    if (!it) return;
    var id = it.r.id;
    close();
    input.value = "";
    syncClear();
    try { input.blur(); } catch (e) { /* ignorer */ }
    // Valgte ruter som er filtrert bort vises likevel (scene.js tegner utheving uavhengig av filter)
    RR.select(id, { source: "list", force: true });
    RR.emit("tab", "turer");
  }

  function raiseSheet() {
    var m = RR.modules.mobile;
    if (S.isMobile && m && m.setSheet) m.setSheet("max");
  }

  function focus() {
    if (!input) return;
    raiseSheet();
    try { input.focus(); } catch (e) { /* ignorer */ }
    try { input.select(); } catch (e) { /* ignorer */ }
  }

  /* ------------------------------------------------------------------ hendelser */
  function onKeydown(e) {
    if (e.isComposing) return;
    var k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) { open(); return; }
      if (!items.length) return;
      var d = k === "ArrowDown" ? 1 : -1;
      setActive(active < 0 ? (d > 0 ? 0 : items.length - 1) : (active + d + items.length) % items.length);
    } else if (k === "Enter") {
      if (!isOpen || !items.length) return;
      e.preventDefault();
      pick(active >= 0 ? active : 0);
    } else if (k === "Escape") {
      if (isOpen) { e.preventDefault(); close(); }
      else if (input.value) { e.preventDefault(); input.value = ""; syncClear(); }
      // Ellers slippes Esc videre (lukker f.eks. turkortet)
    } else if (k === "Tab") {
      close();
    }
  }

  function onInput() {
    syncClear();
    if (!isOpen) { open(); return; }
    clearTimeout(timer);
    if (!input.value) { render(); return; }
    timer = setTimeout(render, DEBOUNCE_MS);
  }

  function onListClick(e) {
    var el = e.target.closest ? e.target.closest(".search-opt") : null;
    if (el) pick(+el.getAttribute("data-i"));
  }

  function onListMove(e) {
    var el = e.target.closest ? e.target.closest(".search-opt") : null;
    if (!el || e.pointerType === "touch") return;
    var i = +el.getAttribute("data-i");
    if (i !== active) setActive(i, true);
  }

  function noBlur(e) { e.preventDefault(); } // behold fokus i feltet ved klikk i lista / tømmeknappen

  function onDocKey(e) {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    var t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    var w = document.getElementById("welcome");
    if (w && !w.hidden) return;
    var l = document.getElementById("left");
    if (l && l.hasAttribute("inert")) return;
    e.preventDefault();
    focus();
  }

  function onRoutes() {
    loadFailed = false;
    buildIndex();
    if (isOpen) render();
  }

  /* ------------------------------------------------------------------ init */
  function init() {
    if (inited) return;
    hostEl = document.getElementById("search");
    if (!hostEl) return;
    inited = true;

    hostEl.innerHTML =
      '<div class="search-box" role="search">' +
        '<label class="sr-only" for="search-input">Søk etter topp</label>' +
        '<div class="search-field">' +
          ICON_SEARCH +
          '<input id="search-input" class="search-input" type="search" role="combobox" aria-autocomplete="list" aria-haspopup="listbox"' +
            ' aria-expanded="false" aria-controls="search-list" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"' +
            ' enterkeyhint="search" placeholder="Søk etter topp …">' +
          '<kbd class="search-kbd" aria-hidden="true">/</kbd>' +
          '<button class="search-clear" type="button" aria-label="Tøm søket" hidden>' + ICON_CLEAR + '</button>' +
        '</div>' +
        '<ul id="search-list" class="search-list" role="listbox" aria-label="Søkeresultater" hidden></ul>' +
        '<div class="sr-only" role="status" aria-live="polite" id="search-status"></div>' +
      '</div>';

    box = hostEl.querySelector(".search-box");
    input = document.getElementById("search-input");
    clearBtn = hostEl.querySelector(".search-clear");
    list = document.getElementById("search-list");
    status = document.getElementById("search-status");

    input.addEventListener("focus", function () { raiseSheet(); open(); });
    input.addEventListener("click", function () { open(); });
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("blur", function (e) {
      if (!e.relatedTarget || !box.contains(e.relatedTarget)) close();
    });
    clearBtn.addEventListener("mousedown", noBlur);
    clearBtn.addEventListener("click", function () {
      input.value = "";
      syncClear();
      input.focus();
      if (isOpen) render(); else open();
    });
    list.addEventListener("mousedown", noBlur);
    list.addEventListener("click", onListClick);
    list.addEventListener("pointermove", onListMove);
    document.addEventListener("pointerdown", function (e) {
      if (isOpen && !box.contains(e.target)) close();
    }, true);
    document.addEventListener("keydown", onDocKey);
    window.addEventListener("resize", position);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", position);

    RR.on("data:routes", onRoutes);
    RR.on("data:error", function () { loadFailed = !(S.routes && S.routes.length); if (isOpen) render(); });
    RR.on("select", function (d) { if (d && d.id != null) saveRecent(Number(d.id)); });
    RR.on("sheet", function () { setTimeout(position, 330); });

    if (S.routes && S.routes.length) onRoutes();
    syncClear();
  }

  RR.modules.search = { init: init, focus: focus, find: find };
})();
