/* Forhold-fanen: vær på toppene (MET), «Best i dag», siste turrapporter.
   Eksponerer RR.modules.forhold = { init, weatherFor(id), load() }. */
(function () {
  "use strict";
  var RR = window.RR, CFG = RR.CFG, U = RR.util, S = RR.state;

  var MAX_CONC = 4;                 // samtidige MET-forespørsler
  var TTL = 30 * 60 * 1000;         // cache 30 min
  var KOMP = ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"];
  var COLL = new Intl.Collator("nb", { numeric: true });
  var NF1 = new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  var root = null, el = {};
  var mem = {};                     // id -> { t, d }
  var failed = {};                  // id -> true
  var inflight = {};                // id -> Promise
  var queue = [], active = 0;
  var wanted = false;               // laste vær så snart ruter finnes
  var loadP = null, loadedAt = 0, loading = false;
  var done = 0, total = 0, anyOk = false, errToasted = false;
  var sortK = "navn", sortDir = 1;
  var reports = { state: "idle", items: [] };  // idle | loading | ok | empty | error
  var renderT = null;

  /* ---------- små hjelpere ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmtT(t) { var n = Math.round(t); return (n < 0 ? "−" : "") + Math.abs(n); }
  function komp(dir) { return KOMP[Math.round(dir / 45) % 8]; }
  function hasLL(r) { return r && r.top && r.top.lat != null && r.top.lon != null && isFinite(r.top.lat) && isFinite(r.top.lon); }
  function dangerLvl() { return (S.danger && S.danger.level) || 0; }
  function isExposed(r) { return dangerLvl() >= 3 && r.eksponert_m != null && r.eksponert_m > 300; }

  function ss(key, val) {
    try {
      if (val === undefined) {
        var x = JSON.parse(sessionStorage.getItem(key));
        return x && x.d && Date.now() - x.t < TTL ? x : null;
      }
      sessionStorage.setItem(key, JSON.stringify(val));
    } catch (e) { /* ignorer */ }
    return null;
  }

  /* ---------- MET: tolking av svaret (fra forhold.html) ---------- */
  function sym(c) {
    if (!c) return "";
    var b = c.replace(/_(day|night|polartwilight)$/, "");
    if (/thunder/.test(b)) return "Torden";
    var sh = /showers$/.test(b);
    b = b.replace(/showers$/, "");
    var M = { clearsky: "Klart", fair: "Lettskyet", partlycloudy: "Delvis skyet", cloudy: "Skyet", fog: "Tåke", rain: "Regn", lightrain: "Lett regn", heavyrain: "Kraftig regn", snow: "Snø", lightsnow: "Lett snø", heavysnow: "Kraftig snø" };
    var SH = { rain: "Regnbyger", lightrain: "Lette regnbyger", heavyrain: "Kraftige regnbyger", snow: "Snøbyger", lightsnow: "Lette snøbyger", heavysnow: "Kraftige snøbyger" };
    if (/sleet/.test(b)) return sh ? "Sluddbyger" : "Sludd";
    return (sh ? SH[b] : M[b]) || "";
  }

  function parseWx(j) {
    var ts = j && j.properties && j.properties.timeseries;
    if (!ts || !ts.length) throw new Error("Tomt svar fra MET");
    var today = U.oslo(new Date()).date, now = Date.now(), pick = null, i;
    for (i = 0; i < ts.length; i++) {
      var o = U.oslo(new Date(ts[i].time));
      if (o.date === today && o.hour === 12) { pick = ts[i]; break; }
    }
    if (!pick || Date.parse(pick.time) + 36e5 < now) {
      pick = ts[0];
      for (i = 0; i < ts.length; i++) if (Date.parse(ts[i].time) + 36e5 > now) { pick = ts[i]; break; }
    }
    var t0 = Date.parse(ts[0].time), end = t0 + 864e5, cov = t0, sum = 0;
    for (i = 0; i < ts.length; i++) {
      var t = Date.parse(ts[i].time), d = ts[i].data;
      if (t >= end) break;
      if (d.next_1_hours && t >= cov) {
        sum += d.next_1_hours.details.precipitation_amount || 0; cov = t + 36e5;
      } else if (d.next_6_hours && t >= cov) {
        var p = d.next_6_hours.details.precipitation_amount || 0;
        sum += p * Math.min(1, (end - t) / 216e5); cov = t + 216e5;
      }
    }
    var dd = pick.data, n = dd.next_1_hours || dd.next_6_hours || dd.next_12_hours, det = dd.instant.details;
    var code = n && n.summary && n.summary.symbol_code;
    return {
      time: pick.time, temp: det.air_temperature, vind: det.wind_speed, dir: det.wind_from_direction,
      sym: code || null, symText: sym(code), ned: Math.round(sum * 10) / 10
    };
  }

  /* ---------- kø med maks 4 samtidige forespørsler ---------- */
  function schedule(fn, front) {
    return new Promise(function (resolve, reject) {
      var job = { fn: fn, res: resolve, rej: reject };
      if (front) queue.unshift(job); else queue.push(job);
      pump();
    });
  }
  function pump() {
    while (active < MAX_CONC && queue.length) {
      var j = queue.shift();
      active++;
      Promise.resolve().then(j.fn).then(j.res, j.rej).then(function () { active--; pump(); });
    }
  }

  /* Hent vær for én topp (cache -> nett). front = prioritet i køen. */
  function fetchWx(id, front) {
    id = Number(id);
    var r = S.byId[id];
    if (!r) return Promise.reject(new Error("Ukjent tur"));
    if (!hasLL(r)) return Promise.reject(new Error("Mangler posisjon for toppen"));
    var m = mem[id];
    if (m && Date.now() - m.t < TTL) return Promise.resolve(m.d);
    var url = CFG.MET_URL(r.top.lat, r.top.lon, r.topp_moh);
    var key = "rr.wx:" + url;
    var c = ss(key);
    if (c) { mem[id] = { t: c.t, d: c.d }; delete failed[id]; return Promise.resolve(c.d); }
    if (inflight[id]) return inflight[id];
    var p = schedule(function () { return U.getJSON(url, { timeout: 20000 }); }, front)
      .then(function (j) {
        var w = parseWx(j), rec = { t: Date.now(), d: w };
        mem[id] = rec; delete failed[id];
        ss(key, rec);
        return w;
      })
      .then(function (w) { delete inflight[id]; sched(); return w; },
        function (e) { delete inflight[id]; failed[id] = true; sched(); throw e; });
    inflight[id] = p;
    return p;
  }

  function weatherFor(id) {
    id = Number(id);
    if (!S.routes.length) return Promise.reject(new Error("Rutene er ikke lastet ennå"));
    return fetchWx(id, true);
  }

  /* ---------- henting av alle topper ---------- */
  function load(force) {
    wanted = true;
    if (!S.routes.length) return Promise.resolve();
    if (loadP && !force && (loading || Date.now() - loadedAt < TTL)) return loadP;
    if (force) { mem = {}; failed = {}; errToasted = false; }
    loading = true; done = 0; anyOk = false;
    var list = S.routes.filter(hasLL);
    total = list.length;
    renderAll();
    var jobs = list.map(function (r) {
      return fetchWx(r.id, false).then(function () { anyOk = true; }, function () { /* markert i failed */ })
        .then(function () { done++; sched(); });
    });
    loadP = Promise.all(jobs).then(function () {
      loading = false; loadedAt = Date.now();
      if (!anyOk && total && !errToasted) {
        errToasted = true;
        U.toast("Fikk ikke hentet værdata. Prøv igjen litt senere.", "error");
      }
      renderAll();
    });
    loadReports(force);
    return loadP;
  }

  /* ---------- turrapporter ---------- */
  function loadReports(force) {
    if (reports.state === "loading" || (reports.state !== "idle" && reports.state !== "error" && !force)) return;
    reports.state = "loading"; sched();
    var url = CFG.REPORTS_URL + "/query?where=1%3D1&outFields=*&orderByFields=CreationDate%20DESC&resultRecordCount=10&f=json";
    U.getJSON(url).then(function (j) {
      reports.items = (j.features || []).map(function (f) { return f.attributes || {}; });
      reports.state = reports.items.length ? "ok" : "empty";
    }).catch(function (e) {
      console.warn("[forhold] turrapporter:", e);
      reports.state = "error";
    }).then(function () { sched(); });
  }

  function rpt(a, k) { return a[k] != null && a[k] !== "" ? a[k] : null; }
  function clean(v) { return String(v).replace(/_/g, " ").trim(); }

  function reportsHtml() {
    if (reports.state === "idle" || reports.state === "loading") return '<p class="fh-mut">Henter turrapporter …</p>';
    if (reports.state === "error") return '<p class="fh-mut">Fikk ikke hentet turrapporter.</p>';
    if (reports.state === "empty") return '<p class="fh-mut">Ingen rapporter ennå – bli den første!</p>';
    return '<ul class="fh-rep">' + reports.items.map(function (a) {
      var rute = rpt(a, "rute"), fore = rpt(a, "f_re"), tegn = rpt(a, "s_du_tegn_p_skredaktivitet");
      var kom = rpt(a, "kommentar_forhold_vind_tips_til"), d = rpt(a, "dato_for_turen") != null ? a.dato_for_turen : a.CreationDate;
      var dt = d != null ? new Date(d) : null;
      var ds = dt && !isNaN(dt) ? dt.toLocaleDateString("nb-NO", { day: "numeric", month: "short" }) : "";
      var tegnTxt = tegn != null ? clean(tegn) : "";
      var avl = tegnTxt && !/^nei$/i.test(tegnTxt);
      return '<li class="fh-rep__item">' +
        '<div class="fh-rep__head">' + (rute ? '<b>' + U.esc(clean(rute)) + '</b>' : '<b>Turrapport</b>') +
        (ds ? ' <span class="fh-mut">' + U.esc(ds) + '</span>' : '') + '</div>' +
        (fore != null ? '<div class="fh-rep__line">Føre: ' + U.esc(clean(fore)) + '</div>' : '') +
        (avl ? '<div class="fh-rep__line fh-rep__warn"><b>Skredtegn: ' + U.esc(tegnTxt) + '</b></div>' : '') +
        (kom ? '<div class="fh-rep__line fh-rep__com">' + U.esc(kom) + '</div>' : '') +
        '</li>';
    }).join("") + '</ul>';
  }

  /* ---------- rendering ---------- */
  function sched() {
    if (renderT) return;
    renderT = setTimeout(function () { renderT = null; renderAll(); }, 120);
  }

  function arrow(dir) {
    return '<svg class="fh-arr" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false" style="transform:rotate(' +
      Math.round((dir + 180) % 360) + 'deg)"><path d="M6 1l4 5H7.2v5H4.8V6H2z" fill="currentColor"/></svg>';
  }

  function rowsData() {
    return S.routes.map(function (r) {
      var m = mem[r.id];
      return { r: r, w: m ? m.d : null, st: hasLL(r) ? (failed[r.id] ? "–" : (m ? "" : "…")) : "–" };
    });
  }

  function keepFocus(fn) {
    var a = document.activeElement, cls = null, id = null;
    if (a && root && root.contains(a) && a.getAttribute && a.getAttribute("data-id") &&
      (a.classList.contains("fh-best") || a.classList.contains("fh-rowbtn"))) {
      cls = a.classList.contains("fh-best") ? "fh-best" : "fh-rowbtn";
      id = a.getAttribute("data-id");
    }
    fn();
    if (cls) {
      var n = root.querySelector("." + cls + '[data-id="' + id + '"]');
      if (n) try { n.focus({ preventScroll: true }); } catch (e) { /* ignorer */ }
    }
  }

  function renderAll() {
    if (!root) return;
    renderHead();
    keepFocus(function () { renderBest(); renderList(); });
    el.reports.innerHTML = reportsHtml();
  }

  function renderHead() {
    var first = null, latest = 0, id;
    for (id in mem) {
      if (!first) first = mem[id].d;
      if (mem[id].t > latest) latest = mem[id].t;
    }
    var when = "i dag kl. 12";
    if (first) {
      var o = U.oslo(new Date(first.time)), today = U.oslo(new Date()).date;
      when = (o.date === today ? "i dag" : U.dayName(o.date)) + " kl. " + pad(o.hour);
    }
    el.title.textContent = "Vær på toppene " + when;

    var txt = "", showProg = false, retry = false;
    if (!S.routes.length) txt = "Henter ruter …";
    else if (!wanted && !loading && !loadP) txt = "";
    else if (loading) { txt = "Henter vær … " + Math.min(done, total) + " av " + total; showProg = true; }
    else if (anyOk && latest) { var dt = new Date(latest); txt = "Oppdatert " + pad(dt.getHours()) + ":" + pad(dt.getMinutes()); }
    else if (loadP) { txt = "Fikk ikke hentet værdata."; retry = true; }
    el.upd.textContent = txt;
    el.prog.hidden = !showProg;
    if (showProg) el.progBar.style.width = (total ? Math.round(100 * Math.min(done, total) / total) : 0) + "%";
    el.retry.hidden = !retry;

    var lvl = dangerLvl();
    el.note.hidden = lvl < 3;
    if (lvl >= 3) el.note.textContent = "Faregrad " + lvl + " i dag. Turer med over 300 m eksponert terreng er merket «Eksponert».";

    // skjermleser: bare ferdigmelding, ikke hvert steg
    var fin = !loading && loadP ? (anyOk ? txt : "Fikk ikke hentet værdata.") : "";
    if (el.sr.textContent !== fin) el.sr.textContent = fin;
  }

  function renderBest() {
    var rows = rowsData();
    var html;
    if (!S.routes.length) html = '<p class="fh-mut">Henter ruter …</p>';
    else if (!loadP || loading) html = '<p class="fh-mut">Finner dagens beste topper …</p>';
    else {
      var c = rows.filter(function (x) { return x.w && x.w.ned <= 1; })
        .sort(function (a, b) { return a.w.vind - b.w.vind || a.w.ned - b.w.ned; }).slice(0, 3);
      if (!c.length) html = '<p class="fh-mut">' + (anyOk ? "Det er meldt nedbør på alle toppene det neste døgnet." : "Ingen værdata å vise ennå.") + '</p>';
      else html = '<ol class="fh-best-list">' + c.map(function (x, i) {
        var r = x.r, w = x.w;
        return '<li><button type="button" class="fh-best" data-id="' + r.id + '">' +
          '<span class="fh-best__rank" aria-hidden="true">' + (i + 1) + '</span>' +
          '<span class="fh-best__main">' +
          '<span class="fh-best__name">' + U.esc(r.navn) + (r.topp_moh != null ? ' <span class="fh-mut">' + Math.round(r.topp_moh) + ' moh</span>' : '') + '</span>' +
          '<span class="fh-best__meta">' + arrow(w.dir) + ' ' + NF1.format(w.vind) + ' m/s ' + komp(w.dir) +
          ' · ' + NF1.format(w.ned) + ' mm · ' + fmtT(w.temp) + '°' + (w.symText ? ' · ' + U.esc(w.symText) : '') + '</span>' +
          '</span>' +
          (isExposed(r) ? '<span class="fh-tag" title="' + Math.round(r.eksponert_m) + ' m eksponert terreng">Eksponert</span>' : '') +
          '</button></li>';
      }).join("") + '</ol>';
    }
    el.best.innerHTML = html;
  }

  function sortVal(x, k) {
    if (k === "navn") return x.r.navn;
    if (!x.w) return null;
    return x.w[k === "temp" ? "temp" : k === "vind" ? "vind" : "ned"];
  }

  function updateSortAttrs() {
    var ths = root.querySelectorAll("th[data-k]");
    for (var i = 0; i < ths.length; i++) {
      if (ths[i].getAttribute("data-k") === sortK) ths[i].setAttribute("aria-sort", sortDir > 0 ? "ascending" : "descending");
      else ths[i].removeAttribute("aria-sort");
    }
  }

  function renderList() {
    updateSortAttrs();
    if (!S.routes.length) { el.tbody.innerHTML = '<tr><td colspan="4" class="fh-mut fh-pad">Henter ruter …</td></tr>'; return; }
    var rows = rowsData().sort(function (a, b) {
      var x = sortVal(a, sortK), y = sortVal(b, sortK);
      if (x == null && y == null) return COLL.compare(a.r.navn, b.r.navn);
      if (x == null) return 1;
      if (y == null) return -1;
      var c = sortK === "navn" ? COLL.compare(x, y) : (x < y ? -1 : x > y ? 1 : 0);
      return (c || COLL.compare(a.r.navn, b.r.navn)) * (c ? sortDir : 1);
    });
    el.tbody.innerHTML = rows.map(function (x) {
      var r = x.r, w = x.w, exp = isExposed(r), st = x.st;
      var sub = (exp ? '<span class="fh-tag" title="' + Math.round(r.eksponert_m) + ' m eksponert terreng">Eksponert</span> ' : '') +
        (r.topp_moh != null ? Math.round(r.topp_moh) + ' moh' : '') +
        (w && w.symText ? ' · ' + U.esc(w.symText) : '');
      var wind = w
        ? '<span title="Vind fra ' + komp(w.dir) + ' (' + Math.round(w.dir) + '°)">' + arrow(w.dir) + ' ' + NF1.format(w.vind) +
          ' <span class="fh-mut">' + komp(w.dir) + '</span></span><span class="sr-only"> meter per sekund fra ' + komp(w.dir) + '</span>'
        : st;
      var sel = S.selectedId === r.id;
      return '<tr class="fh-tr' + (exp ? ' fh-exp' : '') + (sel ? ' fh-sel' : '') + '" data-id="' + r.id + '">' +
        '<th scope="row" class="fh-name"><button type="button" class="fh-rowbtn" data-id="' + r.id + '"' + (sel ? ' aria-current="true"' : '') + '>' + U.esc(r.navn) + '</button>' +
        '<span class="fh-sub">' + sub + '</span></th>' +
        '<td class="fh-n">' + (w ? fmtT(w.temp) + '°' : st) + '</td>' +
        '<td class="fh-n">' + wind + '</td>' +
        '<td class="fh-n">' + (w ? NF1.format(w.ned) + ' <span class="fh-mut">mm</span>' : st) + '</td></tr>';
    }).join("");
  }

  /* ---------- oppbygging ---------- */
  function build() {
    root.innerHTML =
      '<div class="fh">' +
      '<section class="fh-intro" aria-labelledby="fh-title">' +
      '<h2 class="fh-title" id="fh-title">Vær på toppene i dag kl. 12</h2>' +
      '<p class="fh-upd fh-mut"><span class="fh-upd__txt"></span> <button type="button" class="fh-retry btn btn--ghost" hidden>Prøv igjen</button></p>' +
      '<div class="fh-prog" hidden aria-hidden="true"><span class="fh-prog__bar"></span></div>' +
      '<p class="fh-note" hidden></p>' +
      '<span class="sr-only fh-sr" role="status" aria-live="polite"></span>' +
      '</section>' +
      '<section class="fh-sec" aria-labelledby="fh-h-best"><h3 class="fh-h" id="fh-h-best">Best i dag</h3>' +
      '<p class="fh-mut fh-hint fh-hint--top">Minst vind og høyst 1 mm nedbør.</p><div class="fh-best-wrap"></div></section>' +
      '<section class="fh-sec" aria-labelledby="fh-h-all"><h3 class="fh-h" id="fh-h-all">Vær på alle toppene</h3>' +
      '<table class="fh-tbl"><caption class="sr-only">Vær på alle toppene. Vind i meter per sekund, nedbør i millimeter neste 24 timer. Velg en rad for å vise turen.</caption>' +
      '<thead><tr>' +
      '<th scope="col" data-k="navn"><button type="button" class="fh-sort" data-sort="navn">Navn</button></th>' +
      '<th scope="col" class="fh-n" data-k="temp"><button type="button" class="fh-sort" data-sort="temp">°C</button></th>' +
      '<th scope="col" class="fh-n" data-k="vind"><button type="button" class="fh-sort" data-sort="vind">Vind m/s</button></th>' +
      '<th scope="col" class="fh-n" data-k="ned"><button type="button" class="fh-sort" data-sort="ned">Nedbør</button></th>' +
      '</tr></thead><tbody class="fh-tbody"></tbody></table>' +
      '<p class="fh-mut fh-hint">Pila viser hvor vinden blåser mot. Nedbør er summert for neste 24 timer.</p></section>' +
      '<section class="fh-sec" aria-labelledby="fh-h-rep"><h3 class="fh-h" id="fh-h-rep">Siste turrapporter</h3><div class="fh-reports"></div></section>' +
      '<a class="btn btn--primary fh-share" href="' + U.esc(CFG.REPORT_FORM_URL) + '" target="_blank" rel="noopener">Del forholdene fra turen din ↗</a>' +
      '<p class="fh-foot fh-mut">Data: MET Norway og NVE/Varsom.</p>' +
      '</div>';
    el = {
      title: root.querySelector(".fh-title"), upd: root.querySelector(".fh-upd__txt"),
      retry: root.querySelector(".fh-retry"), prog: root.querySelector(".fh-prog"), progBar: root.querySelector(".fh-prog__bar"),
      note: root.querySelector(".fh-note"), sr: root.querySelector(".fh-sr"),
      best: root.querySelector(".fh-best-wrap"), tbody: root.querySelector(".fh-tbody"), reports: root.querySelector(".fh-reports")
    };
  }

  function onClick(e) {
    var t = e.target;
    if (!t.closest) return;
    var b;
    if ((b = t.closest(".fh-retry"))) { load(true); return; }
    if ((b = t.closest("[data-sort]"))) {
      var k = b.getAttribute("data-sort");
      if (k === sortK) sortDir = -sortDir; else { sortK = k; sortDir = 1; }
      renderList();
      return;
    }
    if ((b = t.closest(".fh-best"))) {
      RR.select(Number(b.getAttribute("data-id")), { source: "list" });
      RR.emit("tab", "turer");
      return;
    }
    if ((b = t.closest("tr.fh-tr"))) {
      RR.select(Number(b.getAttribute("data-id")), { source: "list" });
    }
  }

  function init() {
    root = document.getElementById("forhold");
    if (!root) return;
    build();

    root.addEventListener("click", onClick);

    RR.on("data:routes", function () {
      renderAll();
      var pane = document.getElementById("pane-forhold");
      if (wanted || (pane && !pane.hidden)) load();
    });
    RR.on("danger", function () { renderAll(); });
    RR.on("select", function () { sched(); });
    RR.on("tab", function (t) { if (t === "forhold") load(); });
    RR.on("wx:request", function (d) {
      if (!d || d.id == null) return;
      fetchWx(d.id, true).catch(function () { /* card.js viser feil selv via weatherFor */ });
    });
    var tab = document.getElementById("tab-forhold");
    if (tab) tab.addEventListener("click", function () { load(); });

    renderAll();
    var pane = document.getElementById("pane-forhold");
    if (pane && !pane.hidden) load();
  }

  RR.modules.forhold = { init: init, weatherFor: weatherFor, load: load };
})();
