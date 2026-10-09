/* Panel – «Turer»-fanen: skredfare (#danger, #danger-mini), Finn tur (#finn) og turliste (#list). */
(function () {
  "use strict";
  var RR = window.RR, CFG = RR.CFG, U = RR.util, S = RR.state, esc = U.esc;

  var SORTS = [
    ["navn", "Navn", "Sorter etter navn"],
    ["km", "Kortest", "Sorter etter kortest tur"],
    ["hm", "Minst hm", "Sorter etter færrest høydemeter"],
    ["tid", "Tid", "Sorter etter tid"]
  ];
  var DANGER_REFRESH_MS = 60 * 60 * 1000;
  var LONG_TEXT = 140;

  var els = {};
  var inited = false;
  var loaded = false;          // ruter hentet
  var loadError = false;       // data:error uten ruter
  var dangerStatus = "loading"; // loading | ok | error
  var dangerSeq = 0;
  var dangerAt = 0;
  var textOpen = false;

  function $(id) { return document.getElementById(id); }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function reducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }

  /* =========================================================
     Skredfare
     ========================================================= */
  function ringHtml(level, mini, glyph) {
    var l = level | 0;
    var svg = '<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
      '<circle class="panel-ring__track" cx="60" cy="60" r="50"/>' +
      '<circle class="panel-ring__arc" cx="60" cy="60" r="50"/>' +
      (l === 5 ? '<circle class="panel-ring__edge" cx="60" cy="60" r="55.5"/><circle class="panel-ring__edge" cx="60" cy="60" r="44.5"/>' : "") +
      "</svg>";
    return '<span class="panel-ring' + (mini ? " panel-ring--mini" : "") + '" data-l="' + l + '">' + svg +
      '<span class="panel-ring__c"><span class="panel-ring__n">' + esc(glyph != null ? glyph : (l || "–")) + "</span>" +
      (mini ? "" : '<span class="panel-ring__l">Faregrad</span>') + "</span></span>";
  }

  function varsomLink(cls, txt) {
    return '<a class="' + cls + '" href="' + esc(CFG.VARSOM_URL) + '" target="_blank" rel="noopener">' + txt + "</a>";
  }

  function renderDanger() {
    var h = els.danger;
    if (!h) return;
    var head = '<h2 class="panel-h" id="panel-danger-h">Skredfare · Romsdal</h2>';
    var html;
    if (dangerStatus === "error" && !S.danger) {
      html = '<section class="panel-card panel-danger" aria-labelledby="panel-danger-h">' + head +
        '<p class="panel-msg" role="alert">Fikk ikke hentet skredvarselet. Sjekk ' +
        varsomLink("panel-inline", "varsom.no ↗") + ".</p>" +
        '<button type="button" class="panel-link" data-act="retry-danger">Prøv igjen</button></section>';
    } else if (!S.danger) {
      html = '<section class="panel-card panel-danger" aria-labelledby="panel-danger-h" aria-busy="true">' + head +
        '<div class="panel-danger__main"><div class="panel-ring panel-skel panel-skel--ring" aria-hidden="true"></div>' +
        '<div class="panel-danger__side"><div class="panel-skel panel-skel--l1" aria-hidden="true"></div>' +
        '<div class="panel-skel panel-skel--l2" aria-hidden="true"></div></div></div>' +
        '<p class="panel-sr" role="status">Henter skredvarsel …</p></section>';
    } else {
      var d = S.danger, t = d.days[0] || { label: "I dag", text: "" };
      var level = d.level | 0;
      var text = level === 0 ? "Ingen varsel nå – trolig utenfor sesong." : (t.text || "");
      var pills = d.days.slice(1, 3).map(function (x) {
        return '<li class="panel-pill" data-l="' + x.level + '"><span class="panel-pill__d">' + esc(x.label) + "</span>" +
          '<span class="panel-pill__n" data-l="' + x.level + '" aria-hidden="true">' + (x.level || "–") + "</span>" +
          '<span class="panel-sr">faregrad ' + (x.level || "ikke vurdert") + ", " + esc(x.name) + "</span></li>";
      }).join("");
      var long = text.length > LONG_TEXT;
      html = '<section class="panel-card panel-danger" aria-labelledby="panel-danger-h">' + head +
        '<div class="panel-danger__main">' +
        '<div class="panel-ring-wrap" role="img" aria-label="Faregrad ' + (level || "ikke vurdert") + ", " + esc(d.name) + '">' + ringHtml(level) + "</div>" +
        '<div class="panel-danger__side"><p class="panel-danger__name">' + esc(d.name) + "</p>" +
        '<p class="panel-danger__day">' + esc(t.label) + "</p></div></div>" +
        (pills ? '<ul class="panel-pills" aria-label="Kommende dager">' + pills + "</ul>" : "") +
        (text ? '<p class="panel-danger__text" id="panel-danger-text" data-open="' + (long && textOpen) + '">' + esc(text) + "</p>" : "") +
        '<div class="panel-danger__links">' +
        (long ? '<button type="button" class="panel-link" data-act="more" aria-expanded="' + textOpen + '" aria-controls="panel-danger-text">' + (textOpen ? "Vis mindre" : "Les mer") + "</button>" : "") +
        varsomLink("panel-link panel-ext", "Les varselet på varsom.no ↗") + "</div></section>";
    }
    h.innerHTML = html;
  }

  function renderMini() {
    var m = els.mini;
    if (!m) return;
    var label, level, glyph;
    if (S.danger) {
      level = S.danger.level | 0;
      label = level ? "Skredfare i dag: " + level + " " + S.danger.name : "Skredfare i dag: ikke vurdert";
    } else if (dangerStatus === "error") {
      level = 0; glyph = "?";
      label = "Skredfare: fikk ikke hentet varselet. Åpne varsom.no";
    } else { m.innerHTML = ""; return; }
    m.innerHTML = '<a class="panel-mini" href="' + esc(CFG.VARSOM_URL) + '" target="_blank" rel="noopener" aria-label="' + esc(label) +
      '" title="' + esc(label) + '">' + ringHtml(level, true, glyph) + "</a>";
  }

  function loadDanger() {
    var seq = ++dangerSeq;
    if (!S.danger) { dangerStatus = "loading"; renderDanger(); renderMini(); }
    var today = U.oslo().date;
    U.getJSON(CFG.AVALANCHE_URL(today, U.addDays(today, 2))).then(function (a) {
      if (seq !== dangerSeq) return;
      if (!Array.isArray(a)) throw new Error("Uventet svar fra Varsom");
      a = a.filter(function (x) { return x && x.ValidFrom; })
        .sort(function (x, y) { return x.ValidFrom < y.ValidFrom ? -1 : x.ValidFrom > y.ValidFrom ? 1 : 0; });
      var days = a.slice(0, 3).map(function (x) {
        var date = String(x.ValidFrom).slice(0, 10), l = U.dangerLevel(x.DangerLevel);
        return {
          date: date,
          label: date === today ? "I dag" : cap(U.dayName(date)),
          level: l, name: CFG.DANGER_NAMES[l], color: CFG.DANGER_COLORS[l],
          text: String(x.MainText || "").trim()
        };
      });
      var top = days[0] ? days[0].level : 0;
      S.danger = { level: top, name: CFG.DANGER_NAMES[top], color: CFG.DANGER_COLORS[top], days: days };
      dangerStatus = "ok";
      dangerAt = Date.now();
      renderDanger();
      renderMini();
      RR.emit("danger", S.danger);
    }).catch(function (e) {
      if (seq !== dangerSeq) return;
      console.warn("[panel] skredvarsel feilet:", e);
      if (S.danger) return; // behold forrige varsel
      dangerStatus = "error";
      renderDanger();
      renderMini();
      U.toast("Fikk ikke hentet skredvarselet.", "error");
    });
  }

  /* =========================================================
     Finn tur
     ========================================================= */
  function finnHtml() {
    var chips = CFG.LEVELS.map(function (n) {
      return '<button type="button" class="chip panel-chip" data-niva="' + esc(n) + '" aria-pressed="true">' +
        '<span class="lvl-dot" data-niva="' + esc(n) + '" aria-hidden="true"></span>' + esc(n) + "</button>";
    }).join("");
    return '<section class="panel-card panel-finn" aria-labelledby="panel-finn-h">' +
      '<div class="panel-finn__head"><h2 class="panel-h panel-h--grad" id="panel-finn-h">Finn tur</h2>' +
      '<button type="button" class="panel-link" id="panel-reset" hidden>Nullstill</button></div>' +
      '<div class="panel-field"><div class="panel-field__top"><label for="panel-km">Maks lengde</label><output for="panel-km" id="panel-km-out"></output></div>' +
      '<input type="range" class="panel-range" id="panel-km" min="0" max="' + CFG.MAX_KM + '" step="0.5"></div>' +
      '<div class="panel-field"><div class="panel-field__top"><label for="panel-hm">Maks høydemeter</label><output for="panel-hm" id="panel-hm-out"></output></div>' +
      '<input type="range" class="panel-range" id="panel-hm" min="0" max="' + CFG.MAX_HM + '" step="50"></div>' +
      '<div class="panel-field"><div class="panel-field__top"><span id="panel-niva-l">Nivå</span></div>' +
      '<div class="panel-chips" role="group" aria-labelledby="panel-niva-l">' + chips + "</div></div></section>";
  }

  function setRange(inp, out, val, fmt) {
    var v = Number(val), min = Number(inp.min), max = Number(inp.max);
    if (isNaN(v)) v = max;
    if (Number(inp.value) !== v) inp.value = v;
    var cur = Number(inp.value);
    inp.style.setProperty("--p", ((cur - min) / (max - min) * 100) + "%");
    var txt = cur >= max ? "Alle" : "≤ " + fmt(cur);
    out.textContent = txt;
    inp.setAttribute("aria-valuetext", txt);
  }

  function isDefaultFilter() {
    var f = S.filter;
    return f.maxKm >= CFG.MAX_KM && f.maxHm >= CFG.MAX_HM &&
      CFG.LEVELS.every(function (n) { return f.niva.indexOf(n) !== -1; });
  }

  function syncControls() {
    if (!els.km) return;
    var f = S.filter;
    setRange(els.km, els.kmOut, f.maxKm, function (v) { return v.toLocaleString("nb-NO") + " km"; });
    setRange(els.hm, els.hmOut, f.maxHm, function (v) { return v.toLocaleString("nb-NO") + " hm"; });
    els.chips.forEach(function (c) { c.setAttribute("aria-pressed", f.niva.indexOf(c.dataset.niva) !== -1 ? "true" : "false"); });
    els.reset.hidden = isDefaultFilter();
    if (els.seg) {
      Array.prototype.forEach.call(els.seg.querySelectorAll("button"), function (b) {
        b.setAttribute("aria-pressed", b.dataset.key === S.sort ? "true" : "false");
      });
    }
  }

  function resetFilter() {
    var focusKm = document.activeElement === els.reset;
    var inList = els.list && els.list.contains(document.activeElement);
    RR.setFilter({ maxKm: CFG.MAX_KM, maxHm: CFG.MAX_HM, niva: CFG.LEVELS.slice() });
    if (focusKm && els.km) els.km.focus();
    else if (inList) {
      var r = els.list.querySelector(".panel-row");
      if (r) r.focus({ preventScroll: true });
    }
  }

  function toggleLevel(n) {
    var cur = S.filter.niva.slice(), i = cur.indexOf(n);
    if (i !== -1) {
      if (cur.length === 1) return; // minst ett nivå må være valgt
      cur.splice(i, 1);
    } else cur.push(n);
    cur.sort(function (a, b) { return CFG.LEVELS.indexOf(a) - CFG.LEVELS.indexOf(b); });
    RR.setFilter({ niva: cur });
  }

  /* =========================================================
     Liste
     ========================================================= */
  function listShell() {
    var seg = SORTS.map(function (s) {
      return '<button type="button" data-act="sort" data-key="' + s[0] + '" title="' + esc(s[2]) + '" aria-pressed="' + (S.sort === s[0]) + '">' + esc(s[1]) + "</button>";
    }).join("");
    return '<section class="panel-listwrap" aria-labelledby="panel-count">' +
      '<h2 class="panel-count" id="panel-count" aria-live="polite"></h2>' +
      '<div class="panel-seg" id="panel-seg" role="group" aria-label="Sortering" hidden>' + seg + "</div>" +
      '<div class="panel-listbody" id="panel-listbody"></div></section>';
  }

  function isExposed(r) {
    return !!(S.danger && S.danger.level >= 3 && r.eksponert_m > 300);
  }

  function rowHtml(r) {
    var meta = [U.fmtKm(r.tur_km), U.fmtHm(r.hoydemeter)];
    if (r.park && r.park.est_tid_tekst) meta.push(esc(r.park.est_tid_tekst));
    var cur = S.selectedId === r.id;
    return '<li><button type="button" class="panel-row" data-id="' + esc(r.id) + '"' + (cur ? ' aria-current="true"' : "") + ">" +
      '<span class="lvl-dot" data-niva="' + esc(r.niva) + '" aria-hidden="true"></span>' +
      '<span class="panel-row__main"><span class="panel-row__name">' + esc(r.navn) +
      (isExposed(r) ? ' <span class="panel-tag" title="' + esc(Math.round(r.eksponert_m)) + ' m eksponert terreng">Eksponert</span>' : "") +
      '</span><span class="panel-row__meta">' + meta.join(" · ") + '<span class="panel-sr">. Nivå ' + esc(r.niva) + "</span></span></span></button></li>";
  }

  function renderList() {
    if (!els.body) return;
    var active = document.activeElement, fid = null;
    if (active && active.classList && active.classList.contains("panel-row") && els.body.contains(active)) fid = active.dataset.id;

    var html, count, showSeg = false;
    els.body.removeAttribute("aria-busy");
    if (loadError && !S.routes.length) {
      count = "Turer";
      html = '<div class="panel-state" role="alert"><p class="panel-msg">Fikk ikke hentet turene.</p>' +
        '<button type="button" class="btn panel-btn" data-act="reload">Prøv igjen</button></div>';
    } else if (!loaded) {
      count = "Henter turer …";
      els.body.setAttribute("aria-busy", "true");
      html = '<div class="panel-skels" aria-hidden="true">' + new Array(6).join('<div class="panel-skel panel-skel--row"></div>') + "</div>";
    } else {
      var ids = S.visibleIds || [];
      count = ids.length === 1 ? "1 tur" : ids.length + " turer";
      showSeg = true;
      if (!ids.length) {
        html = '<div class="panel-state"><p class="panel-msg">' +
          (S.routes.length ? "Ingen turer passer filteret." : "Ingen turer funnet.") + "</p>" +
          (S.routes.length ? '<button type="button" class="btn panel-btn" data-act="reset">Nullstill filter</button>' : "") + "</div>";
      } else {
        html = '<ul class="panel-list">' + ids.map(function (id) { return S.byId[id]; })
          .filter(Boolean).map(rowHtml).join("") + "</ul>";
      }
    }
    els.count.textContent = count;
    els.seg.hidden = !showSeg;
    els.body.innerHTML = html;
    if (fid != null) {
      var again = els.body.querySelector('.panel-row[data-id="' + fid + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }

  function markSelected(sel) {
    if (!els.body) return;
    var id = sel && sel.id != null ? String(sel.id) : null, target = null;
    Array.prototype.forEach.call(els.body.querySelectorAll(".panel-row"), function (b) {
      if (id !== null && b.dataset.id === id) { b.setAttribute("aria-current", "true"); target = b; }
      else b.removeAttribute("aria-current");
    });
    if (target && sel.source !== "list") {
      try { target.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }); }
      catch (e) { target.scrollIntoView(); }
    }
  }

  function onListKey(e) {
    var k = e.key;
    if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "Home" && k !== "End") return;
    var cur = e.target.closest ? e.target.closest(".panel-row") : null;
    if (!cur) return;
    var rows = Array.prototype.slice.call(els.body.querySelectorAll(".panel-row"));
    var i = rows.indexOf(cur), n = i;
    if (k === "ArrowDown") n = Math.min(rows.length - 1, i + 1);
    else if (k === "ArrowUp") n = Math.max(0, i - 1);
    else if (k === "Home") n = 0;
    else n = rows.length - 1;
    e.preventDefault();
    if (rows[n]) rows[n].focus();
  }

  /* =========================================================
     Init
     ========================================================= */
  function init() {
    if (inited) return;
    els.danger = $("danger"); els.finn = $("finn"); els.list = $("list"); els.mini = $("danger-mini");
    if (!els.finn || !els.list) { console.warn("[panel] mangler mount-punkter"); return; }
    inited = true;

    // Finn tur
    els.finn.innerHTML = finnHtml();
    els.km = $("panel-km"); els.kmOut = $("panel-km-out");
    els.hm = $("panel-hm"); els.hmOut = $("panel-hm-out");
    els.reset = $("panel-reset");
    els.chips = Array.prototype.slice.call(els.finn.querySelectorAll(".panel-chip"));
    els.km.addEventListener("input", function () { RR.setFilter({ maxKm: parseFloat(els.km.value) }); });
    els.hm.addEventListener("input", function () { RR.setFilter({ maxHm: parseFloat(els.hm.value) }); });
    els.chips.forEach(function (c) { c.addEventListener("click", function () { toggleLevel(c.dataset.niva); }); });
    els.reset.addEventListener("click", resetFilter);

    // Liste
    els.list.innerHTML = listShell();
    els.count = $("panel-count"); els.seg = $("panel-seg"); els.body = $("panel-listbody");
    els.list.addEventListener("click", function (e) {
      var row = e.target.closest(".panel-row");
      if (row) { RR.select(Number(row.dataset.id), { source: "list" }); return; }
      var b = e.target.closest("[data-act]");
      if (!b) return;
      var act = b.dataset.act;
      if (act === "sort") RR.setSort(b.dataset.key);
      else if (act === "reset") resetFilter();
      else if (act === "reload") location.reload();
    });
    els.list.addEventListener("keydown", onListKey);

    // Skredfare
    if (els.danger) els.danger.addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "retry-danger") loadDanger();
      else if (b.dataset.act === "more") {
        textOpen = !textOpen;
        var p = $("panel-danger-text");
        if (p) p.dataset.open = String(textOpen);
        b.setAttribute("aria-expanded", String(textOpen));
        b.textContent = textOpen ? "Vis mindre" : "Les mer";
      }
    });

    loaded = S.routes.length > 0;
    syncControls();
    renderDanger();
    renderMini();
    renderList();
    markSelected({ id: S.selectedId, source: "list" });

    RR.on("data:routes", function () { loaded = true; loadError = false; });
    RR.on("data:error", function () { if (!S.routes.length) { loadError = true; renderList(); } });
    RR.on("filter", function () { syncControls(); renderList(); });
    RR.on("select", function (d) { markSelected(d); });
    RR.on("danger", function () { renderList(); });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && dangerStatus === "ok" && Date.now() - dangerAt > DANGER_REFRESH_MS) loadDanger();
    });

    loadDanger();
  }

  function refresh() {
    if (!inited) return;
    syncControls();
    renderList();
    markSelected({ id: S.selectedId, source: "list" });
    loadDanger();
  }

  RR.modules.panel = { init: init, refresh: refresh };
})();
