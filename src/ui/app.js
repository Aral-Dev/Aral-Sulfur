/* ARAL SULFUR v1.1.1 — Simple Client Application (Vanilla ES6, zero deps, zero emojis)
   Calm glass edition: 4 menus (Home / Subscribers / Network / Settings),
   live telemetry chart, digital clock, static & rotating per-user IPs,
   protocol & port selection, theme switcher and GitHub self-updater. */
(function () {
  'use strict';

  var OFFICIAL_GITHUB_REPO = 'Aral-Dev/Aral-Sulfur';
  var OFFICIAL_GITHUB_URL = 'https://github.com/Aral-Dev/Aral-Sulfur';

  var $ = function (id) { return document.getElementById(id); };
  var html = document.documentElement;

  var LS = {
    get: function (k) { try { return localStorage.getItem('nl.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('nl.' + k, v); } catch (e) {} }
  };

  var lang = LS.get('lang') === 'en' ? 'en' : 'fa';
  var theme = LS.get('theme') === 'light' ? 'light' : 'dark';
  var ipBlurred = LS.get('ipblur') === '1';

  var STATE = {
    mode: 'loading',
    isDemo: false,
    host: location.host || 'aral.workers.dev',
    edge: '—',
    cf: {
      clientIp: '—', country: 'XX', countryNameFa: 'در حال تشخیص…', countryNameEn: 'Detecting…',
      city: '', asn: 0, ispFa: 'در حال شناسایی…', ispEn: 'Detecting ISP…', colo: '—'
    },
    settings: null,
    users: [],
    logs: [],
    totals: {},
    selectedUserId: '',
    usersQuery: '',
    usersFilter: 'all',
    usersSelected: [],
    currentNodes: [],
    ghInfo: null,
    currentVersion: '1.0.0'
  };

  /* ---------------------------------------------------------------- utils */

  function tr(fa, en) { return lang === 'fa' ? fa : en; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatBytes(b) {
    var v = Math.max(0, Number(b) || 0);
    if (v < 1024) return v + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return (Math.round(v * 10) / 10) + ' ' + units[i];
  }

  function uuid4() {
    if (crypto && crypto.randomUUID) { try { return crypto.randomUUID(); } catch (e) {} }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function randPass(len) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    var out = '';
    var arr = new Uint8Array(len || 14);
    crypto.getRandomValues(arr);
    for (var i = 0; i < arr.length; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  function textToLines(str) {
    return String(str || '').split(/[\n\r]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function linesToText(arr) {
    return Array.isArray(arr) ? arr.join('\n') : '';
  }

  /* ---------------------------------------------------------------- toast */

  var toastTimer = null;
  function showToast(fa, en) {
    var box = $('toast');
    if (!box) return;
    box.textContent = tr(fa, en) || String(fa || en || '');
    box.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('show'); }, 2600);
  }

  function copyText(str, labelFa, labelEn) {
    if (!str) return;
    var done = function () {
      showToast((labelFa || 'لینک') + ' ' + tr('رونوشت شد', 'copied'), (labelEn || 'Copied') + ' — OK');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(done, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = str;
      ta.style.position = 'fixed';
      ta.style.top = '-999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  function drawQrInto(boxId, text) {
    var box = $(boxId);
    if (!box || !text || typeof qrcode !== 'function') return;
    try {
      var bg = html.getAttribute('data-theme') === 'dark' ? '#f4f0e8' : '#ffffff';
      var fg = '#1D2117';
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 2, margin: 4, scalable: true });
      var svg = box.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', '156');
        svg.setAttribute('height', '156');
        svg.setAttribute('shape-rendering', 'crispEdges');
        svg.querySelectorAll('rect').forEach(function (r) { r.setAttribute('fill', bg); });
        svg.querySelectorAll('path').forEach(function (p) { p.setAttribute('fill', fg); });
      }
    } catch (e) {
      box.innerHTML = '';
    }
  }

  /* -------------------------------------------------- visitor identity */

  var ISP_LOCAL_MAP = [
    [/mobile communication|mci|hamrah/i, 'همراه اول (MCI)', 'MCI (Hamrah Aval)'],
    [/irancell|mtn/i, 'ایرانسل (MTN Irancell)', 'MTN Irancell'],
    [/iran telecommunication|tci|mkh/i, 'مخابرات ایران (TCI)', 'TCI (Telecom Iran)'],
    [/rightel/i, 'رایتل (Rightel)', 'Rightel'],
    [/shatel/i, 'شاتل (Shatel)', 'Shatel'],
    [/asiatech/i, 'آسیاتک (Asiatech)', 'Asiatech'],
    [/mobinnet/i, 'مبین‌نت (Mobinnet)', 'Mobinnet'],
    [/hiweb/i, 'های‌وب (HiWEB)', 'HiWEB'],
    [/pars online|parsonline/i, 'پارس‌آنلاین (ParsOnline)', 'ParsOnline'],
    [/zitel/i, 'زیتل (Zitel)', 'Zitel'],
    [/pishgaman/i, 'پیشگامان (Pishgaman)', 'Pishgaman'],
    [/afranet/i, 'افرانت (Afranet)', 'Afranet'],
    [/respina/i, 'رسپینا (Respina)', 'Respina'],
    [/cloudflare/i, 'کلادفلر (Cloudflare)', 'Cloudflare Net']
  ];

  var COUNTRY_NAMES = {
    IR: ['ایران', 'Iran'], NL: ['هلند', 'Netherlands'], DE: ['آلمان', 'Germany'],
    US: ['آمریکا', 'United States'], GB: ['بریتانیا', 'United Kingdom'], FR: ['فرانسه', 'France'],
    TR: ['ترکیه', 'Turkey'], AE: ['امارات', 'UAE'], FI: ['فنلاند', 'Finland'], SE: ['سوئد', 'Sweden'],
    CA: ['کانادا', 'Canada'], SG: ['سنگاپور', 'Singapore'], JP: ['ژاپن', 'Japan'],
    RU: ['روسیه', 'Russia'], CN: ['چین', 'China']
  };

  function classifyLocalIsp(raw) {
    var s = String(raw || '');
    for (var i = 0; i < ISP_LOCAL_MAP.length; i++) {
      if (ISP_LOCAL_MAP[i][0].test(s)) return [ISP_LOCAL_MAP[i][1], ISP_LOCAL_MAP[i][2]];
    }
    return [s || '—', s || '—'];
  }

  function normColo(v) {
    var s = String(v || '').trim().toUpperCase();
    return /^[A-Z]{3}$/.test(s) ? s : '';
  }

  function mergeVisitorCf(cfObj) {
    if (!cfObj || typeof cfObj !== 'object') return;
    var c = STATE.cf;
    if (cfObj.clientIp && cfObj.clientIp !== '127.0.0.1') c.clientIp = String(cfObj.clientIp);
    if (cfObj.country && cfObj.country !== 'XX') {
      c.country = String(cfObj.country).toUpperCase();
      var known = COUNTRY_NAMES[c.country];
      c.countryNameFa = known ? known[0] : (cfObj.countryNameFa || c.country);
      c.countryNameEn = known ? known[1] : (cfObj.countryNameEn || c.country);
    }
    if (cfObj.city) c.city = String(cfObj.city);
    if (cfObj.asn) c.asn = Number(cfObj.asn) || 0;
    if (cfObj.ispRaw || cfObj.ispFa || cfObj.ispEn) {
      var pair = classifyLocalIsp(cfObj.ispRaw || cfObj.ispFa || cfObj.ispEn);
      c.ispFa = cfObj.ispFa || pair[0];
      c.ispEn = cfObj.ispEn || pair[1];
    }
    if (cfObj.colo) c.colo = normColo(cfObj.colo) || c.colo;
    renderVisitorStrip();
  }

  function renderVisitorStrip() {
    var ipEl = $('visitor-ip');
    if (!ipEl) return;
    var c = STATE.cf;
    ipEl.textContent = c.clientIp || '—';
    ipEl.classList.toggle('is-blurred', ipBlurred);
    var ic = $('ip-blur-icon');
    if (ic) {
      ic.innerHTML = '<use href="#i-eye' + (ipBlurred ? '' : '-off') + '"/>';
    }
    var ctry = $('visitor-country');
    if (ctry) ctry.textContent = tr(c.countryNameFa, c.countryNameEn);
    var iso = $('visitor-iso');
    if (iso) iso.textContent = c.country && c.country !== 'XX' ? c.country : '';
    var isp = $('visitor-isp');
    if (isp) isp.textContent = tr(c.ispFa, c.ispEn);
    var colo = $('visitor-colo');
    if (colo) colo.textContent = c.colo || '—';
  }

  async function detectVisitorNetwork() {
    if (isSandboxPreview) {
      mergeVisitorCf({
        clientIp: '5.160.214.88', country: 'IR', city: 'Tehran', asn: 44244,
        ispRaw: 'MTN Irancell', colo: 'FRA'
      });
      seedTelemetry(46);
      pushTelemetrySample(46, 18.4);
      return;
    }
    try {
      var t0 = performance.now();
      var r = await fetch('/api/client-info?_=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' });
      var rtt = Math.max(1, Math.round(performance.now() - t0));
      if (r.ok) {
        var j = await r.json();
        if (j && j.cf) mergeVisitorCf(j.cf);
        seedTelemetry(rtt);
        pushTelemetrySample(rtt, null);
      }
    } catch (e) {}
    var curIp = STATE.cf.clientIp;
    if (!curIp || curIp === '—' || curIp === '127.0.0.1' || curIp === '::1' || STATE.cf.country === 'XX') {
      try {
        var ctrl = new AbortController();
        var tid = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 3200);
        var res = await fetch('https://speed.cloudflare.com/meta', { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(tid);
        if (res.ok) {
          var meta = await res.json();
          if (meta && meta.clientIp) {
            mergeVisitorCf({
              clientIp: meta.clientIp, country: meta.country || 'XX', city: meta.city || '',
              asn: meta.asn || 0, ispRaw: meta.asOrganization || '', colo: normColo(meta.colo) || STATE.edge
            });
          }
        }
      } catch (e) {}
    }
  }

  /* ----------------------------------------------- telemetry chart (calm) */

  var chartMode = 'live';
  var rttHistory = [];
  var speedHistory = [];
  var MAX_POINTS = 40;
  var chartPhase = 0;
  var usageAnimProgress = 1;
  var lastMeasuredMbps = 0;
  var speedBurstRunning = false;

  /* Render budget: ONE rAF chain, throttled to ~30fps, repainting only while
     the Home tab is visible AND something actually changed (live pulse, usage
     animation, new samples, theme swap, resize). drawChartFrame never
     self-schedules — two overlapping chains froze the browser in v1.1.0. */
  var chartColorCache = null;
  var chartDataRev = 0;
  var chartDrawnRev = -1;
  var chartDrawnMode = '';
  var chartDrawnW = 0;
  var chartDrawnH = 0;
  var chartLastDraw = 0;
  var chartReducedMotion = false;
  try { chartReducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  function invalidateChartColors() { chartColorCache = null; chartDataRev++; }

  function chartColors() {
    if (!chartColorCache) {
      chartColorCache = {
        honey: cssVar('--honey-hi', '#d9a03a'),
        lime: cssVar('--lime', '#E5EB70'),
        coral: cssVar('--coral', '#F79082'),
        forest: cssVar('--forest-hi', '#6f9a6d'),
        dim: cssVar('--dim', '#7c7768'),
        hairline: cssVar('--hairline', 'rgba(255,255,255,.09)')
      };
    }
    return chartColorCache;
  }

  /* Theme / language swaps repaint the canvas with fresh palette values. */
  try {
    new MutationObserver(function () { invalidateChartColors(); })
      .observe(html, { attributes: true, attributeFilter: ['data-theme', 'data-lang'] });
  } catch (e) {}

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(html).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function pushTelemetrySample(rttMs, mbpsVal) {
    if (typeof rttMs === 'number' && isFinite(rttMs)) {
      rttHistory.push(Math.max(1, Math.min(999, rttMs)));
      if (rttHistory.length > MAX_POINTS) rttHistory.shift();
    }
    if (typeof mbpsVal === 'number' && isFinite(mbpsVal)) {
      lastMeasuredMbps = mbpsVal;
      speedHistory.push(Math.max(0.2, Math.min(500, mbpsVal)));
    } else {
      var base = lastMeasuredMbps > 0
        ? Math.max(0.8, lastMeasuredMbps * (0.95 + Math.random() * 0.08))
        : Math.max(1.2, Math.min(45, 220 / Math.max(8, (rttMs || 40)) + (Math.random() * 1.4 - 0.7)));
      speedHistory.push(Number(base.toFixed(2)));
    }
    if (speedHistory.length > MAX_POINTS) speedHistory.shift();
    updateTelemetryKpis();
  }

  /* Warm the chart with a soft organic baseline derived from the first live
     measurement so the panel never greets the user with an empty plot. */
  var telemetrySeeded = false;
  function seedTelemetry(rttMs) {
    if (telemetrySeeded) return;
    telemetrySeeded = true;
    var r = Math.max(8, Math.min(300, Number(rttMs) || 45));
    for (var i = 0; i < MAX_POINTS - 6; i++) {
      var jr = Math.max(1, Math.round(r * (0.88 + Math.random() * 0.24)));
      var sp = Math.max(1.2, Math.min(45, 220 / Math.max(8, jr) + (Math.random() * 1.4 - 0.7)));
      rttHistory.push(jr);
      speedHistory.push(Number(sp.toFixed(2)));
    }
    updateTelemetryKpis();
  }

  function updateTelemetryKpis() {
    chartDataRev++;
    var latestRtt = rttHistory.length ? rttHistory[rttHistory.length - 1] : null;
    var jitter = 0;
    if (rttHistory.length >= 2) {
      var sumDiff = 0;
      for (var i = 1; i < rttHistory.length; i++) sumDiff += Math.abs(rttHistory[i] - rttHistory[i - 1]);
      jitter = Math.round(sumDiff / (rttHistory.length - 1));
    }
    var latestSpd = speedHistory.length ? speedHistory[speedHistory.length - 1] : 0;
    var totalB = (STATE.users || []).reduce(function (acc, u) { return acc + (u.usedBytes || 0); }, 0);
    if ($('kpi-rtt')) $('kpi-rtt').textContent = latestRtt != null ? latestRtt + ' ms' : '— ms';
    if ($('kpi-jitter')) $('kpi-jitter').textContent = rttHistory.length >= 2 ? jitter + ' ms' : '0 ms';
    if ($('kpi-speed')) $('kpi-speed').textContent = latestSpd > 0 ? latestSpd.toFixed(1) + ' Mbps' : '— Mbps';
    if ($('kpi-total-bw')) $('kpi-total-bw').textContent = formatBytes(totalB);
    if ($('chart-sample-lbl')) $('chart-sample-lbl').textContent = rttHistory.length + ' SAMPLES';
  }

  async function runBurstSpeedProbe() {
    if (speedBurstRunning) return;
    speedBurstRunning = true;
    var ic = $('speed-burst-ic');
    if (ic) ic.classList.add('ic-spin');
    try {
      if (isSandboxPreview) {
        for (var k = 0; k < 4; k++) {
          await new Promise(function (r) { setTimeout(r, 180); });
          pushTelemetrySample(38 + Math.round(Math.random() * 14), 24 + Math.random() * 18);
        }
      } else {
        var sizes = [65536, 131072, 262144, 262144];
        for (var i = 0; i < sizes.length; i++) {
          var t0 = performance.now();
          var res = await fetch('/api/speed-probe?bytes=' + sizes[i] + '&_=' + Date.now() + '_' + i, {
            cache: 'no-store', credentials: 'same-origin'
          });
          var buf = await res.arrayBuffer();
          var dtSec = Math.max(0.002, (performance.now() - t0) / 1000);
          var mbps = (buf.byteLength * 8) / (dtSec * 1000000);
          pushTelemetrySample(rttHistory.length ? rttHistory[rttHistory.length - 1] : Math.max(1, Math.round(dtSec * 350)), Number(mbps.toFixed(2)));
        }
      }
      showToast('تست سرعت انجام شد', 'Speed test complete');
    } catch (e) {
      showToast('خطا در تست سرعت', 'Speed test failed');
    }
    speedBurstRunning = false;
    if (ic) ic.classList.remove('ic-spin');
  }

  function setChartMode(mode) {
    chartMode = mode === 'usage' ? 'usage' : 'live';
    if ($('chart-mode-live')) $('chart-mode-live').classList.toggle('active', chartMode === 'live');
    if ($('chart-mode-usage')) $('chart-mode-usage').classList.toggle('active', chartMode === 'usage');
    if ($('chart-legend-live')) $('chart-legend-live').hidden = chartMode !== 'live';
    if ($('chart-legend-usage')) $('chart-legend-usage').hidden = chartMode !== 'usage';
    if (chartMode === 'usage') usageAnimProgress = 0;
    chartDataRev++;
  }

  function hexToRgba(hex, alpha) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
    if (!m) return 'rgba(150,150,150,' + alpha + ')';
    var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function drawChartFrame(ts) {
    var canvas = $('telemetry-canvas');
    if (!canvas) return;
    if (STATE.mode !== 'admin' || !$('pane-home') || $('pane-home').hidden) return;
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = canvas.clientWidth || 600;
    var h = canvas.clientHeight || 210;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    try { ctx.direction = 'ltr'; } catch (e) {}

    var C = chartColors();
    var honey = C.honey, lime = C.lime, coral = C.coral, forest = C.forest, dim = C.dim, hairline = C.hairline;

    var padL = 8, padR = 8, padT = 14, padB = 18;
    var iw = w - padL - padR, ih = h - padT - padB;

    /* dotted baseline grid */
    ctx.strokeStyle = hairline;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    for (var g = 1; g <= 3; g++) {
      var gy = padT + ih * (g / 4);
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(w - padR, gy);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    chartPhase = (ts || 0) / 1000;

    if (chartMode === 'live') {
      drawLiveChart(ctx, padL, padT, iw, ih, honey, lime, coral, dim);
    } else {
      if (usageAnimProgress < 1) usageAnimProgress = Math.min(1, usageAnimProgress + 0.055);
      drawUsageChart(ctx, padL, padT, iw, ih, forest, honey, dim, ts || 0);
    }
  }

  function smoothPath(ctx, pts) {
    if (pts.length < 2) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) {
      var xc = (pts[i][0] + pts[i - 1][0]) / 2;
      var yc = (pts[i][1] + pts[i - 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], xc, yc);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }

  function drawLiveChart(ctx, padL, padT, iw, ih, honey, lime, coral, dim) {
    var n = speedHistory.length;
    if (!n) return;

    var maxSpd = 4;
    for (var i = 0; i < n; i++) maxSpd = Math.max(maxSpd, speedHistory[i]);
    maxSpd = Math.min(500, maxSpd * 1.15);
    var maxRtt = 40;
    for (var j = 0; j < rttHistory.length; j++) maxRtt = Math.max(maxRtt, rttHistory[j]);
    maxRtt = Math.min(999, maxRtt * 1.2);

    var step = iw / Math.max(1, MAX_POINTS - 1);
    var offset = iw - (n - 1) * step;

    /* speed area */
    var pts = [];
    for (var s = 0; s < n; s++) {
      pts.push([padL + offset + s * step, padT + ih - (speedHistory[s] / maxSpd) * ih]);
    }
    var grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, hexToRgba(honey, 0.28));
    grad.addColorStop(1, hexToRgba(honey, 0.0));
    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.lineTo(pts[pts.length - 1][0], padT + ih);
    ctx.lineTo(pts[0][0], padT + ih);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.strokeStyle = honey;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    /* breathing dot at the latest sample */
    var last = pts[pts.length - 1];
    var pulse = 3.2 + Math.sin(chartPhase * 2.4) * 1.1;
    ctx.beginPath();
    ctx.arc(last[0], last[1], pulse + 5, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(lime, 0.16);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(last[0], last[1], 3.4, 0, Math.PI * 2);
    ctx.fillStyle = lime;
    ctx.fill();

    /* rtt dashed line */
    if (rttHistory.length >= 2) {
      var rn = rttHistory.length;
      var rStep = iw / Math.max(1, MAX_POINTS - 1);
      var rOffset = iw - (rn - 1) * rStep;
      var rPts = [];
      for (var r = 0; r < rn; r++) {
        rPts.push([padL + rOffset + r * rStep, padT + ih - (rttHistory[r] / maxRtt) * ih]);
      }
      ctx.beginPath();
      smoothPath(ctx, rPts);
      ctx.strokeStyle = hexToRgba(coral, 0.85);
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* axis labels */
    ctx.fillStyle = dim;
    ctx.font = '10px "JBM", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(Math.round(maxSpd) + ' Mbps', padL + 2, padT + 2);
    ctx.textAlign = 'right';
    if (rttHistory.length) ctx.fillText(Math.round(maxRtt) + ' ms', padL + iw - 2, padT + 2);
  }

  function drawUsageChart(ctx, padL, padT, iw, ih, forest, honey, dim, ts) {
    var users = (STATE.users || []).slice(0, 12);
    if (!users.length) {
      ctx.fillStyle = dim;
      ctx.font = '12px "Vazir", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tr('هنوز مشترکی ساخته نشده', 'No subscribers yet'), padL + iw / 2, padT + ih / 2);
      return;
    }
    var gap = 10;
    var bw = (iw - gap * (users.length - 1)) / users.length;
    var ease = 1 - Math.pow(1 - usageAnimProgress, 3);
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      var used = Math.max(0, Number(u.usedBytes) || 0);
      var limit = Math.max(0, Number(u.limitBytes) || 0);
      var pct;
      if (limit > 0) pct = Math.min(1, used / limit);
      else pct = used > 0 ? 0.35 : 0.04;
      var grow = pct * ease;
      var bh = Math.max(3, grow * ih);
      var x = padL + i * (bw + gap);
      var y = padT + ih - bh;

      var grad = ctx.createLinearGradient(0, y, 0, padT + ih);
      grad.addColorStop(0, honey);
      grad.addColorStop(1, forest);
      ctx.fillStyle = grad;
      ctx.beginPath();
      var r = Math.min(7, bw / 2, bh / 2);
      ctx.moveTo(x, padT + ih);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + bw - r, y);
      ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
      ctx.lineTo(x + bw, padT + ih);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = dim;
      ctx.font = '10px "Vazir", sans-serif';
      ctx.textAlign = 'center';
      var name = String(u.name || '').slice(0, 8);
      ctx.fillText(name, x + bw / 2, padT + ih + 13);
    }
  }

  /* ------------------------------------------------------- digital clock */

  function tickClock() {
    var clockEl = $('digital-clock');
    if (!clockEl) return;
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0');
    var mm = String(now.getMinutes()).padStart(2, '0');
    var ss = String(now.getSeconds()).padStart(2, '0');
    clockEl.textContent = hh + ':' + mm + ':' + ss;
    var dateEl = $('clock-date');
    if (dateEl) {
      try {
        dateEl.textContent = new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR' : 'en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }).format(now);
      } catch (e) {
        dateEl.textContent = now.toDateString();
      }
    }
  }

  /* ------------------------------------------------- sandbox demo store */

  var isSandboxPreview = (location.protocol !== 'http:' && location.protocol !== 'https:') || window.origin === 'null';
  var demoStore = null;

  function ensureDemoStore() {
    if (demoStore) return demoStore;
    var now = Date.now();
    demoStore = {
      ok: true, version: '1.1.1', state: 'ready', mode: 'admin',
      host: 'aral-sulfur-demo.pages.dev', edge: 'FRA', kvBound: true,
      tgProxy: (function () {
        var demoSecret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
        var ports = [443, 2053, 2083, 2087, 2096, 8443];
        var list = ports.map(function (p, i) {
          var sec = 'dd' + (demoSecret.slice(0, 30) + (p % 97).toString(16).padStart(2, '0'));
          var qs = 'server=aral-sulfur-demo.pages.dev' + (p !== 443 ? '&port=' + p : '') + '&secret=' + sec;
          return { port: p, secret: sec, tgUrl: 'tg://webproxy?' + qs, tmeUrl: 'https://t.me/webproxy?' + qs };
        });
        return {
          tgUrl: 'tg://webproxy?server=aral-sulfur-demo.pages.dev&secret=' + demoSecret,
          tmeUrl: 'https://t.me/webproxy?server=aral-sulfur-demo.pages.dev&secret=' + demoSecret,
          server: 'aral-sulfur-demo.pages.dev', secret: demoSecret, ports: list
        };
      })(),
      settings: {
        enableVless: true, enableTrojan: true, enableSS: false,
        tlsPorts: [443, 2053], httpPorts: [80, 8080], enableHttpPorts: false,
        fingerprint: 'chrome', earlyData: 2048,
        enableFragment: true, fragmentPackets: '1-1', fragmentLength: '10-20', fragmentInterval: '10-20',
        cleanIPs: ['www.speedtest.net#Speedtest'], customDomains: [], proxyIPs: ['ProxyIP.NL.CMLiussss.net']
      },
      totals: { totalUsedBytes: 41_481_270_000, activeUsers: 2 },
      logs: [{ ts: now - 3600e3, event: 'user:add', detail: 'مشترک جدید ساخته شد: سارا' }],
      users: [
        {
          id: 'u_demo_admin', name: 'مدیر (اصلی)', note: 'حساب مدیر', enabled: true, status: 'active',
          uuid: uuid4(), trojanPassword: randPass(14), subToken: 'demoadmintoken0001',
          trafficLimitGB: 0, usedBytes: 18_642_000_000, limitBytes: 0, connections: 142,
          expiryDays: 0, remainingDays: -1, startOnFirstUse: false, protocols: '',
          ips: [], autoRotateIps: true, ipCount: 15, poolType: '',
          nodeCount: 9,
          urls: {
            pressPass: 'https://aral-sulfur-demo.pages.dev/sub/demoadmintoken0001',
            normalSub: 'https://aral-sulfur-demo.pages.dev/sub/demoadmintoken0001?format=b64',
            xrayFragmentSub: 'https://aral-sulfur-demo.pages.dev/sub/demoadmintoken0001?format=xray',
            singboxSub: 'https://aral-sulfur-demo.pages.dev/sub/demoadmintoken0001?format=singbox',
            clashSub: 'https://aral-sulfur-demo.pages.dev/sub/demoadmintoken0001?format=clash',
            privateDoH: 'https://aral-sulfur-demo.pages.dev/dns-query/demoadmintoken0001'
          },
          statusUrl: 'https://aral-sulfur-demo.pages.dev/status/demoadmintoken0001'
        },
        {
          id: 'u_demo_sara', name: 'سارا', note: '', enabled: true, status: 'active',
          uuid: uuid4(), trojanPassword: randPass(14), subToken: 'demosaratoken000002',
          trafficLimitGB: 50, usedBytes: 22_839_270_000, limitBytes: 53_687_091_200, connections: 88,
          expiryDays: 30, remainingDays: 17, startOnFirstUse: false, protocols: 'vless,trojan',
          ips: ['104.17.10.12', 'www.speedtest.net#Speedtest'], autoRotateIps: false, ipCount: 15, poolType: '',
          nodeCount: 9,
          urls: {
            pressPass: 'https://aral-sulfur-demo.pages.dev/sub/demosaratoken000002',
            normalSub: 'https://aral-sulfur-demo.pages.dev/sub/demosaratoken000002?format=b64',
            xrayFragmentSub: 'https://aral-sulfur-demo.pages.dev/sub/demosaratoken000002?format=xray',
            singboxSub: 'https://aral-sulfur-demo.pages.dev/sub/demosaratoken000002?format=singbox',
            clashSub: 'https://aral-sulfur-demo.pages.dev/sub/demosaratoken000002?format=clash',
            privateDoH: 'https://aral-sulfur-demo.pages.dev/dns-query/demosaratoken000002'
          },
          statusUrl: 'https://aral-sulfur-demo.pages.dev/status/demosaratoken000002'
        },
        {
          id: 'u_demo_reza', name: 'رضا', note: 'پشتیبانی تلگرام', enabled: false, status: 'paused',
          uuid: uuid4(), trojanPassword: randPass(14), subToken: 'demarezatoken000003',
          trafficLimitGB: 20, usedBytes: 3_120_000_000, limitBytes: 21_474_836_480, connections: 12,
          expiryDays: 0, remainingDays: -1, startOnFirstUse: true, protocols: '',
          ips: [], autoRotateIps: true, ipCount: 8, poolType: 'ipv4',
          nodeCount: 9,
          urls: {
            pressPass: 'https://aral-sulfur-demo.pages.dev/sub/demarezatoken000003',
            normalSub: 'https://aral-sulfur-demo.pages.dev/sub/demarezatoken000003?format=b64',
            xrayFragmentSub: 'https://aral-sulfur-demo.pages.dev/sub/demarezatoken000003?format=xray',
            singboxSub: 'https://aral-sulfur-demo.pages.dev/sub/demarezatoken000003?format=singbox',
            clashSub: 'https://aral-sulfur-demo.pages.dev/sub/demarezatoken000003?format=clash',
            privateDoH: 'https://aral-sulfur-demo.pages.dev/dns-query/demarezatoken000003'
          },
          statusUrl: 'https://aral-sulfur-demo.pages.dev/status/demarezatoken000003'
        }
      ]
    };
    return demoStore;
  }

  /* ------------------------------------------------------------- api() */

  async function api(path, method, body) {
    method = method || 'GET';
    if (isSandboxPreview) {
      var ds = ensureDemoStore();
      if (path === '/api/bootstrap') return JSON.parse(JSON.stringify(ds));
      if (path === '/api/settings') {
        Object.assign(ds.settings, body || {});
        return JSON.parse(JSON.stringify(ds));
      }
      if (path === '/api/users' && method === 'POST') {
        var nu = JSON.parse(JSON.stringify(ds.users[0]));
        nu.id = 'u_demo_' + Math.random().toString(36).slice(2, 8);
        nu.name = (body && body.name) || 'مشترک تازه';
        nu.note = (body && body.note) || '';
        nu.usedBytes = 0; nu.connections = 0;
        nu.trafficLimitGB = Number(body && body.trafficLimitGB) || 0;
        nu.limitBytes = nu.trafficLimitGB * 1073741824;
        nu.protocols = (body && body.protocols) || '';
        nu.ips = (body && body.ips) || [];
        nu.autoRotateIps = Boolean(body && body.autoRotateIps);
        nu.ipCount = Number(body && body.ipCount) || 15;
        nu.subToken = 'demo' + Math.random().toString(36).slice(2, 12);
        ds.users.push(nu);
        return Object.assign(JSON.parse(JSON.stringify(ds)), { createdId: nu.id });
      }
      var um = path.match(/^\/api\/users\/([^/]+)$/);
      if (um) {
        var uid = um[1];
        var idx = ds.users.findIndex(function (u) { return u.id === uid; });
        if (method === 'DELETE') {
          if (idx >= 0 && ds.users.length > 1) ds.users.splice(idx, 1);
          return JSON.parse(JSON.stringify(ds));
        }
        if (idx >= 0 && method === 'PUT') {
          var b = body || {};
          if (b.resetTraffic) { ds.users[idx].usedBytes = 0; ds.users[idx].connections = 0; }
          if (b.enabled !== undefined) { ds.users[idx].enabled = b.enabled; ds.users[idx].status = b.enabled ? 'active' : 'paused'; }
          if (b.name) ds.users[idx].name = b.name;
          if (b.note !== undefined) ds.users[idx].note = b.note;
          if (b.trafficLimitGB !== undefined) {
            ds.users[idx].trafficLimitGB = Number(b.trafficLimitGB) || 0;
            ds.users[idx].limitBytes = ds.users[idx].trafficLimitGB * 1073741824;
          }
          if (b.protocols !== undefined) ds.users[idx].protocols = b.protocols;
          if (b.ips !== undefined) ds.users[idx].ips = b.ips;
          if (b.autoRotateIps !== undefined) ds.users[idx].autoRotateIps = Boolean(b.autoRotateIps);
          if (b.ipCount !== undefined) ds.users[idx].ipCount = Number(b.ipCount) || 15;
          return JSON.parse(JSON.stringify(ds));
        }
      }
      if (path === '/api/users/bulk') {
        var ids = (body && body.ids) || [];
        var act = (body && body.action) || '';
        ds.users = ds.users.filter(function (u) {
          if (!ids.includes(u.id)) return true;
          if (act === 'delete') return ds.users.length - ids.length >= 1 ? false : true;
          if (act === 'enable') { u.enabled = true; u.status = 'active'; }
          if (act === 'disable') { u.enabled = false; u.status = 'paused'; }
          if (act === 'reset_traffic') { u.usedBytes = 0; u.connections = 0; }
          return true;
        });
        return JSON.parse(JSON.stringify(ds));
      }
      if (path === '/api/users/' + encodeURIComponent(STATE.selectedUserId) + '/nodes') {
        return { ok: true, nodes: [] };
      }
      if (path === '/api/update/check') {
        return {
          ok: true, repo: OFFICIAL_GITHUB_REPO, repoUrl: OFFICIAL_GITHUB_URL,
          currentVersion: ds.version, latestVersion: ds.version, updateAvailable: false,
          notPublishedYet: true, releaseUrl: OFFICIAL_GITHUB_URL, releaseNotes: '', scriptName: 'aral-sulfur-demo'
        };
      }
      if (path === '/api/update/apply') return { ok: true, applied: true, version: ds.version };
      if (path === '/api/password') return { ok: true };
      if (path === '/api/killswitch') {
        ds.settings.killSwitch = !ds.settings.killSwitch;
        return JSON.parse(JSON.stringify(ds));
      }
      if (path === '/api/backup') {
        return { ok: true, version: 2, exportedAt: new Date().toISOString(), settings: ds.settings, users: ds.users };
      }
      if (path === '/api/restore') {
        if (body && Array.isArray(body.users)) ds.users = body.users;
        if (body && body.settings) Object.assign(ds.settings, body.settings);
        return JSON.parse(JSON.stringify(ds));
      }
      return { ok: true };
    }

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var tid = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 15000) : null;
    var opts = {
      method: method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'x-aral': '1' }
    };
    if (ctrl) opts.signal = ctrl.signal;
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res;
    try {
      res = await fetch(path, opts);
    } catch (netErr) {
      if (tid) clearTimeout(tid);
      if (netErr && netErr.name === 'AbortError') {
        throw new Error(tr('زمان درخواست به پایان رسید (Timeout).', 'Request timed out.'));
      }
      throw new Error(tr('ارتباط با سرور برقرار نشد؛ اتصال اینترنت را بررسی کنید.', 'Network error — could not reach Worker.'));
    }
    if (tid) clearTimeout(tid);

    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }

    if (res.status === 401 && path !== '/api/login' && path !== '/api/bootstrap') {
      ingestBootstrap({ mode: 'login', host: STATE.host, edge: STATE.edge });
      throw new Error(data.error || tr('نشست منقضی شده است؛ دوباره وارد شوید.', 'Session expired — sign in again.'));
    }

    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'HTTP ' + res.status);
    }
    return data;
  }

  /* ------------------------------------------------------ appearance */

  function applyAppearance() {
    html.setAttribute('data-lang', lang);
    html.setAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');
    html.setAttribute('data-theme', theme);
    document.querySelectorAll('.t-pick').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-th') === theme);
    });
    var lbls = document.querySelectorAll('#lang, #lang-login, #lang-2');
    lbls.forEach(function (b) { b.textContent = lang === 'fa' ? 'EN' : 'FA'; });
    var ph = $('u-search');
    if (ph) ph.placeholder = tr('جستجو…', 'Search…');
    var flt = $('u-filter');
    if (flt) {
      var map = { all: ['همه', 'All'], active: ['فعال', 'Active'], paused: ['متوقف', 'Paused'], expired: ['منقضی', 'Expired'] };
      Array.from(flt.options).forEach(function (o) {
        var m = map[o.value];
        if (m) o.textContent = tr(m[0], m[1]);
      });
    }
    if (STATE.mode === 'admin') {
      renderVisitorStrip();
      renderHomeLinks();
      renderUsersLedger();
    }
  }

  document.querySelectorAll('.t-pick').forEach(function (b) {
    b.addEventListener('click', function () {
      theme = b.getAttribute('data-th') === 'light' ? 'light' : 'dark';
      LS.set('theme', theme);
      applyAppearance();
      drawQrInto('main-qr', STATE.currentQrText);
    });
  });
  ['lang', 'lang-login', 'lang-2'].forEach(function (id) {
    var b = $(id);
    if (b) b.addEventListener('click', function () {
      lang = lang === 'fa' ? 'en' : 'fa';
      LS.set('lang', lang);
      applyAppearance();
      drawQrInto('main-qr', STATE.currentQrText);
    });
  });

  /* ------------------------------------------------------ preloader/toast boot */

  var preloaderHidden = false;
  function hidePreloader() {
    if (preloaderHidden) return;
    preloaderHidden = true;
    var p = $('preloader');
    if (p) {
      p.classList.add('gone');
      setTimeout(function () { try { p.remove(); } catch (e) { p.hidden = true; } }, 600);
    }
  }
  /* Loading reliability: if the first paint is still waiting after 6s, keep the
     branded screen alive and offer a one-tap reload instead of a blank page. */
  setTimeout(function () {
    if (preloaderHidden) return;
    var p = $('preloader');
    if (!p) return;
    if (!p.querySelector('.pre-retry')) {
      var btn = document.createElement('button');
      btn.className = 'btn ghost sm-btn pre-retry';
      btn.type = 'button';
      btn.style.marginTop = '22px';
      btn.innerHTML = '<svg class="ic ic-sm"><use href="#i-refresh"/></svg><span class="fa">تلاش دوباره</span><span class="en">RETRY</span>';
      btn.onclick = function () { try { location.reload(); } catch (e) {} };
      p.appendChild(btn);
    }
  }, 6000);

  /* ------------------------------------------------------ free notice modal */

  var freeModal = $('free-notice-modal');
  var freeInfoBtn = null;
  function closeFreeModal() {
    if (freeModal) freeModal.hidden = true;
    LS.set('freeok' + STATE.currentVersion, '1');
  }
  if ($('btn-free-close')) $('btn-free-close').onclick = closeFreeModal;
  if (freeModal) {
    freeModal.addEventListener('click', function (ev) {
      if (ev.target === freeModal) closeFreeModal();
    });
  }

  /* ------------------------------------------------------ bootstrap */

  function ingestBootstrap(data) {
    if (!data || typeof data !== 'object') return;
    hidePreloader();
    if (data.tgProxy !== undefined) STATE.tgProxy = data.tgProxy;
    var stateToMode = {
      needs_setup: 'setup', locked: 'login', stateless: 'stateless', needs_kv: 'stateless', ready: 'admin'
    };
    var resolvedMode = data.mode || stateToMode[data.state] || 'stateless';
    STATE.mode = resolvedMode;
    STATE.isDemo = isSandboxPreview;
    STATE.host = data.host || (data.cf && data.cf.host) || location.host || 'aral.workers.dev';
    if (data.edge && data.edge !== 'CF-GLOBAL') STATE.edge = normColo(data.edge) || STATE.edge;
    else if (STATE.edge === '—' && data.edge) STATE.edge = normColo(data.edge) || STATE.edge;
    if (data.version) STATE.currentVersion = data.version;

    if (data.cf) mergeVisitorCf(data.cf);
    else renderVisitorStrip();

    $('v-setup').hidden = resolvedMode !== 'setup';
    $('v-login').hidden = resolvedMode !== 'login';
    $('v-stateless').hidden = resolvedMode !== 'stateless';
    $('v-admin').hidden = resolvedMode !== 'admin';

    /* Official free & non-commercial notice — once per version on login & admin */
    if ((resolvedMode === 'login' || resolvedMode === 'admin') && freeModal && !LS.get('freeok' + STATE.currentVersion)) {
      freeModal.hidden = false;
    }

    if (resolvedMode === 'stateless') {
      $('diag-mode').textContent = 'STATELESS';
      $('diag-kv').textContent = data.kvBound ? 'UNINITIALIZED' : 'NOT BOUND';
      $('diag-uuid').textContent = (data.hasEnvUuid || data.statelessUser) ? 'SET (READY)' : 'NOT SET';
      $('diag-edge').textContent = STATE.edge;
      renderStatelessTicket();
      return;
    }

    if (resolvedMode === 'admin') {
      STATE.settings = data.settings || null;
      STATE.users = data.users || [];
      STATE.logs = data.logs || [];
      STATE.totals = data.totals || {};
      $('demo-badge').hidden = !STATE.isDemo;

      if (!STATE.selectedUserId || !STATE.users.some(function (u) { return u.id === STATE.selectedUserId; })) {
        STATE.selectedUserId = STATE.users[0] ? STATE.users[0].id : '';
      }

      var showFree = !LS.get('freeok' + STATE.currentVersion) && freeModal;
      if (showFree) freeModal.hidden = false;

      populateSettingsForms();
      renderHomeStats();
      renderHomeLinks();
      renderUsersLedger();
      renderTgTab();
      updateTelemetryKpis();
      syncGhUpdaterUI();

      /* first-run update whisper */
      if (!LS.get('updchk') ) {
        LS.set('updchk', '1');
        checkGitHubUpdates(true);
      }
    }
  }

  function softApplyBootstrap(data) {
    if (!data || typeof data !== 'object') return;
    if (data.settings) STATE.settings = data.settings;
    if (Array.isArray(data.users)) STATE.users = data.users;
    if (Array.isArray(data.logs)) STATE.logs = data.logs;
    if (data.totals) STATE.totals = data.totals;
    if (data.version) STATE.currentVersion = data.version;
    if (STATE.mode !== 'admin') return;
    if (!STATE.selectedUserId || !STATE.users.some(function (u) { return u.id === STATE.selectedUserId; })) {
      STATE.selectedUserId = STATE.users[0] ? STATE.users[0].id : '';
    }
    renderHomeStats();
    renderHomeLinks();
    renderUsersLedger();
    renderTgTab();
    updateTelemetryKpis();
  }

  /* ------------------------------------------------------ setup & login */

  if ($('setup-gen-uuid')) {
    $('setup-gen-uuid').addEventListener('click', function () {
      $('setup-uuid').value = uuid4();
    });
  }

  if ($('f-setup')) {
    $('f-setup').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      $('setup-err').hidden = true;
      try {
        var res = await api('/api/setup', 'POST', {
          password: $('setup-pass').value,
          firstUserName: $('setup-name').value.trim(),
          preferredUuid: $('setup-uuid').value.trim()
        });
        showToast('پنل راه‌اندازی شد', 'Panel initialized');
        ingestBootstrap(res);
      } catch (err) {
        $('setup-err').textContent = err.message;
        $('setup-err').hidden = false;
      }
    });
  }

  if ($('f-login')) {
    $('f-login').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      $('login-err').hidden = true;
      try {
        var res = await api('/api/login', 'POST', { password: $('login-pass').value });
        $('login-pass').value = '';
        showToast('خوش آمدی', 'Signed in');
        ingestBootstrap(res);
      } catch (err) {
        $('login-err').textContent = err.message;
        $('login-err').hidden = false;
      }
    });
  }

  if ($('btn-recover')) {
    $('btn-recover').onclick = function (ev) {
      ev.preventDefault();
      var token = prompt(
        tr('توکن API کلادفلر (با دسترسی Workers Scripts:Edit) را وارد کن تا مالکیت ورکر اثبات و رمز پنل ریست شود. تمام مشترکین و تنظیمات حفظ می‌شوند.', 'Paste a Cloudflare API token (Workers Scripts:Edit) to prove ownership and reset the panel password. All subscribers and settings are preserved.')
      );
      if (!token) return;
      api('/api/recover', 'POST', { token: token })
        .then(function (r) {
          if (r && r.ok) {
            showToast('رمز ریست شد — اکنون رمز جدید تعیین کن', 'Password reset — set a new one now');
            location.reload();
          } else {
            showToast((r && r.error) || 'failed', (r && r.error) || 'failed');
          }
        })
        .catch(function (err) { showToast(err.message, err.message); });
    };
  }

  if ($('sub-jump-btn')) {
    $('sub-jump-btn').addEventListener('click', function () {
      var tok = ($('sub-jump-inp').value || '').trim();
      if (!tok) return;
      window.open('/sub/' + encodeURIComponent(tok), '_blank', 'noopener');
    });
  }

  if ($('btn-ip-blur')) {
    $('btn-ip-blur').addEventListener('click', function () {
      ipBlurred = !ipBlurred;
      LS.set('ipblur', ipBlurred ? '1' : '0');
      renderVisitorStrip();
    });
  }

  if ($('btn-logout')) {
    $('btn-logout').addEventListener('click', async function () {
      try { await api('/api/logout', 'POST'); } catch (e) {}
      location.reload();
    });
  }

  /* ------------------------------------------------------ stateless ticket */

  if ($('sl-uuid')) $('sl-uuid').value = LS.get('uuid') || '';
  if ($('sl-mint')) {
    $('sl-mint').addEventListener('click', function () {
      $('sl-uuid').value = uuid4();
      LS.set('uuid', $('sl-uuid').value);
      renderStatelessTicket();
    });
  }
  if ($('sl-uuid')) {
    $('sl-uuid').addEventListener('input', function () {
      LS.set('uuid', $('sl-uuid').value.trim());
      renderStatelessTicket();
    });
  }

  var slUri = '';
  function renderStatelessTicket() {
    var inp = $('sl-uuid');
    if (!inp) return;
    var id = (inp.value || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      $('sl-box').hidden = true;
      return;
    }
    $('sl-box').hidden = false;
    var h = STATE.host;
    slUri = 'vless://' + id + '@' + h + ':443?encryption=none&security=tls&sni=' + h + '&fp=chrome&type=ws&host=' + h + '&path=%2F%3Fed%3D2048#Aral%20Sulfur';
    $('sl-sub').href = '/sub/' + id;
    drawQrInto('sl-qr', slUri);
  }
  if ($('sl-copy')) {
    $('sl-copy').addEventListener('click', function () {
      copyText(slUri, 'لینک VLESS', 'VLESS URI');
    });
  }

  /* ------------------------------------------------------ admin tabs */

  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabName);
    });
    ['home', 'users', 'net', 'tg', 'settings'].forEach(function (t) {
      var pane = $('pane-' + t);
      if (pane) pane.hidden = t !== tabName;
    });
    if (tabName === 'home') updateTelemetryKpis();
  }
  document.querySelectorAll('.tab-btn').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });

  /* ------------------------------------------------------ home: stats + links */

  function renderHomeStats() {
    if ($('st-edge')) $('st-edge').textContent = STATE.edge || '—';
    if ($('st-kv')) $('st-kv').textContent = STATE.isDemo ? 'DEMO' : 'OK';
    var active = (STATE.users || []).filter(function (u) { return u.status === 'active'; }).length;
    if ($('st-users')) $('st-users').textContent = active + '/' + STATE.users.length;
    var total = (STATE.totals && STATE.totals.totalUsedBytes) ||
      (STATE.users || []).reduce(function (a, u) { return a + (u.usedBytes || 0); }, 0);
    if ($('st-traffic')) $('st-traffic').textContent = formatBytes(total);
    if ($('ver-foot')) $('ver-foot').textContent = STATE.currentVersion;
    if ($('ver-foot-tg')) $('ver-foot-tg').textContent = STATE.currentVersion;
  }

  function getSelectedUser() {
    return STATE.users.find(function (u) { return u.id === STATE.selectedUserId; }) || STATE.users[0] || null;
  }

  function subBase(user) {
    var proto = location.protocol === 'http:' ? 'http://' : 'https://';
    return proto + STATE.host + '/sub/' + encodeURIComponent(user.subToken);
  }

  var currentQrFormat = 'b64';

  function renderHomeLinks() {
    var sel = $('sel-user');
    if (!sel) return;
    var prev = STATE.selectedUserId;
    sel.innerHTML = '';
    STATE.users.forEach(function (u, i) {
      var opt = document.createElement('option');
      opt.value = u.id;
      var label = esc(u.name) + (i === 0 ? ' ' + tr('(مدیر)', '(admin)') : '');
      opt.textContent = label;
      sel.appendChild(opt);
    });
    if (prev && STATE.users.some(function (u) { return u.id === prev; })) sel.value = prev;
    else if (STATE.users[0]) { sel.value = STATE.users[0].id; STATE.selectedUserId = STATE.users[0].id; }

    var u = getSelectedUser();
    if (!u) return;

    /* status mini card */
    var cell = $('u-status-cell');
    if (cell) {
      var stMap = {
        active: ['فعال', 'ACTIVE', 'ok'],
        paused: ['متوقف', 'PAUSED', 'bad'],
        expired: ['منقضی', 'EXPIRED', 'bad'],
        limited: ['پر شده', 'LIMITED', 'inv']
      };
      var st = stMap[u.status] || stMap.active;
      var usedStr = formatBytes(u.usedBytes);
      var limStr = u.limitBytes > 0 ? formatBytes(u.limitBytes) : tr('نامحدود', '∞');
      var ipMode = u.autoRotateIps
        ? tr('چرخش خودکار (' + (u.ipCount || 15) + ' آی‌پی)', 'AUTO-ROTATE (' + (u.ipCount || 15) + ')')
        : (Array.isArray(u.ips) && u.ips.length ? tr('آی‌پی ثابت (' + u.ips.length + ')', 'STATIC (' + u.ips.length + ')') : tr('پیش‌فرض پنل', 'PANEL DEFAULT'));
      cell.innerHTML =
        '<span class="badge ' + st[2] + '">' + st[0] + '</span>' +
        '<span class="chip">' + usedStr + ' / ' + limStr + '</span>' +
        '<span class="chip">' + esc(ipMode) + '</span>';
    }
    if ($('node-count')) {
      $('node-count').innerHTML = esc(String(u.nodeCount || 0)) + ' ' + tr('نود', 'NODES');
    }
    if ($('open-pass')) $('open-pass').href = u.statusUrl || subBase(u);
    updateQr();
  }

  function updateQr() {
    var u = getSelectedUser();
    if (!u || !u.urls) return;
    var text = currentQrFormat === 'xray' ? u.urls.xrayFragmentSub : u.urls.pressPass;
    STATE.currentQrText = text;
    drawQrInto('main-qr', text);
    if ($('qr-caption')) $('qr-caption').textContent = text;
  }

  /* ------------------------------------------------------ telegram proxy tab */

  function tgData() {
    if (STATE.tgProxy && STATE.tgProxy.ports && STATE.tgProxy.ports.length) return STATE.tgProxy;
    return null;
  }

  function renderTgTab() {
    var grid = $('tg-ports-grid');
    var table = $('tg-manual-table');
    if (!grid) return;
    var data = tgData();

    if (!data) {
      grid.innerHTML = '<div class="tg-empty">' + tr(
        'پروکسی تلگرام فعال نیست — از بخش تنظیمات، کلید مخفی را بسازید.',
        'Telegram proxy is not active yet.') + '</div>';
      if (table) table.innerHTML = '';
      return;
    }

    var ports = data.ports;
    grid.innerHTML = '';
    ports.forEach(function (p) {
      var isDefault = p.port === 443;
      var card = document.createElement('div');
      card.className = 'tg-port' + (isDefault ? ' default' : '');
      card.innerHTML =
        '<div class="tg-port-head">' +
          '<span class="tg-port-num">:' + esc(String(p.port)) + '</span>' +
          '<span class="tg-port-tag badge inv">' + (isDefault ? tr('پیش‌فرض', 'DEFAULT') : 'HTTPS') + '</span>' +
        '</div>' +
        '<a class="tg-connect" href="' + esc(p.tgUrl) + '">' +
          '<svg class="ic"><use href="#i-telegram"/></svg>' +
          '<span class="fa">اتصال در تلگرام</span><span class="en">CONNECT</span>' +
        '</a>' +
        '<div class="tg-mini-row">' +
          '<button class="tg-mini act-copy-tg" type="button"><svg class="ic"><use href="#i-copy"/></svg>tg://</button>' +
          '<button class="tg-mini act-copy-tme" type="button"><svg class="ic"><use href="#i-copy"/></svg>t.me</button>' +
          '<button class="tg-mini act-qr" type="button"><svg class="ic"><use href="#i-qr"/></svg>QR</button>' +
        '</div>' +
        '<div class="tg-secret" title="' + tr('لمس = کپی سکرت', 'tap to copy') + '">' + esc(p.secret) + '</div>';
      card.querySelector('.act-copy-tg').addEventListener('click', function () {
        copyText(p.tgUrl, 'لینک ' + p.port, 'Port ' + p.port + ' link');
      });
      card.querySelector('.act-copy-tme').addEventListener('click', function () {
        copyText(p.tmeUrl, 'لینک ' + p.port, 'Port ' + p.port + ' link');
      });
      card.querySelector('.act-qr').addEventListener('click', function () {
        openTgQr(p);
      });
      card.querySelector('.tg-secret').addEventListener('click', function () {
        copyText(p.secret, 'سکرت ' + p.port, 'Port ' + p.port + ' secret');
      });
      grid.appendChild(card);
    });

    if (table) {
      var head = tr('پورت', 'PORT');
      var secLbl = tr('سکرت (لمس = کپی)', 'SECRET (tap to copy)');
      var rowsHtml = '<tr><th style="width:90px">' + head + '</th><th>' + secLbl + '</th></tr>';
      ports.forEach(function (p) {
        rowsHtml += '<tr><td class="mono">:' + esc(String(p.port)) + (p.port === 443 ? ' <span class="badge inv">' + tr('پیش‌فرض', 'DEFAULT') + '</span>' : '') + '</td>' +
          '<td><span class="mono tg-secret" data-sec="' + esc(p.secret) + '">' + esc(p.secret) + '</span></td></tr>';
      });
      rowsHtml += '<tr><td>' + tr('سرور', 'SERVER') + '</td><td><span class="mono">' + esc(data.server || STATE.host) + '</span></td></tr>';
      table.innerHTML = rowsHtml;
      table.querySelectorAll('.tg-secret[data-sec]').forEach(function (el) {
        el.addEventListener('click', function () {
          copyText(el.getAttribute('data-sec'), 'سکرت', 'secret');
        });
      });
    }
  }

  var tgQrBox = null;
  function openTgQr(portInfo) {
    if (!tgQrBox) {
      tgQrBox = document.createElement('div');
      tgQrBox.className = 'modal-backdrop';
      tgQrBox.hidden = true;
      tgQrBox.innerHTML =
        '<div class="modal-box" style="max-width:330px;text-align:center">' +
          '<p class="kicker" style="justify-content:center"><svg class="ic"><use href="#i-qr"/></svg>' +
            '<span class="fa">QR پروکسی تلگرام</span><span class="en">TELEGRAM PROXY QR</span></p>' +
          '<div class="qrbox" style="margin:14px auto"><div class="qr" id="tg-qr"></div></div>' +
          '<p class="mono sm" id="tg-qr-cap" style="word-break:break-all;direction:ltr;color:var(--dim)"></p>' +
          '<div class="actions" style="justify-content:center;margin-top:14px">' +
            '<button class="btn ghost sm-btn" id="tg-qr-copy" type="button"><svg class="ic ic-sm"><use href="#i-copy"/></svg><span class="fa">کپی لینک</span><span class="en">COPY LINK</span></button>' +
            '<button class="btn sm-btn" id="tg-qr-close" type="button"><svg class="ic ic-sm"><use href="#i-x"/></svg><span class="fa">بستن</span><span class="en">CLOSE</span></button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(tgQrBox);
      tgQrBox.addEventListener('click', function (ev) {
        if (ev.target === tgQrBox) tgQrBox.hidden = true;
      });
      $('tg-qr-close').onclick = function () { tgQrBox.hidden = true; };
    }
    drawQrInto('tg-qr', portInfo.tmeUrl);
    $('tg-qr-cap').innerHTML =
      '<b style="color:var(--honey-hi)">PORT ' + esc(String(portInfo.port)) + '</b><br>' +
      '<span style="word-break:break-all">' + esc(portInfo.secret) + '</span>';
    $('tg-qr-copy').onclick = function () {
      copyText(portInfo.tmeUrl, 'لینک ' + portInfo.port, 'Port ' + portInfo.port + ' link');
    };
    tgQrBox.hidden = false;
  }

  if ($('btn-tg-rotate')) {
    $('btn-tg-rotate').addEventListener('click', async function () {
      try {
        await api('/api/tgproxy/rotate', 'POST');
        showToast('کلید جدید ساخته شد', 'New proxy key generated');
        var res = await api('/api/bootstrap', 'GET');
        STATE.tgProxy = res.tgProxy || null;
        renderTgTab();
      } catch (err) {
        showToast(err.message, err.message);
      }
    });
  }

  ['b64', 'xray', 'sb', 'clash', 'doh'].forEach(function (kind) {
    var btn = $('cp-' + kind);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var u = getSelectedUser();
      if (!u || !u.urls) return;
      var url = kind === 'b64' ? u.urls.normalSub
        : kind === 'xray' ? u.urls.xrayFragmentSub
        : kind === 'sb' ? u.urls.singboxSub
        : kind === 'clash' ? u.urls.clashSub
        : u.urls.privateDoH;
      copyText(url,
        tr('اشتراک', 'Sub') + ' (' + kind.toUpperCase() + ')',
        kind.toUpperCase() + ' sub');
    });
  });

  if ($('qr-btn-b64')) {
    $('qr-btn-b64').onclick = function () { currentQrFormat = 'b64'; updateQr(); };
  }
  if ($('qr-btn-xray')) {
    $('qr-btn-xray').onclick = function () { currentQrFormat = 'xray'; updateQr(); };
  }
  if ($('sel-user')) {
    $('sel-user').addEventListener('change', function () {
      STATE.selectedUserId = $('sel-user').value;
      renderHomeLinks();
    });
  }
  if ($('btn-speed-burst')) {
    $('btn-speed-burst').addEventListener('click', function () {
      setChartMode('live');
      runBurstSpeedProbe();
    });
  }
  if ($('chart-mode-live')) $('chart-mode-live').onclick = function () { setChartMode('live'); };
  if ($('chart-mode-usage')) $('chart-mode-usage').onclick = function () { setChartMode('usage'); };

  /* ------------------------------------------------------ users ledger */

  function userUsagePct(u) {
    var used = Math.max(0, Number(u && u.usedBytes) || 0);
    if (used <= 0) return 0;
    var limit = Math.max(0, Number(u && u.limitBytes) || 0);
    if (limit > 0) return Math.min(100, Math.max(1, Math.round((used / limit) * 100)));
    var ref = 50 * 1073741824;
    (STATE.users || []).forEach(function (x) {
      if ((x.usedBytes || 0) > ref) ref = x.usedBytes;
    });
    return Math.min(100, Math.max(1, Math.round((used / ref) * 100)));
  }

  function expiryText(u) {
    if (u.status === 'expired') return tr('منقضی', 'Expired');
    if (u.startOnFirstUse && !u.firstConnectedAt) return tr('از اولین اتصال', 'From first connect');
    if (!u.expiryDays && !u.expiresAt) return tr('نامحدود', 'Unlimited');
    var rem = Number(u.remainingDays);
    if (rem >= 0) return tr(rem + ' روز مانده', rem + ' days left');
    return tr('نامحدود', 'Unlimited');
  }

  function filteredUsers() {
    var q = STATE.usersQuery.trim().toLowerCase();
    return (STATE.users || []).filter(function (u) {
      if (STATE.usersFilter === 'active' && u.status !== 'active') return false;
      if (STATE.usersFilter === 'paused' && u.status !== 'paused') return false;
      if (STATE.usersFilter === 'expired' && u.status !== 'expired') return false;
      if (q) {
        var hay = (u.name + ' ' + (u.note || '') + ' ' + (u.uuid || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function renderUsersLedger() {
    var list = $('users-list');
    if (!list) return;
    var users = filteredUsers();
    list.innerHTML = '';
    if (!users.length) {
      list.innerHTML = '<div class="empty-note">' + tr('مشترکی یافت نشد.', 'No subscribers found.') + '</div>';
      syncBulkBar();
      return;
    }
    users.forEach(function (u) {
      var card = document.createElement('div');
      card.className = 'ucard' + (u.status === 'paused' ? ' paused' : '') + (u.enabled ? '' : ' off');

      var ava = document.createElement('div');
      ava.className = 'uava';
      ava.textContent = String(u.name || '?').trim().charAt(0) || '?';

      var main = document.createElement('div');
      main.className = 'umain';
      var protoLbl = u.protocols ? u.protocols.split(',').join(' · ').toUpperCase() : tr('پیش‌فرض', 'DEFAULT');
      var ipLbl = u.autoRotateIps
        ? tr('IP چرخشی', 'ROTATING IP')
        : ((u.ips && u.ips.length) ? tr('IP ثابت', 'STATIC IP') : tr('IP پیش‌فرض', 'DEFAULT IP'));
      main.innerHTML =
        '<div class="uname">' + esc(u.name) + '</div>' +
        '<div class="umeta">' +
          '<span class="mono">' + esc(protoLbl) + '</span>' +
          '<span>' + esc(ipLbl) + '</span>' +
          '<span>' + esc(expiryText(u)) + '</span>' +
          (u.note ? '<span title="' + esc(u.note) + '">' + esc(String(u.note).slice(0, 18)) + '</span>' : '') +
        '</div>';

      var meter = document.createElement('div');
      meter.className = 'umeter';
      var pct = userUsagePct(u);
      var usedStr = formatBytes(u.usedBytes);
      var limStr = u.limitBytes > 0 ? formatBytes(u.limitBytes) : '∞';
      meter.innerHTML =
        '<div class="meter"><i style="width:' + pct + '%"></i></div>' +
        '<div class="umeta" style="margin-top:5px"><span class="mono">' + esc(usedStr + ' / ' + limStr) + '</span>' +
        '<span class="mono">' + pct + '%</span>' +
        '<span>' + esc(String(u.connections || 0)) + ' ' + tr('اتصال', 'conn') + '</span></div>';

      var acts = document.createElement('div');
      acts.className = 'uacts';
      var isSel = STATE.usersSelected.indexOf(u.id) >= 0;

      var sel = document.createElement('label');
      sel.className = 'selbox';
      sel.innerHTML = '<input type="checkbox" data-sel="' + esc(u.id) + '"' + (isSel ? ' checked' : '') + '>';

      var editBtn = document.createElement('button');
      editBtn.className = 'btn ghost sm-btn u-act-edit';
      editBtn.type = 'button';
      editBtn.innerHTML = '<svg class="ic ic-sm"><use href="#i-sliders"/></svg>' + tr('ویرایش', 'EDIT');
      editBtn.onclick = function () { openUserModal(u); };

      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn ghost sm-btn';
      toggleBtn.type = 'button';
      if (u.enabled) {
        toggleBtn.innerHTML = '<svg class="ic ic-sm"><use href="#i-power"/></svg>' + tr('توقف', 'PAUSE');
      } else {
        toggleBtn.innerHTML = '<svg class="ic ic-sm"><use href="#i-check"/></svg>' + tr('فعال', 'RESUME');
      }
      toggleBtn.onclick = async function () {
        try {
          var res = await api('/api/users/' + encodeURIComponent(u.id), 'PUT', { enabled: !u.enabled });
          softApplyBootstrap(res);
          showToast(u.enabled ? 'مشترک متوقف شد' : 'مشترک فعال شد', u.enabled ? 'Paused' : 'Resumed');
        } catch (err) { showToast(err.message, err.message); }
      };

      var resetBtn = document.createElement('button');
      resetBtn.className = 'btn ghost sm-btn';
      resetBtn.type = 'button';
      resetBtn.title = tr('ریست حجم مصرف', 'Reset traffic');
      resetBtn.innerHTML = '<svg class="ic ic-sm"><use href="#i-refresh"/></svg>' + tr('ریست', 'RESET');
      resetBtn.onclick = async function () {
        try {
          var res = await api('/api/users/' + encodeURIComponent(u.id), 'PUT', { resetTraffic: true });
          softApplyBootstrap(res);
          showToast('مصرف ریست شد', 'Traffic reset');
        } catch (err) { showToast(err.message, err.message); }
      };

      acts.appendChild(sel);
      acts.appendChild(editBtn);
      acts.appendChild(toggleBtn);
      acts.appendChild(resetBtn);

      card.appendChild(ava);
      card.appendChild(main);
      card.appendChild(meter);
      card.appendChild(acts);
      list.appendChild(card);
    });

    list.querySelectorAll('input[data-sel]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-sel');
        if (cb.checked) { if (STATE.usersSelected.indexOf(id) < 0) STATE.usersSelected.push(id); }
        else STATE.usersSelected = STATE.usersSelected.filter(function (x) { return x !== id; });
        syncBulkBar();
      });
    });
    syncBulkBar();
  }

  function syncBulkBar() {
    var bar = $('bulk-bar');
    if (!bar) return;
    bar.hidden = STATE.usersSelected.length === 0;
    if ($('bulk-count')) $('bulk-count').textContent = String(STATE.usersSelected.length);
  }

  if ($('u-select-all')) {
    $('u-select-all').addEventListener('change', function () {
      var on = $('u-select-all').checked;
      STATE.usersSelected = on ? filteredUsers().map(function (u) { return u.id; }) : [];
      renderUsersLedger();
    });
  }

  async function runBulk(action) {
    if (!STATE.usersSelected.length) return;
    if (action === 'delete') {
      var okay = confirm(tr('حذف ' + STATE.usersSelected.length + ' مشترک قابل بازگشت نیست. مطمئنی؟', 'Deleting ' + STATE.usersSelected.length + ' subscribers cannot be undone. Continue?'));
      if (!okay) return;
    }
    try {
      var res = await api('/api/users/bulk', 'POST', { ids: STATE.usersSelected, action: action });
      STATE.usersSelected = [];
      softApplyBootstrap(res);
      showToast('انجام شد', 'Done');
    } catch (err) { showToast(err.message, err.message); }
  }
  [['bulk-enable', 'enable'], ['bulk-disable', 'disable'], ['bulk-reset', 'reset_traffic'], ['bulk-delete', 'delete']].forEach(function (pair) {
    var b = $(pair[0]);
    if (b) b.addEventListener('click', function () { runBulk(pair[1]); });
  });

  if ($('u-search')) {
    $('u-search').addEventListener('input', function () {
      STATE.usersQuery = $('u-search').value || '';
      renderUsersLedger();
    });
  }
  if ($('u-filter')) {
    $('u-filter').addEventListener('change', function () {
      STATE.usersFilter = $('u-filter').value || 'all';
      renderUsersLedger();
    });
  }
  if ($('u-refresh')) {
    $('u-refresh').addEventListener('click', async function () {
      var ic = $('u-refresh').querySelector('.ic');
      if (ic) ic.classList.add('ic-spin');
      try {
        var res = await api('/api/bootstrap', 'GET');
        softApplyBootstrap(res);
        showToast('فهرست به‌روز شد', 'Refreshed');
      } catch (e) { showToast(e.message, e.message); }
      if (ic) ic.classList.remove('ic-spin');
    });
  }

  /* ------------------------------------------------------ user modal */

  var umUser = null;

  function setPill(id, on) {
    var el = $(id);
    if (el) el.classList.toggle('on', Boolean(on));
  }

  function refreshIpModeBoxes() {
    var auto = $('uf-autorot-ips') && $('uf-autorot-ips').checked;
    if ($('uf-static-box')) $('uf-static-box').hidden = auto;
    if ($('uf-rot-box')) $('uf-rot-box').hidden = !auto;
  }

  function openUserModal(u) {
    umUser = u || null;
    var modal = $('user-modal');
    if (!modal) return;
    $('um-title-fa').textContent = u ? ('ویرایش: ' + u.name) : 'مشترک جدید';
    $('um-title-en').textContent = u ? ('EDIT: ' + u.name) : 'NEW SUBSCRIBER';
    $('uf-id').value = u ? u.id : '';
    $('uf-name').value = u ? u.name : '';
    $('uf-note').value = u ? (u.note || '') : '';
    $('uf-gb').value = u ? String(u.trafficLimitGB || 0) : '0';
    $('uf-days').value = u ? String(u.expiryDays || 0) : '0';
    $('uf-uuid').value = u ? u.uuid : '';
    $('uf-tr').value = u ? u.trojanPassword : '';
    $('uf-first').checked = u ? Boolean(u.startOnFirstUse) : false;

    var protos = u && u.protocols ? String(u.protocols).split(',').filter(Boolean) : [];
    setPill('uf-p-vless', protos.indexOf('vless') >= 0);
    setPill('uf-p-trojan', protos.indexOf('trojan') >= 0);
    setPill('uf-p-ss', protos.indexOf('ss') >= 0);

    /* IP section */
    $('uf-ips').value = u && Array.isArray(u.ips) ? u.ips.join('\n') : '';
    var auto = u ? Boolean(u.autoRotateIps) : true;
    $('uf-autorot-ips').checked = auto;
    $('uf-ipcount').value = u ? String(u.ipCount || 15) : '15';
    var poolSel = $('uf-pooltype');
    if (poolSel) poolSel.value = (u && u.poolType) ? String(u.poolType) : 'mixed';
    refreshIpModeBoxes();

    $('uf-del').hidden = !u || STATE.users.length <= 1;
    var err = $('uf-err');
    if (err) { err.hidden = true; err.textContent = ''; }
    modal.hidden = false;
  }

  function closeUserModal() {
    var modal = $('user-modal');
    if (modal) modal.hidden = true;
    umUser = null;
  }

  if ($('um-close')) $('um-close').onclick = closeUserModal;
  if ($('user-modal')) {
    $('user-modal').addEventListener('click', function (ev) {
      if (ev.target === $('user-modal')) closeUserModal();
    });
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if ($('user-modal') && !$('user-modal').hidden) closeUserModal();
      if (freeModal && !freeModal.hidden) closeFreeModal();
    }
  });

  ['uf-p-vless', 'uf-p-trojan', 'uf-p-ss'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('click', function () {
      el.classList.toggle('on');
    });
  });
  if ($('uf-p-clear')) {
    $('uf-p-clear').onclick = function () {
      setPill('uf-p-vless', false);
      setPill('uf-p-trojan', false);
      setPill('uf-p-ss', false);
    };
  }
  if ($('uf-autorot-ips')) {
    $('uf-autorot-ips').addEventListener('change', refreshIpModeBoxes);
  }

  if ($('btn-add-user-modal')) $('btn-add-user-modal').onclick = function () { openUserModal(null); };
  if ($('uf-gen-uuid')) $('uf-gen-uuid').onclick = function () { $('uf-uuid').value = uuid4(); };
  if ($('uf-gen-tr')) $('uf-gen-tr').onclick = function () { $('uf-tr').value = randPass(14); };
  if ($('uf-rand-name')) $('uf-rand-name').onclick = function () { $('uf-name').value = tr('مشترک ', 'User ') + randPass(5); };
  if ($('uf-reset')) $('uf-reset').onclick = closeUserModal;

  function collectUserForm() {
    var protos = [];
    if ($('uf-p-vless') && $('uf-p-vless').classList.contains('on')) protos.push('vless');
    if ($('uf-p-trojan') && $('uf-p-trojan').classList.contains('on')) protos.push('trojan');
    if ($('uf-p-ss') && $('uf-p-ss').classList.contains('on')) protos.push('ss');
    return {
      name: $('uf-name').value.trim(),
      note: $('uf-note').value.trim(),
      trafficLimitGB: Number($('uf-gb').value) || 0,
      expiryDays: Number($('uf-days').value) || 0,
      startOnFirstUse: $('uf-first').checked,
      protocols: protos.join(','),
      ips: textToLines($('uf-ips').value),
      autoRotateIps: $('uf-autorot-ips').checked,
      ipCount: Number($('uf-ipcount').value) || 15,
      poolType: $('uf-pooltype') && $('uf-pooltype').value !== 'mixed' ? ($('uf-pooltype').value || '') : ''
    };
  }

  if ($('uf-del')) {
    $('uf-del').onclick = async function () {
      if (!umUser) return;
      var okay = confirm(tr('مشترک «' + umUser.name + '» حذف شود؟ این کار قابل بازگشت نیست.', 'Delete subscriber "' + umUser.name + '"? This cannot be undone.'));
      if (!okay) return;
      try {
        var r = await api('/api/users/' + encodeURIComponent(umUser.id), 'DELETE');
        closeUserModal();
        ingestBootstrap(r);
        showToast('مشترک حذف شد', 'Subscriber deleted');
      } catch (err) {
        showToast(err.message, err.message);
      }
    };
  }

  if ($('f-user')) {
    $('f-user').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var editId = $('uf-id').value;
      var payload = collectUserForm();
      var err = $('uf-err');
      if (err) { err.hidden = true; err.textContent = ''; }
      if (!payload.name) payload.name = tr('مشترک تازه', 'New subscriber');
      if ($('uf-uuid').value.trim()) payload.uuid = $('uf-uuid').value.trim();
      if ($('uf-tr').value.trim()) payload.trojanPassword = $('uf-tr').value.trim();
      try {
        var res;
        if (editId) {
          res = await api('/api/users/' + encodeURIComponent(editId), 'PUT', payload);
          showToast('مشترک ویرایش شد', 'Subscriber updated');
        } else {
          res = await api('/api/users', 'POST', payload);
          if (res.createdId) STATE.selectedUserId = res.createdId;
          showToast('مشترک جدید ساخته شد', 'Subscriber created');
        }
        closeUserModal();
        softApplyBootstrap(res);
        renderHomeLinks();
      } catch (e2) {
        if (err) { err.hidden = false; err.textContent = e2.message; }
        showToast(e2.message, e2.message);
      }
    });
  }

  /* ------------------------------------------------------ network settings */

  function populateSettingsForms() {
    var s = STATE.settings || {};
    setPill('s-vless', Boolean(s.enableVless));
    setPill('s-trojan', Boolean(s.enableTrojan));
    setPill('s-ss', Boolean(s.enableSS));

    var tlsSet = new Set((s.tlsPorts || [443]).map(Number));
    var tlsBox = $('tls-ports-box');
    if (tlsBox) tlsBox.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.checked = tlsSet.has(Number(cb.value));
    });
    var httpSet = new Set((s.httpPorts || [80, 8080, 8880, 2052, 2082, 2086, 2095]).map(Number));
    var httpBox = $('http-ports-box');
    if (httpBox) httpBox.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.checked = httpSet.has(Number(cb.value));
    });
    if ($('s-http-on')) $('s-http-on').checked = Boolean(s.enableHttpPorts);
    if ($('s-fp')) $('s-fp').value = s.fingerprint || 'chrome';
    if ($('s-ed')) $('s-ed').value = String(s.earlyData != null ? s.earlyData : 2048);
    if ($('s-frag-on')) $('s-frag-on').checked = Boolean(s.enableFragment);
    if ($('s-frag-pkt')) $('s-frag-pkt').value = s.fragmentPackets || '1-1';
    if ($('s-frag-len')) $('s-frag-len').value = s.fragmentLength || '10-20';
    if ($('s-frag-int')) $('s-frag-int').value = s.fragmentInterval || '10-20';
    if ($('s-cleanips')) $('s-cleanips').value = linesToText(s.cleanIPs);
    if ($('s-custom-domains')) $('s-custom-domains').value = linesToText(s.customDomains);
    if ($('s-proxyips')) $('s-proxyips').value = linesToText(s.proxyIPs);

    /* kill switch state */
    syncKillSwitch();
  }

  function collectSettingsFromForms() {
    var ports = [];
    var tlsBox = $('tls-ports-box');
    if (tlsBox) tlsBox.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      if (cb.checked) ports.push(Number(cb.value));
    });
    if (!ports.length) ports = [443];
    var hPorts = [];
    var httpBox = $('http-ports-box');
    if (httpBox) httpBox.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      if (cb.checked) hPorts.push(Number(cb.value));
    });
    if (!hPorts.length) hPorts = [80];

    return {
      enableVless: $('s-vless') && $('s-vless').classList.contains('on'),
      enableTrojan: $('s-trojan') && $('s-trojan').classList.contains('on'),
      enableSS: $('s-ss') && $('s-ss').classList.contains('on'),
      enableHttpPorts: $('s-http-on') ? $('s-http-on').checked : false,
      tlsPorts: ports,
      httpPorts: hPorts,
      fingerprint: $('s-fp') ? $('s-fp').value : 'chrome',
      earlyData: Number($('s-ed') ? $('s-ed').value : 2048),
      enableFragment: $('s-frag-on') ? $('s-frag-on').checked : true,
      fragmentPackets: $('s-frag-pkt') ? $('s-frag-pkt').value.trim() : '1-1',
      fragmentLength: $('s-frag-len') ? $('s-frag-len').value.trim() : '10-20',
      fragmentInterval: $('s-frag-int') ? $('s-frag-int').value.trim() : '10-20',
      cleanIPs: textToLines($('s-cleanips') ? $('s-cleanips').value : ''),
      customDomains: textToLines($('s-custom-domains') ? $('s-custom-domains').value : ''),
      proxyIPs: textToLines($('s-proxyips') ? $('s-proxyips').value : '')
    };
  }

  async function saveAllSettings() {
    try {
      var patch = collectSettingsFromForms();
      var res = await api('/api/settings', 'PUT', patch);
      STATE.settings = res.settings || STATE.settings;
      showToast('تنظیمات ذخیره شد', 'Settings saved');
    } catch (err) {
      showToast(err.message, err.message);
    }
  }
  if ($('save-net')) $('save-net').onclick = saveAllSettings;

  ['s-vless', 's-trojan', 's-ss'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('click', function () { el.classList.toggle('on'); });
  });

  /* ------------------------------------------------------ kill switch */

  function syncKillSwitch() {
    var on = Boolean(STATE.settings && STATE.settings.killSwitch);
    var lbl = $('kill-lbl');
    if (lbl) {
      lbl.innerHTML = on
        ? '<span class="fa">خاموش‌کردن سرویس (فعال)</span><span class="en">KILL SWITCH: ON</span>'
        : '<span class="fa">فعال‌سازی</span><span class="en">ENABLE</span>';
    }
    var btn = $('btn-kill');
    if (btn) btn.classList.toggle('danger', !on);
  }

  if ($('btn-kill')) {
    $('btn-kill').addEventListener('click', async function () {
      var on = Boolean(STATE.settings && STATE.settings.killSwitch);
      try {
        var res = await api('/api/killswitch', 'POST', {});
        STATE.settings = res.settings || STATE.settings;
        syncKillSwitch();
        showToast(on ? 'سرویس روشن شد' : 'سرویس اضطراری متوقف شد', on ? 'Service resumed' : 'Kill switch engaged');
      } catch (err) { showToast(err.message, err.message); }
    });
  }

  /* ------------------------------------------------------ password */

  if ($('f-pass')) {
    $('f-pass').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      try {
        await api('/api/password', 'POST', {
          currentPassword: $('pw-cur').value,
          newPassword: $('pw-new').value
        });
        $('pw-cur').value = '';
        $('pw-new').value = '';
        showToast('رمز مدیر تغییر کرد', 'Password changed');
      } catch (err) {
        showToast(err.message, err.message);
      }
    });
  }

  /* ------------------------------------------------------ backup & restore */

  if ($('btn-export')) {
    $('btn-export').addEventListener('click', async function () {
      try {
        var res = await api('/api/backup', 'GET');
        var blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'aral-sulfur-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
        showToast('پشتیبان دانلود شد', 'Backup downloaded');
      } catch (err) { showToast(err.message, err.message); }
    });
  }

  if ($('btn-import')) {
    $('btn-import').addEventListener('click', function () { $('inp-import').click(); });
  }
  if ($('inp-import')) {
    $('inp-import').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = async function () {
        try {
          var data = JSON.parse(String(reader.result || '{}'));
          if (!data || !Array.isArray(data.users)) {
            throw new Error(tr('فایل پشتیبان معتبر نیست.', 'Invalid backup file.'));
          }
          var okay = confirm(tr('بازیابی، تنظیمات و مشترکین فعلی را جایگزین می‌کند. ادامه؟', 'Restore replaces current subscribers and settings. Continue?'));
          if (!okay) return;
          var res = await api('/api/restore', 'POST', data);
          ingestBootstrap(res);
          showToast('بازیابی انجام شد', 'Restored');
        } catch (err) {
          showToast(err.message, err.message);
        }
        ev.target.value = '';
      };
      reader.readAsText(file);
    });
  }

  /* ------------------------------------------------------ GitHub updater */

  var ghChecking = false;

  function syncGhUpdaterUI() {
    var curV = (STATE.ghInfo && STATE.ghInfo.currentVersion) || STATE.currentVersion || '1.0.0';
    if ($('gh-mini-ver')) $('gh-mini-ver').textContent = 'V' + curV;
    if ($('gh-cur-ver')) $('gh-cur-ver').textContent = 'V' + curV;
  }

  function showGhMessage(text, isOk) {
    var box = $('gh-msg');
    if (!box) return;
    if (!text) { box.hidden = true; box.textContent = ''; return; }
    box.className = isOk ? 'ok-msg' : 'err';
    box.textContent = text;
    box.hidden = false;
  }

  async function checkGitHubUpdates(silentToast) {
    if (ghChecking) return;
    ghChecking = true;
    var bdg = $('gh-status-badge');
    if (bdg) {
      bdg.className = 'badge';
      bdg.textContent = tr('در حال بررسی…', 'CHECKING…');
    }
    try {
      var res = await api('/api/update/check', 'GET');
      STATE.ghInfo = res;
      if (res.currentVersion) STATE.currentVersion = res.currentVersion;
      syncGhUpdaterUI();
      if ($('gh-rem-ver')) $('gh-rem-ver').textContent = res.latestVersion ? 'V' + res.latestVersion : '—';
      if ($('gh-dl-link') && res.releaseUrl) $('gh-dl-link').href = res.releaseUrl;
      if ($('gh-notes-box')) {
        if (res.releaseNotes && res.releaseNotes.trim()) {
          $('gh-notes-box').textContent = res.releaseNotes.trim();
          $('gh-notes-box').hidden = false;
        } else {
          $('gh-notes-box').hidden = true;
        }
      }
      if ($('gh-inp-script') && !($('gh-inp-script').value || '').trim() && res.scriptName) {
        $('gh-inp-script').value = res.scriptName;
      }
      if (bdg) {
        if (res.notPublishedYet) {
          bdg.className = 'badge';
          bdg.textContent = tr('مخزن آماده انتشار', 'AWAITING RELEASE');
        } else if (res.updateAvailable) {
          bdg.className = 'badge inv';
          bdg.textContent = tr('نسخهٔ جدید آماده نصب', 'UPDATE AVAILABLE');
        } else {
          bdg.className = 'badge ok';
          bdg.textContent = tr('به‌روز است', 'UP TO DATE');
        }
      }
      if (!silentToast) {
        if (res.updateAvailable) {
          showToast('نسخهٔ جدید V' + res.latestVersion + ' یافت شد', 'Update V' + res.latestVersion + ' available');
        } else {
          showToast('پنل به آخرین نسخه مجهز است', 'Already on the latest version');
        }
      }
    } catch (err) {
      if (bdg) {
        bdg.className = 'badge bad';
        bdg.textContent = tr('خطا در اتصال', 'CHECK FAILED');
      }
      showGhMessage(err.message, false);
    } finally {
      ghChecking = false;
    }
  }

  if ($('btn-gh-check')) {
    $('btn-gh-check').onclick = function () {
      showGhMessage('', false);
      checkGitHubUpdates(false);
    };
  }

  if ($('btn-gh-apply')) {
    $('btn-gh-apply').onclick = async function () {
      var btn = $('btn-gh-apply');
      if (btn.disabled) return;
      btn.disabled = true;
      showGhMessage(tr('در حال دریافت و نصب بروزرسانی…', 'Downloading and applying the update…'), true);
      try {
        var res = await api('/api/update/apply', 'POST', {
          token: $('gh-inp-token') ? $('gh-inp-token').value.trim() : '',
          scriptName: $('gh-inp-script') ? $('gh-inp-script').value.trim() : ''
        });
        if (res.ok) {
          showGhMessage(
            tr('بروزرسانی نصب شد (' + (res.version || STATE.ghInfo && STATE.ghInfo.latestVersion || '') + '). چند لحظه بعد صفحه را نوسازی کنید.', 'Update applied (' + (res.version || '') + '). Refresh the page in a moment.'),
            true
          );
          showToast('بروزرسانی نصب شد', 'Update applied');
        } else {
          showGhMessage(res.error || 'failed', false);
        }
      } catch (err) {
        showGhMessage(err.message, false);
      } finally {
        btn.disabled = false;
      }
    };
  }

  /* ------------------------------------------------------ periodic tasks */

  setInterval(function () {
    if (STATE.mode === 'admin' || STATE.mode === 'login') {
      detectVisitorNetwork();
    }
  }, 7000);

  setInterval(function () {
    if (STATE.mode === 'admin' && !document.hidden) {
      api('/api/bootstrap', 'GET')
        .then(softApplyBootstrap)
        .catch(function () {});
    }
  }, 30000);

  /* --------------------------------------------------------------- boot */

  if ($('year')) $('year').textContent = String(new Date().getFullYear());
  if (window.ARAL && window.ARAL.cf) mergeVisitorCf(window.ARAL.cf);
  applyAppearance();
  detectVisitorNetwork();
  tickClock();
  setInterval(function () { if (!document.hidden) tickClock(); }, 1000);
  (function chartLoop(ts) {
    requestAnimationFrame(chartLoop);
    if (document.hidden) return;
    var canvas = $('telemetry-canvas');
    if (!canvas) return;
    if (STATE.mode !== 'admin' || !$('pane-home') || $('pane-home').hidden) return;
    var now = ts || performance.now();
    var hasData = rttHistory.length > 0 || speedHistory.length > 0;
    var animating = chartMode === 'live' ? (hasData && !chartReducedMotion) : usageAnimProgress < 1;
    var sizeChanged = canvas.clientWidth !== chartDrawnW || canvas.clientHeight !== chartDrawnH;
    var dirty = chartDrawnRev !== chartDataRev || chartDrawnMode !== chartMode || sizeChanged;
    if (!animating && !dirty) return;
    if (now - chartLastDraw < 31) return;
    chartLastDraw = now;
    chartDrawnRev = chartDataRev;
    chartDrawnMode = chartMode;
    chartDrawnW = canvas.clientWidth;
    chartDrawnH = canvas.clientHeight;
    drawChartFrame(now);
  })(performance.now());

  /* Loading reliability: retry the bootstrap handshake (2 extra attempts with
     backoff) so a cold KV read or a dropped connection never leaves a blank page. */
  function fetchBootstrapWithRetry(attempt) {
    api('/api/bootstrap', 'GET')
      .then(ingestBootstrap)
      .catch(function (err) {
        if (attempt < 2 && !preloaderHidden) {
          setTimeout(function () { fetchBootstrapWithRetry(attempt + 1); }, 900 * (attempt + 1));
          return;
        }
        try {
          $('diag-mode').textContent = 'OFFLINE';
          $('v-stateless').hidden = false;
          renderStatelessTicket();
        } catch (e) {}
        hidePreloader();
      });
  }
  fetchBootstrapWithRetry(0);
})();
