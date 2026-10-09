/* scene.js – kart (3D SceneView / 2D MapView), lag, ruter, kartkontroller, tegnforklaring.
   Eier: #map, #controls (btn-mode, btn-locate, btn-steep, btn-legend), #legend. */
(function () {
  "use strict";
  var RR = window.RR, CFG = RR.CFG, U = RR.util, S = RR.state;
  var E = RR.esri;

  var WKID = CFG.WKID || 25833;
  var SR = { wkid: WKID };
  var DEFAULT_HEADING = 150;          // mot sørøst
  var TILT = 60;
  var ESRI_CSS = "https://js.arcgis.com/4.31/esri/themes/";
  var BG = { dark: [13, 11, 22], light: [222, 230, 238] };

  /* ---------- tilstand ---------- */
  var inited = false;
  var mapEl = null, host = null;
  var map = null, ground = null;
  var view = null, viewMode = null, handles = [];
  var switching = false, queuedMode = null, switchPromise = null;
  var viewReady = false;
  var imageryLayer = null, terrainLayer = null, steepLayer = null;
  var routesLayer = null, pointsLayer = null, hlLayer = null, topLayer = null, locLayer = null;
  var routeG = {}, pointG = {}, topG = null;
  var hl = null, rafId = 0;
  var pendingZoom = null, fitted = false, userMoved = false;
  var lastHeading = DEFAULT_HEADING;
  var warned = {};
  var locGraphic = null;
  var reduced = false;
  var profileCache = {};
  var theme = "dark";
  var hoverBusy = false, hoverLast = 0, hovering = false;

  /* ---------- små hjelpere ---------- */
  function $(id) { return document.getElementById(id); }
  function rgb(hex, a) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a == null ? 1 : a];
  }
  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    U.toast(msg, "error", 7000);
  }
  function levelColor(r) { return (CFG.LEVEL_COLORS && CFG.LEVEL_COLORS[r && r.niva]) || "#FF3EDB"; }
  function ignoreAbort(e) { if (e && e.name !== "AbortError") console.warn("[scene]", e); }

  /* UTM33 (ETRS89/GRS80) fra lat/lon – Krüger-rekke */
  function toUTM33(lat, lon) {
    var a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = 15 * Math.PI / 180;
    var n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n2 * n2;
    var A = a / (1 + n) * (1 + n2 / 4 + n4 / 64);
    var al = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16, 13 * n2 / 48 - 3 * n3 / 5, 61 * n3 / 240];
    var phi = lat * Math.PI / 180, lam = lon * Math.PI / 180 - lon0;
    var q = 2 * Math.sqrt(n) / (1 + n);
    var t = Math.sinh(Math.atanh(Math.sin(phi)) - q * Math.atanh(q * Math.sin(phi)));
    var xi = Math.atan2(t, Math.cos(lam));
    var eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
    var x = eta, y = xi;
    for (var j = 1; j <= 3; j++) {
      x += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
      y += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    }
    return { x: 500000 + k0 * A * x, y: k0 * A * y };
  }

  var DEFAULT_CENTER = toUTM33(62.57, 7.69);   // Åndalsnes

  /* ---------- geometri ---------- */
  function xyPaths(r) {
    return r.paths.map(function (p) { return p.map(function (v) { return [v[0], v[1]]; }); });
  }
  function boundsOf(r) {
    var b = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
    r.paths.forEach(function (p) { p.forEach(function (v) {
      if (v[0] < b.xmin) b.xmin = v[0]; if (v[0] > b.xmax) b.xmax = v[0];
      if (v[1] < b.ymin) b.ymin = v[1]; if (v[1] > b.ymax) b.ymax = v[1];
    }); });
    return b;
  }
  function mkExtent(b, grow, minSize) {
    var w = b.xmax - b.xmin, h = b.ymax - b.ymin, cx = (b.xmin + b.xmax) / 2, cy = (b.ymin + b.ymax) / 2;
    w = Math.max(w * (1 + grow), minSize); h = Math.max(h * (1 + grow), minSize);
    return new E.Extent({ xmin: cx - w / 2, xmax: cx + w / 2, ymin: cy - h / 2, ymax: cy + h / 2, spatialReference: SR });
  }
  function routeExtent(r) { return mkExtent(boundsOf(r), 0.2, 700); }
  function allExtent() {
    var b = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
    S.routes.forEach(function (r) {
      var rb = boundsOf(r);
      b.xmin = Math.min(b.xmin, rb.xmin); b.ymin = Math.min(b.ymin, rb.ymin);
      b.xmax = Math.max(b.xmax, rb.xmax); b.ymax = Math.max(b.ymax, rb.ymax);
    });
    if (!isFinite(b.xmin)) return null;
    return mkExtent(b, 0.15, 3000);
  }
  function routeHeading(r) {
    if (!r || !r.start || !r.top) return lastHeading;
    var dx = r.top.x - r.start.x, dy = r.top.y - r.start.y;
    if (Math.sqrt(dx * dx + dy * dy) < 150) return lastHeading;
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }

  /* ---------- symboler ---------- */
  function lineSym(mode, color, width) {
    if (mode === "3d") {
      return { type: "line-3d", symbolLayers: [{ type: "line", size: width, material: { color: color }, cap: "round", join: "round" }] };
    }
    return { type: "simple-line", color: color, width: width, cap: "round", join: "round" };
  }

  function routeSymbol(mode, hex) {
    var c = rgb(hex, 1), g = rgb(hex, 0.38), d = [8, 6, 16, 0.62];
    if (mode === "3d") {
      return { type: "line-3d", symbolLayers: [
        { type: "line", size: 10.5, material: { color: d }, cap: "round", join: "round" },
        { type: "line", size: 7.5, material: { color: g }, cap: "round", join: "round" },
        { type: "line", size: 3.6, material: { color: c }, cap: "round", join: "round" }
      ] };
    }
    function stroke(w, col) {
      return { type: "CIMSolidStroke", enable: true, width: w, color: col, capStyle: "Round", joinStyle: "Round" };
    }
    var to255 = function (a) { return [a[0], a[1], a[2], Math.round(a[3] * 255)]; };
    return { type: "cim", data: { type: "CIMSymbolReference", symbol: { type: "CIMLineSymbol", symbolLayers: [
      stroke(3.2, to255(c)), stroke(6.6, to255(g)), stroke(9.6, to255(d))
    ] } } };
  }

  var P_SVG = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32">' +
    '<circle cx="16" cy="16" r="13" fill="#fff" stroke="#00C8FF" stroke-width="3.5"/>' +
    '<text x="16" y="21.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="16" fill="#0a3a52">P</text></svg>');

  function pointSymbol(mode, kind) {
    var isPark = kind === "park";
    if (mode === "3d") {
      return {
        type: "point-3d",
        symbolLayers: [isPark
          ? { type: "icon", resource: { href: P_SVG }, size: 26 }
          : { type: "icon", resource: { primitive: "circle" }, material: { color: [255, 255, 255, 1] }, outline: { color: [0, 200, 255, 1], size: 2.2 }, size: 13 }],
        verticalOffset: { screenLength: 40, maxWorldLength: 500, minWorldLength: 15 },
        callout: { type: "line", size: 1.3, color: [255, 255, 255, 0.92], border: { color: [0, 200, 255, 0.9] } }
      };
    }
    return isPark
      ? { type: "picture-marker", url: P_SVG, width: 24, height: 24 }
      : { type: "simple-marker", style: "circle", size: 11, color: [255, 255, 255, 1], outline: { color: [0, 200, 255, 1], width: 2 } };
  }

  function locSymbol(mode) {
    if (mode === "3d") {
      return { type: "point-3d", symbolLayers: [
        { type: "icon", resource: { primitive: "circle" }, material: { color: [26, 115, 232, 0.28] }, size: 34 },
        { type: "icon", resource: { primitive: "circle" }, material: { color: [26, 115, 232, 1] }, outline: { color: [255, 255, 255, 1], size: 2.4 }, size: 15 }
      ] };
    }
    return { type: "simple-marker", style: "circle", size: 14, color: [26, 115, 232, 1], outline: { color: [255, 255, 255, 1], width: 2.5 } };
  }

  function topSymbols(mode, text) {
    if (mode === "3d") {
      return [
        { type: "point-3d", symbolLayers: [{ type: "icon", resource: { primitive: "triangle" }, material: { color: [255, 255, 255, 1] }, outline: { color: [0, 0, 0, 0.7], size: 1.2 }, size: 12 }] },
        { type: "point-3d", symbolLayers: [{ type: "text", text: text, size: 11, material: { color: [255, 255, 255, 1] },
          halo: { color: [10, 8, 20, 0.85], size: 1.6 }, font: { weight: "bold" } }],
          verticalOffset: { screenLength: 30, maxWorldLength: 500, minWorldLength: 10 },
          callout: { type: "line", size: 1, color: [255, 255, 255, 0.85] } }
      ];
    }
    return [
      { type: "simple-marker", style: "triangle", size: 11, color: [255, 255, 255, 1], outline: { color: [10, 8, 20, 0.8], width: 1 } },
      { type: "text", text: text, color: [255, 255, 255, 1], haloColor: [10, 8, 20, 0.85], haloSize: 2, yoffset: 12,
        font: { size: 11, weight: "bold" } }
    ];
  }

  /* ---------- tema / miljø ---------- */
  function sunDate() { return new Date(Date.UTC(new Date().getFullYear(), 2, 21, 10, 30)); }
  function envFor(t) {
    return {
      atmosphereEnabled: true,
      starsEnabled: t === "dark",
      background: { type: "color", color: BG[t === "light" ? "light" : "dark"] },
      lighting: { type: "sun", date: sunDate(), directShadowsEnabled: false, cameraTrackingEnabled: false }
    };
  }

  function applyTheme(t) {
    theme = t === "light" ? "light" : "dark";
    var link = $("esri-theme");
    if (link) {
      var href = ESRI_CSS + theme + "/main.css";
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
    }
    if (!view) return;
    try {
      if (viewMode === "3d") view.environment = envFor(theme);
      else view.background = { color: BG[theme] };
    } catch (e) { console.warn("[scene] tema:", e); }
  }

  /* ---------- padding ---------- */
  function currentPadding() {
    if (S.isMobile) {
      var h = window.innerHeight || 700;
      return { left: 0, right: 0, top: 0, bottom: S.selectedId != null ? Math.round(h * 0.5) : 110 };
    }
    var panel = 340 + 24;
    return { left: panel, right: S.selectedId != null ? panel : 0, top: 0, bottom: 0 };
  }
  function updatePadding() {
    if (!view) return;
    try { view.padding = currentPadding(); } catch (e) { /* ignorer */ }
  }

  /* ---------- lag og kart ---------- */
  function buildMap() {
    imageryLayer = new E.TileLayer({ url: CFG.IMAGERY_URL, id: "rr-imagery", title: "Flyfoto" });
    terrainLayer = new E.ElevationLayer({ url: CFG.TERRAIN_URL, id: "rr-terrain", title: "Terreng" });
    ground = new E.Ground({ layers: [terrainLayer] });
    RR.ground = ground;
    var basemap = new E.Basemap({ baseLayers: [imageryLayer], title: "Flyfoto", id: "rr-basemap", spatialReference: SR });
    steepLayer = new E.MapImageLayer({
      url: CFG.STEEPNESS_URL, id: "rr-steep", title: "Bratthet (NVE)",
      sublayers: [{ id: 0, visible: true }],
      opacity: CFG.STEEPNESS_OPACITY, visible: S.steepness !== false
    });
    routesLayer = new E.GraphicsLayer({ id: "rr-routes", title: "Ruter", listMode: "hide", elevationInfo: { mode: "on-the-ground" } });
    hlLayer = new E.GraphicsLayer({ id: "rr-hl", title: "Valgt rute", listMode: "hide", elevationInfo: { mode: "on-the-ground" } });
    pointsLayer = new E.GraphicsLayer({ id: "rr-points", title: "Parkering", listMode: "hide", elevationInfo: { mode: "relative-to-ground", offset: 0 } });
    topLayer = new E.GraphicsLayer({ id: "rr-top", title: "Topp", listMode: "hide", elevationInfo: { mode: "relative-to-ground", offset: 0 } });
    locLayer = new E.GraphicsLayer({ id: "rr-loc", title: "Min posisjon", listMode: "hide", elevationInfo: { mode: "on-the-ground" } });
    map = new E.Map({ basemap: basemap, ground: ground });
    map.addMany([steepLayer, routesLayer, hlLayer, pointsLayer, topLayer, locLayer]);

    imageryLayer.load().catch(function () {
      // Uten flyfoto mangler 3D-scenen flisskjema og blir blank – fall tilbake til 2D.
      if (S.mode === "3d") {
        warnOnce("img", "Flyfoto kunne ikke lastes. Viser enkelt 2D-kart.");
        setMode("2d");
      } else warnOnce("img", "Flyfoto kunne ikke lastes. Kartet vises uten bakgrunnsbilde.");
    });
    terrainLayer.load().catch(function () { warnOnce("ter", "Terrengdata kunne ikke lastes. Kartet vises uten høyde."); });
    steepLayer.load().catch(function () { warnOnce("steep", "Bratthetskartet fra NVE kunne ikke lastes."); });
  }

  function buildRoutes() {
    if (!routesLayer) return;
    routesLayer.removeAll(); pointsLayer.removeAll();
    routeG = {}; pointG = {};
    var mode = viewMode || S.mode || "3d";
    var rg = [], pg = [];
    S.routes.forEach(function (r) {
      var vis = RR.passes ? RR.passes(r) : true;
      var line = new E.Polyline({ paths: xyPaths(r), spatialReference: SR });
      var g = new E.Graphic({ geometry: line, symbol: routeSymbol(mode, levelColor(r)), attributes: { rid: r.id, kind: "route" }, visible: vis });
      routeG[r.id] = g; rg.push(g);
      var pt = r.park || r.start;
      if (pt && pt.x != null) {
        var kind = r.park ? "park" : "start";
        var pgf = new E.Graphic({
          geometry: new E.Point({ x: pt.x, y: pt.y, spatialReference: SR }),
          symbol: pointSymbol(mode, kind), attributes: { rid: r.id, kind: kind }, visible: vis
        });
        pointG[r.id] = pgf; pg.push(pgf);
      }
    });
    routesLayer.addMany(rg); pointsLayer.addMany(pg);
    updateHighlight(S.selectedId);
  }

  function restyle(mode) {
    S.routes.forEach(function (r) {
      var g = routeG[r.id]; if (g) g.symbol = routeSymbol(mode, levelColor(r));
      var p = pointG[r.id]; if (p) p.symbol = pointSymbol(mode, r.park ? "park" : "start");
    });
    if (locGraphic) locGraphic.symbol = locSymbol(mode);
    updateHighlight(S.selectedId);
  }

  function applyVisibility(ids) {
    var set = {};
    ids.forEach(function (i) { set[i] = true; });
    S.routes.forEach(function (r) {
      var v = !!set[r.id];
      if (routeG[r.id]) routeG[r.id].visible = v;
      if (pointG[r.id]) pointG[r.id].visible = v;
    });
  }

  /* ---------- valgt rute: highlight + puls ---------- */
  function stopPulse() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  function setGlow(k) {
    if (!hl) return;
    var mode = viewMode || "3d";
    var base = mode === "3d" ? 9 : 10;
    hl.glow.symbol = lineSym(mode, rgb(hl.color, 0.22 + 0.4 * k), base + 7 * k);
  }

  function startPulse() {
    stopPulse();
    if (!hl) return;
    if (reduced) { setGlow(0.8); return; }
    var last = 0;
    function tick(t) {
      rafId = requestAnimationFrame(tick);
      if (t - last < 40) return;
      last = t;
      setGlow(0.5 + 0.5 * Math.sin(t / 380));
    }
    rafId = requestAnimationFrame(tick);
  }

  function updateHighlight(id) {
    stopPulse();
    hl = null; topG = null;
    if (!hlLayer) return;
    hlLayer.removeAll(); topLayer.removeAll();
    var r = id != null ? S.byId[id] : null;
    routesLayer.opacity = r ? 0.5 : 1;
    if (!r) return;
    var mode = viewMode || S.mode || "3d";
    var color = levelColor(r);
    var line = new E.Polyline({ paths: xyPaths(r), spatialReference: SR });
    var attrs = { rid: r.id, kind: "route" };
    var edge = new E.Graphic({ geometry: line, symbol: lineSym(mode, [8, 6, 16, 0.78], mode === "3d" ? 15 : 14), attributes: attrs });
    var glow = new E.Graphic({ geometry: line, symbol: lineSym(mode, rgb(color, 0.4), mode === "3d" ? 12 : 12), attributes: attrs });
    var core = new E.Graphic({ geometry: line, symbol: lineSym(mode, rgb(color, 1), mode === "3d" ? 5.6 : 5.2), attributes: attrs });
    hlLayer.addMany([edge, glow, core]);
    hl = { glow: glow, color: color };
    if (r.top && r.top.x != null) {
      var txt = r.navn + (r.topp_moh != null ? " · " + Math.round(r.topp_moh) + " moh" : "");
      var syms = topSymbols(mode, txt);
      var tp = new E.Point({ x: r.top.x, y: r.top.y, spatialReference: SR });
      topLayer.addMany(syms.map(function (s) { return new E.Graphic({ geometry: tp, symbol: s, attributes: { rid: r.id, kind: "top" } }); }));
    }
    startPulse();
  }

  /* ---------- kamera ---------- */
  function goTo(target, opts) {
    if (!view) return Promise.resolve();
    opts = opts || {};
    var o = {};
    ["duration", "easing", "animate", "speedFactor", "maxDuration"].forEach(function (k) { if (opts[k] != null) o[k] = opts[k]; });
    var t = target;
    return view.goTo(t, o).catch(ignoreAbort);
  }

  function zoomToRoute(id) {
    id = id == null ? S.selectedId : Number(id);
    var r = id != null ? S.byId[id] : null;
    if (!r) return Promise.resolve();
    if (!view || !viewReady) { pendingZoom = r.id; return Promise.resolve(); }
    userMoved = true;
    var ext = routeExtent(r);
    if (viewMode === "3d") {
      var h = routeHeading(r);
      lastHeading = h;
      return goTo({ target: ext, heading: h, tilt: TILT }, { duration: reduced ? 0 : 2000, animate: !reduced, easing: "in-out-cubic" });
    }
    return goTo(ext, { duration: reduced ? 0 : 1400, animate: !reduced, easing: "in-out-cubic" });
  }

  function fitAll(animate) {
    var ext = allExtent();
    if (!ext || !view || !viewReady) return Promise.resolve();
    fitted = true;
    if (viewMode === "3d") return goTo({ target: ext, heading: lastHeading, tilt: TILT }, { animate: animate !== false && !reduced, duration: 1800 });
    return goTo(ext, { animate: animate !== false && !reduced, duration: 1200 });
  }

  /* ---------- opprett / riv view ---------- */
  function destroyView() {
    handles.forEach(function (h) { try { h.remove(); } catch (e) { /* ignorer */ } });
    handles = [];
    viewReady = false; hovering = false;
    if (view) {
      try { view.map = null; } catch (e) { /* ignorer */ }
      try { view.destroy(); } catch (e) { /* ignorer */ }
    }
    if (host && host.parentNode) host.parentNode.removeChild(host);
    view = null; host = null; RR.view = null;
  }

  function layerErrorMsg(layer) {
    var id = layer && layer.id;
    if (id === "rr-imagery") return ["img", "Flyfoto kunne ikke vises. Kartet vises uten bakgrunnsbilde."];
    if (id === "rr-terrain") return ["ter", "Terrengdata kunne ikke vises. Kartet vises uten høyde."];
    if (id === "rr-steep") return ["steep", "Bratthetskartet fra NVE kunne ikke vises."];
    return null;
  }

  function createView(mode, carry) {
    host = document.createElement("div");
    host.className = "scene-view scene-view--" + mode;
    mapEl.appendChild(host);
    var c = carry || {};
    var center = c.center || DEFAULT_CENTER;
    var pt = new E.Point({ x: center.x, y: center.y, spatialReference: SR });
    var common = {
      container: host, map: map, spatialReference: SR, popupEnabled: false,
      padding: currentPadding(), ui: { components: ["attribution"] },
      center: pt, scale: c.scale || 220000
    };
    var v;
    if (mode === "3d") {
      var weak = U.lowPower && U.lowPower();
      common.viewingMode = "local";
      common.qualityProfile = weak ? "low" : (S.isMobile ? "medium" : "high");
      common.environment = envFor(theme);
      common.constraints = { altitude: { max: 90000 }, tilt: { max: 84 } };
      v = new E.SceneView(common);
    } else {
      common.constraints = { snapToZoom: false, rotationEnabled: true };
      common.background = { color: BG[theme] };
      v = new E.MapView(common);
    }
    view = v; viewMode = mode;
    handles.push(v.on("layerview-create-error", function (ev) {
      var m = layerErrorMsg(ev.layer);
      console.warn("[scene] layerview-create-error", ev.layer && ev.layer.id, ev.error);
      if (m) warnOnce(m[0], m[1]);
    }));
    return v.when().then(function () {
      if (v !== view) return v;
      if (mode === "3d") {
        var heading = c.heading != null ? c.heading : lastHeading;
        var fit = !c.center && allExtent();
        var p = fit ? v.goTo({ target: fit, heading: heading, tilt: TILT }, { animate: false })
                    : v.goTo({ heading: heading, tilt: TILT }, { animate: false });
        if (fit) fitted = true;
        return p.catch(ignoreAbort).then(function () { return v; });
      }
      if (!c.center) {
        var ext = allExtent();
        if (ext) { fitted = true; return v.goTo(ext, { animate: false }).catch(ignoreAbort).then(function () { return v; }); }
      }
      return v;
    });
  }

  function captureCarry() {
    if (!view || !viewReady) return null;
    try {
      var cen = view.center;
      if (!cen || cen.x == null) return null;
      var out = { center: { x: cen.x, y: cen.y }, scale: view.scale };
      if (viewMode === "3d" && view.camera) out.heading = view.camera.heading;
      if (out.heading != null && isFinite(out.heading)) lastHeading = out.heading;
      return out;
    } catch (e) { return null; }
  }

  function afterReady(v, mode) {
    viewReady = true;
    RR.view = v;
    S.mode = mode;
    var b = document.body;
    b.classList.remove("mode-2d", "mode-3d");
    b.classList.add("mode-" + mode);
    b.dataset.sceneMode = mode;
    var btn = $("btn-mode");
    if (btn) {
      var to = mode === "3d" ? "2D" : "3D";
      var txt = btn.querySelector(".ctl__txt");
      if (txt) txt.textContent = to; else btn.textContent = to;
      btn.setAttribute("aria-label", "Bytt til " + to + "-kart");
      btn.title = "Bytt til " + to + "-kart";
    }
    bindViewEvents(v);
    applyTheme(theme);
    updatePadding();
    RR.emit("view:ready", { view: v, mode: mode });
    if (pendingZoom != null) {
      var id = pendingZoom; pendingZoom = null;
      if (S.selectedId === id) zoomToRoute(id);
    }
  }

  function setMode(mode) {
    mode = mode === "2d" ? "2d" : "3d";
    if (!inited) { S.mode = mode; return Promise.resolve(null); }
    if (switching) { queuedMode = mode; return switchPromise; }
    if (view && viewReady && viewMode === mode) return Promise.resolve(view);

    if (mode === "3d" && U.webglOk && !U.webglOk()) {
      U.toast("3D støttes ikke på denne enheten. Viser 2D-kart.", "error");
      mode = "2d";
      if (view && viewReady && viewMode === "2d") return Promise.resolve(view);
    }
    switching = true;
    var btn = $("btn-mode");
    if (btn) btn.disabled = true;
    var carry = captureCarry();
    destroyView();
    restyle(mode);

    function done(v, m) { afterReady(v, m); return v; }
    switchPromise = createView(mode, carry).then(function (v) { return done(v, mode); }).catch(function (err) {
      console.error("[scene] kunne ikke opprette " + mode + "-visning:", err);
      destroyView();
      if (mode === "3d") {
        U.toast("3D-kartet kunne ikke startes. Viser 2D-kart i stedet.", "error", 7000);
        restyle("2d");
        return createView("2d", carry).then(function (v) { return done(v, "2d"); });
      }
      U.toast("Kartet kunne ikke startes. Last siden på nytt.", "error", 9000);
      return null;
    }).catch(function (err) {
      console.error("[scene]", err);
      U.toast("Kartet kunne ikke startes. Last siden på nytt.", "error", 9000);
      return null;
    }).then(function (v) {
      switching = false;
      if (btn) btn.disabled = false;
      var q = queuedMode; queuedMode = null;
      if (q && q !== viewMode) return setMode(q);
      return v;
    });
    return switchPromise;
  }

  /* ---------- interaksjon på kartet ---------- */
  var HIT_KINDS = { route: 1, park: 1, start: 1, top: 1 };
  function hitRid(res) {
    var arr = (res && res.results) || [];
    for (var i = 0; i < arr.length; i++) {
      var g = arr[i].graphic;
      if (g && g.attributes && g.attributes.rid != null && HIT_KINDS[g.attributes.kind]) return g.attributes.rid;
    }
    return null;
  }
  function hitOpts() { return { include: [pointsLayer, routesLayer, hlLayer, topLayer] }; }

  function bindViewEvents(v) {
    handles.push(v.on("click", function (ev) {
      v.hitTest({ x: ev.x, y: ev.y }, hitOpts()).then(function (res) {
        var rid = hitRid(res);
        if (rid != null) RR.select(rid, { source: "map" });
      }).catch(function () { /* ignorer */ });
    }));
    handles.push(v.on("pointer-move", function (ev) {
      if (ev.pointerType === "touch" || ev.buttons) return;
      var now = performance.now();
      if (hoverBusy || now - hoverLast < 70) return;
      hoverBusy = true; hoverLast = now;
      v.hitTest({ x: ev.x, y: ev.y }, hitOpts()).then(function (res) {
        var on = hitRid(res) != null;
        if (on !== hovering && host) { hovering = on; host.classList.toggle("scene-hover", on); }
      }).catch(function () { /* ignorer */ }).then(function () { hoverBusy = false; });
    }));
    handles.push(v.on("pointer-leave", function () {
      if (hovering && host) { hovering = false; host.classList.remove("scene-hover"); }
    }));
    handles.push(v.on(["drag", "mouse-wheel", "double-click"], function () { userMoved = true; }));
  }

  /* ---------- bratthet ---------- */
  function setSteep(on) {
    S.steepness = !!on;
    if (steepLayer) steepLayer.visible = S.steepness;
    var b = $("btn-steep");
    if (b) {
      b.setAttribute("aria-pressed", String(S.steepness));
      b.title = S.steepness ? "Skjul bratthet" : "Vis bratthet";
    }
    var leg = $("legend");
    if (leg) leg.classList.toggle("scene-legend--nosteep", !S.steepness);
  }

  /* ---------- min posisjon ---------- */
  function locate() {
    var btn = $("btn-locate");
    if (!navigator.geolocation) { U.toast("Nettleseren din støtter ikke posisjon.", "error"); return; }
    if (btn) { btn.setAttribute("aria-busy", "true"); btn.disabled = true; }
    function fin() { if (btn) { btn.removeAttribute("aria-busy"); btn.disabled = false; } }
    navigator.geolocation.getCurrentPosition(function (pos) {
      fin();
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      if (lat < 57.5 || lat > 71.5 || lon < 4 || lon > 31.5) {
        U.toast("Du er utenfor kartområdet (Norge).", "error");
        return;
      }
      var u = toUTM33(lat, lon);
      if (!view || !viewReady) return;
      var pt = new E.Point({ x: u.x, y: u.y, spatialReference: SR });
      locLayer.removeAll();
      locGraphic = new E.Graphic({ geometry: pt, symbol: locSymbol(viewMode), attributes: { kind: "loc" } });
      locLayer.add(locGraphic);
      userMoved = true;
      var ext = new E.Extent({ xmin: u.x - 1800, xmax: u.x + 1800, ymin: u.y - 1800, ymax: u.y + 1800, spatialReference: SR });
      if (viewMode === "3d") goTo({ target: ext, heading: lastHeading, tilt: TILT }, { duration: 1800 });
      else goTo(ext, { duration: 1200 });
    }, function (err) {
      fin();
      var msg = "Fant ikke posisjonen din.";
      if (err && err.code === 1) msg = "Du har ikke gitt tilgang til posisjonen din. Endre det i nettleserinnstillingene.";
      else if (err && err.code === 3) msg = "Det tok for lang tid å finne posisjonen din. Prøv igjen.";
      else if (err && err.code === 2) msg = "Posisjonen din er ikke tilgjengelig akkurat nå.";
      U.toast(msg, "error");
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  /* ---------- tegnforklaring og knapper ---------- */
  var ICONS = {
    locate: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>',
    steep: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 19 11 5l4.2 7.4L17.5 9 21 19z"/><path d="M3 19h18" opacity=".55"/><path d="M7.5 19a4.5 4.5 0 0 0-1.4-3.2" opacity=".8"/></svg>',
    legend: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="6.5" r="1.4" fill="currentColor"/><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="5" cy="17.5" r="1.4" fill="currentColor"/><path d="M10 6.5h10M10 12h10M10 17.5h10"/></svg>'
  };

  var STEEP = [
    ["27–29°", "#f2e600"], ["30–34°", "#f49a1b"], ["35–39°", "#e0241b"],
    ["40–44°", "#a3267f"], ["45–49°", "#2650b0"], ["≥ 50°", "#14121c"]
  ];

  function legendHTML() {
    var lv = (CFG.LEVELS || []).map(function (n) {
      var c = CFG.LEVEL_COLORS[n];
      return '<li><span class="scene-legend__line" style="--c:' + U.esc(c) + '"></span>' + U.esc(n) + '</li>';
    }).join("");
    var st = STEEP.map(function (s) {
      return '<li><span class="scene-legend__sw" style="background:' + s[1] + '"></span>' + s[0] + '</li>';
    }).join("");
    return '<div class="scene-legend__head"><h2 class="scene-legend__title" id="legend-title">Tegnforklaring</h2>' +
      '<button type="button" class="scene-legend__close" aria-label="Lukk tegnforklaring"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
      '<h3 class="scene-legend__sub">Vanskelighetsgrad</h3><ul class="scene-legend__list">' + lv + '</ul>' +
      '<h3 class="scene-legend__sub">Markører</h3><ul class="scene-legend__list">' +
      '<li><span class="scene-legend__pin">P</span>Parkering / start</li>' +
      '<li><span class="scene-legend__line scene-legend__line--sel" style="--c:#00C8FF"></span>Valgt rute (pulserer)</li></ul>' +
      '<div class="scene-legend__steep"><h3 class="scene-legend__sub">Bratthet (NVE)</h3><ul class="scene-legend__list scene-legend__list--grid">' + st + '</ul></div>';
  }

  function setLegend(open) {
    var leg = $("legend"), b = $("btn-legend");
    if (!leg || !b) return;
    leg.hidden = !open;
    b.setAttribute("aria-expanded", String(open));
  }

  function wireControls() {
    var b;
    if ((b = $("btn-mode"))) {
      b.removeAttribute("aria-pressed");
      if (!b.querySelector(".ctl__txt")) { b.innerHTML = '<span class="ctl__txt">' + (S.mode === "3d" ? "2D" : "3D") + '</span>'; }
      b.addEventListener("click", function () { setMode(viewMode === "3d" ? "2d" : "3d"); });
    }
    if ((b = $("btn-locate"))) { b.innerHTML = ICONS.locate; b.addEventListener("click", locate); }
    if ((b = $("btn-steep"))) {
      b.innerHTML = ICONS.steep;
      b.addEventListener("click", function () { setSteep(!S.steepness); });
    }
    if ((b = $("btn-legend"))) {
      b.innerHTML = ICONS.legend;
      b.addEventListener("click", function () { var l = $("legend"); setLegend(!!(l && l.hidden)); });
    }
    var leg = $("legend");
    if (leg) {
      leg.innerHTML = legendHTML();
      leg.setAttribute("role", "region");
      leg.setAttribute("aria-labelledby", "legend-title");
      leg.addEventListener("click", function (e) {
        if (e.target.closest(".scene-legend__close")) { setLegend(false); var lb = $("btn-legend"); if (lb) lb.focus(); }
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var l = $("legend");
      if (l && !l.hidden) {
        var inside = l.contains(document.activeElement);
        setLegend(false);
        if (inside) { var lb = $("btn-legend"); if (lb) lb.focus(); }
      }
    });
  }

  /* ---------- høydeprofil ---------- */
  function resample(pts, maxN) {
    var cum = [0], i;
    for (i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    var total = cum[cum.length - 1];
    if (!(total > 0)) return { pts: pts.slice(0, 2), total: 0 };
    var step = Math.max(25, total / (maxN - 1));
    var n = Math.max(2, Math.ceil(total / step) + 1);
    var out = [], j = 0;
    for (i = 0; i < n; i++) {
      var d = Math.min(total, i * (total / (n - 1)));
      while (j < pts.length - 2 && cum[j + 1] < d) j++;
      var seg = cum[j + 1] - cum[j], f = seg > 0 ? (d - cum[j]) / seg : 0;
      var a = pts[j], b = pts[j + 1];
      var z = (a[2] != null && b[2] != null) ? a[2] + (b[2] - a[2]) * f : null;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, z]);
    }
    return { pts: out, total: total };
  }

  function sampleProfile(route) {
    if (!route || !route.paths) return Promise.resolve([]);
    if (profileCache[route.id]) return profileCache[route.id];
    var flat = [];
    route.paths.forEach(function (p) { p.forEach(function (v) {
      var l = flat[flat.length - 1];
      if (!l || l[0] !== v[0] || l[1] !== v[1]) flat.push([v[0], v[1], v.length > 2 && isFinite(v[2]) ? v[2] : null]);
    }); });
    if (flat.length < 2) return Promise.resolve([]);
    var rs = resample(flat, 300);
    var pts = rs.pts, total = rs.total;
    var dists = pts.map(function (_, i) { return total * i / (pts.length - 1); });

    function fallback() {
      var hasZ = pts.every(function (p) { return p[2] != null; }) && pts.some(function (p) { return Math.abs(p[2]) > 1; });
      var z0 = route.start_moh != null ? +route.start_moh : null;
      var z1 = route.topp_moh != null ? +route.topp_moh : null;
      return pts.map(function (p, i) {
        var z;
        if (hasZ) z = p[2];
        else if (z0 != null && z1 != null) z = z0 + (z1 - z0) * (total ? dists[i] / total : 0);
        else z = z1 != null ? z1 : (z0 != null ? z0 : 0);
        return { d: Math.round(dists[i]), z: Math.round(z * 10) / 10 };
      });
    }

    var prom;
    try {
      var poly = new E.Polyline({ paths: [pts.map(function (p) { return [p[0], p[1]]; })], spatialReference: SR });
      var g = RR.ground || ground;
      prom = g.load().then(function () {
        return g.queryElevation(poly, { demResolution: "finest-contiguous" });
      }).then(function (res) {
        var path = res && res.geometry && res.geometry.paths && res.geometry.paths[0];
        if (!path || path.length !== pts.length) throw new Error("uventet høyderesultat");
        var out = path.map(function (v, i) {
          if (v.length < 3 || !isFinite(v[2])) throw new Error("mangler høyde");
          return { d: Math.round(dists[i]), z: Math.round(v[2] * 10) / 10 };
        });
        return out;
      }).catch(function (e) {
        console.warn("[scene] høydeprofil – bruker reserveløsning:", e && e.message);
        return fallback();
      });
    } catch (e) {
      prom = Promise.resolve(fallback());
    }
    profileCache[route.id] = prom;
    return prom;
  }

  /* ---------- init ---------- */
  function init() {
    if (inited) return;
    mapEl = $("map");
    if (!mapEl || !E.Map) { console.error("[scene] mangler #map eller ArcGIS-klasser"); return; }
    inited = true;
    try {
      var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      reduced = mq.matches;
      var h = function (e) { reduced = e.matches; if (hl) startPulse(); };
      if (mq.addEventListener) mq.addEventListener("change", h); else if (mq.addListener) mq.addListener(h);
    } catch (e) { /* ignorer */ }

    var dt = document.documentElement.dataset.theme;
    theme = (S.theme === "light" || dt === "light") ? "light" : "dark";

    wireControls();
    setSteep(S.steepness !== false);

    try { buildMap(); } catch (e) {
      console.error("[scene] kunne ikke bygge kartet:", e);
      U.toast("Kartet kunne ikke startes. Last siden på nytt.", "error", 9000);
      return;
    }
    if (S.routes.length) buildRoutes();

    RR.on("data:routes", function () {
      buildRoutes();
      if (view && viewReady && !fitted && !userMoved && S.selectedId == null) fitAll(true);
      if (view && viewReady && S.selectedId != null) zoomToRoute(S.selectedId);
    });
    RR.on("filter", function (d) { applyVisibility((d && d.ids) || []); });
    RR.on("select", function (d) {
      updateHighlight(d.id);
      updatePadding();
      if (d.id != null && d.source !== "flyover") zoomToRoute(d.id);
    });
    RR.on("theme", function (t) { applyTheme(t); });
    // Under fly over blir den brede gløden for dominerende nær kameraet
    RR.on("fly:start", function () { if (hlLayer) hlLayer.visible = false; if (routesLayer) routesLayer.opacity = 1; });
    RR.on("fly:stop", function () { if (hlLayer) hlLayer.visible = true; if (routesLayer && S.selectedId != null) routesLayer.opacity = 0.5; });
    RR.on("mode", function (m) {
      if ((m === "2d" || m === "3d") && (m !== viewMode || switching)) setMode(m);
    });
    RR.on("mobile", function () { updatePadding(); });

    setMode(S.mode === "2d" ? "2d" : "3d");
  }

  RR.modules.scene = {
    init: init,
    setMode: setMode,
    goTo: goTo,
    zoomToRoute: zoomToRoute,
    sampleProfile: sampleProfile
  };
})();
