/* Turkort (høyre glasspanel, #right / #card).
   Lytter: select, danger, data:routes, view:ready. Sender: fly:request, wx:request. */
(function () {
  "use strict";
  var RR = window.RR, U = RR.util, esc = U.esc;

  var rightEl = null, cardEl = null;
  var currentId = null;          // id til tur som er tegnet i kortet
  var profCache = {};            // id -> { pts, approx }
  var profPending = {};          // id -> Promise
  var wxCache = {};              // id -> { html } | { error }
  var KOMP = ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"];
  var SYM = { clearsky: "Klart", fair: "Lettskyet", partlycloudy: "Delvis skyet", cloudy: "Skyet", fog: "Tåke",
    rain: "Regn", lightrain: "Lett regn", heavyrain: "Kraftig regn", snow: "Snø", lightsnow: "Lett snø", heavysnow: "Kraftig snø",
    sleet: "Sludd", lightsleet: "Lett sludd", heavysleet: "Kraftig sludd" };

  /* ---------- hjelpere ---------- */
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; }
  function fmt0(n) { return Math.round(n).toLocaleString("nb-NO"); }
  function fmt1(n) { return (Math.round(n * 10) / 10).toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function fmtKmShort(n) { return (Math.round(n * 10) / 10).toLocaleString("nb-NO", { maximumFractionDigits: 1 }); }
  function route(id) { return id == null ? null : RR.state.byId[id] || null; }
  function qs(sel) { return cardEl ? cardEl.querySelector(sel) : null; }

  var I = {
    close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5.2l3.3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    compass: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 5.5v13M12 5.5l-3 3.6M12 5.5l3 3.6" transform="ROT" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    steep: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M3.5 19.5h17M3.5 19.5L17 6.5M9.5 19.5a6 6 0 0 0-2-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 3.8L2.8 19.5h18.4L12 3.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.4M12 16.9v.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    swap: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.6-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8z" fill="currentColor"/></svg>',
    nav: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M7 18.5a4.2 4.2 0 0 1-.4-8.4 5.5 5.5 0 0 1 10.6 1.1 3.7 3.7 0 0 1-.4 7.3H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 15V4M12 4L8 8M12 4l4 4M5 12v6.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  /* ---------- høydeprofil: data ---------- */
  function pathProfile(r) {
    var pts = [], total = 0, prev = null, withZ = 0, n = 0;
    (r.paths || []).forEach(function (path) {
      path.forEach(function (v) {
        n++;
        var z = v[2];
        if (isNum(z)) withZ++;
        if (prev) total += Math.hypot(v[0] - prev[0], v[1] - prev[1]);
        prev = v;
        pts.push({ d: total, z: isNum(z) ? z : null });
      });
    });
    if (!n || withZ < n * 0.6) return null;
    var zs = pts.filter(function (p) { return p.z != null; });
    var mn = Math.min.apply(null, zs.map(function (p) { return p.z; }));
    var mx = Math.max.apply(null, zs.map(function (p) { return p.z; }));
    if (!(mx - mn > 2) || mn < -50 || total < 50) return null;
    // fyll hull
    var last = zs[0].z;
    pts.forEach(function (p) { if (p.z == null) p.z = last; else last = p.z; });
    return pts;
  }

  function linearProfile(r) {
    var a = num(r.start_moh), b = num(r.topp_moh);
    if (a == null || b == null) return null;
    var km = num(r.opp_km) || (num(r.tur_km) ? num(r.tur_km) / 2 : 0) || 1;
    var L = km * 1000, out = [], N = 24;
    for (var i = 0; i < N; i++) { var t = i / (N - 1); out.push({ d: L * t, z: a + (b - a) * t }); }
    return out;
  }

  function fallbackProfile(r) { return pathProfile(r) || linearProfile(r); }

  function normalize(arr) {
    if (!Array.isArray(arr)) return null;
    var pts = arr.filter(function (p) { return p && isNum(p.d) && isNum(p.z); });
    if (pts.length < 2) return null;
    pts.sort(function (a, b) { return a.d - b.d; });
    return pts;
  }

  function loadProfile(r) {
    var id = r.id;
    if (profCache[id]) return Promise.resolve(profCache[id]);
    if (profPending[id]) return profPending[id];
    var sc = RR.modules.scene, p;
    if (sc && typeof sc.sampleProfile === "function") {
      try { p = Promise.resolve(sc.sampleProfile(r)); } catch (e) { p = Promise.reject(e); }
    } else {
      p = Promise.reject(new Error("scene mangler"));
    }
    var prom = p.then(function (arr) {
      var pts = normalize(arr);
      if (!pts) throw new Error("tom profil");
      return (profCache[id] = { pts: pts, approx: false });
    }).catch(function () {
      var pts = fallbackProfile(r);
      // Ikke mellomlagre reservevarianten permanent – scene kan bli klar senere
      return { pts: pts, approx: true };
    }).then(function (res) { delete profPending[id]; return res; });
    profPending[id] = prom;
    return prom;
  }

  /* ---------- høydeprofil: tegning ---------- */
  var VW = 300, VH = 120, PL = 40, PR = 8, PT = 10, PB = 20;

  function drawProfile(box, res, r) {
    var pts = res && res.pts;
    if (!pts || pts.length < 2) {
      box.innerHTML = '<p class="card-prof__empty">Høydeprofil er ikke tilgjengelig for denne turen.</p>';
      return;
    }
    var zmin = Infinity, zmax = -Infinity;
    pts.forEach(function (p) { if (p.z < zmin) zmin = p.z; if (p.z > zmax) zmax = p.z; });
    if (zmax - zmin < 20) { var mid = (zmax + zmin) / 2; zmin = mid - 10; zmax = mid + 10; }
    var dmax = pts[pts.length - 1].d || 1;
    var pw = VW - PL - PR, ph = VH - PT - PB;
    function X(d) { return PL + (d / dmax) * pw; }
    function Y(z) { return PT + (1 - (z - zmin) / (zmax - zmin)) * ph; }

    var step = Math.max(1, Math.ceil(pts.length / 220)), line = [];
    for (var i = 0; i < pts.length; i += step) line.push(pts[i]);
    if (line[line.length - 1] !== pts[pts.length - 1]) line.push(pts[pts.length - 1]);
    var dLine = line.map(function (p, k) { return (k ? "L" : "M") + X(p.d).toFixed(1) + " " + Y(p.z).toFixed(1); }).join("");
    var dFill = dLine + "L" + X(dmax).toFixed(1) + " " + (PT + ph) + "L" + PL + " " + (PT + ph) + "Z";

    var zFirst = pts[0].z, zTop = Math.max.apply(null, pts.map(function (p) { return p.z; }));
    var label = "Høydeprofil: fra " + fmt0(zFirst) + " til " + fmt0(zTop) + " moh over " + fmtKmShort(dmax / 1000) + " km" +
      (res.approx ? " (forenklet)" : "") + ". Bruk piltastene for å utforske.";
    var ax = PT + ph;

    box.innerHTML =
      '<svg class="card-prof__svg" viewBox="0 0 ' + VW + ' ' + VH + '" role="img" tabindex="0" aria-label="' + esc(label) + '" preserveAspectRatio="xMidYMid meet">' +
      '<defs>' +
      '<linearGradient id="card-pg-line" gradientUnits="userSpaceOnUse" x1="' + PL + '" y1="0" x2="' + (VW - PR) + '" y2="0"><stop offset="0" style="stop-color:var(--acc1)"/><stop offset="1" style="stop-color:var(--acc2)"/></linearGradient>' +
      '<linearGradient id="card-pg-fill" gradientUnits="userSpaceOnUse" x1="' + PL + '" y1="0" x2="' + (VW - PR) + '" y2="0"><stop offset="0" style="stop-color:var(--acc1)"/><stop offset="1" style="stop-color:var(--acc2)"/></linearGradient>' +
      '<linearGradient id="card-pg-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
      '<mask id="card-pg-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="' + VW + '" height="' + VH + '"><rect x="0" y="0" width="' + VW + '" height="' + VH + '" fill="url(#card-pg-fade)"/></mask>' +
      '</defs>' +
      '<line class="card-prof__grid" x1="' + PL + '" x2="' + (VW - PR) + '" y1="' + PT + '" y2="' + PT + '"/>' +
      '<line class="card-prof__axis" x1="' + PL + '" x2="' + (VW - PR) + '" y1="' + ax + '" y2="' + ax + '"/>' +
      '<g mask="url(#card-pg-mask)"><path d="' + dFill + '" fill="url(#card-pg-fill)" opacity=".5"/></g>' +
      '<path d="' + dLine + '" fill="none" stroke="url(#card-pg-line)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<text class="card-prof__t" x="' + (PL - 5) + '" y="' + (PT + 3.5) + '" text-anchor="end">' + fmt0(zmax) + ' moh</text>' +
      '<text class="card-prof__t" x="' + (PL - 5) + '" y="' + (ax + 3.5) + '" text-anchor="end">' + fmt0(zmin) + ' moh</text>' +
      '<text class="card-prof__t" x="' + PL + '" y="' + (VH - 5) + '" text-anchor="start">0 km</text>' +
      '<text class="card-prof__t" x="' + (PL + pw / 2) + '" y="' + (VH - 5) + '" text-anchor="middle">' + fmtKmShort(dmax / 2000) + '</text>' +
      '<text class="card-prof__t" x="' + (VW - PR) + '" y="' + (VH - 5) + '" text-anchor="end">' + fmtKmShort(dmax / 1000) + ' km</text>' +
      '<g class="card-prof__mark" hidden><line class="card-prof__ml" x1="0" x2="0" y1="' + PT + '" y2="' + ax + '"/><circle class="card-prof__mc" r="4.5" cx="0" cy="0"/></g>' +
      '</svg>' +
      '<div class="card-prof__read" hidden></div>' +
      '<span class="sr-only card-prof__live" aria-live="polite"></span>' +
      (res.approx ? '<p class="card-prof__note">Forenklet profil</p>' : "");

    var svg = box.querySelector("svg"), mark = svg.querySelector(".card-prof__mark"),
      ml = svg.querySelector(".card-prof__ml"), mc = svg.querySelector(".card-prof__mc"),
      read = box.querySelector(".card-prof__read"), live = box.querySelector(".card-prof__live");
    var kbD = null;

    function zAt(d) {
      var lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { var m = (lo + hi) >> 1; if (pts[m].d <= d) lo = m; else hi = m; }
      var a = pts[lo], b = pts[hi], span = b.d - a.d;
      return span > 0 ? a.z + (b.z - a.z) * Math.min(1, Math.max(0, (d - a.d) / span)) : a.z;
    }
    function show(d, announce) {
      d = Math.min(dmax, Math.max(0, d));
      var z = zAt(d), x = X(d), y = Y(z);
      mark.removeAttribute("hidden");
      ml.setAttribute("x1", x); ml.setAttribute("x2", x);
      mc.setAttribute("cx", x); mc.setAttribute("cy", y);
      var txt = fmtKmShort(d / 1000) + " km · " + fmt0(z) + " moh";
      read.textContent = txt;
      read.removeAttribute("hidden");
      var W = box.clientWidth || 300, rw = read.offsetWidth || 90;
      var px = (x / VW) * (svg.getBoundingClientRect().width || W);
      read.style.left = Math.min(W - rw / 2, Math.max(rw / 2, px)) + "px";
      if (announce) live.textContent = txt;
    }
    function hide() { mark.setAttribute("hidden", ""); read.setAttribute("hidden", ""); }
    function fromPointer(e) {
      var rc = svg.getBoundingClientRect();
      if (!rc.width) return;
      var x = ((e.clientX - rc.left) / rc.width) * VW;
      kbD = Math.min(dmax, Math.max(0, ((x - PL) / pw) * dmax));
      show(kbD, false);
    }
    svg.addEventListener("pointerdown", fromPointer);
    svg.addEventListener("pointermove", fromPointer);
    svg.addEventListener("pointerleave", function () { if (document.activeElement !== svg) hide(); });
    svg.addEventListener("pointercancel", hide);
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", function (e) {
      var s = dmax / 40, k = e.key;
      if (k === "ArrowRight" || k === "ArrowUp") kbD = kbD == null ? s : kbD + s;
      else if (k === "ArrowLeft" || k === "ArrowDown") kbD = kbD == null ? dmax : kbD - s;
      else if (k === "Home") kbD = 0;
      else if (k === "End") kbD = dmax;
      else if (k === "Escape" && !mark.hasAttribute("hidden")) { hide(); kbD = null; e.stopPropagation(); e.preventDefault(); return; }
      else return;
      e.preventDefault();
      kbD = Math.min(dmax, Math.max(0, kbD));
      show(kbD, true);
    });
  }

  function fillProfile(r) {
    var box = qs(".card-prof__box");
    if (!box) return;
    var id = r.id;
    box.classList.add("is-loading");
    box.innerHTML = '<div class="card-prof__skel" aria-hidden="true"></div><span class="sr-only">Laster høydeprofil</span>';
    loadProfile(r).then(function (res) {
      if (RR.state.selectedId !== id || currentId !== id) return;
      var b = qs(".card-prof__box");
      if (!b) return;
      b.classList.remove("is-loading");
      try { drawProfile(b, res, r); } catch (e) {
        console.error("[card] profil", e);
        b.innerHTML = '<p class="card-prof__empty">Kunne ikke vise høydeprofilen.</p>';
      }
    });
  }

  /* ---------- advarsel ---------- */
  function warnHtml(r) {
    var d = RR.state.danger;
    if (!d || !r) return "";
    var lvl = Number(d.level) || 0, ex = num(r.eksponert_m);
    if (lvl >= 3 && ex != null && ex > 300) {
      return '<div class="card-warn" role="note"><span class="card-warn__ic">' + I.warn + '</span><p>Faregrad ' + lvl +
        ' i dag og mye eksponert terreng. Vurder en annen tur.</p></div>';
    }
    return "";
  }
  function updateWarn() {
    var slot = qs(".card-warn-slot"), r = route(currentId);
    if (slot) slot.innerHTML = warnHtml(r);
  }

  /* ---------- kort ---------- */
  function row(icon, label, value, sub) {
    return '<div class="card-row"><span class="card-row__ic">' + icon + '</span><div class="card-row__b">' +
      '<div class="card-row__l">' + esc(label) + '</div><div class="card-row__v">' + value + '</div>' +
      (sub ? '<div class="card-row__s">' + esc(sub) + '</div>' : '') + '</div></div>';
  }

  function fellebytteText(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s || s === "0" || /^(nei|ingen|ikke|-|–)$/i.test(s)) return null;
    return /^\d+([.,]\d+)?$/.test(s) ? s + (s === "1" ? " fellebytte" : " fellebytter") : s;
  }

  function navHref(r) {
    var p = r.park;
    if (p && p.nav_url) return p.nav_url;
    var lat = p && p.lat != null ? p.lat : r.start && r.start.lat, lon = p && p.lon != null ? p.lon : r.start && r.start.lon;
    if (lat != null && lon != null) return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(lat + "," + lon);
    return null;
  }

  function buildCard(r) {
    var p = r.park, hm = num(r.hoydemeter), km = num(r.tur_km), opp = num(r.opp_km);
    var top = num(r.topp_moh), st = num(r.start_moh);
    var sub = [];
    if (top != null) sub.push("Topp " + fmt0(top) + " moh");
    if (st != null) sub.push("start " + fmt0(st) + " moh");

    var rows = "";
    if (p && p.est_tid_tekst) rows += row(I.clock, "Estimert tid", esc(p.est_tid_tekst));
    if (p && (p.himmelretning || num(p.himmelretning_grader) != null)) {
      var deg = num(p.himmelretning_grader);
      var ic = I.compass.replace("ROT", 'rotate(' + (deg || 0) + ' 12 12)');
      rows += row(ic, "Nedkjøring mot", esc(p.himmelretning || (deg != null ? KOMP[Math.round(deg / 45) % 8] : "")), p.forhold_tips || "");
    } else if (p && p.forhold_tips) {
      rows += row(I.compass.replace("ROT", ""), "Føretips", "", p.forhold_tips);
    }
    var mb = num(r.maks_bratthet);
    if (mb != null) rows += row(I.steep, "Maks bratthet", esc(Math.round(mb) + "°"));
    var ex = num(r.eksponert_m);
    if (ex != null) rows += row(I.warn, "Eksponering", esc(fmt0(ex) + " m i skredterreng"));
    var fb = fellebytteText(r.fellebytte);
    if (fb) rows += row(I.swap, "Fellebytte", esc(fb));

    var href = navHref(r);
    var webgl = U.webglOk();

    return '' +
      '<article class="card" aria-labelledby="card-title">' +
      '<button type="button" class="card-close" data-act="close" aria-label="Lukk turkort">' + I.close + '</button>' +
      '<header class="card-head">' +
      '<span class="card-lvl"><span class="lvl-dot" data-niva="' + esc(r.niva) + '" aria-hidden="true"></span>' + esc(r.niva) + '</span>' +
      '<h2 class="card-title" id="card-title" tabindex="-1">' + esc(r.navn) + '</h2>' +
      (sub.length ? '<p class="card-sub">' + esc(sub.join(" · ")) + '</p>' : '') +
      '</header>' +
      '<div class="card-big">' +
      '<div class="card-big__i"><span class="card-big__n">' + (hm != null ? fmt0(hm) : "–") + '</span><span class="card-big__u">hm</span></div>' +
      '<div class="card-big__i"><span class="card-big__n">' + (km != null ? fmt1(km) : "–") + '</span><span class="card-big__u">km</span></div>' +
      '</div>' +
      (opp != null ? '<p class="card-opp">Opp: ' + esc(fmt1(opp)) + ' km</p>' : '') +
      (rows ? '<div class="card-rows">' + rows + '</div>' : '') +
      '<div class="card-warn-slot">' + warnHtml(r) + '</div>' +
      '<section class="card-prof" aria-label="Høydeprofil"><div class="card-prof__box"></div></section>' +
      '<div class="card-btns">' +
      '<button type="button" class="btn btn--primary card-btn card-btn--fly" data-act="fly"' +
      (webgl ? '' : ' disabled aria-disabled="true" title="3D støttes ikke av nettleseren din"') + '>' + I.play + '<span>Fly over ruta</span></button>' +
      (href
        ? '<a class="btn btn--ghost card-btn" data-act="nav" href="' + esc(href) + '" target="_blank" rel="noopener">' + I.nav + '<span>Naviger hit</span></a>'
        : '<button type="button" class="btn btn--ghost card-btn" disabled aria-disabled="true" title="Mangler koordinater">' + I.nav + '<span>Naviger hit</span></button>') +
      '<button type="button" class="btn btn--ghost card-btn" data-act="wx" aria-expanded="false" aria-controls="card-wx">' + I.cloud + '<span>Vær på toppen</span></button>' +
      '<button type="button" class="btn btn--ghost card-btn card-btn--share" data-act="share">' + I.share + '<span>Del</span></button>' +
      '</div>' +
      '<div class="card-wx" id="card-wx" aria-live="polite" hidden></div>' +
      '<p class="card-foot">Rutene er beregnet automatisk og ikke kvalitetssikret.</p>' +
      '</article>';
  }

  function render(id) {
    if (!cardEl) return;
    var r = route(id);
    if (!r) { clear(); return; }
    currentId = r.id;
    try {
      cardEl.innerHTML = buildCard(r);
    } catch (e) {
      console.error("[card] render", e);
      cardEl.innerHTML = '<div class="card"><button type="button" class="card-close" data-act="close" aria-label="Lukk turkort">' + I.close +
        '</button><p class="card-err">Kunne ikke vise turkortet.</p></div>';
      U.toast("Kunne ikke vise turkortet.", "error");
      return;
    }
    if (rightEl) rightEl.scrollTop = 0;
    var cached = wxCache[r.id];
    if (cached) showWx(r, cached);
    fillProfile(r);
  }

  function clear() {
    currentId = null;
    if (cardEl) cardEl.innerHTML = "";
  }

  /* ---------- vær ---------- */
  function compass(deg) { return KOMP[Math.round((((deg % 360) + 360) % 360) / 45) % 8]; }

  function wxLine(w) {
    var parts = [];
    var t = num(w.temp);
    if (t != null) parts.push(fmt0(t).replace("-", "−") + " °C");
    var v = num(w.vind);
    if (v != null) {
      var dir = "";
      if (w.dir != null && w.dir !== "") dir = isNum(Number(w.dir)) ? compass(Number(w.dir)) : String(w.dir);
      parts.push(fmt0(v) + " m/s" + (dir ? " fra " + dir : ""));
    }
    var sym = w.symText || (w.sym && (SYM[String(w.sym).replace(/_(day|night|polartwilight)$/, "")] || null));
    if (sym) parts.push(sym);
    var ned = num(w.ned);
    if (ned != null) parts.push(fmt1(ned).replace(/,0$/, "") + " mm neste døgn");
    return parts.join(" · ");
  }

  function showWx(r, data) {
    var el = qs(".card-wx"), btn = qs('[data-act="wx"]');
    if (!el) return;
    var yr = r.park && r.park.yr_url;
    var link = yr ? ' <a class="card-wx__a" href="' + esc(yr) + '" target="_blank" rel="noopener">Se på yr.no ↗</a>' : "";
    el.hidden = false;
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (data.loading) {
      el.innerHTML = '<span class="card-wx__h">Været på toppen</span><span class="card-wx__t card-wx__t--load">Henter vær…</span>';
    } else if (data.error) {
      el.innerHTML = '<span class="card-wx__h">Været på toppen</span><span class="card-wx__t">Fikk ikke hentet været akkurat nå.</span>' + link;
    } else {
      el.innerHTML = '<span class="card-wx__h">Været på toppen</span><span class="card-wx__t">' + esc(data.text) + '</span>' + link;
    }
  }

  function requestWx() {
    var r = route(currentId);
    if (!r) return;
    var id = r.id;
    RR.emit("wx:request", { id: id });
    var fh = RR.modules.forhold;
    if (!fh || typeof fh.weatherFor !== "function") {
      if (r.park && r.park.yr_url) window.open(r.park.yr_url, "_blank", "noopener");
      else U.toast("Været er ikke tilgjengelig nå.", "error");
      return;
    }
    var cached = wxCache[id];
    if (cached && cached.text) { showWx(r, cached); return; }
    showWx(r, { loading: true });
    var p;
    try { p = Promise.resolve(fh.weatherFor(id)); } catch (e) { p = Promise.reject(e); }
    p.then(function (w) {
      var text = w ? wxLine(w) : "";
      if (!text) throw new Error("tomt vær");
      wxCache[id] = { text: text };
      if (currentId === id) showWx(r, wxCache[id]);
    }).catch(function () {
      if (currentId === id) showWx(r, { error: true });
    });
  }

  /* ---------- del ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (ok, fail) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:-100px;opacity:0";
        document.body.appendChild(ta); ta.select();
        var done = document.execCommand("copy");
        ta.remove();
        done ? ok() : fail(new Error("copy"));
      } catch (e) { fail(e); }
    });
  }

  function share() {
    var r = route(currentId);
    if (!r) return;
    var url = RR.shareUrl(r.id);
    if (navigator.share) {
      navigator.share({ title: r.navn + " – Randonee ruteplanlegger", url: url }).catch(function (e) {
        if (e && e.name === "AbortError") return;
        copyText(url).then(function () { U.toast("Lenke kopiert"); }, function () { U.toast("Kunne ikke dele lenken.", "error"); });
      });
      return;
    }
    copyText(url).then(function () { U.toast("Lenke kopiert"); }, function () { U.toast("Kunne ikke kopiere lenken.", "error"); });
  }

  /* ---------- hendelser ---------- */
  function onSelect(e) {
    var id = e && e.id;
    if (id == null || !e.route) {
      if (rightEl) rightEl.hidden = true;
      document.body.classList.remove("has-card");
      clear();
      return;
    }
    render(id);
    if (rightEl) rightEl.hidden = false;
    document.body.classList.add("has-card");
    var src = e.source;
    if (src === "list" || src === "url" || src === "map") {
      var h = qs(".card-title");
      if (h) { try { h.focus({ preventScroll: true }); } catch (err) { h.focus(); } }
    }
  }

  function syncFromState() {
    var id = RR.state.selectedId;
    if (id != null && route(id)) onSelect({ id: id, route: route(id), source: null });
  }

  function init() {
    rightEl = document.getElementById("right");
    cardEl = document.getElementById("card");
    if (!rightEl || !cardEl) { console.warn("[card] mangler #right/#card"); return; }

    cardEl.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-act]") : null;
      if (!b || !cardEl.contains(b) || b.disabled) return;
      var act = b.getAttribute("data-act");
      if (act === "close") RR.select(null, { source: "card" });
      else if (act === "fly") { if (currentId != null) RR.emit("fly:request", { id: currentId }); }
      else if (act === "wx") requestWx();
      else if (act === "share") share();
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape" || ev.defaultPrevented) return;
      if (RR.state.selectedId == null || rightEl.hidden) return;
      var w = document.getElementById("welcome");
      if (w && !w.hidden) return;
      var t = ev.target;
      if (t && t.closest && t.closest('[role="dialog"],[aria-modal="true"]')) return;
      RR.select(null, { source: "card" });
    });

    RR.on("select", onSelect);
    RR.on("danger", updateWarn);
    RR.on("data:routes", function () {
      // Valgt tur kom før data: tegn nå
      var id = RR.state.selectedId;
      if (id != null && route(id) && currentId !== id) onSelect({ id: id, route: route(id), source: null });
    });
    RR.on("view:ready", function () {
      // Profil fra scene kan nå være tilgjengelig – oppgrader forenklet profil
      var r = route(currentId);
      if (!r || profCache[r.id]) return;
      var box = qs(".card-prof__box");
      if (box && !box.classList.contains("is-loading")) fillProfile(r);
    });
    syncFromState();
  }

  RR.modules.card = { init: init, render: render };
})();
