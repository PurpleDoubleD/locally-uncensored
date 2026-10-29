/* Locally Uncensored — shared marketing behaviour (vanilla, no deps).
   Ported from the lu-labs.ai React components (LuMonogram / SiteNav).
   Builds the 3D monogram, injects the ambient background + atmosphere,
   and wires the theme toggle + mobile nav. Purely visual; no SEO impact. */
(function () {
  "use strict";
  var MARK = "/assets/marketing/";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── 3D monogram ──────────────────────────────────────────────────────
  var VARIANTS = {
    nav:  { N: 12, depth: 36, tilt: 16, persp: 400,  size: 52,
            haloBlur: 9,  haloZ: -40,
            glow: "drop-shadow(0 0 2px rgba(139,92,246,0.6))",
            outline: "drop-shadow(0.3px 0.3px 0 rgba(0,0,0,0.55)) drop-shadow(-0.3px -0.3px 0 rgba(0,0,0,0.55)) drop-shadow(0.3px -0.3px 0 rgba(0,0,0,0.55)) drop-shadow(-0.3px 0.3px 0 rgba(0,0,0,0.55))" },
    hero: { N: 18, depth: 92, tilt: 18, persp: 1000, size: 172,
            haloBlur: 30, haloZ: -85,
            glow: "drop-shadow(0 0 6px rgba(139,92,246,0.85)) drop-shadow(0 0 16px rgba(139,92,246,0.5))",
            outline: (function () {
              var o = [];
              [0.55, -0.55].forEach(function (x) {
                [0.55, -0.55].forEach(function (y) { o.push("drop-shadow(" + x + "px " + y + "px 0 rgba(0,0,0,0.55))"); });
              });
              o.push("drop-shadow(0.65px 0 0 rgba(0,0,0,0.55))", "drop-shadow(-0.65px 0 0 rgba(0,0,0,0.55))",
                     "drop-shadow(0 0.65px 0 rgba(0,0,0,0.55))", "drop-shadow(0 -0.65px 0 rgba(0,0,0,0.55))");
              return o.join(" ");
            })() }
  };

  function backLayers(N, depth, base, span) {
    var out = [];
    for (var i = 0; i < N - 1; i++) {
      var t = i / (N - 1);
      out.push({ z: Math.round(t * depth), b: (base + span * t).toFixed(2) });
    }
    return out;
  }

  function img(cls, src, z, filter) {
    var el = document.createElement("img");
    el.className = cls; el.src = src; el.alt = ""; el.setAttribute("aria-hidden", "true");
    el.style.transform = "translateZ(" + z + "px)";
    if (filter) el.style.filter = filter;
    return el;
  }

  function buildMono(host) {
    var v = VARIANTS[host.dataset.mono] || VARIANTS.nav;
    var size = parseInt(host.dataset.size, 10) || v.size;
    host.textContent = "";
    host.style.width = size + "px"; host.style.height = size + "px";

    var stage = document.createElement("div");
    stage.className = "lu-mono-stage";
    stage.style.perspective = v.persp + "px";
    stage.style.perspectiveOrigin = "50% 45%";
    stage.style.width = size + "px"; stage.style.height = size + "px";

    var tilt = document.createElement("div");
    tilt.className = "lu-mono-tilt";
    tilt.style.width = size + "px"; tilt.style.height = size + "px";

    var halo = document.createElement("div");
    halo.className = "lu-mono-halo";
    halo.style.filter = "blur(" + v.haloBlur + "px)";
    halo.style.transform = "translate(-50%,-50%) translateZ(" + v.haloZ + "px)";

    var sway = document.createElement("div");
    sway.className = "lu-mono-sway";
    var extrude = document.createElement("div");
    extrude.className = "lu-mono-extrude";

    backLayers(v.N, v.depth, 0.38, 0.7).forEach(function (l) {
      extrude.appendChild(img("lu-mono-layer", MARK + "lu-ring-flat.png", l.z, "brightness(" + l.b + ")"));
    });
    extrude.appendChild(img("lu-mono-layer", MARK + "lu-ring-metal.png", v.depth, "brightness(1.05) " + v.glow));
    backLayers(v.N, v.depth, 0.4, 0.66).forEach(function (l) {
      extrude.appendChild(img("lu-mono-layer", MARK + "lu-letters-flat.png", l.z, "brightness(" + l.b + ")"));
    });
    extrude.appendChild(img("lu-mono-layer", MARK + "lu-letters-violet.png", v.depth, "brightness(1.05) " + v.outline + " " + v.glow));

    var sheen = document.createElement("div");
    sheen.className = "lu-mono-sheen";
    sheen.style.transform = "translateZ(" + (v.depth + 2) + "px)";

    sway.appendChild(extrude); sway.appendChild(sheen);
    tilt.appendChild(halo); tilt.appendChild(sway);
    stage.appendChild(tilt); host.appendChild(stage);

    if (!reduce) {
      stage.addEventListener("mousemove", function (e) {
        var r = stage.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        tilt.style.transform = "rotateX(" + (-py * v.tilt).toFixed(2) + "deg) rotateY(" + (px * v.tilt).toFixed(2) + "deg)";
      });
      stage.addEventListener("mouseleave", function () {
        tilt.style.transform = "rotateX(0deg) rotateY(0deg)";
      });
    }
  }

  // ── Ambient background + atmosphere ──────────────────────────────────
  function injectAmbient() {
    if (!document.querySelector(".lu-bg")) {
      var bg = document.createElement("div"); bg.className = "lu-bg"; bg.setAttribute("aria-hidden", "true");
      ["b1", "b2", "b3", "b4"].forEach(function (c) {
        var b = document.createElement("div"); b.className = "lu-blob " + c; bg.appendChild(b);
      });
      document.body.insertBefore(bg, document.body.firstChild);
    }
    if (!document.querySelector(".lu-atmosphere")) {
      var atm = document.createElement("div"); atm.className = "lu-atmosphere"; atm.setAttribute("aria-hidden", "true");
      var v = document.createElement("div"); v.className = "lu-vignette";
      var g = document.createElement("div"); g.className = "lu-grain";
      atm.appendChild(v); atm.appendChild(g);
      document.body.appendChild(atm);
    }
  }

  // ── Theme toggle (same data-theme mechanism as before) ───────────────
  function wireTheme() {
    var sw = document.getElementById("theme-switch");
    if (!sw) return;
    sw.addEventListener("click", function () {
      var root = document.documentElement;
      root.setAttribute("data-theme", root.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
  }

  // ── Mobile nav ───────────────────────────────────────────────────────
  function wireNav() {
    var t = document.querySelector(".lu-nav-toggle");
    var links = document.querySelector(".lu-nav-links");
    if (t && links) t.addEventListener("click", function () { links.classList.toggle("open"); });
  }

  // ── Scroll arrow (index) — smooth scroll without adding a hash ────────
  function wireScrollArrow() {
    var a = document.querySelector(".scroll-arrow");
    if (!a) return;
    a.addEventListener("click", function (e) {
      e.preventDefault();
      var t = document.getElementById("content-start");
      if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Preserve a validated campaign source when a visitor crosses from the
  // editorial LUC site to LU Labs. Static pricing links carry a useful default
  // (`luc-pricing`), but an inbound campaign source must win so the
  // eventual checkout can still be attributed after login.
  function wireFunnelSource() {
    var source = new URLSearchParams(window.location.search).get("src");
    if (!source || !/^[a-z0-9_-]{1,32}$/.test(source)) return;

    var links = document.querySelectorAll('a[href^="https://lu-labs.ai/"]');
    for (var i = 0; i < links.length; i++) {
      try {
        var target = new URL(links[i].href);
        target.searchParams.set("src", source);
        links[i].href = target.toString();
      } catch (e) {}
    }
  }

  // ── Language toggle (EN ↔ DE, client-side via Google Translate) ──────
  var LANG_KEY = "lu-lang";
  var FLAG_DE = '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#000"/><rect y="13.4" width="60" height="13.3" fill="#D00"/><rect y="26.7" width="60" height="13.3" fill="#FFCE00"/></svg>';
  var FLAG_EN = '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#012169"/><path d="M0 0l60 40M60 0L0 40" stroke="#fff" stroke-width="8"/><path d="M0 0l60 40M60 0L0 40" stroke="#C8102E" stroke-width="4"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="13"/><path d="M30 0v40M0 20h60" stroke="#C8102E" stroke-width="8"/></svg>';

  function langPref() {
    try { return localStorage.getItem(LANG_KEY); } catch (e) { return null; }
  }
  function pageLang() { return (document.documentElement.lang || "en").slice(0, 2); }

  function setGoogTrans(v) {
    ["", "; domain=" + location.hostname, "; domain=." + location.hostname].forEach(function (d) {
      document.cookie = v
        ? "googtrans=" + v + "; expires=Fri, 31 Dec 2038 23:59:59 GMT; path=/" + d
        : "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" + d;
    });
  }

  function bootTranslate(target) {
    setGoogTrans("/auto/" + target);
    var brands = document.querySelectorAll(".lu-nav-word, .mast-title");
    for (var i = 0; i < brands.length; i++) brands[i].classList.add("notranslate");
    var holder = document.createElement("div");
    holder.id = "lu-gt"; holder.className = "notranslate";
    document.body.appendChild(holder);
    window.luGTInit = function () {
      new google.translate.TranslateElement({ pageLanguage: pageLang(), includedLanguages: "de,en", autoDisplay: false }, "lu-gt");
    };
    var s = document.createElement("script");
    s.src = "https://translate.google.com/translate_a/element.js?cb=luGTInit";
    s.async = true;
    document.body.appendChild(s);
  }

  // The button shows the flag of the language the page is in right now. A
  // click opens a menu with the one other language.
  function wireLang() {
    if (pageLang() !== "en") return;
    var pref = langPref();
    var current = pref === "de" ? "de" : "en";
    var target = current === "de" ? "en" : "de";

    var wrap = document.createElement("div");
    wrap.className = "lu-lang-wrap notranslate";
    wrap.setAttribute("translate", "no");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lu-lang";
    btn.title = current === "de" ? "Sprache: Deutsch" : "Language: English";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = current === "de" ? FLAG_DE : FLAG_EN;

    var menu = document.createElement("div");
    menu.className = "lu-lang-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    var opt = document.createElement("button");
    opt.type = "button";
    opt.className = "lu-lang-opt";
    opt.setAttribute("role", "menuitem");
    opt.setAttribute("lang", target);
    opt.innerHTML = (target === "de" ? FLAG_DE : FLAG_EN) + "<span>" + (target === "de" ? "Deutsch" : "English") + "</span>";
    menu.appendChild(opt);
    wrap.appendChild(btn); wrap.appendChild(menu);

    function open(on) {
      menu.hidden = !on;
      btn.setAttribute("aria-expanded", on ? "true" : "false");
      if (on) opt.focus();
    }
    btn.addEventListener("click", function (e) { e.stopPropagation(); open(menu.hidden); });
    document.addEventListener("click", function (e) { if (!menu.hidden && !wrap.contains(e.target)) open(false); });
    wrap.addEventListener("keydown", function (e) { if (e.key === "Escape" && !menu.hidden) { open(false); btn.focus(); } });
    opt.addEventListener("click", function () {
      try { localStorage.setItem(LANG_KEY, target); } catch (e) {}
      setGoogTrans(target === "de" ? "/auto/de" : null);
      location.reload();
    });

    var right = document.querySelector(".lu-nav-right");
    if (right) right.insertBefore(wrap, right.firstChild);
    else { wrap.classList.add("fixed"); document.body.appendChild(wrap); }

    if (pref === "de") bootTranslate("de");
    else setGoogTrans(null);
  }

  // ── The phone app (19.10.2026) ──────────────────────────────────────
  // On a phone, first thing under the navigation: the iPhone app is in review
  // at the App Store, Google Play follows; on Android the APK of the latest
  // release downloads now (the GitHub release asset), an iPhone
  // uses LU Cloud in the browser until then. A computer sees nothing; closed
  // stays closed in this browser.
  var PHONE_KEY = "lu_phone_app_banner_closed";
  var APK_URL = "https://github.com/PurpleDoubleD/locally-uncensored/releases/download/v3.0.7/LU-3.0.7-Android.apk";
  function phoneKind() {
    var ua = navigator.userAgent || "";
    if (/android/i.test(ua)) return "android";
    if (/iphone|ipad|ipod/i.test(ua)) return "ios";
    if (/macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) return "ios";
    return null;
  }
  function wirePhoneApp() {
    var kind = phoneKind();
    if (!kind) return;
    try { if (localStorage.getItem(PHONE_KEY) === "1") return; } catch (e) {}
    var box = document.createElement("aside");
    box.className = "lu-phone-app";
    box.setAttribute("aria-label", "Locally Uncensored on your phone");
    box.setAttribute("data-kind", kind);
    // One slim row (20.10.2026, a third of the old height): phone icon,
    // two short lines, a compact button, close.
    var icon = '<svg class="lu-phone-app-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M10.5 18.2h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    box.innerHTML = icon + (kind === "android"
      ? '<div class="lu-phone-app-text"><p class="lu-phone-app-title">LU on your phone</p>' +
        '<p class="lu-phone-app-note">iPhone in review, Play soon. <a href="/android/">Install help</a></p></div>' +
        '<a class="lu-phone-app-cta" href="' + APK_URL + '" aria-label="Download the Android app (APK, about 27 MB)">Get APK</a>'
      : '<div class="lu-phone-app-text"><p class="lu-phone-app-title">LU for iPhone soon</p>' +
        '<p class="lu-phone-app-note">In App Store review. Try LU&nbsp;Cloud.</p></div>' +
        '<a class="lu-phone-app-cta" href="https://lu-labs.ai/app?src=luc-phone-banner">LU Cloud</a>');
    var x = document.createElement("button");
    x.type = "button"; x.className = "lu-phone-app-x"; x.setAttribute("aria-label", "Close"); x.textContent = "\u2715";
    x.addEventListener("click", function () {
      try { localStorage.setItem(PHONE_KEY, "1"); } catch (e) {}
      box.remove();
    });
    box.appendChild(x);
    var nav = document.querySelector(".lu-nav");
    if (nav && nav.parentNode) nav.parentNode.insertBefore(box, nav.nextSibling);
    else document.body.insertBefore(box, document.body.firstChild);
  }

  function init() {
    injectAmbient();
    var monos = document.querySelectorAll("[data-mono]");
    for (var i = 0; i < monos.length; i++) buildMono(monos[i]);
    wireTheme(); wireNav(); wireScrollArrow(); wireFunnelSource(); wireLang(); wirePhoneApp();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
