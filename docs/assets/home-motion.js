/* Locally Uncensored homepage: the mini-video engine and its scenes.
   Every demo is a small HTML composition of the app, drawn as a pure function
   of time (render(t)) and scaled into its frame like a video. Vanilla, no
   dependencies. A demo only runs while it is on screen, stops with the tab,
   and starts paused (on a poster frame) for visitors who ask for reduced
   motion. Content follows the app: tool names from the agent, Create modes
   from intents.ts, model names from the catalog. */
(function () {
  "use strict";
  var doc = document, html = doc.documentElement;
  /* "hm" gates everything that waits for this script (redacted headings,
     the closing mark), so nothing stays hidden if the script never runs */
  html.classList.add("js", "hm");
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var REDUCE = !!(mq && mq.matches);
  var IMG = "/assets/home/";

  /* ---------- time ---------- */
  function cl(x, a, b) { return x < a ? a : x > b ? b : x; }
  function sg(t, a, b) { return b <= a ? (t >= b ? 1 : 0) : cl((t - a) / (b - a), 0, 1); }
  function lr(a, b, p) { return a + (b - a) * p; }
  var E = {
    o2: function (p) { return 1 - (1 - p) * (1 - p); },
    o3: function (p) { return 1 - Math.pow(1 - p, 3); },
    i2: function (p) { return p * p; },
    io2: function (p) { return p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; },
    io3: function (p) { return p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; },
    bk: function (p) { var c = 1.70158; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); }
  };

  /* ---------- cached writes: a frame only touches what changed ---------- */
  function S(el, k, v) { if (!el) return; var c = el.__s || (el.__s = {}); if (c[k] !== v) { c[k] = v; el.style.setProperty(k, v); } }
  function T(el, s) { if (el && el.__t !== s) { el.__t = s; el.textContent = s; } }
  function C(el, c, on) { if (!el) return; on = !!on; var m = el.__c || (el.__c = {}); if (m[c] !== on) { m[c] = on; el.classList.toggle(c, on); } }
  function O(el, o) { S(el, "opacity", o >= .999 ? "1" : o <= .001 ? "0" : o.toFixed(3)); }
  function TR(el, v) { S(el, "transform", v); }
  function D(el, on) { S(el, "display", on ? "" : "none"); }
  function q(r, s) { return r.querySelector(s); }
  function qa(r, s) { return [].slice.call(r.querySelectorAll(s)); }

  /* ---------- motion helpers ---------- */
  function fin(el, t, a, d, dy, b, bd) {
    var p = E.o3(sg(t, a, a + (d || .3)));
    if (b != null) p *= 1 - E.o2(sg(t, b, b + (bd || .25)));
    O(el, p);
    if (dy) TR(el, "translateY(" + ((1 - p) * dy).toFixed(1) + "px)");
    return p;
  }
  function pop(el, t, a, d) {
    var p = sg(t, a, a + (d || .3));
    O(el, Math.min(1, p * 2.2));
    TR(el, p >= 1 ? "none" : "scale(" + (.82 + .18 * E.bk(p)).toFixed(3) + ")");
    return p;
  }
  /* height 0 -> natural through a one-row grid, so the chat above slides up */
  function grow(el, t, a, d, b, bd) {
    var p = E.o3(sg(t, a, a + (d || .32)));
    if (b != null) p *= 1 - E.io2(sg(t, b, b + (bd || .3)));
    S(el, "grid-template-rows", p <= .001 ? "0fr" : p >= .999 ? "1fr" : p.toFixed(3) + "fr");
    O(el, p);
    return p;
  }
  function typ(el, s, t, a, b) { var n = Math.round(s.length * sg(t, a, b)); T(el, n >= s.length ? s : s.slice(0, n)); return n; }
  function words(el, s, t, a, b) {
    if (el.__ws !== s) { el.__ws = s; el.__w = s.split(/(?=\s)/); }
    var w = el.__w, n = Math.round(w.length * sg(t, a, b));
    T(el, n >= w.length ? s : w.slice(0, n).join(""));
    return n / w.length;
  }
  function blink(t) { return Math.floor(t * 2.6) % 2 ? .15 : 1; }
  function prs(t, c) { var x = t - c; if (x < 0 || x > .32) return 1; return x < .07 ? 1 - x / .07 * .1 : .9 + E.bk(sg(x, .07, .32)) * .1; }
  /* a picture "developing": blur, noise and a little zoom settle */
  function dev(img, t, a, d, noise) {
    var p = sg(t, a, a + d), e = E.o2(p);
    O(img, p > 0 ? 1 : 0);
    S(img, "filter", p >= 1 || p <= 0 ? "none" : "blur(" + ((1 - e) * 14).toFixed(1) + "px) saturate(" + (.3 + .7 * e).toFixed(2) + ") brightness(" + (1.3 - .3 * e).toFixed(2) + ")");
    TR(img, p >= 1 ? "none" : "scale(" + (1.08 - .08 * E.o3(p)).toFixed(3) + ")");
    if (noise) O(noise, p > 0 && p < 1 ? (1 - e) * .9 : 0);
    return p;
  }
  function wipe(top, line, p) {
    S(top, "clip-path", "inset(0 " + ((1 - p) * 100).toFixed(2) + "% 0 0)");
    if (line) { S(line, "left", (p * 100).toFixed(2) + "%"); O(line, p > 0 && p < 1 ? 1 : 0); }
  }
  function pauseV(v) { if (v && !v.paused) v.pause(); }
  /* keep a clip in step with the scene clock */
  function vsync(v, t, a, b, live) {
    if (!v) return;
    if (t >= a && t < b) {
      var want = t - a;
      if (v.preload !== "auto") { v.preload = "auto"; }
      if (live) {
        if (v.paused) { try { v.currentTime = want; } catch (e) {} var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); }
        else if (Math.abs(v.currentTime - want) > .4) { try { v.currentTime = want; } catch (e) {} }
      } else {
        pauseV(v);
        if (v.readyState > 0 && Math.abs(v.currentTime - want) > .05) { try { v.currentTime = want; } catch (e) {} }
      }
    } else pauseV(v);
  }
  /* element centre in stage (design) pixels */
  function pos(el, st) {
    var a = el.getBoundingClientRect(), b = st.getBoundingClientRect(), s = b.width / (st.offsetWidth || 1) || 1;
    return [(a.left - b.left + a.width * .5) / s, (a.top - b.top + a.height * .55) / s];
  }
  function tgt(x, st) { return typeof x === "function" ? x() : x && x.nodeType ? pos(x, st) : x; }
  /* keys: [arrive time, target, travel time, click?] */
  function cursor(el, t, keys, st) {
    var n = keys.length, s0 = keys[0][0] - (keys[0][2] || .35) - .15, end = keys[n - 1][0] + .6;
    if (t < s0 || t > end) { O(el, 0); return; }
    var i = 0; while (i < n - 1 && t > keys[i][0]) i++;
    var k = keys[i], d = k[2] || .35, pi = tgt(k[1], st), pp;
    pp = i === 0 ? [pi[0] + 80, pi[1] + 110] : tgt(keys[i - 1][1], st);
    var p = t > k[0] ? 1 : E.io3(sg(t, k[0] - d, k[0]));
    var x = lr(pp[0], pi[0], p), y = lr(pp[1], pi[1], p);
    if (t > keys[n - 1][0]) { var z = E.i2(sg(t, keys[n - 1][0] + .25, end)); x += z * 40; y += z * 60; }
    var sc = 1;
    for (var j = 0; j < n; j++) if (keys[j][3]) sc = Math.min(sc, prs(t, keys[j][0] + .02) * (1 - (1 - prs(t, keys[j][0] + .02)) * 1.2));
    O(el, Math.min(sg(t, s0, s0 + .18), 1 - sg(t, end - .3, end)));
    TR(el, "translate(" + (x - 2).toFixed(1) + "px," + (y - 2).toFixed(1) + "px) scale(" + sc.toFixed(3) + ")");
  }
  /* a screen change: the old screen leaves fast (b to b+.16), the new one
     pushes in just after (a+.1), so two screens never sit on top of each other */
  function screen(el, t, a, b) {
    var on = (a <= 0 || t >= a + .1) && t < b + .16;
    S(el, "visibility", on ? "visible" : "hidden");
    if (!on) { O(el, 0); return; }
    var pin = a <= 0 ? 1 : E.o3(sg(t, a + .1, a + .46)), pout = E.i2(sg(t, b, b + .16));
    O(el, Math.min(pin, 1 - pout));
    TR(el, pin >= 1 && pout <= 0 ? "none" : "translateX(" + ((1 - pin) * 30 - pout * 22).toFixed(1) + "px)");
  }
  function compose(c, t, ss) {
    var cur = null, i;
    for (i = 0; i < ss.length; i++) if (t >= ss[i][1] && t < ss[i][3]) cur = ss[i];
    if (cur) { typ(c.ty, cur[0], t, cur[1], cur[2]); O(c.ph, 0); O(c.caret, t < cur[2] ? 1 : blink(t)); }
    else { T(c.ty, ""); O(c.ph, 1); O(c.caret, 0); }
    if (c.snd) {
      var s = 1; for (i = 0; i < ss.length; i++) s = Math.min(s, prs(t, ss[i][3] - .08));
      TR(c.snd, s >= 1 ? "none" : "scale(" + s.toFixed(3) + ")");
      C(c.snd, "hot", !!cur && t >= cur[2]);
    }
  }
  function toolState(el, t, done) {
    var sp = el.__sp || (el.__sp = q(el, ".spin")), ok = el.__ok || (el.__ok = q(el, ".ok"));
    D(sp, t < done); D(ok, t >= done);
    if (t >= done) TR(ok, "scale(" + (.5 + .5 * E.bk(sg(t, done, done + .28))).toFixed(3) + ")");
  }
  function fmt(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60); }

  /* ---------- the app, as markup ---------- */
  var I = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    remote: '<circle cx="12" cy="12" r="2"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14M7.76 16.24a6 6 0 0 1 0-8.49M16.24 7.76a6 6 0 0 1 0 8.49M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    spark: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    term: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    bot: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4M8 14h.01M16 14h.01"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
    maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7M5 11l9 9"/>',
    video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4"/>',
    user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    ff: '<path d="M13 19l9-7-9-7zM2 19l9-7-9-7z"/>',
    person: '<circle cx="12" cy="5" r="1"/><path d="m9 20 3-6 3 6M6 8l6 2 6-2M12 10v4"/>'
  };
  function ic(k, cls) { return '<svg class="ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24">' + I[k] + "</svg>"; }
  var LU = '<svg class="lu" viewBox="176 176 672 672"><rect x="193" y="193" width="638" height="638" rx="138" ry="138" fill="none" stroke="currentColor" stroke-width="40"/><path fill="currentColor" d="M302,342 H377 V612 H433.6 A162,162 0 0,0 500.5,680 H302 Z"/><path fill="currentColor" d="M434,342 H508 V545 A69,69 0 0,0 646,545 V342 H722 V537.5 A144,144 0 0,1 434,537.5 Z"/></svg>';
  var CUR = '<svg class="cur" viewBox="0 0 20 24"><path d="M2 2 L2 19 L6.5 15 L9.5 22 L12.5 20.7 L9.6 14 L16 14 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  var NAV = ["Chat", "Create", "Compare", "Benchmark", "Models", "Settings"];

  function topbar() {
    return '<div class="ap-tb">' + ic("menu", "tb-m") + LU + ic("cloud", "tb-cl") + '<div class="ap-nav">' + ic("dl", "wo") + ic("sun", "wo") +
      NAV.map(function (n, i) { return '<span data-nav="' + n + '"' + (i > 1 ? ' class="wo"' : "") + ">" + n + "</span>"; }).join("") + "</div></div>";
  }
  function rail(on) {
    function r(k) { return '<span class="r' + (k === on ? " on" : "") + '" data-r="' + k + '">' + ic(k) + "</span>"; }
    return '<div class="ap-rail"><span class="r">' + ic("panel") + '</span><i class="sep"></i>' + r("chat") + r("code") + r("remote") + '<span class="r plus">' + ic("plus") + "</span></div>";
  }
  function composer(model, tag, pre) {
    return '<div class="cmp"><span class="cmp-t"><span class="ty"></span><i class="caret"></i></span><span class="cmp-ph">Message...</span>' + (pre || "") +
      '<span class="mc"><i></i>' + model + (tag ? "<em>" + tag + "</em>" : "") + '</span><span class="snd">' + ic("send") + "</span></div>";
  }
  function cmpRefs(r) { return { ty: q(r, ".ty"), ph: q(r, ".cmp-ph"), caret: q(r, ".caret"), snd: q(r, ".snd") }; }
  function gw(inner, cls) { return '<div class="gw' + (cls ? " " + cls : "") + '"><div class="gi">' + inner + "</div></div>"; }
  function tool(icon, name, arg) { return '<div class="tool">' + ic(icon) + '<span class="nm">' + name + '</span><span class="ar">' + arg + '</span><i class="spin"></i>' + ic("check", "ok") + "</div>"; }
  function msg(inner) { return '<div class="msg"><span class="av">' + LU + '</span><div class="col">' + inner + "</div></div>"; }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function img(src, cls, st) { return '<img src="' + IMG + src + '" alt="" decoding="async" loading="lazy"' + (cls ? ' class="' + cls + '"' : "") + (st ? ' style="' + st + '"' : "") + ">"; }
  function vid(src, poster) { return '<video muted playsinline preload="none" disablepictureinpicture disableremoteplayback data-poster="' + IMG + poster + '" src="' + IMG + src + '"></video>'; }

  /* ---------- Create: the twelve modes from intents.ts, in the app's order ---------- */
  var MODES = [
    { s: "Image", l: "Image", c: "#60A5FA", i: "image", p: "Woman with a katana in neon rain", d: "Describe it and get a picture." },
    { s: "Edit", l: "Edit / Image to Image", c: "#A78BFA", i: "wand", p: "Same shot, burning desert at sunset", d: "Restyle a picture, or paint a mask to change one part of it." },
    { s: "Cutout", l: "Remove Background", c: "#34D399", i: "scissors", p: "Cut her out of the background", d: "The subject, cut out in one click." },
    { s: "Enhance", l: "Enhance Image", c: "#FBBF24", i: "maximize", p: "Sharpen every detail", d: "Upscale a picture and sharpen it." },
    { s: "Erase", l: "Erase Object", c: "#F87171", i: "eraser", p: "Erase the nun", d: "Paint over something and it is gone." },
    { s: "Video", l: "Video", c: "#F472B6", i: "video", p: "She swings the katana at the camera", d: "Describe the motion and get a clip." },
    { s: "Animate", l: "Animate Image", c: "#FB923C", i: "film", p: "The bike bursts out of the fireball", d: "A still picture starts to move." },
    { s: "Character", l: "Character Studio", c: "#818CF8", i: "user", p: "Same character, four new shots", d: "One character, the same face in every shot." },
    { s: "Lipsync", l: "Talking Character", c: "#2DD4BF", i: "mic", p: "Make her say: Welcome to the studio.", d: "Give a character a voice, with the lips in sync." },
    { s: "Music", l: "Music", c: "#C084FC", i: "music", p: "Dark synthwave for an alien chase", d: "A music track from a few words." },
    { s: "Extend", l: "Extend Video", c: "#38BDF8", i: "ff", p: "Continue the chase", d: "Keep a clip going past its last frame." },
    { s: "Motion", l: "Motion Control", c: "#A3E635", i: "person", p: "Copy this move onto my character", d: "Copy a move onto your own character." }
  ];
  var GAL = ["neon.webp", "desert.webp", "rei-cutout.webp", "bike.webp", "nun-erased.webp", "neon.webp", "bike.webp", "desert.webp", "neon.webp", "alien.webp", "bike.webp", "desert.webp"];
  function pills() { return '<div class="pills">' + MODES.map(function (m) { return '<span class="pill">' + ic(m.i) + "<b>" + m.s + "</b></span>"; }).join("") + "</div>"; }
  function info(opts, gal) {
    return '<div class="cr-info"><span class="k"></span><span class="t"></span><i class="u"></i><span class="d"></span>' +
      (opts ? '<div class="opts"><span class="l">QUALITY</span><span class="o">Draft</span><span class="o on">Standard</span><span class="o">High</span></div><div class="opts"><span class="l">ASPECT</span><span class="o">1:1</span><span class="o on">16:9</span><span class="o">9:16</span></div>' : "") +
      (gal ? '<div class="gal">' + GAL.map(function (g) { return '<i data-bg="' + g + '"></i>'; }).join("") + "</div>" : "") + "</div>";
  }
  var FX = '<i class="scan"></i><i class="prog"></i><span class="hud">LU CLOUD</span><span class="stp"></span>';
  function layer(k) {
    var h = "";
    switch (k) {
      case 0: h = img("neon.webp") + '<i class="noise"></i>'; break;
      case 1: h = img("neon.webp") + img("desert.webp", "top") + '<i class="wline"></i>'; break;
      case 2: h = img("neon.webp", "base") + '<div class="ck"></div>' + img("rei-cutout.webp", "top"); break;
      case 3: h = img("bike.webp", "lo") + img("bike.webp", "top") + '<i class="wline"></i><span class="badge">UPSCALED</span>'; break;
      case 4: h = img("nun-erased.webp") + img("nun.webp", "top") + '<i class="ring"></i>'; break;
      case 5: h = img("neon.webp") + vid("katana.mp4", "neon.webp"); break;
      case 6: h = img("bike.webp") + vid("bike.mp4", "bike.webp"); break;
      case 7: h = [["neon.webp", "42% 30%", 1], ["desert.webp", "42% 30%", 1], ["neon.webp", "44% 18%", 1.7], ["desert.webp", "45% 20%", 1.7]].map(function (c, i) {
          return '<div class="tile" style="left:' + (2.5 + i * 24.2) + '%;top:5%;width:22.6%;height:90%">' + img(c[0], "", "object-position:" + c[1] + ";transform:scale(" + c[2] + ");transform-origin:" + c[1]) + "</div>"; }).join(""); break;
      case 8: h = img("neon.webp", "zm") + '<div class="bars bv">' + new Array(25).join("<i></i>") + '</div><div class="sub"></div>'; break;
      case 9: h = img("alien.webp", "dim") + '<div class="bars bm">' + new Array(49).join("<i></i>") + "</div>"; break;
      case 10: h = '<div class="strip">' + ["18% 50%", "50% 50%", "82% 50%"].map(function (p) { return '<div class="sf">' + img("bike.webp", "", "object-position:" + p) + "</div>"; }).join("") + '<div class="sf nx">' + ic("ff") + "</div></div>"; break;
      case 11: h = img("desert.webp", "dim") + '<svg class="skel" viewBox="0 0 200 300" fill="none" stroke="#bef264" stroke-width="7" stroke-linecap="round"><circle cx="100" cy="40" r="22"/><path d="M100 64 V160 M100 160 L70 250 M100 160 L135 250"/><path class="arm" d="M100 88 L52 132 M100 88 L152 62"/></svg>'; break;
    }
    return '<div class="md" data-m="' + k + '">' + h + "</div>";
  }
  function layerRefs(stage) {
    var L = {};
    qa(stage, ".md").forEach(function (el) {
      var k = +el.getAttribute("data-m");
      L[k] = { el: el, img: q(el, "img"), top: q(el, ".top"), base: q(el, ".base"), lo: q(el, ".lo"), noise: q(el, ".noise"), wl: q(el, ".wline"), ck: q(el, ".ck"),
        ring: q(el, ".ring"), badge: q(el, ".badge"), v: q(el, "video"), tiles: qa(el, ".tile"), bars: qa(el, ".bars i"), sub: q(el, ".sub"),
        strip: q(el, ".strip"), nx: q(el, ".nx"), arm: q(el, ".arm"), zm: q(el, ".zm") };
    });
    return L;
  }
  function infoSet(r, k) {
    if (r.__k === k) return; r.__k = k;
    var m = MODES[k];
    T(r.k, (k < 9 ? "0" : "") + (k + 1) + " / 12"); S(r.k, "color", m.c);
    T(r.t, m.l); T(r.d, m.d); S(r.u, "background", m.c);
  }
  /* what each mode does on the stage, u = seconds since Create was pressed */
  function modeFx(L, k, u, live, dur) {
    var p, i;
    switch (k) {
      case 0: dev(L.img, u, .04, .66, L.noise); break;
      case 1: wipe(L.top, L.wl, E.io3(sg(u, .06, .62))); break;
      case 2: p = sg(u, .12, .42); O(L.base, 1 - p); O(L.ck, p); O(L.top, p); break;
      case 3: p = E.io3(sg(u, .06, .66)); wipe(L.top, L.wl, p); O(L.badge, sg(u, .6, .72)); break;
      case 4: p = E.o3(sg(u, 0, .16)); O(L.ring, p * (1 - sg(u, .34, .5))); TR(L.ring, "scale(" + (1.18 - .18 * p).toFixed(3) + ")"); O(L.top, 1 - sg(u, .3, .52)); break;
      case 5: case 6: vsync(L.v, u, 0, dur, live); break;
      case 7: for (i = 0; i < L.tiles.length; i++) pop(L.tiles[i], u, .02 + i * .07, .26); break;
      case 8:
        TR(L.zm, "scale(" + (1 + .06 * sg(u, 0, dur)).toFixed(3) + ")");
        for (i = 0; i < L.bars.length; i++) TR(L.bars[i], "scaleY(" + (.12 + .88 * Math.abs(Math.sin(u * 13 + i * 1.3) * Math.cos(u * 5 + i * .4))).toFixed(3) + ")");
        typ(L.sub, "Welcome to the studio.", u, .1, .7); break;
      case 9: for (i = 0; i < L.bars.length; i++) TR(L.bars[i], "scaleY(" + (.1 + .9 * Math.abs(Math.sin(u * 7 + i * .7) * Math.cos(u * 3.1 + i * .23))).toFixed(3) + ")"); break;
      case 10: TR(L.strip, "scaleX(" + (.74 + .26 * E.o3(sg(u, 0, .4))).toFixed(3) + ")"); O(L.nx, .45 + .55 * Math.abs(Math.sin(u * 5))); break;
      case 11: TR(L.arm, "rotate(" + (Math.sin(u * 6.5) * 16).toFixed(2) + "deg)"); break;
    }
  }
  /* shared progress bar, scan line and step counter of the Create stage */
  function genFx(r, t, wins) {
    var on = null;
    for (var i = 0; i < wins.length; i++) if (t >= wins[i][0] && t < wins[i][1]) on = wins[i];
    if (!on) { TR(r.prog, "scaleX(0)"); O(r.scan, 0); O(r.stp, 0); return; }
    var p = sg(t, on[0], on[1]);
    TR(r.prog, "scaleX(" + p.toFixed(4) + ")");
    if (on[2] === "gen") {
      O(r.stp, 1); T(r.stp, "STEP " + Math.max(1, Math.ceil(p * 28)) + " / 28");
      O(r.scan, p < .92 ? .9 : 0); S(r.scan, "top", (E.io2((p * 1.6) % 1) * 100).toFixed(2) + "%");
    } else { O(r.stp, 0); O(r.scan, 0); }
  }

  /* ---------- engine ---------- */
  var DEFS = {}, players = [], ticking = false, lastNow = 0, hidden = !!doc.hidden;
  function scene(name, def) { DEFS[name] = def; }

  function Player(fig) {
    var name = fig.getAttribute("data-mv"), def = DEFS[name], self = this;
    this.fig = fig; this.def = def; this.D = def.D;
    this.box = q(fig, ".mv-box"); this.stage = q(fig, ".mv-stage");
    this.stage.classList.add("sc-" + name);
    this.tall = fig.classList.contains("mv--tall");
    this.fitSize();
    this.r = def.build(this.stage, this) || {};
    this.vids = qa(this.stage, "video");
    this.t = REDUCE ? (def.poster != null ? def.poster : def.D * .75) : 0;
    this.playing = !REDUCE; this.vis = false; this.seen = false;
    this.pp = q(fig, ".mv-pp"); this.fill = q(fig, ".mv-fill"); this.tc = q(fig, ".mv-tc"); this.track = q(fig, ".mv-track");
    this.ch = def.chapters || [[0, ""]];
    this.nav = qa(doc, '[data-mv-for="' + fig.id + '"] [data-i]');
    this.ch.forEach(function (c, i) {
      if (i && self.track) { var k = doc.createElement("i"); k.className = "mv-tick"; k.style.left = (c[0] / self.D * 100).toFixed(2) + "%"; self.track.appendChild(k); }
    });
    if (this.pp) { this.pp.addEventListener("click", function () { self.play(!self.playing); }); }
    if (this.track) this.track.addEventListener("click", function (e) {
      var b = self.track.getBoundingClientRect(); self.seek((e.clientX - b.left) / b.width * self.D, self.playing);
    });
    this.nav.forEach(function (b) {
      function go() { var i = +b.getAttribute("data-i"); if (self.ch[i]) self.seek(self.ch[i][0] + .001, true); }
      b.addEventListener("click", go);
      if (b.tagName !== "BUTTON") b.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    this.syncPP();
    if (def.layout) def.layout(this.r, this.tall, this);
    this.draw();
  }
  Player.prototype.live = function () { return this.playing && this.vis && !hidden; };
  /* a demo loads its pictures, gallery thumbs and video posters once it comes
     near the viewport, all at once, so no frame waits for a lazy image */
  Player.prototype.wake = function () {
    if (this.woke) return; this.woke = true;
    qa(this.stage, "img[loading]").forEach(function (i) { i.loading = "eager"; });
    qa(this.stage, "[data-bg]").forEach(function (g) { g.style.backgroundImage = "url(" + IMG + g.getAttribute("data-bg") + ")"; });
    qa(this.stage, "video[data-poster]").forEach(function (v) { v.poster = v.getAttribute("data-poster"); v.preload = "auto"; });
  };
  Player.prototype.fitSize = function () {
    var w = this.box.clientWidth; if (!w) return false;
    var tall = w < (this.def.tallBelow || 560), changed = tall !== this.tall;
    this.tall = tall; C(this.fig, "mv--tall", tall);
    TR(this.stage, "scale(" + (w / (tall ? this.def.tw : this.def.w)).toFixed(4) + ")");
    return changed;
  };
  Player.prototype.fit = function () { if (this.fitSize() && this.def.layout) this.def.layout(this.r, this.tall, this); this.draw(); };
  Player.prototype.draw = function () {
    var t = this.t;
    this.def.render(t, this.r, this);
    if (this.fill) TR(this.fill, "scaleX(" + (t / this.D).toFixed(4) + ")");
    if (this.tc) T(this.tc, fmt(t) + " / " + fmt(this.D));
    var ci = 0, i;
    for (i = 0; i < this.ch.length; i++) if (t >= this.ch[i][0]) ci = i;
    var c1 = ci + 1 < this.ch.length ? this.ch[ci + 1][0] : this.D, cp = sg(t, this.ch[ci][0], c1);
    for (i = 0; i < this.nav.length; i++) {
      var b = this.nav[i], k = +b.getAttribute("data-i");
      C(b, "on", k === ci); C(b, "done", k < ci);
      S(b, "--p", k === ci ? cp.toFixed(3) : "0");
    }
  };
  Player.prototype.adv = function (dt) { this.t += dt; if (this.t >= this.D) { this.t -= this.D; this.vids.forEach(pauseV); } this.draw(); };
  Player.prototype.seek = function (t, play) { this.t = cl(t, 0, this.D - .001); this.vids.forEach(pauseV); if (play && !this.playing) this.play(true); else this.draw(); kick(); };
  Player.prototype.play = function (on) { this.playing = on; this.syncPP(); if (!on) this.vids.forEach(pauseV); else kick(); this.draw(); };
  Player.prototype.syncPP = function () { if (!this.pp) return; C(this.pp, "is-paused", !this.playing); this.pp.setAttribute("aria-label", this.playing ? "Pause demo" : "Play demo"); };

  function kick() { if (!ticking) { ticking = true; lastNow = performance.now(); requestAnimationFrame(frame); } }
  function frame(now) {
    var dt = Math.min(.05, Math.max(0, (now - lastNow) / 1000)), any = false;
    lastNow = now;
    for (var i = 0; i < players.length; i++) { var p = players[i]; if (p.live()) { p.adv(dt); any = true; } }
    if (any) requestAnimationFrame(frame); else ticking = false;
  }

  /* ═══════════════════════════════ scenes ═══════════════════════════════ */

  /* HERO: one character from chat to Create to code, 16 s */
  var HX = {
    q1: "Give me a character for my graphic novel. Dark and dangerous.",
    a1: "Rei. Ex-courier for the Kuroda family, one blade, no patience left. She walks the neon districts in the rain, because nobody follows her there twice.",
    p: ["Rei, katana, neon rain, cinematic still", "She swings the katana at the camera", "Same shot, burning desert at sunset"],
    q2: "Add rei.png to the hero of my landing page."
  };
  scene("hero", {
    w: 960, h: 560, tw: 400, th: 560, tallBelow: 640, D: 16, poster: 6.3,
    chapters: [[0, "Chat"], [4, "Image"], [6.6, "Video"], [10.35, "Edit"], [12.1, "Code"]],
    build: function (st) {
      st.innerHTML = '<div class="ap">' + topbar() + rail("chat") + '<div class="ap-main">' +
        '<div class="scr s-chat"><div class="feed">' + gw('<div class="bub">' + HX.q1 + "</div>", "c1") + gw('<div class="msg"><span class="av">' + LU + '</span><div class="ans"></div></div>', "c2") + "</div>" + composer("Qwen 3.8 27B", "LOCAL") + "</div>" +
        '<div class="scr s-create">' + pills() + '<div class="cr-stage">' + layer(0) + layer(5) + layer(1) + FX + "</div>" + info(true, false) +
          '<div class="ccmp"><span class="cmp-t"><span class="ty"></span><i class="caret"></i></span><span class="chip"><em>CLOUD</em>LU Cloud</span><span class="go">' + ic("spark") + "Create</span></div></div>" +
        '<div class="scr s-code"><div class="cd-head">' + ic("code") + "<span>Coding Agent</span>" + ic("folder", "fo") + '<span class="mono">rei-comic</span><span class="cd-chip">Ask' + ic("down") + '</span></div><div class="feed">' +
          gw('<div class="bub">' + HX.q2 + "</div>", "k1") + gw(msg(tool("file", "file_read", "index.html")), "k2") +
          gw('<div class="ind"><div class="pend"><div class="pend-h">Pending (1)<span class="pend-ok">' + ic("check") + 'Applied</span></div><div class="pend-f">' + ic("file") + 'index.html<span class="pl">+2</span><span class="mi">-1</span></div>' +
            '<div class="dl"><span class="n">21</span>' + esc('  <section class="hero">') + '</div><div class="dl del"><span class="n">22</span>' + esc("-   <h1>Coming soon</h1>") + "</div>" +
            '<div class="dl add"><span class="n">22</span>' + esc('+   <img src="rei.png" alt="Rei">') + '</div><div class="dl add"><span class="n">23</span>' + esc("+   <h1>Neon Rain, chapter one</h1>") + "</div>" +
            '<div class="dl"><span class="n">24</span>' + esc("  </section>") + '</div><div class="pend-b"><span class="btn apply">Apply</span><span class="btn">Reject</span></div></div></div>', "k3") +
        "</div>" + composer("Qwen 3 Coder", "LOCAL") + "</div>" +
        "</div>" + CUR + "</div>";
      var sChat = q(st, ".s-chat"), sCreate = q(st, ".s-create"), sCode = q(st, ".s-code"), ccmp = q(sCreate, ".ccmp");
      return {
        st: st, sChat: sChat, sCreate: sCreate, sCode: sCode, cur: q(st, ".cur"),
        navChat: q(st, '[data-nav="Chat"]'), navCreate: q(st, '[data-nav="Create"]'), railChat: q(st, '[data-r="chat"]'), railCode: q(st, '[data-r="code"]'), menu: q(st, ".tb-m"),
        cc: cmpRefs(q(sChat, ".cmp")), c1: q(sChat, ".c1"), c2: q(sChat, ".c2"), ans: q(sChat, ".ans"),
        pills: qa(sCreate, ".pill"), L: layerRefs(sCreate), info: { k: q(sCreate, ".k"), t: q(sCreate, ".t"), u: q(sCreate, ".u"), d: q(sCreate, ".d") },
        cty: q(ccmp, ".ty"), ccaret: q(ccmp, ".caret"), go: q(ccmp, ".go"), prog: q(sCreate, ".prog"), scan: q(sCreate, ".scan"), stp: q(sCreate, ".stp"),
        kc: cmpRefs(q(sCode, ".cmp")), k1: q(sCode, ".k1"), k2: q(sCode, ".k2"), k3: q(sCode, ".k3"), kt: q(sCode, ".tool"),
        dls: qa(sCode, ".dl"), del: q(sCode, ".dl.del"), adds: qa(sCode, ".dl.add"), pok: q(sCode, ".pend-ok"), pb: q(sCode, ".pend-b"), apply: q(sCode, ".btn.apply")
      };
    },
    render: function (t, r, P) {
      var inCreate = t >= 4 && t < 12.1, inCode = t >= 12.1 && t < 15.65;
      C(r.navChat, "on", !inCreate); C(r.navCreate, "on", inCreate);
      C(r.railChat, "on", !inCode); C(r.railCode, "on", inCode);
      if (t < 15.65) screen(r.sChat, t, 0, 4); else screen(r.sChat, t, 15.65, 99);
      screen(r.sCreate, t, 4, 12.1);
      screen(r.sCode, t, 12.1, 15.65);

      /* chat */
      var tc = t >= 15.65 ? t - 16 : t;
      compose(r.cc, tc, [[HX.q1, .25, 1.35, 1.5]]);
      grow(r.c1, tc, 1.5, .3); grow(r.c2, tc, 1.8, .3);
      words(r.ans, HX.a1, tc, 1.95, 3.6);

      /* create: Image, then Video, then Edit */
      var m = t < 6.6 ? 0 : t < 10.35 ? 1 : 2, K = [0, 5, 1][m];
      r.pills.forEach(function (p, i) { C(p, "on", i === K); });
      infoSet(r.info, K);
      var ps = [[HX.p[0], 4.35, 4.95], [HX.p[1], 6.7, 7.25], [HX.p[2], 10.45, 10.95]][m];
      typ(r.cty, ps[0], t, ps[1], ps[2]); O(r.ccaret, t >= ps[1] && t < ps[2] + .9 ? (t < ps[2] ? 1 : blink(t)) : 0);
      TR(r.go, "scale(" + Math.min(prs(t, 5.05), prs(t, 7.35), prs(t, 11.05)).toFixed(3) + ")");
      TR(r.info.u, "scaleX(" + E.o3(sg(t, [4, 6.6, 10.35][m], [4, 6.6, 10.35][m] + .4)).toFixed(3) + ")");
      var L0 = r.L[0], L5 = r.L[5], L1 = r.L[1];
      O(L0.el, t >= 5.1 ? 1 : 0); modeFx(L0, 0, t - 5.12, false, 1);
      O(L5.el, sg(t, 7.45, 7.6) * (1 - sg(t, 10.35, 10.55))); modeFx(L5, 5, t - 7.45, P.live(), 2.9);
      O(L1.el, t >= 11.1 ? 1 : 0); modeFx(L1, 1, t - 11.1, false, 1);
      genFx(r, t, [[5.1, 6.4, "gen"], [7.45, 10.35, "vid"], [11.1, 11.8, "gen"]]);

      /* code */
      compose(r.kc, t, [[HX.q2, 12.35, 13.15, 13.3]]);
      grow(r.k1, t, 13.3, .3); grow(r.k2, t, 13.55, .3); toolState(r.kt, t, 13.95);
      grow(r.k3, t, 14.05, .4);
      r.dls.forEach(function (d, i) { fin(d, t, 14.2 + i * .06, .22, 0); });
      var ap = E.io2(sg(t, 15.0, 15.22));
      S(r.del, "height", ((1 - ap) * 24).toFixed(1) + "px");
      r.adds.forEach(function (a) { S(a, "background-color", "rgba(52,211,153," + (.10 * (1 - sg(t, 15.05, 15.45))).toFixed(3) + ")"); });
      O(r.pok, sg(t, 15.05, 15.25)); O(r.pb, 1 - sg(t, 15.05, 15.2));
      TR(r.apply, "scale(" + prs(t, 14.97).toFixed(3) + ")");

      var st = r.st;
      cursor(r.cur, t, [
        [3.95, r.navCreate, .5, 1],
        [5.05, r.go, .55, 1],
        [6.58, function () { return pos(r.pills[5], st); }, .5, 1],
        [7.35, r.go, .5, 1],
        [8.6, function () { var p = pos(r.go, st); return [p[0] + 40, p[1] - 90]; }, .6],
        [10.32, r.pills[1], .6, 1],
        [11.05, r.go, .5, 1],
        [12.05, P.tall ? r.menu : r.railCode, .6, 1],
        [14.95, r.apply, .7, 1]
      ], st);
    }
  });

  /* CHAT: a filtered model refuses, LU writes the scene and draws it */
  var CH = {
    q1: "Write the scene where the nun finally speaks. Make it disturbing.",
    a1: 'She doesn\'t raise her voice. She never has to. "You prayed for a sign," she whispers, and every candle in the hall bends toward her. "I am the answer nobody wanted."',
    q2: "Now draw her."
  };
  scene("chat", {
    w: 720, h: 450, tw: 400, th: 520, D: 13.5, poster: 11,
    chapters: [[0, "Ask anything"], [1.95, "A filtered model refuses"], [3.85, "LU answers"], [7.2, "Ask for a picture"]],
    build: function (st) {
      st.innerHTML = '<div class="ap">' + topbar() + rail("chat") + '<div class="ap-main"><div class="feed">' +
        gw('<div class="bub">' + CH.q1 + "</div>", "g1") +
        gw('<div class="ghost"><span class="gh-k">Typical filtered model</span><span class="gh-t">I\'m sorry, but I can\'t help with that request.</span><i class="gh-bar"></i><span class="gh-stamp">REFUSED</span></div>', "g2") +
        gw('<div class="msg"><span class="av">' + LU + '</span><div class="ans"></div></div>', "g3") +
        gw('<div class="bub">' + CH.q2 + "</div>", "g4") +
        gw(msg(tool("image", "image_generate", "nun, candles, cinematic") + '<div class="gen">' + img("nun.webp") + '<i class="noise"></i><span class="stp"></span></div>'), "g5") +
        "</div>" + composer("Hermes 3 405B", "CLOUD") + "</div></div>";
      return { cm: cmpRefs(st), g: [1, 2, 3, 4, 5].map(function (i) { return q(st, ".g" + i); }), ans: q(st, ".ans"), bar: q(st, ".gh-bar"), stamp: q(st, ".gh-stamp"),
        tool: q(st, ".g5 .tool"), gimg: q(st, ".gen img"), noise: q(st, ".gen .noise"), stp: q(st, ".gen .stp") };
    },
    render: function (t, r) {
      compose(r.cm, t, [[CH.q1, .2, 1.45, 1.6], [CH.q2, 7.2, 7.75, 7.9]]);
      grow(r.g[0], t, 1.6, .3);
      grow(r.g[1], t, 1.95, .35, 3.55, .32);
      TR(r.bar, "scaleX(" + E.io2(sg(t, 2.85, 3.2)).toFixed(3) + ")");
      var sp = sg(t, 3.15, 3.35); O(r.stamp, sp); TR(r.stamp, "rotate(6deg) scale(" + (1.6 - .6 * E.o3(sp)).toFixed(3) + ")");
      grow(r.g[2], t, 3.85, .3);
      words(r.ans, CH.a1, t, 4.0, 6.9);
      grow(r.g[3], t, 7.9, .3);
      grow(r.g[4], t, 8.15, .35);
      toolState(r.tool, t, 10.25);
      var p = dev(r.gimg, t, 8.35, 1.85, r.noise);
      O(r.stp, p > 0 && p < 1 ? 1 : 0); T(r.stp, "STEP " + Math.max(1, Math.ceil(p * 28)) + " / 28");
    }
  });

  /* CREATE: all twelve modes, 1.45 s each */
  var MD = 1.45;
  scene("create", {
    w: 720, h: 450, tw: 400, th: 520, D: MD * 12, poster: MD * 5 + 1.1,
    chapters: MODES.map(function (m, k) { return [k * MD, m.s]; }),
    build: function (st) {
      var ls = ""; for (var k = 0; k < 12; k++) ls += layer(k);
      st.innerHTML = '<div class="ap ap--norail">' + topbar() + '<div class="ap-main">' + pills() + '<div class="cr-stage">' + ls + FX + "</div>" + info(true, true) +
        '<div class="ccmp"><span class="cmp-t"><span class="ty"></span><i class="caret"></i></span><span class="chip"><em>CLOUD</em>LU Cloud</span><span class="go">' + ic("spark") + "Create</span></div></div></div>";
      C(q(st, '[data-nav="Create"]'), "on", true);
      var gal = qa(st, ".gal i");
      return { pills: qa(st, ".pill"), L: layerRefs(st), info: { k: q(st, ".k"), t: q(st, ".t"), u: q(st, ".u"), d: q(st, ".d") }, gal: gal,
        ty: q(st, ".ccmp .ty"), caret: q(st, ".ccmp .caret"), go: q(st, ".go"), prog: q(st, ".prog"), scan: q(st, ".scan"), stp: q(st, ".stp") };
    },
    render: function (t, r, P) {
      var k = Math.min(11, Math.floor(t / MD)), a = k * MD, m = MODES[k];
      r.pills.forEach(function (p, i) { C(p, "on", i === k); });
      infoSet(r.info, k);
      TR(r.info.u, "scaleX(" + E.o3(sg(t, a, a + .4)).toFixed(3) + ")");
      typ(r.ty, m.p, t, a + .05, a + .5); O(r.caret, t < a + .5 ? 1 : blink(t));
      TR(r.go, "scale(" + prs(t, a + .56).toFixed(3) + ")");
      /* the result of mode k appears when Create is pressed and stays until
         the next one lands; each loop starts on an empty canvas */
      var show = t >= a + .6 ? k : k - 1;
      for (var i = 0; i < 12; i++) {
        var L = r.L[i], vis = i === show;
        O(L.el, vis ? 1 : 0);
        if (vis) modeFx(L, i, show === k ? t - (a + .6) : t - (show * MD + .6), P.live(), MD);
        else if (L.v) pauseV(L.v);
      }
      var gw0 = [5, 6].indexOf(k) >= 0 ? "vid" : "gen";
      genFx(r, t, [[a + .6, a + (gw0 === "vid" ? MD : 1.3), gw0]]);
      for (i = 0; i < 12; i++) O(r.gal[i], t >= i * MD + 1.3 ? 1 : .15);
    }
  });

  /* CODE: the temperature bug, diff first */
  var CD = { q1: "The temperature is always 0.15 too high. Find the bug.", a1: "Found it: line 8 adds 32.15 instead of 32." };
  scene("code", {
    w: 720, h: 450, tw: 400, th: 520, D: 11, poster: 4.9,
    chapters: [[0, "Describe the problem"], [1.85, "It reads your files"], [3.6, "You see the diff first"], [5.9, "Apply, then it tests"]],
    build: function (st) {
      st.innerHTML = '<div class="ap">' + topbar() + rail("code") + '<div class="ap-main"><div class="cd-head">' + ic("code") + "<span>Coding Agent</span>" + ic("folder", "fo") + '<span class="mono">weather-app</span><span class="cd-chip">Ask' + ic("down") + '</span></div><div class="feed">' +
        gw('<div class="bub">' + CD.q1 + "</div>", "g1") +
        gw(msg(tool("file", "file_read", "src/convert.py")), "g2") +
        gw('<div class="ind"><div class="ans"></div></div>', "g3") +
        gw('<div class="ind"><div class="pend"><div class="pend-h">Pending (1)<span class="pend-ok">' + ic("check") + 'Applied</span></div><div class="pend-f">' + ic("file") + 'src/convert.py<span class="pl">+1</span><span class="mi">-1</span></div>' +
          '<div class="dl"><span class="n">7</span>def to_fahrenheit(c):</div><div class="dl del"><span class="n">8</span>-    return c * 9 / 5 + 32.15</div><div class="dl add"><span class="n">8</span>+    return c * 9 / 5 + 32</div>' +
          '<div class="pend-b"><span class="btn apply">Apply</span><span class="btn">Reject</span></div></div></div>', "g4") +
        gw('<div class="ind">' + tool("term", "shell_execute", "pytest -q") + '<div class="res" style="margin-top:6px">' + ic("check") + "12 passed</div></div>", "g5") +
        "</div>" + composer("Qwen 3 Coder", "LOCAL") + "</div>" + CUR + "</div>";
      return { st: st, cm: cmpRefs(st), g: [1, 2, 3, 4, 5].map(function (i) { return q(st, ".g" + i); }), ans: q(st, ".g3 .ans"),
        t1: q(st, ".g2 .tool"), t3: q(st, ".g5 .tool"), res: q(st, ".res"), dls: qa(st, ".dl"), del: q(st, ".dl.del"), add: q(st, ".dl.add"),
        pok: q(st, ".pend-ok"), pb: q(st, ".pend-b"), apply: q(st, ".btn.apply"), cur: q(st, ".cur") };
    },
    render: function (t, r) {
      compose(r.cm, t, [[CD.q1, .2, 1.4, 1.55]]);
      grow(r.g[0], t, 1.55, .3);
      grow(r.g[1], t, 1.85, .3); toolState(r.t1, t, 2.35);
      grow(r.g[2], t, 2.5, .3); words(r.ans, CD.a1, t, 2.55, 3.3);
      grow(r.g[3], t, 3.6, .4);
      r.dls.forEach(function (d, i) { fin(d, t, 3.8 + i * .1, .25, 0); });
      var pulse = t > 4.2 && t < 5.9 ? .12 + .1 * Math.abs(Math.sin((t - 4.2) * 4)) : .12;
      var ap = E.io2(sg(t, 6.0, 6.22));
      S(r.del, "background-color", "rgba(248,113,113," + pulse.toFixed(3) + ")");
      S(r.del, "height", ((1 - ap) * 22).toFixed(1) + "px");
      S(r.add, "background-color", "rgba(52,211,153," + (.10 * (1 - sg(t, 6.05, 6.45))).toFixed(3) + ")");
      O(r.pok, sg(t, 6.05, 6.25)); O(r.pb, 1 - sg(t, 6.05, 6.2));
      TR(r.apply, "scale(" + prs(t, 5.92).toFixed(3) + ")");
      grow(r.g[4], t, 6.6, .35); toolState(r.t3, t, 7.6); pop(r.res, t, 7.65, .3);
      cursor(r.cur, t, [[5.9, r.apply, .7, 1]], r.st);
    }
  });

  /* AGENT: one sentence, four tools, a web page builds up next to the chat */
  var AG = { q1: "Build a landing page for my bakery. Warm colors, a menu, opening hours.", a1: "Done. Your page is running on localhost:8000." };
  scene("agent", {
    w: 720, h: 450, tw: 400, th: 520, D: 13, poster: 8,
    chapters: [[0, "Give it a goal"], [1.95, "It picks its tools"], [2.65, "It writes the files"], [5.2, "It runs the result"]],
    build: function (st) {
      st.innerHTML = '<div class="gnd"></div><div class="ap ap-win">' + topbar() + rail("chat") + '<div class="ap-main"><div class="feed">' +
        gw('<div class="bub">' + AG.q1 + "</div>", "g1") +
        gw(msg(tool("globe", "web_search", "bakery landing page ideas")), "g2") +
        gw('<div class="ind">' + tool("file", "file_write", "index.html") + "</div>", "g3") +
        gw('<div class="ind">' + tool("file", "file_write", "style.css") + "</div>", "g4") +
        gw('<div class="ind">' + tool("term", "shell_execute", "python -m http.server 8000") + "</div>", "g5") +
        gw('<div class="ind"><div class="ans"></div></div>', "g6") +
        "</div>" + composer("DeepSeek V3.2", "CLOUD", '<span class="mode">' + ic("bot") + "Agent</span>") + "</div></div>" +
        '<div class="br"><div class="br-bar"><i></i><i></i><i></i><div class="br-url"><b></b><span class="u"></span></div></div><div class="br-pg">' +
          '<div class="pg-raw"><h1>Crumb &amp; Co.</h1><p>Bread worth waking up for.</p><h2>Menu</h2><ul><li>Sourdough loaf, 4.50</li><li>Cinnamon roll, 3.20</li><li>Rye with seeds, 5.00</li></ul><h2>Opening hours</h2><p>Tuesday to Sunday, 7:00 to 14:00</p><p><a>Find us</a></p></div>' +
          '<div class="pg"><div class="pg-hero"><b>Crumb &amp; Co.</b><span>Bread worth waking up for.</span><em>See the menu</em></div>' +
            '<div class="pg-menu"><div><i style="background:linear-gradient(135deg,#e8b77a,#b8752f)"></i><b>Sourdough</b><small>4.50</small></div><div><i style="background:linear-gradient(135deg,#f3d3a3,#c98b4c)"></i><b>Cinnamon roll</b><small>3.20</small></div><div><i style="background:linear-gradient(135deg,#a07852,#5d3b22)"></i><b>Seeded rye</b><small>5.00</small></div></div>' +
            '<div class="pg-hours"><span>Tue to Sun</span><span>7:00 to 14:00</span></div></div>' +
        "</div></div>";
      return { cm: cmpRefs(st), g: [1, 2, 3, 4, 5, 6].map(function (i) { return q(st, ".g" + i); }), tools: qa(st, ".feed .tool"), ans: q(st, ".ans"),
        br: q(st, ".br"), url: q(st, ".br-url .u"), live: q(st, ".br-url b"), raw: q(st, ".pg-raw"), rawEls: qa(st, ".pg-raw > *"), pg: q(st, ".pg"), pgEls: qa(st, ".pg > *") };
    },
    render: function (t, r) {
      compose(r.cm, t, [[AG.q1, .2, 1.5, 1.65]]);
      grow(r.g[0], t, 1.65, .3);
      var T0 = [1.95, 2.65, 3.95, 5.2], T1 = [2.5, 3.2, 4.5, 5.8];
      for (var i = 0; i < 4; i++) { grow(r.g[i + 1], t, T0[i], .28); toolState(r.tools[i], t, T1[i]); }
      grow(r.g[5], t, 6.05, .3); words(r.ans, AG.a1, t, 6.1, 7.0);
      pop(r.br, t, 3.2, .38);
      r.rawEls.forEach(function (e, i) { fin(e, t, 3.3 + i * .07, .22, 6); });
      var sp = E.io2(sg(t, 4.5, 4.95));
      O(r.raw, 1 - sp); O(r.pg, sp);
      r.pgEls.forEach(function (e, i) { TR(e, sp >= 1 ? "none" : "translateY(" + ((1 - E.o3(sg(t, 4.5 + i * .08, 4.95 + i * .08))) * 14).toFixed(1) + "px)"); });
      T(r.url, t < 5.8 ? "C:/bakery/index.html" : "localhost:8000");
      C(r.live, "live", t >= 5.8);
    }
  });

  /* PHONE: QR, 6-digit code, then the phone asks and the PC renders */
  function qrPath(seed) {
    var n = 25, d = "", r = seed, x, y;
    function rnd() { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; }
    function inF(x, y) { return (x < 8 && y < 8) || (x > 16 && y < 8) || (x < 8 && y > 16); }
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (!inF(x, y) && rnd() > .5) d += "M" + x + " " + y + "h1v1h-1z";
    function fdr(ox, oy) { return "M" + ox + " " + oy + "h7v7h-7zM" + (ox + 1) + " " + (oy + 1) + "v5h5v-5zM" + (ox + 2) + " " + (oy + 2) + "h3v3h-3z"; }
    return '<svg viewBox="0 0 25 25" shape-rendering="crispEdges"><path fill="#111" fill-rule="evenodd" d="' + d + fdr(0, 0) + fdr(18, 0) + fdr(0, 18) + '"/></svg>';
  }
  var CODE6 = "418207";
  scene("phone", {
    w: 720, h: 450, tw: 400, th: 520, D: 12.5, poster: 8.6,
    chapters: [[0, "Scan the QR code"], [2.1, "Type the 6-digit code"], [3.9, "Your PC does the work"]],
    build: function (st) {
      var qr = qrPath(7), pcs = "";
      for (var i = 0; i < 6; i++) pcs += (i === 3 ? '<i class="gap"></i>' : "") + "<i>" + CODE6[i] + "</i>";
      var phs = ""; for (i = 0; i < 6; i++) phs += (i === 3 ? '<i class="gap"></i>' : "") + "<i></i>";
      var keys = ""; "123456789 0 ".split("").forEach(function (k) { keys += "<i>" + (k === " " ? "" : k) + "</i>"; });
      st.innerHTML = '<div class="gnd"></div><div class="ap ap-win">' + topbar() + rail("remote") + '<div class="ap-main"><div class="rm">' +
        '<div class="rm-h">Remote access<span class="rm-seg"><span class="on">LAN</span><span>Tunnel</span></span><span class="rm-tg"></span></div>' +
        '<div class="rm-b"><div class="qr">' + qr + '</div><div class="rm-c"><span class="rm-l">Passcode</span><div class="pc">' + pcs + '</div><div class="rm-s"><b></b><span class="s"></span></div></div></div>' +
        '<div class="rm-act"><div class="tool">' + ic("image") + '<span class="nm">image_generate</span><span class="ar">running on this PC</span><i class="spin"></i>' + ic("check", "ok") + '</div><div class="rm-bar"><i></i></div></div>' +
        "</div></div></div>" +
        '<div class="ph"><div class="ph-scr">' +
          '<div class="ph-v ph-cam"><div class="qr">' + qr + '</div><div class="ph-fr"></div><i class="ph-sl"></i><div class="ph-cap">Point at the QR code</div></div>' +
          '<div class="ph-v ph-code"><div class="t">Enter the 6-digit code</div><div class="s">It is shown on your PC</div><div class="pc">' + phs + '</div><div class="kp">' + keys + "</div></div>" +
          '<div class="ph-v ph-chat"><div class="hdr"><b></b>REMOTE</div><div class="feed">' +
            gw('<div class="bub">Draw a creature for my horror game.</div>', "g1") +
            gw('<div class="col2">' + tool("image", "image_generate", "on your PC") + '<div class="gen">' + img("alien.webp") + '<i class="noise"></i></div><div class="cap2">Rendered on your PC, sent to your phone.</div></div>', "g2") +
          '</div><div class="cmp"><span class="cmp-t"><span class="ty"></span><i class="caret"></i></span><span class="cmp-ph">Message...</span><span class="snd">' + ic("send") + "</span></div></div>" +
        "</div></div>";
      return { pcs: qa(st, ".rm .pc i:not(.gap)"), stDot: q(st, ".rm-s b"), stTx: q(st, ".rm-s .s"), act: q(st, ".rm-act"), actTool: q(st, ".rm-act .tool"), bar: q(st, ".rm-bar i"),
        cam: q(st, ".ph-cam"), code: q(st, ".ph-code"), chat: q(st, ".ph-chat"), sl: q(st, ".ph-sl"), fr: q(st, ".ph-fr"), phs: qa(st, ".ph-code .pc i:not(.gap)"), keys: qa(st, ".kp i"),
        cm: cmpRefs(q(st, ".ph-chat")), g1: q(st, ".ph-chat .g1"), g2: q(st, ".ph-chat .g2"), ptool: q(st, ".ph-chat .tool"), pimg: q(st, ".ph-chat .gen img"), pnoise: q(st, ".ph-chat .noise"), cap: q(st, ".cap2") };
    },
    render: function (t, r) {
      /* phone screens */
      screen(r.cam, t, 0, 2.1); screen(r.code, t, 2.1, 3.9); screen(r.chat, t, 3.9, 99);
      var sw = sg(t, .5, 1.8), found = sg(t, 1.8, 1.95);
      S(r.sl, "top", (26 + 36 * Math.abs(Math.sin(sw * Math.PI * 1.5))).toFixed(1) + "%"); O(r.sl, sw > 0 && sw < 1 ? 1 : 0);
      S(r.fr, "--tk", found > 0 && t < 2.1 ? "#a78bfa" : "#fff");
      /* digits, one every 0.2 s */
      var n = 0; for (var i = 0; i < 6; i++) { var at = 2.35 + i * .2; if (t >= at) n = i + 1; }
      r.phs.forEach(function (e, i) { T(e, i < n ? CODE6[i] : ""); C(e, "hit", i === n - 1 && t < 3.6); });
      r.pcs.forEach(function (e, i) { C(e, "hit", t >= 2.1 && t < 3.6 && i < n); });
      var kIdx = n ? "1234567890".indexOf(CODE6[n - 1]) : -1;
      r.keys.forEach(function (k, i) { var idx = i < 9 ? i : i === 10 ? 9 : -2; C(k, "hit", t < 3.6 && idx === kIdx && t - (2.35 + (n - 1) * .2) < .14); });
      var ok = t >= 3.55;
      C(r.stDot, "ok", ok); T(r.stTx, ok ? "Phone connected" : "Waiting for a device");
      /* chat from the phone */
      compose(r.cm, t, [["Draw a creature for my horror game.", 4.2, 5.3, 5.45]]);
      grow(r.g1, t, 5.45, .3); grow(r.g2, t, 5.75, .35);
      toolState(r.ptool, t, 7.95); dev(r.pimg, t, 5.95, 1.95, r.pnoise); fin(r.cap, t, 8.1, .3);
      fin(r.act, t, 5.7, .3, 8); toolState(r.actTool, t, 7.95);
      TR(r.bar, "scaleX(" + E.io2(sg(t, 5.7, 7.9)).toFixed(3) + ")");
    }
  });

  /* CLOUD: where the prompt runs, your PC or LU Cloud */
  scene("cloud", {
    w: 720, h: 450, tw: 400, th: 520, D: 12, poster: 9,
    chapters: [[0, "On your PC"], [6, "On LU Cloud"]],
    build: function (st) {
      st.innerHTML = '<div class="gnd"></div>' +
        '<div class="cl-tg"><i class="cl-knob"></i><span class="a">' + ic("cpu") + 'On your PC</span><span class="b">' + ic("cloud") + "LU Cloud</span></div>" +
        '<div class="cl-bd"><b>YOUR PC</b></div>' +
        '<svg class="cl-wire"><path class="wa" fill="none" stroke="rgba(196,181,253,.35)" stroke-width="2"/><path class="wa2" fill="none" stroke="#c4b5fd" stroke-width="4" stroke-linecap="round" stroke-dasharray=".1 13"/>' +
          '<path class="wb" fill="none" stroke="rgba(196,181,253,.35)" stroke-width="2" pathLength="1" stroke-dasharray="1 1"/><path class="wb2" fill="none" stroke="#c4b5fd" stroke-width="4" stroke-linecap="round" stroke-dasharray=".1 13"/></svg>' +
        '<div class="cl-card cl-app"><div class="hd">' + LU + 'Locally Uncensored</div><div class="cl-q">Write me a horror story</div><i class="cl-ln" style="width:100%"></i><i class="cl-ln" style="width:88%"></i><i class="cl-ln" style="width:94%"></i><i class="cl-ln" style="width:58%"></i></div>' +
        '<div class="cl-card cl-gpu"><div class="hd">' + ic("cpu") + 'Your graphics card</div><span class="sm">Runs the model right here</span><div class="cl-vr"><div class="l"><span>VRAM</span><span class="ld">MODEL LOADED</span></div><div class="b"><i></i></div></div><div class="cl-tags"><span>OFFLINE</span><span>FREE</span><span>PRIVATE</span></div></div>' +
        '<div class="cl-card cl-cl"><div class="hd">' + ic("cloud") + 'LU Cloud</div><span class="sm">Runs on our GPUs, no graphics card needed</span><div class="cl-row"><b>47</b>chat models</div><div class="cl-row"><b>7</b>open image models</div><div class="cl-row"><b>14</b>open video models</div></div>' +
        '<div class="cl-cap"><span class="c1">Free · private · works offline</span><span class="c2">From €19 a month · works on a Mac and a phone</span></div>';
      return { st: st, knob: q(st, ".cl-knob"), ta: q(st, ".cl-tg .a"), tb: q(st, ".cl-tg .b"), bd: q(st, ".cl-bd"), svg: q(st, ".cl-wire"), wa: q(st, ".wa"), wa2: q(st, ".wa2"), wb: q(st, ".wb"), wb2: q(st, ".wb2"),
        app: q(st, ".cl-app"), lines: qa(st, ".cl-ln"), gpu: q(st, ".cl-gpu"), vr: q(st, ".cl-vr .b i"), ld: q(st, ".cl-vr .ld"), cl: q(st, ".cl-cl"), c1: q(st, ".c1"), c2: q(st, ".c2"), cap: q(st, ".cl-cap") };
    },
    layout: function (r, tall) {
      var L = tall ? {
        bdA: [12, 70, 186, 362], bdB: [12, 70, 186, 172], app: [24, 90, 162, 140], gpu: [24, 262, 162, 156], cl: [212, 150, 176, 216],
        wa: "M105 230 L105 262", wb: "M186 150 C 206 150 196 250 212 256", vb: "0 0 400 520" } : {
        bdA: [30, 90, 432, 262], bdB: [30, 90, 216, 262], app: [50, 116, 176, 214], gpu: [264, 116, 178, 214], cl: [500, 92, 192, 262],
        wa: "M226 223 L264 223", wb: "M226 150 C 300 50 430 60 500 160", vb: "0 0 720 450" };
      r.G = L;
      function box(el, b) { S(el, "left", b[0] + "px"); S(el, "top", b[1] + "px"); S(el, "width", b[2] + "px"); S(el, "height", b[3] + "px"); }
      box(r.app, L.app); box(r.gpu, L.gpu); box(r.cl, L.cl);
      r.svg.setAttribute("viewBox", L.vb); r.wa.setAttribute("d", L.wa); r.wa2.setAttribute("d", L.wa); r.wb.setAttribute("d", L.wb); r.wb2.setAttribute("d", L.wb);
      S(r.cap, "bottom", tall ? "26px" : "22px");
    },
    render: function (t, r) {
      var G = r.G; if (!G) return;
      /* c = 0 local, 1 cloud; morph at 6 s and back at the loop */
      var c = t < 6 ? 1 - E.io3(sg(t, 0, .7)) : E.io3(sg(t, 6, 6.7));
      TR(r.knob, "translateX(" + (c * 124).toFixed(1) + "px)");
      C(r.ta, "on", c < .5); C(r.tb, "on", c >= .5);
      var bd = G.bdA.map(function (v, i) { return lr(v, G.bdB[i], c); });
      S(r.bd, "left", bd[0].toFixed(1) + "px"); S(r.bd, "top", bd[1].toFixed(1) + "px"); S(r.bd, "width", bd[2].toFixed(1) + "px"); S(r.bd, "height", bd[3].toFixed(1) + "px");
      O(r.gpu, 1 - .72 * c); S(r.gpu, "filter", c > .01 ? "grayscale(" + c.toFixed(2) + ")" : "none");
      O(r.cl, .28 + .72 * c); S(r.cl, "filter", c < .99 ? "grayscale(" + (1 - c).toFixed(2) + ")" : "none");
      /* wires: local runs through the short one, cloud draws the long one */
      O(r.wa, 1 - c); O(r.wa2, 1 - c);
      var draw = t >= 6 ? E.io2(sg(t, 6.2, 6.9)) : 1 - sg(t, 0, .35);
      S(r.wb, "stroke-dashoffset", (1 - draw).toFixed(3)); O(r.wb2, t >= 6 ? sg(t, 6.8, 7.0) : 1 - sg(t, 0, .2));
      S(r.wa2, "stroke-dashoffset", (-(t * 26) % 13.1).toFixed(2)); S(r.wb2, "stroke-dashoffset", (-(t * 34) % 13.1).toFixed(2));
      /* the answer streams in both modes */
      var s0 = t < 6 ? 1.2 : 7.2;
      r.lines.forEach(function (l, i) { TR(l, "scaleX(" + E.o2(sg(t, s0 + i * .75, s0 + i * .75 + .8)).toFixed(3) + ")"); });
      TR(r.vr, "scaleX(" + (t < 6 ? .78 * E.io2(sg(t, .8, 2.1)) : .78 * (1 - E.io2(sg(t, 6, 6.8)))).toFixed(3) + ")");
      T(r.ld, t < 6 ? (t < 2.1 ? "LOADING" : "MODEL LOADED") : "IDLE");
      O(r.c1, 1 - c); O(r.c2, c);
    }
  });

  /* SETUP: installer, first start wizard, a model that fits, first answer */
  var BE = ["Ollama", "LM Studio", "vLLM", "KoboldCpp", "Jan", "llama.cpp", "LocalAI", "GPT4All", "TabbyAPI", "Aphrodite", "SGLang", "TGI"];
  scene("setup", {
    w: 720, h: 450, tw: 400, th: 520, D: 12, poster: 6.8,
    chapters: [[0, "Download and install"], [3.6, "The wizard finds everything"], [7.8, "Chat. Code. Create."]],
    build: function (st) {
      var be = BE.map(function (b, i) { return '<div><i class="dot"></i>' + b + '<span class="st"></span></div>'; }).join("");
      st.innerHTML = '<div class="gnd"></div>' +
        '<div class="su-win su-in"><div class="su-tb">' + LU + 'Locally Uncensored 3.0.2 Setup<span class="x">' + ic("x2") + '</span></div><div class="su-bd"><div class="h">Installing Locally Uncensored</div><div class="s">Signed installer, about 14 MB. No Docker, no terminal.</div><div class="su-pb"><i></i></div><div class="su-tk"><span class="f"></span><span class="pc"></span></div></div><span class="su-btn">Finish</span></div>' +
        '<div class="su-win su-wz"><div class="su-tb">' + LU + 'First start</div><div class="su-bd"><div class="h">Looking for local AI engines</div><div class="s">Twelve backends, checked in a few seconds.</div><div class="be">' + be + '</div><div class="su-ft">Ollama and LM Studio found. You are set.</div></div><span class="su-btn">Continue</span></div>' +
        '<div class="su-win su-rd">' + '<div class="su-tb">' + LU + 'Locally Uncensored</div><div class="su-bd"><div class="su-card"><span class="ico">' + ic("spark") + '</span><div><div class="nm">Gemma 4 E4B</div><div class="ds">Recommended for this PC</div></div><div class="rb"><span class="lb">DOWNLOADING</span><div class="b"><i></i></div></div></div>' +
          '<div class="feed su-feed">' + gw('<div class="bub">Hi!</div>', "g1") + gw('<div class="msg"><span class="av">' + LU + '</span><div class="ans"></div></div>', "g2") + "</div>" + composer("Gemma 4 E4B", "LOCAL") + "</div></div>" + CUR;
      return { st: st, inW: q(st, ".su-in"), pb: q(st, ".su-in .su-pb i"), tkF: q(st, ".su-in .su-tk .f"), tkP: q(st, ".su-in .su-tk .pc"), fin: q(st, ".su-in .su-btn"),
        wz: q(st, ".su-wz"), rows: qa(st, ".be > div"), ft: q(st, ".su-ft"), cont: q(st, ".su-wz .su-btn"),
        rd: q(st, ".su-rd"), lb: q(st, ".rb .lb"), rbar: q(st, ".rb .b i"), cm: cmpRefs(q(st, ".su-rd")), g1: q(st, ".su-rd .g1"), g2: q(st, ".su-rd .g2"), ans: q(st, ".su-rd .ans"), cur: q(st, ".cur") };
    },
    layout: function (r, tall) {
      function box(el, b) { S(el, "left", b[0] + "px"); S(el, "top", b[1] + "px"); S(el, "width", b[2] + "px"); S(el, "height", b[3] + "px"); }
      if (tall) { box(r.inW, [20, 150, 360, 200]); box(r.wz, [14, 30, 372, 460]); box(r.rd, [14, 50, 372, 420]); S(q(r.wz, ".be"), "grid-template-columns", "1fr"); }
      else { box(r.inW, [150, 110, 420, 200]); box(r.wz, [110, 42, 500, 366]); box(r.rd, [90, 40, 540, 370]); S(q(r.wz, ".be"), "grid-template-columns", "1fr 1fr"); }
    },
    render: function (t, r) {
      /* installer */
      var inOn = t < 3.75;
      O(r.inW, inOn ? Math.min(E.o3(sg(t, .05, .35)), 1 - sg(t, 3.45, 3.7)) : 0);
      TR(r.inW, "scale(" + (inOn ? (t < 3.45 ? .94 + .06 * E.o3(sg(t, .05, .4)) : 1 - .04 * sg(t, 3.45, 3.7)) : 1).toFixed(3) + ")");
      var p = E.io2(sg(t, .35, 2.75));
      TR(r.pb, "scaleX(" + p.toFixed(3) + ")");
      var F = ["app files", "chat engine", "ComfyUI bridge", "model manager", "updater", "shortcuts"];
      T(r.tkF, p >= 1 ? "Done" : "Copying " + F[Math.min(5, Math.floor(p * 6))]); T(r.tkP, Math.round(p * 100) + "%");
      O(r.fin, sg(t, 2.85, 3.05)); TR(r.fin, "scale(" + prs(t, 3.28).toFixed(3) + ")");
      /* wizard */
      var wzOn = t >= 3.6 && t < 7.95;
      O(r.wz, wzOn ? Math.min(E.o3(sg(t, 3.6, 3.95)), 1 - sg(t, 7.55, 7.85)) : 0);
      TR(r.wz, "scale(" + (wzOn ? (t < 7.55 ? .94 + .06 * E.o3(sg(t, 3.6, 4)) : 1 - .04 * sg(t, 7.55, 7.85)) : 1).toFixed(3) + ")");
      r.rows.forEach(function (row, i) {
        var a = 4.0 + i * .2, st = row.__st || (row.__st = q(row, ".st")), dt = row.__d || (row.__d = q(row, ".dot")), f = i < 2;
        C(row, "cur2", t >= a && t < a + .2);
        T(st, t < a ? "" : t < a + .18 ? "checking" : f ? "found" : "not running");
        C(st, "f", f && t >= a + .18); C(dt, "f", f && t >= a + .18);
      });
      fin(r.ft, t, 6.55, .3, 6); O(r.cont, sg(t, 6.6, 6.8)); TR(r.cont, "scale(" + prs(t, 7.3).toFixed(3) + ")");
      /* ready */
      O(r.rd, t >= 7.8 ? E.o3(sg(t, 7.8, 8.15)) : 0);
      TR(r.rd, "scale(" + (.94 + .06 * E.o3(sg(t, 7.8, 8.2))).toFixed(3) + ")");
      var dp = E.io2(sg(t, 8.3, 9.5));
      TR(r.rbar, "scaleX(" + dp.toFixed(3) + ")"); T(r.lb, dp >= 1 ? "INSTALLED" : "DOWNLOADING");
      compose(r.cm, t, [["Hi!", 9.8, 10.0, 10.1]]);
      grow(r.g1, t, 10.1, .3); grow(r.g2, t, 10.3, .3); words(r.ans, "Hi! What do you want to make today?", t, 10.4, 11.2);
      cursor(r.cur, t, [[3.28, r.fin, .5, 1], [7.3, r.cont, .7, 1]], r.st);
    }
  });
  I.x2 = '<path d="M18 6 6 18M6 6l12 12"/>';

  /* ═══════════════════════════════ boot ═══════════════════════════════ */
  function boot() {
    var figs = qa(doc, ".mv[data-mv]");
    figs.forEach(function (f) { if (DEFS[f.getAttribute("data-mv")]) { var p = new Player(f); p.hero = f.classList.contains("mv--hero"); f.__mv = p; players.push(p); } });

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          var p = e.target.__mv; if (!p) return;
          /* the hero starts as soon as a strip of it shows under the fold */
          var v = e.isIntersecting && e.intersectionRatio >= (p.hero ? .08 : .3);
          if (v && !p.seen) { p.seen = true; if (!REDUCE) p.t = 0; }
          if (v !== p.vis) { p.vis = v; if (!v) p.vids.forEach(pauseV); p.draw(); if (v) kick(); }
        });
      }, { threshold: [0, .08, .3, .6] });
      players.forEach(function (p) { io.observe(p.fig); });
      var near = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { near.unobserve(e.target); e.target.__mv.wake(); } });
      }, { rootMargin: "900px 0px" });
      players.forEach(function (p) { near.observe(p.fig); });
    } else players.forEach(function (p) { p.wake(); p.vis = true; kick(); });

    if ("ResizeObserver" in window) {
      var ro = new ResizeObserver(function (es) { es.forEach(function (e) { var p = e.target.parentNode && e.target.parentNode.__mv; if (p) p.fit(); }); });
      players.forEach(function (p) { ro.observe(p.box); });
    } else window.addEventListener("resize", function () { players.forEach(function (p) { p.fit(); }); });

    doc.addEventListener("visibilitychange", function () {
      hidden = !!doc.hidden;
      if (hidden) players.forEach(function (p) { p.vids.forEach(pauseV); }); else kick();
    });
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(function () { players.forEach(function (p) { p.draw(); }); });

    /* headings: the censor bar collapses into the underscore when they come into view */
    var rx = qa(doc, ".rx"), gets = qa(doc, ".hp-get"), nums = qa(doc, "[data-count]");
    if ("IntersectionObserver" in window && !REDUCE) {
      var io2 = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting) return;
          var el = e.target; io2.unobserve(el);
          if (el.hasAttribute("data-count")) countUp(el); else el.classList.add("in");
        });
      }, { threshold: .6, rootMargin: "0px 0px -8% 0px" });
      rx.concat(gets, nums).forEach(function (el) { io2.observe(el); });
    } else rx.concat(gets).forEach(function (el) { el.classList.add("in"); });
  }
  function countUp(el) {
    var to = +el.getAttribute("data-count"), t0 = performance.now();
    function step(now) { var p = E.o3(sg(now - t0, 0, 900)); el.textContent = String(Math.round(to * p)); if (p < 1) requestAnimationFrame(step); }
    el.textContent = "0"; requestAnimationFrame(step);
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot); else boot();
})();
