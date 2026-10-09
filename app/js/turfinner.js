/* Turfinner-fanen: «Hva er den beste turen for meg i dag/i morgen?»
   Eksponerer RR.modules.turfinner = { init, run(), score(route, ctx) }.

   ---------------------------------------------------------------------------
   RANGERING – score(route, ctx) -> { score, reasons[], warnings[] }
   ctx = { danger: 0-5 (faregrad valgt dag, 0 = ikke vurdert), wx: {temp,vind,ned}|null, pos: {lat,lon}|null }
   Start 100 poeng. Vekter (poeng):
   - Skred (faregrad L, eksponert terreng E i meter):
       straff = K[L] * E / 100,   K = {0:0, 1:0.4, 2:1.5, 3:6, 4:12, 5:20}
       (L3 + 400 m = -24, L2 + 400 m = -6). L>=3 og E>300 gir advarsel.
       E < 100 m: «Lite skredterreng», bonus +8 ved L>=3, +3 ved L2.
   - Vær på toppen kl. 12 (Oslo):
       vind v (m/s): < 4: +4 «Lite vind»; > 6: -3 pr. m/s over 6; > 12: ytterligere -5 pr. m/s over 12
       (advarsel «Sterk vind» fra 12 m/s).
       nedbør n (mm neste 24 t): <= 0,2: +4 «Opphold»; ellers -2,5 pr. mm (maks 15 mm); advarsel fra 5 mm.
       manglende vær: -8 (rangeres uten værinfo).
   - Himmelretning (nedkjøringen): N/NØ/NV +4 («Nordvendt – kald snø»), +4 til om temp <= -1;
       S/SØ/SV: +6 «Sørvendt – vårføre/skare» om temp >= 0,5, ellers 0.
   - Avstand (bare med posisjon): -3 pr. 10 km til parkering (maks -15).
   Skred veier tyngst ved faregrad 3+, deretter vind og nedbør; himmelretning og avstand er finjustering.
   --------------------------------------------------------------------------- */
(function () {
  "use strict";
  var RR = window.RR, CFG = RR.CFG, U = RR.util, S = RR.state;

  var HM_MIN = 200, HM_MAX = CFG.MAX_HM || 1100;
  var KEY = "rr.finner";
  var TTL = 30 * 60 * 1000;
  var K_SKRED = [0, 0.4, 1.5, 6, 12, 20];
  var NORD = ["N", "NØ", "NV"], SOR = ["S", "SØ", "SV"];

  var root = null, el = {};
  var opts = { day: 0, niva: ["Lett", "Middels"], maxHm: HM_MAX };
  var pos = null;                 // { lat, lon }
  var geoState = "idle";          // idle | loading | ok | error
  var geoMsg = "";
  var hasRun = false, wantRun = false, running = 0, seq = 0, lastRunAt = 0;
  var debT = null;
  var wxCache = {};               // "id|dato" -> { t, d }
  var view = { kind: "idle" };    // idle | wait | loading | error | empty | result

  /* ---------- hjelpere ---------- */
  var NF = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 1 });
  function fmtT(t) { var n = Math.round(t); return (n < 0 ? "−" : "") + Math.abs(n) + " °C"; }
  function fmtMm(n) { return NF.format(Math.round(n * 10) / 10) + " mm"; }
  function hasLL(o) { return o && o.lat != null && o.lon != null && isFinite(o.lat) && isFinite(o.lon); }
  function dayLabel() { return opts.day === 0 ? "i dag" : "i morgen"; }
  function dateOf(day) { var t = U.oslo().date; return day ? U.addDays(t, day) : t; }

  function haversineKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function startPoint(r) {
    if (r.park && hasLL(r.park)) return r.park;
    if (hasLL(r.start)) return r.start;
    if (hasLL(r.top)) return r.top;
    return null;
  }

  function store(write) {
    try {
      if (write) U.store(KEY, JSON.stringify({ niva: opts.niva, maxHm: opts.maxHm }));
      else {
        var j = JSON.parse(U.store(KEY) || "null");
        if (j && Array.isArray(j.niva)) {
          var n = j.niva.filter(function (x) { return CFG.LEVELS.indexOf(x) !== -1; });
          if (n.length) opts.niva = n;
        }
        if (j && j.maxHm >= HM_MIN && j.maxHm <= HM_MAX) opts.maxHm = Math.round(j.maxHm / 50) * 50;
      }
    } catch (e) { /* ignorer */ }
  }

  /* ---------- rangering (ren funksjon) ---------- */
  function score(r, ctx) {
    ctx = ctx || {};
    var s = 100, R = [], W = [];
    function add(t, p) { R.push({ t: t, p: p }); }
    var L = ctx.danger | 0, E = r.eksponert_m, wx = ctx.wx || null, asp = RR.util.aspectOf(r);

    // Skred
    if (E != null && L >= 1) {
      s -= (K_SKRED[Math.min(L, 5)] || 0) * E / 100;
      if (L >= 3 && E > 300) W.push("Mye skredterreng ved faregrad " + L);
      if (E < 100) {
        if (L >= 3) { s += 8; add("Lite skredterreng", 95); }
        else if (L === 2) { s += 3; add("Lite skredterreng", 85); }
        else add("Lite skredterreng", 30);
      }
    } else if (E != null && E < 100) {
      add("Lite skredterreng", 30);
    }

    // Vær
    var temp = null;
    if (wx) {
      var v = wx.vind, n = wx.ned;
      temp = wx.temp;
      if (v != null) {
        if (v < 4) { s += 4; add("Lite vind", 70); }
        if (v > 6) s -= (v - 6) * 3;
        if (v > 12) s -= (v - 12) * 5;
        if (v >= 12) W.push("Sterk vind (" + Math.round(v) + " m/s)");
      }
      if (n != null) {
        if (n <= 0.2) { s += 4; add("Opphold", 60); }
        else s -= Math.min(n, 15) * 2.5;
        if (n >= 5) W.push("Mye nedbør (" + Math.round(n) + " mm)");
      }
    } else if (ctx.wx === null) {
      s -= 8;
    }

    // Himmelretning
    if (asp) {
      var cold = temp != null && temp <= -1;
      if (NORD.indexOf(asp) !== -1) {
        s += 4;
        if (cold) { s += 4; add("Nordvendt – kald snø", 75); }
        else add("Nordvendt – kald snø", 45);
      } else if (SOR.indexOf(asp) !== -1 && temp != null && temp >= 0.5) {
        s += 6; add("Sørvendt – vårføre/skare", 65);
      }
    }

    // Avstand
    var km = null, sp = ctx.pos && startPoint(r);
    if (sp) {
      km = haversineKm(ctx.pos, sp);
      s -= Math.min(15, km / 10 * 3);
      add((km < 1 ? "Under 1" : Math.round(km)) + " km unna", 40);
    }

    R.sort(function (a, b) { return b.p - a.p; });
    return { score: Math.round(s * 10) / 10, reasons: R.map(function (x) { return x.t; }), warnings: W, km: km };
  }

  /* ---------- vær ---------- */
  function getWx(id, date) {
    var k = id + "|" + date, c = wxCache[k];
    if (c && Date.now() - c.t < TTL) return Promise.resolve(c.d);
    var f = RR.modules.forhold;
    if (!f || !f.forecastFor) return Promise.reject(new Error("Værmodulen mangler"));
    return f.forecastFor(id, date).then(function (d) { wxCache[k] = { t: Date.now(), d: d }; return d; });
  }

  function dangerFor(date) {
    var d = S.danger;
    if (!d || !d.days) return { known: false, level: 0, name: "", day: null };
    var day = null, i;
    for (i = 0; i < d.days.length; i++) if (d.days[i].date === date) { day = d.days[i]; break; }
    if (!day) day = d.days[opts.day] || null;
    if (!day) return { known: true, level: 0, name: "", day: null };
    return { known: true, level: day.level | 0, name: day.name, day: day };
  }

  /* ---------- kjøring ---------- */
  function candidates() {
    return S.routes.filter(function (r) {
      if (opts.niva.indexOf(r.niva) === -1) return false;
      if (opts.maxHm < HM_MAX && r.hoydemeter != null && r.hoydemeter > opts.maxHm + 1e-9) return false;
      return true;
    });
  }

  function run() {
    hasRun = true;
    clearTimeout(debT);
    var my = ++seq;
    if (!S.routes.length) { wantRun = true; view = { kind: "wait" }; render(); return Promise.resolve(); }
    wantRun = false;
    var date = dateOf(opts.day), cand = candidates();
    if (!cand.length) { view = { kind: "empty" }; lastRunAt = Date.now(); render(); return Promise.resolve(); }

    var withLL = cand.filter(function (r) { return hasLL(r.top); });
    var missing = withLL.filter(function (r) {
      var c = wxCache[r.id + "|" + date];
      return !(c && Date.now() - c.t < TTL);
    });
    var results = {}, failed = 0, done = 0;

    function finish() {
      if (my !== seq) return;
      lastRunAt = Date.now();
      if (withLL.length && failed >= withLL.length) {
        view = { kind: "error" };
      } else {
        view = { kind: "result", cand: cand, date: date, failed: failed };
      }
      render();
    }

    if (!missing.length) { finish(); return Promise.resolve(); }
    view = { kind: "loading", n: missing.length, done: 0 };
    render();
    running++;
    return Promise.all(missing.map(function (r) {
      return getWx(r.id, date).then(function () { }, function (e) { failed++; console.warn("[turfinner] vær feilet for", r.id, e && e.message); })
        .then(function () {
          done++;
          if (my === seq && view.kind === "loading") updateProgress(done, missing.length);
        });
    })).then(function () { running--; finish(); });
  }

  function change() {
    store(true);
    if (!hasRun) return;
    clearTimeout(debT);
    debT = setTimeout(run, 250);
  }

  /* Ranger på nytt uten ny henting (f.eks. når skredvarsel kommer). */
  function rerank() { if (view.kind === "result") render(); }

  function ranked() {
    var date = view.date, dg = dangerFor(date), out = [];
    view.cand.forEach(function (r) {
      var c = wxCache[r.id + "|" + date], wx = c ? c.d : null;
      var sc = score(r, { danger: dg.level, wx: wx, pos: pos });
      out.push({ r: r, w: wx, sc: sc });
    });
    out.sort(function (a, b) { return b.sc.score - a.sc.score || (a.sc.warnings.length - b.sc.warnings.length); });
    // 3 til 5 kort: ta med nr. 4 og 5 bare hvis de er nær toppen
    var top = out.length ? out[0].sc.score : 0, n = Math.min(3, out.length);
    while (n < 5 && n < out.length && out[n].sc.score >= top - 30) n++;
    return { list: out.slice(0, n), dg: dg, total: out.length };
  }

  /* ---------- rendering ---------- */
  function updateProgress(done, n) {
    var t = el.res && el.res.querySelector(".tf-loadtxt");
    if (t) t.textContent = "Henter vær for " + n + " topper … " + done + " av " + n;
  }

  function skeleton(n) {
    var h = '<p class="tf-loadtxt" role="status">Henter vær for ' + n + ' topper …</p><ul class="tf-list" aria-hidden="true">';
    for (var i = 0; i < 4; i++) h += '<li><div class="tf-skel"></div></li>';
    return h + "</ul>";
  }

  function card(x, i) {
    var r = x.r, w = x.w, sc = x.sc, sel = S.selectedId === r.id;
    var meta = [U.fmtKm(r.tur_km), U.fmtHm(r.hoydemeter)];
    var tid = r.park && r.park.est_tid_tekst;
    if (tid) meta.push(/^ca/i.test(tid) ? tid : "ca. " + tid);
    var wxl = w
      ? [fmtT(w.temp), Math.round(w.vind) + " m/s", fmtMm(w.ned)].map(U.esc).join(" · ")
      : "Vær ikke tilgjengelig";
    var tags = "";
    sc.warnings.slice(0, 2).forEach(function (t) {
      tags += '<li class="tf-tag tf-tag--warn"><span class="sr-only">Advarsel: </span>' + U.esc(t) + "</li>";
    });
    sc.reasons.slice(0, 3).forEach(function (t) { tags += '<li class="tf-tag">' + U.esc(t) + "</li>"; });
    var tips = r.park && r.park.forhold_tips;
    return '<li><button type="button" class="tf-card" data-id="' + r.id + '"' + (sel ? ' aria-current="true"' : "") + ">" +
      '<span class="tf-rank" aria-hidden="true">' + (i + 1) + "</span>" +
      '<span class="tf-main">' +
      '<span class="tf-name"><span class="sr-only">Nummer ' + (i + 1) + ": </span>" + U.esc(r.navn) +
      ' <span class="lvl-dot" data-niva="' + U.esc(r.niva) + '" title="' + U.esc(r.niva) + '"></span><span class="sr-only"> ' + U.esc(r.niva) + "</span></span>" +
      '<span class="tf-meta">' + meta.map(U.esc).join(" · ") + "</span>" +
      '<span class="tf-wx">' + wxl + "</span>" +
      (tags ? '<ul class="tf-tags">' + tags + "</ul>" : "") +
      (tips ? '<span class="tf-tip">' + U.esc(tips) + "</span>" : "") +
      "</span></button></li>";
  }

  function dangerLine(dg) {
    if (!dg.known) return '<p class="tf-dg tf-dg--none">Skredvarselet er ikke lastet ennå – rangerer uten skredfare.</p>';
    if (!dg.level) return '<p class="tf-dg tf-dg--none">Skredfare ' + dayLabel() + ' er ikke vurdert.</p>';
    return '<p class="tf-dg" data-l="' + dg.level + '"><span class="tf-dg__dot" aria-hidden="true"></span>Skredfare ' + dayLabel() +
      ": <b>" + dg.level + " " + U.esc(dg.name) + "</b></p>";
  }

  function render() {
    if (!root) return;
    var h = "", rk = null;
    switch (view.kind) {
      case "wait":
        h = '<p class="tf-msg" role="status">Henter ruter …</p>';
        break;
      case "loading":
        h = skeleton(view.n);
        break;
      case "error":
        h = '<div class="tf-state" role="alert"><p class="tf-msg">Fikk ikke hentet været akkurat nå.</p>' +
          '<button type="button" class="btn btn--ghost tf-retry">Prøv igjen</button></div>';
        break;
      case "empty":
        h = '<div class="tf-state"><p class="tf-msg">Ingen turer passer valgene. Prøv flere nivåer eller høyere høydemeter.</p></div>';
        break;
      case "result":
        rk = ranked();
        h = '<h3 class="tf-h" id="tf-res-h" tabindex="-1">Beste turer ' + dayLabel() + "</h3>" + dangerLine(rk.dg);
        if (!rk.list.length) h += '<p class="tf-msg">Ingen turer å vise.</p>';
        else h += '<ol class="tf-list" aria-labelledby="tf-res-h">' + rk.list.map(card).join("") + "</ol>";
        if (view.failed) h += '<p class="tf-note">Vær mangler for ' + view.failed + " av " + view.cand.length + ' topper. <button type="button" class="tf-link tf-retry">Prøv igjen</button></p>';
        h += '<p class="tf-foot">Rangert etter skredfare, vær, himmelretning og avstand. Gjør alltid egne vurderinger.</p>';
        break;
      default:
        h = "";
    }
    el.res.setAttribute("aria-busy", view.kind === "loading" ? "true" : "false");
    el.res.innerHTML = h;
    if (view.kind === "result") el.sr.textContent = "Fant " + (rk.list.length) + " anbefalte turer " + dayLabel() + ".";
    else if (view.kind === "error" || view.kind === "empty") el.sr.textContent = el.res.textContent;
  }

  function renderControls() {
    var segs = el.root.querySelectorAll(".tf-seg button");
    for (var i = 0; i < segs.length; i++) segs[i].setAttribute("aria-pressed", String(+segs[i].getAttribute("data-day") === opts.day));
    var chips = el.root.querySelectorAll(".panel-chip");
    for (var j = 0; j < chips.length; j++) chips[j].setAttribute("aria-pressed", String(opts.niva.indexOf(chips[j].getAttribute("data-niva")) !== -1));
    el.hm.value = opts.maxHm;
    syncHm();
    el.geo.setAttribute("aria-pressed", String(geoState === "ok"));
    el.geo.disabled = geoState === "loading";
    el.geoMsg.textContent = geoState === "ok" ? "Posisjon brukt" : geoState === "loading" ? "Finner posisjon …" : geoMsg;
    el.geoMsg.classList.toggle("tf-geomsg--err", geoState === "error");
  }

  function syncHm() {
    var v = +el.hm.value;
    el.hm.style.setProperty("--p", ((v - HM_MIN) / (HM_MAX - HM_MIN) * 100) + "%");
    el.hmOut.textContent = v >= HM_MAX ? "Alle" : "Opptil " + v + " hm";
    el.hm.setAttribute("aria-valuetext", v >= HM_MAX ? "Alle" : "Opptil " + v + " høydemeter");
  }

  /* ---------- posisjon ---------- */
  function toggleGeo() {
    if (geoState === "ok") { pos = null; geoState = "idle"; geoMsg = ""; renderControls(); change(); return; }
    if (!navigator.geolocation) { geoState = "error"; geoMsg = "Nettleseren din støtter ikke posisjon."; renderControls(); return; }
    geoState = "loading"; geoMsg = ""; renderControls();
    navigator.geolocation.getCurrentPosition(function (p) {
      pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      geoState = "ok"; geoMsg = "";
      renderControls();
      change();
    }, function (e) {
      pos = null; geoState = "error";
      geoMsg = e && e.code === 1 ? "Du har ikke gitt tilgang til posisjonen din."
        : e && e.code === 3 ? "Posisjonen tok for lang tid. Prøv igjen."
        : "Fant ikke posisjonen din akkurat nå.";
      renderControls();
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  /* ---------- oppbygging ---------- */
  function build() {
    var chips = CFG.LEVELS.map(function (n) {
      return '<button type="button" class="chip panel-chip" data-niva="' + U.esc(n) + '" aria-pressed="true">' +
        '<span class="lvl-dot" data-niva="' + U.esc(n) + '"></span>' + U.esc(n) + "</button>";
    }).join("");
    root.innerHTML =
      '<div class="tf">' +
      '<h2 class="tf-title">Turfinner</h2>' +
      '<p class="tf-intro">Svar på tre spørsmål, så finner vi dagens beste turer.</p>' +
      '<div class="tf-q"><p class="tf-q__h" id="tf-q1">1. Når?</p>' +
      '<div class="tf-seg" role="group" aria-labelledby="tf-q1">' +
      '<button type="button" data-day="0" aria-pressed="true">I dag</button>' +
      '<button type="button" data-day="1" aria-pressed="false">I morgen</button></div></div>' +
      '<div class="tf-q"><p class="tf-q__h" id="tf-q2">2. Hvor tøft?</p>' +
      '<div class="panel-chips" role="group" aria-labelledby="tf-q2">' + chips + "</div>" +
      '<div class="panel-field"><div class="panel-field__top"><label for="tf-hm">Maks høydemeter</label><output for="tf-hm" id="tf-hm-out"></output></div>' +
      '<input type="range" class="panel-range" id="tf-hm" min="' + HM_MIN + '" max="' + HM_MAX + '" step="50" value="' + HM_MAX + '"></div></div>' +
      '<div class="tf-q"><p class="tf-q__h" id="tf-q3">3. Hvor?</p>' +
      '<div class="tf-geo"><button type="button" class="chip tf-geobtn" aria-pressed="false">Nær meg</button>' +
      '<span class="tf-geomsg" role="status" aria-live="polite"></span></div></div>' +
      '<button type="button" class="btn btn--primary tf-go">Finn turer</button>' +
      '<div class="tf-res"></div><span class="sr-only tf-sr" role="status" aria-live="polite"></span>' +
      "</div>";
    el = {
      root: root, res: root.querySelector(".tf-res"), sr: root.querySelector(".tf-sr"), hm: root.querySelector("#tf-hm"), hmOut: root.querySelector("#tf-hm-out"),
      geo: root.querySelector(".tf-geobtn"), geoMsg: root.querySelector(".tf-geomsg")
    };
  }

  function onClick(e) {
    var t = e.target;
    if (!t.closest) return;
    var b;
    if ((b = t.closest(".tf-seg button"))) {
      var d = +b.getAttribute("data-day");
      if (d !== opts.day) { opts.day = d; renderControls(); change(); }
      return;
    }
    if ((b = t.closest(".panel-chip"))) {
      var n = b.getAttribute("data-niva"), i = opts.niva.indexOf(n);
      if (i !== -1) { if (opts.niva.length > 1) opts.niva.splice(i, 1); }
      else opts.niva.push(n);
      renderControls(); change();
      return;
    }
    if (t.closest(".tf-geobtn")) { toggleGeo(); return; }
    if (t.closest(".tf-go") || t.closest(".tf-retry")) { run(); return; }
    if ((b = t.closest(".tf-card"))) {
      RR.select(Number(b.getAttribute("data-id")), { source: "list" });
      RR.emit("tab", "turer");
    }
  }

  function tabOpen() {
    if (!S.routes.length) { wantRun = true; if (!hasRun) { hasRun = true; view = { kind: "wait" }; render(); } return; }
    if (!hasRun || Date.now() - lastRunAt > TTL) run();
  }

  function init() {
    root = document.getElementById("finner");
    if (!root) return;
    store(false);
    build();
    renderControls();
    root.addEventListener("click", onClick);
    el.hm.addEventListener("input", function () {
      opts.maxHm = +el.hm.value;
      syncHm();
      change();
    });

    RR.on("data:routes", function () { if (wantRun) run(); });
    RR.on("data:error", function () {
      if (view.kind === "wait") { view = { kind: "error" }; render(); }
    });
    RR.on("danger", rerank);
    RR.on("select", function (d) {
      var cs = root.querySelectorAll(".tf-card"), id = d && d.id;
      for (var i = 0; i < cs.length; i++) {
        if (+cs[i].getAttribute("data-id") === id) cs[i].setAttribute("aria-current", "true");
        else cs[i].removeAttribute("aria-current");
      }
    });
    RR.on("tab", function (t) { if (t === "finner") tabOpen(); });
    var pane = document.getElementById("pane-finner");
    if (pane && !pane.hidden) tabOpen();
  }

  RR.modules.turfinner = { init: init, run: run, score: score };
})();
