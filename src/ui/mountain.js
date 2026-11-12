/* ARAL SULFUR — interactive pixel-art summit scene (embeddable component).
   Adapted from the standalone "aral-mountain" scene: calm sulfur night palette with
   honey-lime glow, container-scoped canvases, per-container pointer parallax and particle
   bursts. Auto-initializes every .aral-scene element on the page. */
(function () {
  'use strict';

  var K = {
    ink: '#151109',
    cream: '#f2ecdf',
    tan: '#b3a578',
    sky: ['#181510', '#201c12', '#2a2413', '#34301a'],
    moon: '#f6f2e4',
    moonHalo: '#e5eb70',
    hillFar: '#2b2418',
    hillNear: '#201c12',
    grass: ['#33301c', '#282512', '#1d1b0e', '#131208'],
    flowerHeart: '#f79082',
    rock: ['#8d857a', '#766f65', '#5f5952', '#4a453f', '#383430', '#2a2622'],
    snow: ['#f6f2e8', '#ddd6c4', '#c2bba7', '#a29b88'],
    far: ['#4a4130', '#3d3628', '#312b20', '#26221a'],
    farSnow: ['#e8e2d2', '#cfc7b2', '#b0a891'],
    pine: ['#232a1a', '#2c3420', '#364026'],
    glow: '#e5eb70'
  };

  var REDUCED = (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) || false;
  var MOTION = REDUCED ? 0 : 1;

  var bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  function RNG(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  function layer(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function R(v) { return Math.round(v); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function dither(cols, t, x, y) {
    var p = Math.min(cols.length - 1, Math.max(0, t) * (cols.length - 1)), i = Math.min(cols.length - 2, Math.floor(p));
    return (p - i) > bayer[y & 3][x & 3] / 16 ? cols[i + 1] : cols[i];
  }
  function rect(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); }

  function mkNoise(seed) { var r = RNG(seed), v = []; for (var i = 0; i < 256; i++) v.push(r()); return function (x) { var i = Math.floor(x), f = x - i, t = f * f * (3 - 2 * f); return v[i & 255] + (v[(i + 1) & 255] - v[i & 255]) * t; }; }
  var nz = mkNoise(31);
  function fbm(x, y) { return nz(x + y * 1.3) * 0.6 + nz(x * 2.3 - y * 1.7 + 17) * 0.28 + nz(x * 4.9 + y * 3.1 + 41) * 0.12; }

  function blade(ctx, x, y, h, lean, fill) {
    var rows = [];
    for (var i = 0; i < h; i++) rows.push([x + R(lean * i / h), y - 1 - i, i < h * 0.45 ? 2 : 1]);
    for (var j = 0; j < rows.length; j++) rect(ctx, rows[j][0] - 1, rows[j][1], rows[j][2] + 2, 1, K.ink);
    var t = rows[rows.length - 1]; rect(ctx, t[0], t[1] - 1, t[2], 1, K.ink);
    for (var k = 0; k < rows.length; k++) rect(ctx, rows[k][0], rows[k][1], rows[k][2], 1, fill);
  }

  function makeCloud(w, rnd) {
    var h = R(w * 0.4), g = layer(w + 2, h + 2), x = g.getContext('2d'), base = h, n = 5 + Math.floor(rnd() * 3), cs = [];
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n, hump = 1 - Math.pow(2 * t - 1, 2) * 0.65, r = (h / 1.85) * (0.42 + 0.58 * hump) * (0.65 + 0.35 * rnd());
      cs.push([w * (0.14 + 0.72 * t) + (rnd() - 0.5) * w * 0.04, base - r * 0.8, r]);
    }
    var m = [];
    for (var yy = 0; yy < h + 2; yy++) { m[yy] = []; for (var xx = 0; xx < w + 2; xx++) { var px = xx - 1, py = yy - 1; m[yy][xx] = py < base && py >= 0 && cs.some(function (c) { return (px - c[0]) * (px - c[0]) + (py - c[1]) * (py - c[1]) <= c[2] * c[2]; }); } }
    for (var y2 = 1; y2 <= h; y2++) for (var x2 = 1; x2 <= w; x2++) {
      if (!m[y2][x2]) continue;
      var edge = !m[y2 - 1][x2] || !m[y2 + 1][x2] || !m[y2][x2 - 1] || !m[y2][x2 + 1], py2 = y2 - 1, c = K.cream;
      if (edge) c = K.ink; else if (py2 >= base - 3) c = K.tan; else if (py2 === base - 4 && ((x2 + y2) & 1) === 0) c = K.tan;
      rect(x, x2, y2, 1, 1, c);
    }
    return g;
  }

  function pine(ctx, x, yb, h, rnd) {
    var rows = [];
    for (var i = 0; i < h; i++) rows.push([x, yb - h + i, 1 + 2 * Math.floor(i / 3)]);
    rect(ctx, x - 1, yb - 1, 3, 3, K.ink);
    for (var j = 0; j < rows.length; j++) rect(ctx, rows[j][0] - (rows[j][2] >> 1) - 1, rows[j][1], rows[j][2] + 2, 1, K.ink);
    rect(ctx, x, yb - h - 1, 1, 1, K.ink);
    for (var k = 0; k < rows.length; k++) {
      var w = rows[k][2], l = rows[k][0] - (w >> 1);
      rect(ctx, l, rows[k][1], w, 1, K.pine[0]);
      rect(ctx, l, rows[k][1], Math.max(1, (w >> 1) + ((rows[k][1] & 1) ? 0 : 1)), 1, K.pine[rnd() < 0.8 ? 1 : 2]);
    }
    rect(ctx, x, yb - 1, 1, 2, '#2c2318');
  }

  /* 5x7 pixel glyphs spelling the wordmark */
  var GLY = {
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    r: ['....', '....', '#.##', '##..', '#...', '#...', '#...'],
    a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
    l: ['##.', '.#.', '.#.', '.#.', '.#.', '.#.', '.##']
  };
  var WORD = 'Aral';

  function Scene(root) {
    this.root = root;
    this.back = root.querySelector('.as-back');
    this.front = root.querySelector('.as-front');
    if (!this.back || !this.front) return;
    this.bctx = this.back.getContext('2d');
    this.fctx = this.front.getContext('2d');
    this.mx = 0.5; this.par = 0; this.energy = 0; this.prev = null; this.pulse = 0;
    this.parts = []; this.glints = []; this.acc = 0; this.last = performance.now();
    this.dead = false;
    this.bind();
    this.build();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  Scene.prototype.bind = function () {
    var self = this;
    this.onMove = function (e) {
      var r = self.root.getBoundingClientRect();
      if (!r.width) return;
      self.mx = clamp((e.clientX - r.left) / r.width, 0, 1);
      var now = performance.now();
      if (self.prev) { var sp = Math.hypot(e.clientX - self.prev.x, e.clientY - self.prev.y) / Math.max(1, now - self.prev.t); self.energy = Math.min(1.6, self.energy + sp * 0.1); }
      self.prev = { x: e.clientX, y: e.clientY, t: now };
    };
    this.onLeave = function () { self.prev = null; };
    this.onDown = function () {
      self.pulse = 1; self.energy = 1.6;
      if (self.S && !REDUCED) {
        for (var i = 0; i < 70; i++) self.spawn(2.6);
        for (var j = 0; j < 8; j++) self.addGlint();
      }
    };
    this.root.addEventListener('pointermove', this.onMove, { passive: true });
    this.root.addEventListener('pointerleave', this.onLeave, { passive: true });
    this.root.addEventListener('pointerdown', this.onDown, { passive: true });

    this.onResize = function () {
      clearTimeout(self.rt); self.rt = setTimeout(function () { self.build(); }, 140);
    };
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this.onResize);
      this.ro.observe(this.root);
    } else if (window.addEventListener) {
      window.addEventListener('resize', this.onResize);
    }
  };

  Scene.prototype.spawn = function (boost) {
    if (!this.S) return;
    var S = this.S;
    var x = S.peakX + 1 + Math.random() * 6, tx = clamp(R(x), 0, S.cols - 1);
    var y = S.top[tx] - 1 - Math.random() * 2;
    var sp = (16 + Math.random() * 26) * (boost || (1 + this.energy * 0.5));
    this.parts.push({ x: x, y: y, vx: sp, vy: -2 - Math.random() * 7 * (boost ? 1.6 : 1), age: 0, life: 1.2 + Math.random() * 1.8, ph: Math.random() * 6.28, s: Math.random() < 0.3 ? 2 : 1, w: Math.random() < 0.5 });
    if (this.parts.length > 420) this.parts.shift();
  };

  Scene.prototype.addGlint = function () {
    if (!this.S || !this.S.rim.length) return;
    var g = this.S.rim[Math.floor(Math.random() * this.S.rim.length)];
    this.glints.push({ x: g[0], y: g[1] - 1, t0: performance.now(), dur: 420 + Math.random() * 260 });
  };

  Scene.prototype.build = function () {
    var vw = this.root.clientWidth || 0;
    var vh = this.root.clientHeight || 0;
    if (vw < 40 || vh < 40) return; // hidden container — ResizeObserver will rebuild once visible
    var baseW = Math.min(vw * 0.84, vh * 0.68 * 1095 / 1162);
    var CELL = Math.max(vw < 700 ? 3 : 2, R(5 * baseW / 1095));
    var cols = Math.ceil(vw / CELL), rows = Math.ceil(vh / CELL);
    var back = this.back, front = this.front;
    back.width = cols; back.height = rows; back.style.width = cols * CELL + 'px'; back.style.height = rows * CELL + 'px';
    front.width = cols; front.height = rows; front.style.width = cols * CELL + 'px'; front.style.height = rows * CELL + 'px';
    var gy = R((vh * 0.89 - 0.035 * baseW * 1162 / 1095) / CELL);
    var rnd = RNG(7);
    var self = this;

    /* sky + moon + stars */
    var sky = layer(cols, rows), sx = sky.getContext('2d');
    for (var y0 = 0; y0 < gy; y0++) for (var x0 = 0; x0 < cols; x0++) rect(sx, x0, y0, 1, 1, dither(K.sky, y0 / gy, x0, y0));
    {
      var sr = R(Math.min(gy * 0.07, cols * 0.06)), scx = R(Math.max(sr * 2.2, cols * 0.17)), scy = R(gy * 0.2);
      for (var y1 = scy - sr * 3; y1 <= scy + sr * 3; y1++) for (var x1 = scx - sr * 3; x1 <= scx + sr * 3; x1++) {
        if (x1 < 0 || y1 < 0 || x1 >= cols || y1 >= gy) continue;
        var d = Math.hypot(x1 - scx, y1 - scy);
        if (d <= sr - 1) rect(sx, x1, y1, 1, 1, K.moon);
        else if (d <= sr) rect(sx, x1, y1, 1, 1, K.ink);
        else if (d < sr * 2.6) { var t = (d - sr) / (sr * 1.6); if ((1 - t) * 0.8 > bayer[(y1 + 1) & 3][(x1 + 2) & 3] / 16) rect(sx, x1, y1, 1, 1, K.moonHalo); }
      }
      var st = RNG(2024), stars = Math.floor(cols * gy / 900);
      for (var s2 = 0; s2 < stars; s2++) {
        var sxp = R(st() * cols), syp = R(st() * gy * 0.85);
        if (st() < 0.5 && syp < scy + sr && sxp < scx + sr * 3 && sxp > scx - sr * 3) continue;
        rect(sx, sxp, syp, 1, 1, st() < 0.22 ? K.glow : (st() < 0.5 ? K.cream : '#8fae9d'));
      }
    }

    /* main summit geometry */
    var Hm = Math.min(gy * 0.80, cols * (cols < rows ? 1.35 : 0.70));
    var halfW = Math.min(Hm * 1.2, cols * 0.62);
    var pcx = R(cols * 0.52);
    var P = [
      { c: pcx, h: Hm, wl: halfW, wr: halfW * 0.85, p: 1.30 },
      { c: pcx - halfW * 0.17, h: Hm * 0.84, wl: halfW * 0.30, wr: halfW * 0.30, p: 1.15 },
      { c: pcx - halfW * 0.66, h: Hm * 0.56, wl: halfW * 0.50, wr: halfW * 0.45, p: 1.20 },
      { c: pcx + halfW * 0.62, h: Hm * 0.48, wl: halfW * 0.45, wr: halfW * 0.50, p: 1.20 },
      { c: pcx - halfW * 0.98, h: Hm * 0.30, wl: halfW * 0.40, wr: halfW * 0.35, p: 1.10 },
      { c: pcx + halfW * 1.00, h: Hm * 0.28, wl: halfW * 0.35, wr: halfW * 0.40, p: 1.10 }
    ];
    var top = [], pkH = [];
    for (var x2 = 0; x2 < cols; x2++) {
      var hh = 0, hi = 0;
      for (var pi = 0; pi < P.length; pi++) {
        var pk = P[pi], dd = x2 - pk.c, w = dd < 0 ? pk.wl : pk.wr;
        var v = pk.h * Math.pow(Math.max(0, 1 - Math.abs(dd) / w), pk.p);
        if (v > hh) { hh = v; hi = pi; }
      }
      var frac = hh / Hm;
      var jag = (fbm(x2 * 0.07, 3) - 0.5) * Hm * 0.10 * Math.min(1, frac * 2.2) + (nz(x2 * 0.5) - 0.5) * Hm * 0.03 * Math.min(1, frac * 3);
      top[x2] = hh < 0.6 ? gy : Math.min(gy, R(gy - hh - jag));
      pkH[x2] = P[hi].h;
    }
    var peakX = 0, peakTop = gy;
    for (var x3 = 0; x3 < cols; x3++) if (top[x3] < peakTop) { peakTop = top[x3]; peakX = x3; }
    function T(x) { return top[clamp(x, 0, cols - 1)]; }

    /* far hazy range with parallax */
    var PAD = 24, far = layer(cols + PAD * 2, rows), fx = far.getContext('2d');
    {
      var FP = [[-0.95, 0.46, 0.55], [-0.55, 0.62, 0.6], [-0.12, 0.50, 0.5], [0.38, 0.66, 0.55], [0.82, 0.52, 0.6], [1.2, 0.58, 0.55]];
      var ft = [], fh = [];
      for (var X = 0; X < cols + PAD * 2; X++) {
        var xx = X - PAD, hh2 = 0, side = 0;
        for (var fi = 0; fi < FP.length; fi++) {
          var F = FP[fi], c = pcx + F[0] * halfW, w2 = halfW * F[2], d2 = xx - c;
          var v2 = Hm * F[1] * Math.pow(Math.max(0, 1 - Math.abs(d2) / w2), 1.15);
          if (v2 > hh2) { hh2 = v2; side = d2 < 0 ? -1 : 1; }
        }
        hh2 += (fbm(xx * 0.09, 8) - 0.5) * Hm * 0.05 * Math.min(1, hh2 / Hm * 3);
        ft[X] = hh2 < 0.6 ? gy : R(gy - hh2); fh[X] = [hh2, side];
      }
      for (var X2 = 0; X2 < cols + PAD * 2; X2++) {
        if (ft[X2] >= gy) continue;
        for (var y4 = ft[X2]; y4 < gy; y4++) {
          var h4 = gy - y4, FH = fh[X2], side2 = FH[1];
          var snow = h4 > FH[0] * 0.80 && FH[0] > Hm * 0.36;
          var t4 = (side2 < 0 ? 0.22 : 0.62) + (fbm(X2 * 0.06, y4 * 0.1) - 0.5) * 0.3 - (1 - h4 / Hm) * 0.25;
          rect(fx, X2, y4, 1, 1, snow ? dither(K.farSnow, side2 < 0 ? 0.1 : 0.7, X2, y4) : dither(K.far, clamp(t4, 0, 1), X2, y4));
        }
        var a4 = ft[X2];
        var span = Math.max(a4, Math.max(ft[Math.max(0, X2 - 1)] || a4, ft[Math.min(cols + PAD * 2 - 1, X2 + 1)] || a4) - 1);
        rect(fx, X2, a4, 1, Math.min(span - a4 + 1, 40), '#2c3d36');
      }
    }

    /* main summit rock + snow */
    var mtn = layer(cols, rows), mx_ = mtn.getContext('2d');
    var rimCells = [];
    {
      var slopeK = halfW / Hm / 1.2;
      var RM = [-1.15, -0.62, -0.10, 0.40, 0.95].map(function (m) { return m * slopeK; }), RP2 = [11, 23, 37, 52, 66];
      var facetT = [0.42, 0.10, 0.30, 0.80, 0.62, 0.92];
      function ridgeX(k, y) { return peakX + (y - peakTop) * RM[k] + (fbm(y * 0.05 + RP2[k], k) - 0.5) * Hm * 0.18 * Math.min(1, (y - peakTop) / (Hm * 0.35)); }
      var rx = [];
      for (var y5 = peakTop; y5 < gy; y5++) { rx[y5] = []; for (var k2 = 0; k2 < 5; k2++) rx[y5][k2] = ridgeX(k2, y5); }
      for (var x6 = 0; x6 < cols; x6++) {
        if (top[x6] >= gy) continue;
        for (var y6 = top[x6]; y6 < gy; y6++) {
          var xr = rx[y6] || rx[peakTop];
          var f = 0; for (var k3 = 0; k3 < 5; k3++) if (xr[k3] <= x6) f++;
          var onRidge = false; for (var k4 = 0; k4 < 5; k4++) if (Math.abs(xr[k4] - x6) < 0.6) onRidge = true;
          var t6 = facetT[f] + (fbm(x6 * 0.045, y6 * 0.09) - 0.5) * 0.30 + 0.10 * ((y6 - top[x6]) / Hm);
          var h6 = gy - y6;
          var snowThresh = Math.min(pkH[x6] * 0.78, Hm * 0.64) + (fbm(x6 * 0.08, 9) - 0.5) * Hm * 0.2 + Math.abs(Math.sin(x6 * 0.33)) * Hm * 0.02;
          var sd = h6 - snowThresh;
          var col;
          if (sd > 0 || (sd > -4 && (sd + 4) / 5 > bayer[y6 & 3][x6 & 3] / 16)) {
            var ts = clamp(t6 * 0.9 + (onRidge ? 0.22 : 0), 0, 1);
            col = dither(K.snow, ts, x6, y6);
          } else {
            col = dither(K.rock, clamp(t6 + (onRidge ? 0.25 : 0), 0, 1), x6, y6);
          }
          rect(mx_, x6, y6, 1, 1, col);
        }
      }
      var cr = RNG(99), N = Math.floor(cols * Hm / 70);
      for (var i7 = 0; i7 < N; i7++) {
        var x7 = R(cr() * cols), y7 = R(peakTop + cr() * (gy - peakTop));
        if (top[x7] >= gy || y7 < top[x7] + 3) continue;
        if (gy - y7 > Math.min(pkH[x7] * 0.78, Hm * 0.64) - 2) continue;
        var xr2 = rx[y7] || rx[peakTop]; var f2 = 0; for (var k5 = 0; k5 < 5; k5++) if (xr2[k5] <= x7) f2++;
        var c7 = f2 <= 2 ? '#4d5a54' : '#25303f', len = 2 + R(cr() * 6), lean = (f2 <= 2 ? -1 : 1) * (cr() < 0.5 ? 0.5 : 0.25);
        for (var j7 = 0; j7 < len; j7++) { var cx7 = R(x7 + lean * j7), cy7 = y7 + j7; if (cx7 >= 0 && cx7 < cols && cy7 > top[cx7] + 2 && cy7 < gy) rect(mx_, cx7, cy7, 1, 1, c7); }
      }
      for (var x8 = 0; x8 < cols; x8++) {
        if (top[x8] >= gy) continue;
        var a8 = top[x8], b8 = Math.max(a8, Math.max(T(x8 - 1), T(x8 + 1)) - 1);
        rect(mx_, x8, a8, 1, Math.min(b8 - a8 + 1, 60), K.ink);
        if (gy - a8 > Hm * 0.55 && x8 % 3 === 0) rimCells.push([x8, a8]);
      }
    }

    /* wordmark carved into the rock */
    var widthAt = function (y) { var l = -1, r = -1; for (var x = 0; x < cols; x++) if (top[x] <= y) { if (l < 0) l = x; r = x; } return [l, r]; };
    var s = Math.max(2, Math.floor(cols * (cols < rows ? 0.05 : 0.022))), tw, th, tx, ty;
    var calc = function () {
      tw = 20 * s; th = 7 * s;
      var cy = gy - (rows * 0.165 + th / 2 + 10);
      ty = R(cy - th / 2);
      return widthAt(ty);
    };
    for (; s >= 2; s--) { var lr = calc(); if (lr[1] - lr[0] > tw + 16 + s * 2) break; }
    var wlwr = calc(); tx = R((wlwr[0] + wlwr[1]) / 2 - tw / 2);
    var E = Math.max(2, R(s * 0.5)), OW = s >= 6 ? 2 : 1, PADT = OW + E + 2;
    var TW = tw + PADT * 2, TH = th + PADT * 2;
    var textC = layer(TW, TH), tc = textC.getContext('2d');
    var mask = new Uint8Array(TW * TH), uni = new Uint8Array(TW * TH), letters = [];
    { var ox = 0;
      for (var ci = 0; ci < WORD.length; ci++) {
        var g = GLY[WORD[ci]];
        for (var gy2 = 0; gy2 < 7; gy2++) for (var gx = 0; gx < g[gy2].length; gx++) if (g[gy2][gx] === '#')
          for (var dy = 0; dy < s; dy++) for (var dx = 0; dx < s; dx++) mask[(PADT + gy2 * s + dy) * TW + PADT + (ox + gx) * s + dx] = 1;
        ox += g[0].length + 1;
      } }
    for (var y9 = 0; y9 < TH; y9++) for (var x9 = 0; x9 < TW; x9++) if (mask[y9 * TW + x9])
      for (var e9 = 0; e9 <= E; e9++) { var xx9 = x9 + e9, yy9 = y9 + e9; if (xx9 < TW && yy9 < TH) uni[yy9 * TW + xx9] = 1; }
    for (var yA = 0; yA < TH; yA++) for (var xA = 0; xA < TW; xA++) {
      if (uni[yA * TW + xA]) continue;
      var near = false;
      for (var dyA = -OW; dyA <= OW && !near; dyA++) for (var dxA = -OW; dxA <= OW; dxA++) {
        var xxA = xA + dxA, yyA = yA + dyA; if (xxA >= 0 && yyA >= 0 && xxA < TW && yyA < TH && uni[yyA * TW + xxA]) { near = true; break; } }
      if (near) rect(tc, xA, yA, 1, 1, K.ink);
    }
    for (var yB = 0; yB < TH; yB++) for (var xB = 0; xB < TW; xB++) {
      var iB = yB * TW + xB;
      if (uni[iB] && !mask[iB]) rect(tc, xB, yB, 1, 1, '#123526');
    }
    for (var yC = 0; yC < TH; yC++) for (var xC = 0; xC < TW; xC++) {
      var iC = yC * TW + xC; if (!mask[iC]) continue;
      var ly = (yC - PADT) / th;
      var cC = ly < 0.5 ? '#eafff2' : ly < 0.8 ? '#a5e8c8' : '#6bbf9a';
      if (!mask[iC - 1] || !mask[iC - TW]) cC = '#ffffff';
      else if (!mask[iC + 1] || !mask[iC + TW]) cC = '#3fae83';
      rect(tc, xC, yC, 1, 1, cC);
      letters.push([xC, yC]);
    }
    var textX = tx - PADT, textY = ty - PADT;

    /* hills, pines, meadow */
    var land = layer(cols, rows), lx = land.getContext('2d');
    var h1s = [];
    for (var xD = 0; xD < cols; xD++) {
      var h1 = gy - R(rows * 0.10 + rows * 0.04 * Math.sin(xD * 0.012 + 0.8) + rows * 0.02 * Math.sin(xD * 0.031)); h1s[xD] = h1;
      rect(lx, xD, h1, 1, gy - h1, K.hillFar);
      var h2 = gy - R(rows * 0.045 + rows * 0.025 * Math.sin(xD * 0.02 + 3) + rows * 0.012 * Math.sin(xD * 0.07));
      rect(lx, xD, h2, 1, gy - h2, K.hillNear);
    }
    { var pr = RNG(404); var xE = 3;
      var ph = Math.max(7, R(rows * 0.035));
      while (xE < cols - 3) {
        var nE = 1 + R(pr() * 3);
        for (var iE = 0; iE < nE && xE < cols - 3; iE++) { pine(lx, xE, h1s[xE] + 3 + R(pr() * 3), ph + R(pr() * ph * 0.7), pr); xE += 4 + R(pr() * 5); }
        xE += 6 + R(pr() * Math.max(12, cols * 0.04));
      } }
    var tops = [];
    for (var xF = 0; xF < cols; xF++) {
      var top2 = gy + R(1.4 * Math.sin(xF * 0.045) + Math.sin(xF * 0.11 + 2)); tops[xF] = top2;
      rect(lx, xF, top2, 1, 1, K.ink);
      for (var yF = top2 + 1; yF < rows; yF++) rect(lx, xF, yF, 1, 1, dither(K.grass, Math.min(1, (yF - top2) / (rows - top2 + 6)), xF, yF));
    }
    for (var iG = 0; iG < cols * 0.9; iG++) {
      var xG = R(rnd() * cols), yG = tops[Math.min(cols - 1, xG)] + 3 + R(rnd() * (rows - gy)), wG = 1 + R(rnd() * 3);
      rect(lx, xG, yG, wG, 1, rnd() < 0.5 ? K.grass[2] : K.grass[0]);
    }
    for (var xH = 0; xH < cols; xH += 2 + R(rnd() * 3))
      blade(lx, xH, tops[xH], 2 + R(rnd() * 3), R((rnd() - 0.5) * 4), rnd() < 0.6 ? K.grass[0] : K.grass[1]);
    for (var iI = 0; iI < cols / 60; iI++) {
      var xI = R(rnd() * (cols - 4)) + 1, yI = tops[xI];
      rect(lx, xI + 1, yI - 4, 1, 4, K.ink); rect(lx, xI, yI - 6, 3, 3, K.ink);
      rect(lx, xI + 1, yI - 5, 1, 1, K.flowerHeart); rect(lx, xI, yI - 5, 1, 1, K.cream); rect(lx, xI + 2, yI - 5, 1, 1, K.cream);
    }

    /* clouds */
    var cr2 = RNG(21), clouds = [], cn = Math.max(4, R(cols / 110));
    for (var iJ = 0; iJ < cn; iJ++) {
      var depth = 0.4 + 0.6 * cr2(), wJ = R(cols * (0.06 + 0.09 * depth * cr2() + 0.03));
      clouds.push({ g: makeCloud(wJ, cr2), w: wJ, depth: depth, x: cr2() * (cols + wJ) - wJ, y: R(gy * (0.05 + 0.42 * cr2())), v: 0.5 + 1.3 * depth });
    }
    clouds.sort(function (a, b) { return a.depth - b.depth; });
    var fc = RNG(77), fclouds = [0.10, 0.22].map(function (f, i) { var w = R(cols * (0.09 + 0.03 * i)); return { g: makeCloud(w, fc), w: w, x: fc() * cols, y: R(peakTop + Hm * f), v: 0.7 + 0.6 * i }; });

    /* foreground tufts */
    var fr = RNG(5), tufts = [];
    for (var iK = 0; iK < cols / 9; iK++) tufts.push({ x: R(fr() * cols), y: gy + 5 + R(fr() * Math.max(3, (rows - gy) * 0.5)), h: 3 + R(fr() * 3), col: fr() < 0.5 ? K.grass[0] : K.grass[1] });

    this.S = {
      cols: cols, rows: rows, sky: sky, far: far, mtn: mtn, land: land, clouds: clouds, fclouds: fclouds,
      tufts: tufts, top: top, peakX: peakX, peakTop: peakTop, Hm: Hm, rim: rimCells, PAD: PAD,
      text: { c: textC, x: textX, y: textY, tw: tw, th: th, s: s, tx: tx, ty: ty, letters: letters, TW: TW, TH: TH, PADT: PADT }
    };
    this.parts.length = 0; this.glints.length = 0;
  };

  Scene.prototype.loop = function (now) {
    if (this.dead) return;
    var dt = Math.min(64, now - this.last) / 1000; this.last = now;
    var S = this.S;
    if (S) {
      this.energy *= Math.pow(0.35, dt);
      this.pulse = Math.max(0, this.pulse - dt * 1.4);
      this.par += ((this.mx - 0.5) - this.par) * 0.05;
      var ox = R(this.par * 3), sec = now / 1000;
      var bctx = this.bctx, fctx = this.fctx;

      bctx.drawImage(S.sky, 0, 0);
      for (var c = 0; c < S.clouds.length; c++) {
        var cl = S.clouds[c];
        if (!REDUCED) { cl.x += cl.v * dt; if (cl.x > S.cols) cl.x = -cl.w; }
        bctx.drawImage(cl.g, Math.floor(cl.x + this.par * 14 * cl.depth), cl.y);
      }
      bctx.drawImage(S.far, -S.PAD + R(this.par * 8), 0);
      bctx.drawImage(S.mtn, ox, 0);
      var T = S.text;
      bctx.drawImage(T.c, T.x + ox, T.y);
      var bw = T.s * 1.0, span = T.tw + 0.55 * T.th + bw * 4, cyc = 3.6;
      var band = REDUCED ? -999 : ((sec % cyc) / cyc) * span - bw * 2;
      for (var li = 0; li < T.letters.length; li++) {
        var LX = T.letters[li][0], LY = T.letters[li][1];
        var u = (LX - T.PADT) + (LY - T.PADT) * 0.55, d = Math.abs(u - band);
        var cc = null;
        if (d < bw * 0.5) cc = '#ffffff'; else if (d < bw) cc = '#c8ffe2';
        if (this.pulse > 0.02 && this.pulse > bayer[(LY + T.y) & 3][(LX + T.x) & 3] / 16) cc = '#ffffff';
        if (cc) rect(bctx, LX + T.x + ox, LY + T.y, 1, 1, cc);
      }
      bctx.drawImage(S.land, 0, 0);

      fctx.clearRect(0, 0, S.cols, S.rows);
      for (var fc2 = 0; fc2 < S.fclouds.length; fc2++) {
        var fcl = S.fclouds[fc2];
        if (!REDUCED) { fcl.x += fcl.v * dt; if (fcl.x > S.cols) fcl.x = -fcl.w; }
        fctx.drawImage(fcl.g, Math.floor(fcl.x + this.par * 22), fcl.y);
      }
      /* summit beacon flag */
      {
        var px = S.peakX + ox, pb = S.peakTop + 1, ph2 = Math.max(10, R(S.Hm * 0.09)), fw = R(ph2 * 0.95), fh = Math.max(4, R(ph2 * 0.5));
        rect(fctx, px - 1, pb - ph2, 3, ph2 + 1, K.ink); rect(fctx, px, pb - ph2 + 1, 1, ph2, '#8fae9d');
        rect(fctx, px - 1, pb - ph2 - 2, 3, 3, K.ink); rect(fctx, px, pb - ph2 - 1, 1, 1, K.glow);
        for (var fi2 = 0; fi2 < fw; fi2++) {
          var wv = R(Math.sin(sec * 5 + fi2 * 0.6) * fi2 * 0.10 * MOTION), y0 = pb - ph2 + 1 + wv, x0 = px + 1 + fi2;
          rect(fctx, x0, y0 - 1, 1, 1, K.ink); rect(fctx, x0, y0 + fh, 1, 1, K.ink);
          for (var fj = 0; fj < fh; fj++) rect(fctx, x0, y0 + fj, 1, 1, (fj === (fh >> 1)) ? K.cream : (fj < fh / 2 ? '#2fd98a' : '#1d9e64'));
        }
        for (var fj2 = -1; fj2 <= fh; fj2++) rect(fctx, px + 1 + fw, pb - ph2 + 1 + fj2 + R(Math.sin(sec * 5 + fw * 0.6) * fw * 0.10 * MOTION), 1, 1, K.ink);
      }
      /* wind-blown snow plume + sulfur sparks */
      if (!REDUCED) {
        this.acc += dt * (22 + this.energy * 70);
        while (this.acc >= 1) { this.acc -= 1; this.spawn(); }
        for (var pi2 = this.parts.length - 1; pi2 >= 0; pi2--) {
          var p = this.parts[pi2]; p.age += dt;
          if (p.age > p.life) { this.parts.splice(pi2, 1); continue; }
          var a = p.age / p.life;
          var xP = p.x + p.vx * p.age * (1 - 0.35 * a);
          var yP = p.y + p.vy * p.age + 6 * p.age * p.age + Math.sin(p.age * 5 + p.ph) * 1.4;
          if (a > 0.7 && ((R(xP) + R(yP)) & 1)) continue;
          rect(fctx, R(xP) + ox, R(yP), a < 0.6 ? p.s : 1, a < 0.6 ? p.s : 1, p.w ? K.glow : K.cream);
        }
        if (this.glints.length < 5 && Math.random() < dt * 5) this.addGlint();
      }
      for (var gi = this.glints.length - 1; gi >= 0; gi--) {
        var g2 = this.glints[gi], k = (performance.now() - g2.t0) / g2.dur;
        if (k >= 1) { this.glints.splice(gi, 1); continue; }
        var len = 1 + R(2.2 * Math.sin(Math.PI * k)), gx2 = g2.x + ox;
        rect(fctx, gx2 - len, g2.y, len * 2 + 1, 1, K.glow); rect(fctx, gx2, g2.y - len, 1, len * 2 + 1, K.glow);
      }
      for (var ti = 0; ti < S.tufts.length; ti++) {
        var tf = S.tufts[ti];
        blade(fctx, tf.x, tf.y, tf.h, REDUCED ? 0 : R(Math.sin(sec * 1.7 + ti * 0.9) * 1.6), tf.col);
      }
    }
    requestAnimationFrame(this.loop);
  };

  function init() {
    var nodes = document.querySelectorAll('.aral-scene');
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].__aralScene) nodes[i].__aralScene = new Scene(nodes[i]);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.__aralSceneInit = init;
})();
