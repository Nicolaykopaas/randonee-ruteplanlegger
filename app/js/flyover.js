/* Fly over ruta: kamera følger ruta fra parkering til toppen, deretter rolig runde rundt toppen.
   Lytter: fly:request, select, mode, view:ready. Sender: fly:start, fly:stop, mode. */
(function () {
  "use strict";
  var RR = window.RR, CFG = RR.CFG, U = RR.util, S = RR.state;

  /* ---------- parametere ---------- */
  var STEP_M = 20;            // ønsket avstand mellom samples (m)
  var MAX_SAMPLES = 900;      // tak på antall samples (øker steget for lange ruter)
  var SMOOTH_M = 100;         // halv vindusbredde for glatting av posisjon/heading (m)
  var LOOKAHEAD_M = 200;      // se fremover langs banen for heading (m)
  var BACK_M = 280;           // kamera bak punktet (m)
  var CAM_OFFSET = 140;       // kamerahøyde over terreng (m)
  var TILT = 68;              // tilt langs ruta (grader fra nadir)
  var ORBIT_R = 600;          // m
  var ORBIT_UP = 250;         // m over toppen
  var ORBIT_TILT = 65;
  var ORBIT_DEG_S = 6;        // grader per sekund
  var ORBIT_SECONDS = 30;
  var ORBIT_BLEND_S = 3;      // overgang fra rute-kamera til orbit
  var INTRO_MS = 1500;
  var MODE_TIMEOUT_MS = 8000;
  var ELEV_TIMEOUT_MS = 12000;

  /* ---------- tilstand ---------- */
  var token = 0;              // økes ved start/stopp, avbryter asynkrone steg
  var flyId = null;           // rute vi flyr (eller forbereder å fly) over
  var active = false;         // flybar vist, fly:start sendt
  var phase = "idle";         // idle | prep | intro | path | orbit
  var userPaused = false, autoPaused = false;
  var raf = 0, lastTs = 0;
  var tPath = 0, tOrbit = 0;
  var plan = null;            // ferdig beregnet bane
  var viewHandles = [];
  var modeWaiter = null;
  var prevFocus = null;
  var el = {};                // flybar-elementer
  var lastPct = -1, lastLabel = "";

  /* ---------- små hjelpere ---------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoother(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
  function rad(d) { return d * Math.PI / 180; }
  function norm360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function reduced() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
  }
  function view3d() {
    var v = RR.view;
    return v && v.type === "3d" ? v : null;
  }
  function sr() { return { wkid: CFG.WKID }; }

  /* Glidende gjennomsnitt, symmetrisk vindu som krymper mot endene (endepunktene beholdes) */
  function smoothShrink(a, hw) {
    var n = a.length, out = new Array(n);
    for (var i = 0; i < n; i++) {
      var h = Math.min(hw, i, n - 1 - i), s = 0;
      for (var k = i - h; k <= i + h; k++) s += a[k];
      out[i] = s / (2 * h + 1);
    }
    return out;
  }
  /* Glidende gjennomsnitt med kantverdi utenfor (for heading og høyde) */
  function smoothClamp(a, hw) {
    var n = a.length, out = new Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0;
      for (var k = i - hw; k <= i + hw; k++) s += a[k < 0 ? 0 : k > n - 1 ? n - 1 : k];
      out[i] = s / (2 * hw + 1);
    }
    return out;
  }

  /* ---------- bane ---------- */
  function routeVertices(route) {
    var pts = [];
    function add(x, y) {
      if (typeof x !== "number" || typeof y !== "number" || isNaN(x) || isNaN(y)) return;
      var l = pts[pts.length - 1];
      if (l && Math.abs(l[0] - x) < 0.5 && Math.abs(l[1] - y) < 0.5) return;
      pts.push([x, y]);
    }
    if (route.park && route.park.x != null && route.park.y != null) add(route.park.x, route.park.y);
    (route.paths || []).forEach(function (p) { (p || []).forEach(function (v) { add(v[0], v[1]); }); });
    return pts;
  }

  function resample(pts, step) {
    var cum = [0], i;
    for (i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    var total = cum[cum.length - 1];
    if (total < 30) return null;
    step = Math.max(step, total / MAX_SAMPLES);
    var cnt = Math.max(2, Math.round(total / step) + 1), ds = total / (cnt - 1);
    var X = new Array(cnt), Y = new Array(cnt), seg = 1;
    for (i = 0; i < cnt; i++) {
      var d = i * ds;
      while (seg < pts.length - 1 && cum[seg] < d) seg++;
      var l = cum[seg] - cum[seg - 1], f = l > 0 ? clamp((d - cum[seg - 1]) / l, 0, 1) : 0;
      X[i] = lerp(pts[seg - 1][0], pts[seg][0], f);
      Y[i] = lerp(pts[seg - 1][1], pts[seg][1], f);
    }
    return { X: X, Y: Y, ds: ds, total: total };
  }

  /* Terrenghøyder for liste av [x,y]. Resolver til tall[] (NaN der det mangler) eller null. */
  function sampleElev(coords) {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } }
      var timer = setTimeout(function () { fin(null); }, ELEV_TIMEOUT_MS);
      try {
        // Rask vei: synkron sampling fra terrenget som allerede er lastet i 3D-visningen.
        var gv = RR.view && RR.view.type === "3d" && RR.view.groundView;
        var smp = gv && gv.elevationSampler;
        if (smp && smp.queryElevation) {
          var fast = smp.queryElevation(new RR.esri.Polyline({ paths: [coords], spatialReference: sr() }));
          var fp = fast && fast.paths && fast.paths[0];
          if (fp && fp.length === coords.length) {
            var zs = fp.map(function (v) { var z = v[2]; return typeof z === "number" && isFinite(z) && z > -500 ? z : NaN; });
            var ok = zs.filter(function (z) { return !isNaN(z); }).length;
            if (ok > zs.length * 0.8) return fin(zs);
          }
        }
        var g = RR.ground || (RR.view && RR.view.map && RR.view.map.ground);
        if (!g || !g.queryElevation) return fin(null);
        var pl = new RR.esri.Polyline({ paths: [coords], spatialReference: sr() });
        Promise.resolve(g.load ? g.load() : null).catch(function () { /* prøv likevel */ }).then(function () {
          return g.queryElevation(pl);
        }).then(function (res) {
          var p = res && res.geometry && res.geometry.paths && res.geometry.paths[0];
          if (!p || p.length !== coords.length) return fin(null);
          var nd = res.noDataValue;
          fin(p.map(function (v) {
            var z = v[2];
            return typeof z === "number" && isFinite(z) && z !== nd && z > -500 ? z : NaN;
          }));
        }).catch(function () { fin(null); });
      } catch (e) { fin(null); }
    });
  }

  /* Fyll hull (NaN) ved lineær interpolasjon; fallback lineær fra def0 til def1 */
  function fillGaps(z, def0, def1) {
    var n = z.length, i, out = z ? z.slice() : [];
    var anyOk = false;
    for (i = 0; i < n; i++) if (!isNaN(out[i])) { anyOk = true; break; }
    if (!anyOk) {
      for (i = 0; i < n; i++) out[i] = lerp(def0, def1, n > 1 ? i / (n - 1) : 0);
      return out;
    }
    var prev = -1;
    for (i = 0; i < n; i++) {
      if (isNaN(out[i])) continue;
      if (prev === -1) { for (var a = 0; a < i; a++) out[a] = out[i]; }
      else if (i - prev > 1) { for (var b = prev + 1; b < i; b++) out[b] = lerp(out[prev], out[i], (b - prev) / (i - prev)); }
      prev = i;
    }
    for (i = prev + 1; i < n; i++) out[i] = out[prev];
    return out;
  }

  function buildPlan(route) {
    var pts = routeVertices(route);
    if (pts.length < 2) return Promise.resolve(null);
    var rs = resample(pts, STEP_M);
    if (!rs) return Promise.resolve(null);
    var n = rs.X.length, ds = rs.ds, i;
    var hw = Math.max(1, Math.round(SMOOTH_M / ds));
    var look = Math.max(2, Math.round(LOOKAHEAD_M / ds));
    var minLook = Math.max(1, Math.round(60 / ds));

    var X = smoothShrink(rs.X, hw), Y = smoothShrink(rs.Y, hw);

    /* heading: retning mot punktet ~200 m frem, glattet (utrullet så 359->1 ikke hopper) */
    var H = new Array(n), last = null;
    var fallbackH = Math.atan2(X[n - 1] - X[0], Y[n - 1] - Y[0]) * 180 / Math.PI;
    for (i = 0; i < n; i++) {
      var j = Math.min(n - 1, i + look);
      if (j - i >= minLook) {
        var dx = X[j] - X[i], dy = Y[j] - Y[i];
        if (Math.hypot(dx, dy) > 1) last = Math.atan2(dx, dy) * 180 / Math.PI;
      }
      H[i] = last == null ? fallbackH : last;
    }
    for (i = 1; i < n; i++) {
      var d = H[i] - H[i - 1];
      d -= 360 * Math.round(d / 360);
      H[i] = H[i - 1] + d;
    }
    H = smoothClamp(H, Math.max(1, Math.round(hw * 1.5)));

    /* kameraposisjon (xy) bak punktet */
    var CX = new Array(n), CY = new Array(n);
    for (i = 0; i < n; i++) {
      CX[i] = X[i] - Math.sin(rad(H[i])) * BACK_M;
      CY[i] = Y[i] - Math.cos(rad(H[i])) * BACK_M;
    }
    /* sirkel rundt toppen for terrengsjekk av orbit */
    var topX = X[n - 1], topY = Y[n - 1], circ = [], a;
    for (a = 0; a < 16; a++) circ.push([topX + ORBIT_R * Math.sin(rad(a * 22.5)), topY + ORBIT_R * Math.cos(rad(a * 22.5))]);

    var ptCoords = [], camCoords = [];
    for (i = 0; i < n; i++) { ptCoords.push([X[i], Y[i]]); camCoords.push([CX[i], CY[i]]); }

    return Promise.all([sampleElev(ptCoords), sampleElev(camCoords.concat(circ))]).then(function (r) {
      var s0 = route.start_moh != null ? +route.start_moh : 0;
      var s1 = route.topp_moh != null ? +route.topp_moh : s0 + 500;
      var zP = fillGaps(r[0] || new Array(n).fill(NaN), s0, s1);
      var zAll = r[1] ? r[1] : null;
      var zC, zCirc = null;
      if (zAll) {
        zC = fillGaps(zAll.slice(0, n), s0, s1);
        zCirc = zAll.slice(n).filter(function (v) { return !isNaN(v); });
      } else {
        zC = zP.slice();
      }
      /* glatt også punkthøyden litt (DEM-støy) */
      zP = smoothShrink(zP, 2);
      /* kamerahøyde: terrengomhyllning (maks av kamera- og punkthøyde, utvidet litt fremover),
         glattet, + offset. Glattingen garanterer klaring >= offset over terreng på kameraposisjonen. */
      var base = new Array(n), env = new Array(n);
      for (i = 0; i < n; i++) base[i] = Math.max(zC[i], zP[i]);
      var back = hw, fwd = hw * 2;
      for (i = 0; i < n; i++) {
        var m = -Infinity;
        for (var k = Math.max(0, i - back); k <= Math.min(n - 1, i + fwd); k++) if (base[k] > m) m = base[k];
        env[i] = m;
      }
      var camZ = smoothClamp(env, hw).map(function (v) { return v + CAM_OFFSET; });

      var topZ = zP[n - 1];
      var circMax = zCirc && zCirc.length ? Math.max.apply(null, zCirc) : topZ;
      var orbitZ = Math.max(topZ + ORBIT_UP, circMax + 120);

      return {
        n: n, X: X, Y: Y, H: H, CX: CX, CY: CY, CZ: camZ,
        topX: topX, topY: topY, topZ: topZ, orbitZ: orbitZ,
        h0: H[0], hEnd: H[n - 1]
      };
    });
  }

  /* ---------- kamera ---------- */
  function setCam(v, x, y, z, heading, tilt) {
    v.camera = new RR.esri.Camera({
      position: new RR.esri.Point({ x: x, y: y, z: z, spatialReference: sr() }),
      heading: norm360(heading),
      tilt: tilt
    });
  }
  function camAt(f) {          // f = flyttall-indeks i banen
    var n = plan.n, i = clamp(Math.floor(f), 0, n - 2), t = clamp(f - i, 0, 1);
    return {
      x: lerp(plan.CX[i], plan.CX[i + 1], t),
      y: lerp(plan.CY[i], plan.CY[i + 1], t),
      z: lerp(plan.CZ[i], plan.CZ[i + 1], t),
      h: lerp(plan.H[i], plan.H[i + 1], t)
    };
  }
  function orbitCam(t) {
    var b = smoother(t / ORBIT_BLEND_S);
    var r = lerp(BACK_M, ORBIT_R, b);
    var h = plan.hEnd + ORBIT_DEG_S * t;
    var z = lerp(plan.CZ[plan.n - 1], plan.orbitZ, b);
    return {
      x: plan.topX - Math.sin(rad(h)) * r,
      y: plan.topY - Math.cos(rad(h)) * r,
      z: z, h: h, tilt: lerp(TILT, ORBIT_TILT, b)
    };
  }

  /* ---------- flybar ---------- */
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 5.5v13l11-6.5z"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

  function buildBar() {
    var bar = document.getElementById("flybar");
    if (!bar) return false;
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Fly over ruta");
    bar.innerHTML =
      '<button type="button" class="fly-btn fly-toggle" aria-pressed="false" aria-label="Pause" title="Pause (mellomrom)">' + ICON_PAUSE + '</button>' +
      '<div class="fly-mid">' +
        '<div class="fly-text" aria-live="off"></div>' +
        '<div class="fly-track" role="progressbar" aria-label="Fremdrift" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="fly-fill"></span></div>' +
      '</div>' +
      '<button type="button" class="fly-btn fly-stop" aria-label="Stopp fly over" title="Stopp (Esc)">' + ICON_STOP + '</button>';
    el.bar = bar;
    el.toggle = bar.querySelector(".fly-toggle");
    el.stop = bar.querySelector(".fly-stop");
    el.text = bar.querySelector(".fly-text");
    el.track = bar.querySelector(".fly-track");
    el.fill = bar.querySelector(".fly-fill");
    el.toggle.addEventListener("click", function () { if (userPaused) resume(); else pause(); });
    el.stop.addEventListener("click", function () { stop(); });
    return true;
  }

  function routeName() {
    var r = flyId != null ? S.byId[flyId] : null;
    return r ? r.navn : "ruta";
  }
  function setProgress(pct, label) {
    if (!el.bar) return;
    pct = Math.round(clamp(pct, 0, 100));
    var txt = label || ("Flyr over " + routeName() + " · " + pct + " %");
    if (txt !== lastLabel) { el.text.textContent = txt; lastLabel = txt; }
    if (pct !== lastPct) {
      lastPct = pct;
      el.fill.style.transform = "scaleX(" + (pct / 100) + ")";
      el.track.setAttribute("aria-valuenow", String(pct));
    }
  }
  function syncToggle() {
    if (!el.toggle) return;
    el.toggle.setAttribute("aria-pressed", userPaused ? "true" : "false");
    el.toggle.innerHTML = userPaused ? ICON_PLAY : ICON_PAUSE;
    el.toggle.title = userPaused ? "Fortsett (mellomrom)" : "Pause (mellomrom)";
    el.toggle.setAttribute("aria-label", userPaused ? "Fortsett" : "Pause");
  }

  /* ---------- livssyklus ---------- */
  function isRunning() { return !userPaused && !autoPaused; }

  function bindView(v) {
    unbindView();
    function interrupt() { stop(); }
    try {
      viewHandles.push(v.on("drag", interrupt));
      viewHandles.push(v.on("mouse-wheel", interrupt));
      viewHandles.push(v.on("double-click", interrupt));
      viewHandles.push(v.on("key-down", function (e) {
        var k = e && e.key;
        if (k === " " || k === "Escape" || k === "Shift" || k === "Control" || k === "Alt" || k === "Meta" || k === "Tab") return;
        stop();
      }));
    } catch (e) { /* ignorer */ }
    if (v.container && v.container.addEventListener) {
      var c = v.container;
      c.addEventListener("touchmove", interrupt, { passive: true });
      viewHandles.push({ remove: function () { c.removeEventListener("touchmove", interrupt); } });
    }
  }
  function unbindView() {
    viewHandles.forEach(function (h) { try { h.remove(); } catch (e) { /* ignorer */ } });
    viewHandles = [];
  }

  function cancelWaiter() {
    if (modeWaiter) { clearTimeout(modeWaiter.timer); modeWaiter = null; }
  }

  /* Venter på view:ready med mode 3d. Resolver true/false (timeout). */
  function waitFor3d(tok) {
    return new Promise(function (resolve) {
      cancelWaiter();
      var w = { timer: 0, resolve: resolve };
      w.timer = setTimeout(function () { if (modeWaiter === w) modeWaiter = null; resolve(false); }, MODE_TIMEOUT_MS);
      modeWaiter = w;
    });
  }

  function start(id) {
    id = id == null ? null : Number(id);
    var route = id != null ? S.byId[id] : null;
    if (!route) return;
    if (flyId === id && (active || phase !== "idle")) return;      // allerede i gang
    if (flyId != null) stop();
    if (!U.webglOk()) { U.toast("3D er ikke tilgjengelig på denne enheten.", "error"); return; }

    var tok = ++token;
    flyId = id;
    prevFocus = document.activeElement;
    phase = "prep";

    var ready;
    if (view3d() && S.mode !== "2d") ready = Promise.resolve(true);
    else {
      ready = waitFor3d(tok);
      if (S.mode === "2d") RR.emit("mode", "3d");
    }
    ready.then(function (ok) {
      if (tok !== token) return;
      var v = view3d();
      if (!ok || !v) { fail("3D er ikke tilgjengelig på denne enheten."); return; }
      begin(tok, route, v);
    });
  }

  function fail(msg) {
    U.toast(msg, "error");
    stop();
  }

  function begin(tok, route, v) {
    if (S.selectedId !== route.id) RR.select(route.id, { source: "flyover" });
    if (tok !== token) return;

    if (reduced()) {
      overview(route, v);
      U.toast("Animasjon er slått av (redusert bevegelse).");
      flyId = null; phase = "idle";
      return;
    }

    /* Vis flybar og meld fra med en gang, mens banen beregnes */
    active = true;
    userPaused = false; autoPaused = !!document.hidden;
    plan = null; tPath = 0; tOrbit = 0; lastPct = -1; lastLabel = "";
    document.body.classList.add("is-flying");
    S.flying = true;
    syncToggle();
    setProgress(0, "Forbereder fly over " + route.navn + " …");
    if (el.bar) el.bar.hidden = false;
    RR.emit("fly:start", { id: route.id });
    bindView(v);

    buildPlan(route).then(function (p) {
      if (tok !== token) return;
      if (!p) { fail("Fant ikke noen bane å fly langs."); return; }
      plan = p;
      var c0 = camAt(0);
      phase = "intro";
      var cam = new RR.esri.Camera({
        position: new RR.esri.Point({ x: c0.x, y: c0.y, z: c0.z, spatialReference: sr() }),
        heading: norm360(c0.h), tilt: TILT
      });
      var gp;
      try { gp = v.goTo(cam, { duration: INTRO_MS, easing: "in-out-cubic" }); } catch (e) { gp = Promise.resolve(); }
      return Promise.resolve(gp).catch(function () { /* avbrutt eller ferdig */ }).then(function () {
        if (tok !== token) return;
        phase = "path"; lastTs = 0;
        setProgress(0);
        raf = requestAnimationFrame(function (ts) { frame(tok, ts); });
      });
    }).catch(function (e) {
      console.error("[flyover]", e);
      if (tok === token) fail("Fly over feilet. Prøv igjen.");
    });
  }

  function frame(tok, ts) {
    if (tok !== token) return;
    raf = requestAnimationFrame(function (t2) { frame(tok, t2); });
    var dt = lastTs ? Math.min(0.5, Math.max(0, (ts - lastTs) / 1000)) : 0;
    lastTs = ts;
    if (!isRunning()) return;
    var v = view3d();
    if (!v || !plan) { stop(); return; }

    if (phase === "path") {
      tPath += dt;
      var T = Math.max(5, CFG.FLY_SECONDS || 20);
      var u = clamp(tPath / T, 0, 1);
      var c = camAt(smoother(u) * (plan.n - 1));
      setCam(v, c.x, c.y, c.z, c.h, TILT);
      setProgress(u * 100);
      if (u >= 1) { phase = "orbit"; tOrbit = 0; setProgress(100, "Rundt toppen"); }
    } else if (phase === "orbit") {
      tOrbit += dt;
      var o = orbitCam(tOrbit);
      setCam(v, o.x, o.y, o.z, o.h, o.tilt);
      if (tOrbit >= ORBIT_SECONDS) stop();
    }
  }

  function overview(route, v) {
    var h = 0;
    var a = route.park && route.park.x != null ? route.park : route.start;
    if (a && route.top) h = Math.atan2(route.top.x - a.x, route.top.y - a.y) * 180 / Math.PI;
    try {
      var pl = new RR.esri.Polyline({ paths: route.paths, spatialReference: sr() });
      v.goTo({ target: pl, heading: norm360(h), tilt: 60 }, { duration: 1200 }).catch(function () { /* avbrutt */ });
    } catch (e) { /* ignorer */ }
  }

  function pause() {
    if (!active || userPaused) return;
    userPaused = true;
    syncToggle();
  }
  function resume() {
    if (!active || !userPaused) return;
    userPaused = false;
    syncToggle();
  }

  function stop() {
    var wasActive = active, id = flyId;
    token++;
    cancelWaiter();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    unbindView();
    active = false; flyId = null; phase = "idle"; plan = null;
    userPaused = false; autoPaused = false; lastTs = 0;
    var v = view3d();
    if (wasActive && v) {
      /* Fryser kameraet der det er (avbryter evt. pågående goTo) */
      try { if (v.camera) v.camera = v.camera.clone(); } catch (e) { /* ignorer */ }
    }
    document.body.classList.remove("is-flying");
    S.flying = false;
    var hadFocus = el.bar && el.bar.contains(document.activeElement);
    if (el.bar) el.bar.hidden = true;
    if (hadFocus && prevFocus && prevFocus.focus && document.contains(prevFocus)) {
      try { prevFocus.focus(); } catch (e) { /* ignorer */ }
    }
    prevFocus = null;
    if (wasActive) RR.emit("fly:stop", { id: id });
  }

  function isActive() { return active; }

  /* ---------- hendelser ---------- */
  function onKey(e) {
    if (!active) return;
    if (e.key === "Escape") { e.preventDefault(); stop(); return; }
    if (e.key === " " || e.code === "Space") {
      var t = e.target;
      if (t && t.closest && t.closest("button, a, input, textarea, select, [role=button], [contenteditable]")) return;
      e.preventDefault();
      if (userPaused) resume(); else pause();
    }
  }

  function init() {
    if (!buildBar()) console.warn("[flyover] fant ikke #flybar");
    RR.on("fly:request", function (d) { if (d) start(d.id); });
    RR.on("select", function (d) {
      if (flyId != null && (!d || d.id !== flyId)) stop();
    });
    RR.on("mode", function (m) {
      if (m === "2d" && flyId != null) stop();
    });
    RR.on("view:ready", function (d) {
      var mode = d && d.mode;
      if (modeWaiter && mode === "3d") {
        var w = modeWaiter; modeWaiter = null; clearTimeout(w.timer); w.resolve(true);
        return;
      }
      if (flyId != null) stop();      // ny view midt i flyover
    });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("visibilitychange", function () {
      autoPaused = !!document.hidden;
      lastTs = 0;
    });
  }

  RR.modules.flyover = {
    init: init, start: start, stop: stop, pause: pause, resume: resume, isActive: isActive
  };
})();
