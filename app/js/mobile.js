/* Randonee ruteplanlegger – tema, faner, velkomst og mobil bunnark. */
(function () {
  "use strict";
  var RR = window.RR, CFG = RR.CFG, U = RR.util, S = RR.state;

  var SHEETS = ["min", "mid", "max"];
  var SHEET_LABEL = { min: "lav", mid: "middels", max: "høy" };
  var MIN_PX = 104;
  var TABS = ["turer", "forhold"];

  var inited = false;
  var tab = "turer";
  var sheet = "mid";
  var curPx = MIN_PX;
  var dragging = false;
  var suppressClick = false;
  var countEl = null;
  var handles = [];
  var welcomeState = null;

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ---------------------------------------------------------------- Tema */
  var ICON_SUN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  var ICON_MOON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function applyTheme(t) {
    S.theme = t;
    document.documentElement.setAttribute("data-theme", t);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#eef1f7" : "#0d0b16");

    // ArcGIS-widgettema følger appens tema
    var link = $("esri-theme");
    if (link) {
      var h = link.getAttribute("href") || "";
      var n = h.replace(/\/themes\/(?:dark|light)\//, "/themes/" + t + "/");
      if (n !== h) link.setAttribute("href", n);
    }

    var btn = $("btn-theme");
    if (btn) {
      var label = t === "light" ? "Bytt til mørk modus" : "Bytt til lys modus";
      btn.innerHTML = t === "light" ? ICON_MOON : ICON_SUN;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    }
  }

  function setTheme(t) {
    if (t !== "light" && t !== "dark") return;
    var changed = t !== S.theme;
    applyTheme(t);
    U.store(CFG.STORAGE.theme, t);
    if (changed) RR.emit("theme", t);
  }

  function initTheme() {
    var saved = U.store(CFG.STORAGE.theme);
    applyTheme(saved === "light" ? "light" : "dark");
    var btn = $("btn-theme");
    if (btn) btn.addEventListener("click", function () {
      setTheme(S.theme === "light" ? "dark" : "light");
    });
  }

  /* --------------------------------------------------------------- Faner */
  function selectTab(name, silent) {
    if (TABS.indexOf(name) === -1) return;
    TABS.forEach(function (n) {
      var b = $("tab-" + n), p = $("pane-" + n), on = n === name;
      if (b) { b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; }
      if (p) p.hidden = !on;
    });
    var changed = name !== tab;
    tab = name;
    S.tab = name;
    if (changed) {
      var sc = document.querySelector("#left .panel-scroll");
      if (sc) sc.scrollTop = 0;
      if (!silent) RR.emit("tab", name);
    }
  }

  function initTabs() {
    TABS.forEach(function (n, i) {
      var b = $("tab-" + n);
      if (!b) return;
      b.addEventListener("click", function () {
        selectTab(n);
        if (S.isMobile && sheet === "min") setSheet("mid");
      });
      b.addEventListener("keydown", function (e) {
        var j = -1;
        if (e.key === "ArrowRight") j = (i + 1) % TABS.length;
        else if (e.key === "ArrowLeft") j = (i - 1 + TABS.length) % TABS.length;
        else if (e.key === "Home") j = 0;
        else if (e.key === "End") j = TABS.length - 1;
        if (j < 0) return;
        e.preventDefault();
        selectTab(TABS[j]);
        var nb = $("tab-" + TABS[j]);
        if (nb) nb.focus();
      });
    });
    selectTab("turer", true);
    RR.on("tab", function (name) { selectTab(name, true); });
  }

  /* ------------------------------------------------------------ Velkomst */
  var INERT_IDS = ["map", "left", "right", "controls", "legend", "flybar", "danger-mini"];

  function showWelcome() {
    var w = $("welcome");
    if (!w) return;
    w.innerHTML =
      '<div class="welcome__card glass" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-desc" tabindex="-1">' +
        '<svg class="welcome__logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
          '<defs><linearGradient id="welcome-g" x1="0" x2="1"><stop offset="0" stop-color="#00C8FF"/><stop offset="1" stop-color="#FF3EDB"/></linearGradient></defs>' +
          '<path d="M2 27 13 8l5 8 3-4 9 15z" fill="url(#welcome-g)"/></svg>' +
        '<h2 class="welcome__title grad-text" id="welcome-title">Velkommen til Randonee ruteplanlegger</h2>' +
        '<p class="welcome__lead" id="welcome-desc">Finn toppturer på ski i Romsdal, se rutene i 3D, sjekk skredfare og vær.</p>' +
        '<p class="welcome__safety">Rutene er beregnet automatisk (maks 30° helning) og ikke kvalitetssikret. Turer i fjellet skjer på egen risiko – sjekk skredvarselet på <a href="' +
          U.esc(CFG.VARSOM_URL) + '" target="_blank" rel="noopener noreferrer">varsom.no</a>.</p>' +
        '<div class="welcome__actions"><button type="button" class="btn btn--primary" id="welcome-ok">Jeg forstår – vis kartet</button></div>' +
      '</div>';

    var inerted = [];
    INERT_IDS.forEach(function (id) {
      var el = $(id);
      if (el && !el.hasAttribute("inert")) { el.setAttribute("inert", ""); inerted.push(el); }
    });

    var card = w.querySelector(".welcome__card");
    var ok = $("welcome-ok");

    function focusables() {
      return Array.prototype.slice.call(card.querySelectorAll("a[href], button:not([disabled])"));
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      var list = focusables();
      if (!list.length) { e.preventDefault(); return; }
      var first = list[0], last = list[list.length - 1], a = document.activeElement;
      if (!card.contains(a)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }
    function close() {
      document.removeEventListener("keydown", onKey, true);
      welcomeState = null;
      U.store(CFG.STORAGE.welcomed, "1");
      inerted.forEach(function (el) { el.removeAttribute("inert"); });
      w.hidden = true;
      w.innerHTML = "";
      var target = $("left");
      try { (target || document.body).focus({ preventScroll: true }); } catch (e) { /* ignorer */ }
    }

    welcomeState = { close: close };
    ok.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    w.hidden = false;
    ok.focus();
  }

  function initWelcome() {
    if (U.store(CFG.STORAGE.welcomed)) return;
    showWelcome();
  }

  /* ------------------------------------------------------------ Bunnark */
  function heights() {
    var H = window.innerHeight || document.documentElement.clientHeight || 700;
    return {
      min: MIN_PX,
      mid: Math.max(MIN_PX + 60, Math.round(H * 0.5)),
      max: Math.max(MIN_PX + 120, Math.round(H * 0.88))
    };
  }

  function sheetEls() { return [$("left"), $("right")]; }

  function setPx(px) {
    curPx = px;
    var v = Math.round(px) + "px";
    sheetEls().forEach(function (el) { if (el) el.style.setProperty("--sheet-h", v); });
    document.documentElement.style.setProperty("--sheet-h", v);
  }

  function clearPx() {
    sheetEls().forEach(function (el) { if (el) el.style.removeProperty("--sheet-h"); });
    document.documentElement.style.removeProperty("--sheet-h");
  }

  function updateHandles() {
    handles.forEach(function (h) {
      h.setAttribute("aria-label", "Panelhøyde: " + SHEET_LABEL[sheet] + ". Trykk for å endre.");
      h.setAttribute("aria-expanded", sheet === "min" ? "false" : "true");
    });
    document.body.classList.toggle("sheet-min", !!S.isMobile && sheet === "min" && !dragging);
  }

  function setSheet(h) {
    if (SHEETS.indexOf(h) === -1) return;
    var changed = h !== sheet;
    sheet = h;
    S.sheet = h;
    if (S.isMobile) setPx(heights()[h]);
    updateHandles();
    if (changed) RR.emit("sheet", h);
  }

  function cycle() { setSheet(SHEETS[(SHEETS.indexOf(sheet) + 1) % SHEETS.length]); }
  function step(d) { setSheet(SHEETS[clamp(SHEETS.indexOf(sheet) + d, 0, SHEETS.length - 1)]); }

  function nearest(px) {
    var hs = heights(), best = "min", bd = Infinity;
    SHEETS.forEach(function (n) {
      var d = Math.abs(hs[n] - px);
      if (d < bd) { bd = d; best = n; }
    });
    return best;
  }

  function bindDrag(el, isHandle) {
    var st = null;

    function down(e) {
      if (!S.isMobile) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      st = { id: e.pointerId, y0: e.clientY, h0: curPx, moved: false, pts: [{ t: e.timeStamp, y: e.clientY }] };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignorer */ }
    }
    function move(e) {
      if (!st || e.pointerId !== st.id) return;
      var dy = st.y0 - e.clientY;
      if (!st.moved) {
        if (Math.abs(dy) < 6) return;
        st.moved = true;
        dragging = true;
        document.body.classList.add("sheet-dragging");
        document.body.classList.remove("sheet-min");
      }
      var hs = heights();
      setPx(clamp(st.h0 + dy, hs.min, hs.max));
      st.pts.push({ t: e.timeStamp, y: e.clientY });
      while (st.pts.length > 2 && e.timeStamp - st.pts[0].t > 120) st.pts.shift();
      e.preventDefault();
    }
    function finish(e, cancelled) {
      if (!st || e.pointerId !== st.id) return;
      var s = st;
      st = null;
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignorer */ }
      if (!s.moved) {
        if (!isHandle && !cancelled && sheet === "min") setSheet("mid");
        return;
      }
      dragging = false;
      document.body.classList.remove("sheet-dragging");
      // Hastighet (px/ms, positiv = oppover) projiseres litt frem i tid
      var a = s.pts[0], b = s.pts[s.pts.length - 1], dt = b.t - a.t, v = 0;
      if (!cancelled && dt > 8) v = (a.y - b.y) / dt;
      var hs = heights();
      var projected = clamp(curPx + v * 220, hs.min, hs.max);
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 80);
      setSheet(nearest(projected));
    }

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", function (e) { finish(e, false); });
    el.addEventListener("pointercancel", function (e) { finish(e, true); });
  }

  function makeHandle(el) {
    el.addEventListener("click", function () {
      if (suppressClick) { suppressClick = false; return; }
      if (S.isMobile) cycle();
    });
    el.addEventListener("keydown", function (e) {
      if (!S.isMobile) return;
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); cycle(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); step(-1); }
    });
    bindDrag(el, true);
    handles.push(el);
  }

  function initSheet() {
    var left = $("left"), right = $("right");

    var h1 = $("sheet-handle");
    if (h1) makeHandle(h1);

    if (right) {
      var h2 = document.createElement("div");
      h2.className = "sheet-handle";
      h2.id = "sheet-handle-right";
      h2.setAttribute("role", "button");
      h2.tabIndex = 0;
      h2.innerHTML = "<span></span>";
      right.insertBefore(h2, right.firstChild);
      makeHandle(h2);
    }

    // Tittelfeltet kan også dras / trykkes for å åpne
    var brand = left && left.querySelector(".brand");
    if (brand) {
      bindDrag(brand, false);
      countEl = document.createElement("p");
      countEl.className = "brand__count";
      countEl.textContent = "Henter turer …";
      brand.appendChild(countEl);
    }

    window.addEventListener("resize", function () {
      if (S.isMobile && !dragging) setPx(heights()[sheet]);
    });

    setMobile(!!S.isMobile);
  }

  function setMobile(on) {
    document.body.classList.toggle("is-mobile", !!on);
    if (on) {
      setPx(heights()[sheet]);
    } else {
      dragging = false;
      document.body.classList.remove("sheet-dragging", "sheet-min");
      clearPx();
    }
    updateHandles();
  }

  function updateCount(n) {
    if (!countEl) return;
    countEl.textContent = n + (n === 1 ? " tur" : " turer");
  }

  /* ---------------------------------------------------------------- init */
  function init() {
    if (inited) return;
    inited = true;

    initTheme();
    initTabs();
    initSheet();

    RR.on("mobile", function (on) { setMobile(!!on); });
    RR.on("select", function () { if (S.isMobile) setSheet("mid"); });
    RR.on("fly:start", function () { if (S.isMobile) setSheet("min"); });
    RR.on("filter", function (d) { updateCount(d && d.ids ? d.ids.length : 0); });
    RR.on("data:error", function () { if (countEl) countEl.textContent = "Ingen turer"; });
    if (S.routes && S.routes.length) updateCount(S.visibleIds.length);

    initWelcome();
  }

  RR.modules.mobile = { init: init, setSheet: setSheet, setTheme: setTheme };
})();
