/* Oppstart: laster ArcGIS-klasser, henter ruter + parkering, starter modulene. Lastes sist. */
(function () {
  "use strict";
  var RR = window.RR, CFG = RR.CFG, U = RR.util, S = RR.state;

  var ESRI = {
    Map: "esri/Map",
    SceneView: "esri/views/SceneView",
    MapView: "esri/views/MapView",
    Basemap: "esri/Basemap",
    TileLayer: "esri/layers/TileLayer",
    ElevationLayer: "esri/layers/ElevationLayer",
    MapImageLayer: "esri/layers/MapImageLayer",
    GraphicsLayer: "esri/layers/GraphicsLayer",
    Graphic: "esri/Graphic",
    Ground: "esri/Ground",
    Point: "esri/geometry/Point",
    Polyline: "esri/geometry/Polyline",
    Extent: "esri/geometry/Extent",
    SpatialReference: "esri/geometry/SpatialReference",
    Camera: "esri/Camera",
    geometryEngine: "esri/geometry/geometryEngine",
    reactiveUtils: "esri/core/reactiveUtils",
    esriConfig: "esri/config"
  };

  function q(url, outSR, fields) {
    return url + "/query?where=1%3D1&outFields=" + encodeURIComponent(fields || "*") +
      "&returnGeometry=true&returnZ=true&outSR=" + outSR + "&f=json";
  }

  function loadData() {
    return Promise.all([
      U.getJSON(q(CFG.ROUTES_URL, CFG.WKID)),
      U.getJSON(q(CFG.ROUTES_URL, 4326)).catch(function () { return null; }),
      U.getJSON(q(CFG.PARKING_URL, CFG.WKID)).catch(function () { return null; }),
      U.getJSON(q(CFG.PARKING_URL, 4326)).catch(function () { return null; })
    ]).then(function (res) {
      var rj = res[0], rg = res[1], pj = res[2], pg = res[3];
      if (!rj || !rj.features) throw new Error("Ingen ruter");
      var oidR = rj.objectIdFieldName || "OBJECTID";
      var geo4326 = {};
      if (rg && rg.features) rg.features.forEach(function (f) {
        var id = f.attributes[rg.objectIdFieldName || "OBJECTID"];
        var p = f.geometry && f.geometry.paths; if (!p || !p.length) return;
        var a = p[0][0], z = p[p.length - 1], b = z[z.length - 1];
        geo4326[id] = { start: { lon: a[0], lat: a[1] }, top: { lon: b[0], lat: b[1] } };
      });

      var park = {};
      if (pj && pj.features) {
        var oidP = pj.objectIdFieldName || "OBJECTID";
        var pll = {};
        if (pg && pg.features) pg.features.forEach(function (f) {
          if (f.geometry) pll[f.attributes[pg.objectIdFieldName || "OBJECTID"]] = { lon: f.geometry.x, lat: f.geometry.y };
        });
        pj.features.forEach(function (f) {
          var a = f.attributes, g = f.geometry; if (!g || a.rute_id == null) return;
          var ll = pll[a[oidP]] || {};
          park[a.rute_id] = {
            x: g.x, y: g.y, z: g.z, lat: ll.lat, lon: ll.lon,
            est_tid_tekst: a.est_tid_tekst, minutes: U.parseMinutes(a.est_tid_tekst),
            himmelretning: a.himmelretning, himmelretning_grader: a.himmelretning_grader,
            forhold_tips: a.forhold_tips, nav_url: a.nav_url, yr_url: a.yr_url
          };
        });
      }

      S.routes = rj.features.filter(function (f) { return f.geometry && f.geometry.paths && f.geometry.paths.length; })
        .map(function (f) {
          var a = f.attributes, id = a[oidR], paths = f.geometry.paths;
          var last = paths[paths.length - 1], top = last[last.length - 1], first = paths[0][0];
          var ll = geo4326[id] || {};
          return {
            id: id,
            navn: a.navn || "Uten navn",
            topp_moh: a.topp_moh, start_moh: a.start_moh,
            tur_km: a.tur_km, opp_km: a.opp_km, hoydemeter: a.hoydemeter,
            maks_bratthet: a.maks_bratthet, eksponert_m: a.eksponert_m,
            niva: CFG.LEVELS.indexOf(a.niva) !== -1 ? a.niva : "Middels",
            fellebytte: a.fellebytte,
            paths: paths,                        // [[ [x,y(,z)], ... ]] i EPSG:25833
            start: { x: first[0], y: first[1], lat: ll.start && ll.start.lat, lon: ll.start && ll.start.lon },
            top: { x: top[0], y: top[1], lat: ll.top && ll.top.lat, lon: ll.top && ll.top.lon },
            park: park[id] || null,
            attributes: a
          };
        });
      S.byId = {};
      S.routes.forEach(function (r) { S.byId[r.id] = r; });
      RR.emit("data:routes", S.routes);
      RR.applyFilter();
    });
  }

  function initModules(names) {
    names.forEach(function (n) {
      var m = RR.modules[n];
      if (!m || !m.init) return;
      try { m.init(); } catch (e) { console.error("[RR] init " + n + " feilet:", e); }
    });
  }

  function hideLoader() {
    var l = document.getElementById("loader");
    if (l) { l.classList.add("loader--out"); setTimeout(function () { l.hidden = true; }, 500); }
  }

  function start() {
    var mql = window.matchMedia("(max-width: " + (CFG.MOBILE_BP - 1) + "px)");
    S.isMobile = mql.matches;
    var addL = mql.addEventListener ? "addEventListener" : "addListener";
    mql[addL]("change", function (e) { S.isMobile = e.matches; RR.emit("mobile", e.matches); });

    var params = new URLSearchParams(location.search);
    var wanted = params.get("mode");
    S.mode = wanted === "2d" ? "2d" : wanted === "3d" ? "3d" :
      (!U.webglOk() || (S.isMobile && U.lowPower())) ? "2d" : "3d";

    // Moduler uten ArcGIS-avhengighet kan starte med en gang
    initModules(["mobile", "panel", "card", "forhold"]);

    var dataP = loadData().catch(function (e) {
      console.error(e);
      U.toast("Fikk ikke hentet rutene. Sjekk nettet og last siden på nytt.", "error", 10000);
      RR.emit("data:error", e);
    });

    if (typeof window.require !== "function") {
      U.toast("Kartet kunne ikke lastes. Prøv igjen litt senere.", "error", 10000);
      hideLoader();
      return;
    }
    var keys = Object.keys(ESRI);
    window.require(keys.map(function (k) { return ESRI[k]; }), function () {
      var args = arguments;
      keys.forEach(function (k, i) { RR.esri[k] = args[i]; });
      initModules(["scene", "flyover"]);
      dataP.then(function () {
        var id = params.get("tur");
        if (id != null && S.byId[+id]) RR.select(+id, { source: "url" });
        hideLoader();
      });
    }, function (err) {
      console.error(err);
      U.toast("Kartet kunne ikke lastes. Prøv igjen litt senere.", "error", 10000);
      hideLoader();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
