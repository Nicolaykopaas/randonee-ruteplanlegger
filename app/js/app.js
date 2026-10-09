/* Oppstart: laster ArcGIS-klasser, henter ruter + parkering, starter modulene. Lastes sist. */
(function () {
  "use strict";
  var RR = window.RR, CFG = RR.CFG, U = RR.util, S = RR.state;

  /* ArcGIS-klasser. Kjernen lastes ved oppstart; visningsklassen som ikke trengs lastes først ved behov. */
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
    reactiveUtils: "esri/core/reactiveUtils",
    esriConfig: "esri/config"
  };

  /* Last ArcGIS-klasser ved behov → Promise. Brukes av scene.js for MapView/SceneView. */
  RR.loadEsri = function (keys) {
    keys = keys.filter(function (k) { return !RR.esri[k] && ESRI[k]; });
    if (!keys.length) return Promise.resolve(RR.esri);
    return whenRequire().then(function () {
      return new Promise(function (resolve, reject) {
        window.require(keys.map(function (k) { return ESRI[k]; }), function () {
          var args = arguments;
          keys.forEach(function (k, i) { RR.esri[k] = args[i]; });
          resolve(RR.esri);
        }, reject);
      });
    });
  };

  /* ArcGIS-skriptet lastes async fra <head> – vent til AMD-lasteren finnes */
  function whenRequire() {
    if (typeof window.require === "function") return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var el = document.getElementById("esri-js");
      if (!el) return reject(new Error("Mangler ArcGIS-skript"));
      el.addEventListener("load", function () { resolve(); });
      el.addEventListener("error", function () { reject(new Error("ArcGIS-skriptet feilet")); });
    });
  }

  function q(url, outSR, fields) {
    return url + "/query?where=1%3D1&outFields=" + encodeURIComponent(fields || "*") +
      "&returnGeometry=true&returnZ=true&outSR=" + outSR + "&f=json";
  }

  /* Liten cache (10 min) så nye sidevisninger slipper å vente på tjenesten */
  function cached(url) {
    var key = "rr.q:" + url;
    try {
      var c = JSON.parse(sessionStorage.getItem(key));
      if (c && Date.now() - c.t < 6e5) return Promise.resolve(c.d);
    } catch (e) { /* ignorer */ }
    return U.getJSON(url).then(function (d) {
      try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), d: d })); } catch (e) { /* full/blokkert */ }
      return d;
    });
  }

  function loadData() {
    return Promise.all([
      cached(q(CFG.ROUTES_URL, CFG.WKID)),
      cached(q(CFG.PARKING_URL, CFG.WKID)).catch(function () { return null; })
    ]).then(function (res) {
      var rj = res[0], pj = res[1];
      if (!rj || !rj.features) throw new Error("Ingen ruter");
      var oidR = rj.objectIdFieldName || "OBJECTID";
      var park = {};
      if (pj && pj.features) {
        pj.features.forEach(function (f) {
          var a = f.attributes, g = f.geometry; if (!g || a.rute_id == null) return;
          park[a.rute_id] = {
            x: g.x, y: g.y, z: g.z,
            est_tid_tekst: a.est_tid_tekst, minutes: a.est_tid_min != null ? a.est_tid_min : U.parseMinutes(a.est_tid_tekst),
            topp_lat: a.topp_lat, topp_lon: a.topp_lon,
            himmelretning: a.himmelretning, himmelretning_grader: a.himmelretning_grader,
            forhold_tips: a.forhold_tips, nav_url: a.nav_url, yr_url: a.yr_url
          };
        });
      }

      S.routes = rj.features.filter(function (f) { return f.geometry && f.geometry.paths && f.geometry.paths.length; })
        .map(function (f) {
          var a = f.attributes, id = a[oidR], paths = f.geometry.paths;
          var last = paths[paths.length - 1], top = last[last.length - 1], first = paths[0][0];
          var pk = park[id];
          return {
            id: id,
            navn: a.navn || "Uten navn",
            topp_moh: a.topp_moh, start_moh: a.start_moh,
            tur_km: a.tur_km, opp_km: a.opp_km, hoydemeter: a.hoydemeter,
            maks_bratthet: a.maks_bratthet, eksponert_m: a.eksponert_m,
            niva: CFG.LEVELS.indexOf(a.niva) !== -1 ? a.niva : "Middels",
            fellebytte: a.fellebytte,
            paths: paths,                        // [[ [x,y(,z)], ... ]] i EPSG:25833
            start: { x: first[0], y: first[1] },
            top: { x: top[0], y: top[1], lat: pk && pk.topp_lat, lon: pk && pk.topp_lon },
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
    initModules(["mobile", "panel", "card", "forhold", "search", "turfinner"]);

    var dataP = loadData().then(function () {
      var id = params.get("tur");
      if (id != null && S.byId[+id]) RR.select(+id, { source: "url" });
    }).catch(function (e) {
      console.error(e);
      U.toast("Fikk ikke hentet rutene. Sjekk nettet og last siden på nytt.", "error", 10000);
      RR.emit("data:error", e);
    });
    // Ikke vent på kartmotoren – panelet er nyttig med en gang
    dataP.then(hideLoader);
    setTimeout(hideLoader, 6000);

    var skip = S.mode === "3d" ? "MapView" : "SceneView";
    RR.loadEsri(Object.keys(ESRI).filter(function (k) { return k !== skip; })).then(function () {
      initModules(["scene", "flyover"]);
    }).catch(function (err) {
      console.error(err);
      U.toast("Kartet kunne ikke lastes. Prøv igjen litt senere.", "error", 10000);
      hideLoader();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
