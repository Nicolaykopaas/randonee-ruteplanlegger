/* Randonee ruteplanlegger – felles konfig, state og hendelser.
   Lastes først av alle skript. Alt deles via window.RR. */
(function () {
  "use strict";
  var B = "https://services1.arcgis.com/DIcffHalFljSYvfk/arcgis/rest/services";

  var CFG = {
    ROUTES_URL: B + "/Randonee_ruter_Romsdal/FeatureServer/0",
    PARKING_URL: B + "/Randonee_start_parkering/FeatureServer/0",
    REPORTS_URL: B + "/survey123_04f51183fd94431aa2fa22863d3b8cfb_results/FeatureServer/0",
    REPORT_FORM_URL: "https://arcg.is/0CyvLX3",
    STEEPNESS_URL: "https://kart.nve.no/enterprise/rest/services/Bratthet/MapServer",
    STEEPNESS_OPACITY: 0.4,
    IMAGERY_URL: "https://services.geodataonline.no/arcgis/rest/services/Geocache_UTM33_EUREF89/GeocacheBilder/MapServer",
    TERRAIN_URL: "https://services.geodataonline.no/arcgis/rest/services/Geocache_UTM33_EUREF89/GeocacheTerreng/ImageServer",
    WKID: 25833,
    AVALANCHE_URL: function (fra, til) {
      return "https://api01.nve.no/hydrology/forecast/avalanche/v6.3.0/api/AvalancheWarningByRegion/Simple/3023/1/" + fra + "/" + til;
    },
    VARSOM_URL: "https://varsom.no/snoskred/varsling/",
    MET_URL: function (lat, lon, moh) {
      return "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" + lat.toFixed(4) +
        "&lon=" + lon.toFixed(4) + "&altitude=" + Math.round(moh || 0);
    },
    LEVELS: ["Lett", "Middels", "Krevende"],
    ASPECTS: ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"],
    MAX_START: 800,
    LEVEL_COLORS: { Lett: "#00C8FF", Middels: "#FF3EDB", Krevende: "#FFFFFF" },
    DANGER_COLORS: ["#8A8A96", "#56B528", "#FFE800", "#F18700", "#E61E1E", "#1A1A1A"],
    DANGER_NAMES: ["Ikke vurdert", "Liten", "Moderat", "Betydelig", "Stor", "Meget stor"],
    ACCENT: ["#00C8FF", "#FF3EDB"],
    MAX_KM: 15,
    MAX_HM: 1100,
    MOBILE_BP: 768,
    FLY_SECONDS: 20,
    STORAGE: { theme: "rr.theme", welcomed: "rr.welcomed" }
  };

  /* ---------- hendelser ---------- */
  var handlers = {};
  function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }
  function off(evt, fn) { var h = handlers[evt]; if (h) handlers[evt] = h.filter(function (f) { return f !== fn; }); }
  function emit(evt, data) {
    (handlers[evt] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { console.error("[RR] feil i '" + evt + "':", e); }
    });
  }

  /* ---------- state ---------- */
  var state = {
    routes: [],            // se app.js for objektform
    byId: {},              // id -> rute
    filter: { maxKm: CFG.MAX_KM, maxHm: CFG.MAX_HM, niva: CFG.LEVELS.slice(),
      aspects: CFG.ASPECTS.slice(),   // himmelretning på nedkjøringen
      minStart: 0,                    // min. starthøyde (moh)
      avoidExposed: false },          // skjul >300 m eksponert når faregrad ≥ 3
    sort: "navn",          // navn | km | hm | tid
    visibleIds: [],        // ids som passerer filteret, i sortert rekkefølge
    selectedId: null,
    danger: null,          // { level, name, color, days:[{date,label,level,name,text}] }
    mode: "3d",            // 3d | 2d
    theme: "dark",         // dark | light
    steepness: true,
    flying: false,
    isMobile: false
  };

  /* ---------- filter / valg ---------- */
  function minutes(r) { return r && r.park && r.park.minutes != null ? r.park.minutes : Infinity; }
  var collator = new Intl.Collator("nb", { numeric: true });
  var SORTERS = {
    navn: function (a, b) { return collator.compare(a.navn, b.navn); },
    km: function (a, b) { return (a.tur_km || 0) - (b.tur_km || 0); },
    hm: function (a, b) { return (a.hoydemeter || 0) - (b.hoydemeter || 0); },
    tid: function (a, b) { return minutes(a) - minutes(b); }
  };

  /* Himmelretning (8 sektorer) for nedkjøringen, fra grader eller tekst. null hvis ukjent. */
  function aspectOf(r) {
    var p = r && r.park;
    if (!p) return null;
    if (p.himmelretning_grader != null && isFinite(p.himmelretning_grader)) {
      return CFG.ASPECTS[Math.round(((+p.himmelretning_grader % 360) + 360) % 360 / 45) % 8];
    }
    var t = String(p.himmelretning || "").toUpperCase().replace("OE", "Ø").trim();
    return CFG.ASPECTS.indexOf(t) !== -1 ? t : null;
  }

  /* Mye skredterreng på en dag med faregrad ≥ 3 */
  function isRisky(r) {
    var d = state.danger;
    return !!(d && d.level >= 3 && r && r.eksponert_m > 300);
  }

  function passes(r) {
    var f = state.filter;
    if (r.tur_km != null && r.tur_km > f.maxKm + 1e-9) return false;
    if (r.hoydemeter != null && r.hoydemeter > f.maxHm + 1e-9) return false;
    if (f.niva.indexOf(r.niva) === -1) return false;
    if (f.minStart > 0 && r.start_moh != null && r.start_moh < f.minStart) return false;
    if (f.aspects && f.aspects.length < CFG.ASPECTS.length) {
      var a = aspectOf(r);
      if (a && f.aspects.indexOf(a) === -1) return false;
    }
    if (f.avoidExposed && isRisky(r)) return false;
    return true;
  }

  function applyFilter() {
    var list = state.routes.filter(passes).sort(SORTERS[state.sort] || SORTERS.navn);
    state.visibleIds = list.map(function (r) { return r.id; });
    emit("filter", { ids: state.visibleIds.slice(), filter: state.filter, sort: state.sort });
  }

  function setFilter(partial) {
    Object.keys(partial || {}).forEach(function (k) { state.filter[k] = partial[k]; });
    applyFilter();
  }

  function setSort(key) { if (SORTERS[key]) { state.sort = key; applyFilter(); } }

  function select(id, opts) {
    id = id == null ? null : Number(id);
    if (id != null && !state.byId[id]) id = null;
    if (state.selectedId === id && !(opts && opts.force)) return;
    state.selectedId = id;
    try {
      var u = new URL(location.href);
      if (id == null) u.searchParams.delete("tur"); else u.searchParams.set("tur", id);
      history.replaceState(null, "", u.toString());
    } catch (e) { /* ignorer */ }
    emit("select", { id: id, route: id == null ? null : state.byId[id], source: opts && opts.source });
  }

  function shareUrl(id) {
    var u = new URL(location.href);
    u.search = "";
    if (id != null) u.searchParams.set("tur", id);
    return u.toString();
  }

  /* ---------- hjelpere ---------- */
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val);
    } catch (e) { return null; }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function getJSON(url, opts) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var ms = (opts && opts.timeout) || 15000;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, ms) : null;
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      if (j && j.error) throw new Error(j.error.message || "Tjenestefeil");
      return j;
    }).finally(function () { if (t) clearTimeout(t); });
  }

  /* Dato i Oslo-tid: { date:"YYYY-MM-DD", hour:n } */
  var osloFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  function oslo(d) {
    var o = {};
    osloFmt.formatToParts(d || new Date()).forEach(function (p) { o[p.type] = p.value; });
    return { date: o.year + "-" + o.month + "-" + o.day, hour: +o.hour };
  }
  function addDays(s, n) {
    var p = s.split("-");
    return new Date(Date.UTC(+p[0], p[1] - 1, +p[2] + n, 12)).toISOString().slice(0, 10);
  }
  var DAG = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
  function dayName(s) {
    var p = s.slice(0, 10).split("-");
    return DAG[new Date(Date.UTC(+p[0], p[1] - 1, +p[2], 12)).getUTCDay()];
  }
  function fmtKm(km) { return km == null ? "–" : (Math.round(km * 10) / 10).toLocaleString("nb-NO") + " km"; }
  function fmtHm(hm) { return hm == null ? "–" : Math.round(hm).toLocaleString("nb-NO") + " hm"; }

  /* «3 t 15 min», «ca. 2–3 t» osv. -> minutter (for sortering) */
  function parseMinutes(txt) {
    if (!txt) return null;
    var s = String(txt).toLowerCase().replace(",", ".");
    var h = s.match(/(\d+(?:\.\d+)?)\s*(?:t|h)/), m = s.match(/(\d+)\s*min/), hm = s.match(/(\d+):(\d{2})/);
    if (hm) return (+hm[1]) * 60 + (+hm[2]);
    if (!h && !m) { var n = parseFloat(s); return isNaN(n) ? null : Math.round(n * 60); }
    return Math.round((h ? parseFloat(h[1]) * 60 : 0) + (m ? +m[1] : 0));
  }

  function dangerLevel(x) { var n = parseInt(x, 10); return n >= 1 && n <= 5 ? n : 0; }

  /* Feilmelding/varsel nederst – kind: "info" | "error" */
  function toast(msg, kind, ms) {
    var host = document.getElementById("toasts");
    if (!host) { console.warn(msg); return; }
    var el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " toast--error" : "");
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () { el.classList.add("toast--out"); setTimeout(function () { el.remove(); }, 400); }, ms || 5000);
  }

  function webglOk() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGL2RenderingContext && c.getContext("webgl2"));
    } catch (e) { return false; }
  }

  /* Svak enhet? Brukes for å falle tilbake til 2D på mobil. */
  function lowPower() {
    var mem = navigator.deviceMemory, cores = navigator.hardwareConcurrency;
    return (mem && mem < 4) || (cores && cores < 4) || !webglOk();
  }

  // «Unngå skredterreng» avhenger av dagens faregrad
  on("danger", function () { if (state.filter.avoidExposed && state.routes.length) applyFilter(); });

  window.RR = {
    CFG: CFG,
    state: state,
    esri: {},      // ArcGIS-klasser fylles inn av app.js (Map, SceneView, MapView, ...)
    view: null,    // aktiv view (SceneView eller MapView), settes av scene.js
    ground: null,  // Ground med terreng – settes av scene.js, brukes til høydeprofil
    on: on, off: off, emit: emit,
    setFilter: setFilter, setSort: setSort, applyFilter: applyFilter, passes: passes,
    select: select, shareUrl: shareUrl,
    util: {
      store: store, esc: esc, getJSON: getJSON, oslo: oslo, addDays: addDays, dayName: dayName,
      fmtKm: fmtKm, fmtHm: fmtHm, parseMinutes: parseMinutes, dangerLevel: dangerLevel,
      toast: toast, webglOk: webglOk, lowPower: lowPower,
      aspectOf: aspectOf, isRisky: isRisky
    },
    modules: {}    // hver modul registrerer { init() } her
  };
})();
