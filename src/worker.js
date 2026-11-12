/**
 * ARAL — Cloudflare Worker & Pages Entrypoint (Free-Tier 10ms CPU optimized).
 */

import {
  hashPassword,
  PBKDF2_DEFAULT_ITER,
  randomPassword,
  randomToken,
  randomUUID,
  safeDecodeURIComponent,
  safeJsonParse,
  signSession,
  verifyPassword,
  verifySession,
} from './crypto.js';
import {
  appendLog,
  applyAutoResets,
  beginPasswordRecovery,
  checkLoginRateLimit,
  clearLoginFailures,
  clearPendingUsage,
  clearRuntimeMemoryCaches,
  enrichUserView,
  GITHUB_REPO,
  GITHUB_REPO_URL,
  initializePanelState,
  loadRuntimeState,
  normalizeProxyList,
  normalizeUser,
  PANEL_BRAND,
  PANEL_VERSION,
  pendingUsageBytesOf,
  recordLoginFailure,
  sanitizeSettings,
  saveRuntimeState,
} from './storage.js';
import { dialChainProxy, handlePrivateDoH, handleTunnelWS, normalizeIpPrefix, probeOutboundEndpoint } from './protocols.js';
import {
  buildTgProxyFullLinks,
  generateTgSecret,
  handleTgSessionApi,
  handleTgWebSocket,
  maybeHandleTgBridgePage,
} from './tgproxy.js';
import {
  buildClashYaml,
  buildNodeDescriptors,
  buildSingboxConfig,
  buildXrayConfigs,
  computeQuickUserNodeMeta,
  hydrateUserAddresses,
  renderDecoyGazette,
  serveSubscription,
} from './sub.js';
import { clearPool, getPool, invalidatePoolCache, parseListText, provisionPoolsFromRepo, sampleFrom, savePool, setActiveDataRepo } from './pools.js';
import { handleTgBotUpdate, setTgApiBase, tgBotConnect, tgBotDisconnect, tgBotPublicInfo, tgBotStatus } from './tgbot.js';
import { getInlineAssets, getPanelHtml } from './generated/ui.js';
import { BRAND_FILES } from './generated/brand.js';

const SESSION_COOKIE = 'nl_sess';
const SESSION_TTL_MS = 7 * 86_400_000;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const CF_IP_RANGES_URL = 'https://api.cloudflare.com/client/v4/ips';
let cfIpRangesCache = null;
const FAVICON_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAMAAABg3Am1AAAAwFBMVEXjnRrr2KSnYRX11VnQpmXm4M/41yZeZlDNdAmfi2ciMBdYWiyhpZRqLAJ8g3GpihjPtJM7RymIPQCmdUL58uj9+vX17uOlVwImMxnz6dj3xwjp5NjztwisYwi2eCi8gjfHxrn75YgVJAmxaxXCjEj2yRX41kf65XqlqJjq3Mb2yif66Jb16Mo2QinXtYbm1rryuRe1tqbGllbbvJLspgryqAf52HmZnIviyacwPCR1fGizcRv51Rb51AogLhSMkX73ASp6AAAEw0lEQVR42nWVCXOiTBCGZ5iDQ+Nmd2mGW7xA8D6jUbP//199PShoUvV1VVKo79Pn0EPcb+a5LgAEJaW0jPSj+9PIdzmA6NodbcavX784FS78P4Byb2r+7nTsLqWr1YpSzgmjP5AXANyPhWNuIniaG1DGZt+QJwCbxfkj+pk1wJwyCm4LPQAPXNO3vacaBG0f5wOWXk7wCnggFh3xKp/lxSxoo1x2p4v3AqDe6QF4rZ6y6joYzFoHKaWjVwD1Hy/uXVZVlRzM6Ew8vjmN0nT8Aojf3ad7QYtcxms2wZY2MfDXk9pCA4Bpt3qgec6qNaHFJI4rVrTdgZ3icAdgasKzI5LlE8kGR1bFcRxe83n7E1crqIHIjNr8aUUwwmBwPBYTDHG7hvmzuNTQgAfd6bMAua9QjvoBlZMwDqvDte02rBROkLjR58tgZcgotudY0EJWMo7X5EBokxWMUwRg0waAYJAzPNiDY1EMsISJrPZ7Qgg73kcIJVZB3I/oOS6ZM8Kw/8WAHQ4TRhnq11Iydk8L+lsg0bTJkcp8Eh/IYZ0XBWNrOaCzow6AIcjx0drUJSKDxj+7hvHhsA7DEP2yYnY8zjghlmEhQ2tVcClJ1oy/kNdbqHsfSvS7n2C3ZjOGWsuy8EV65LQjWdRMWN5uYTgJw5vUaVT5ek1IeM+JEDm/D48TcW/RPK8mUsqbROAumUzCg3UIQ8TIgeX1sYIlAo+EJrEGpLxeyR41F0XCK7qPr3GMgVj91mEenNwzEuwm5Rr/ZKULJoYxsqz94XCwyA25UJJ5A9xLxj6yG8bIdZXGSKEl+LTGgskeW9H0tQEwo0LqbmqzDKVGFwO7yYgyDIOQKyHNbGmzNY66fQ/AwtaPULm3DKMGcAzfAc8LvJJbf95aCpNCofH2pvQnHrjeA5iTWh6IckV33EZ/tQZdW5b68/b21sGN2ec7WgaBZmhA2j0ZZe80WNF32/5rPOyvjfb+/n5alVEUIRDQ5+aLOr7vf9QnPQiisizFfB7U5qFB9nuBp3Q+bwEwnbPj+Nn93XhsVrfdsdD19SaaPzff9OvsLM5+515c1rX//bOFwP/auhlkdfig3a1icf4yM3/h9zAETB1/OBw62cYZ1uY7m6zJ9zE40z8vBPz7Wvgb8PCTY3an0yja1Pbv/PX5DdAJLZwutbVygYfL9LEYNNEza/sJYEKOb4KhqMCkTKgBParO0O+gvvMT0AmdI64SNe9iUlOoI+BkFueOiCKxcXwNdBsAPob+cBoYRj/lYGKFmTkcbnQEc/iFw/G/fMfOhsNnhGkXl19tnitsuzed9np630HU7fU+tdmR+PzsPrc3XphLbUF98dYX2m5ZusHunZ+eM7wfQJ3SVj1spb/19OUuEmMJY3wb9IrXR+Mx9hoILsoOxFyUAk79bYDrqs+DkaI0SfqcngyOyLZflnxr76BOqa+SPprN3aUxQoAbqQZ4klxSvjT66HOkTn11SZd3QPAx6tPE4FSlGlB9VOwgVUuApcLLzUsTmiYr+Haxe6ka79RIvAJcA/06awTKB4C4kaApxVe4LC6jRG2DBL3XwEklo8tIJauRaiJ42zHn4zHfcs+l2zE+8SDYjk/Ax/r63+mvtid3O6533n9FKsr5gCWy1wAAAABJRU5ErkJggg==';
const FAVICON_PNG_BYTES = Uint8Array.from(atob(FAVICON_PNG_B64), (ch) => ch.charCodeAt(0));
const LOGO_192_PNG_B64 = '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';

/* Progressive Web App manifest + service worker (self-hosted, zero CDN) */
function PWA_MANIFEST(request) {
  let origin = 'https://example.workers.dev';
  try { origin = new URL(request.url).origin; } catch {}
  const icon = `data:image/png;base64,${LOGO_192_PNG_B64}`;
  return JSON.stringify({
    name: 'Aral Sulfur Panel',
    short_name: 'Aral Sulfur',
    description: 'ARAL SULFUR — VLESS, Trojan and Shadowsocks panel on Cloudflare. Copying and selling prohibited.',
    start_url: '/panel',
    scope: '/',
    display: 'standalone',
    background_color: '#1D2117',
    theme_color: '#1D2117',
    dir: 'rtl',
    lang: 'fa-IR',
    icons: [
      { src: icon, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: icon, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    ],
  });
}

const PWA_SERVICE_WORKER = `/* ARAL SULFUR service worker — minimal, panel-shell cache only */
const SW_CACHE = 'aral-sulfur-v2';
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SW_CACHE));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SW_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (/^\/(api|sub|feed|yaml|status|dns-query)\//.test(url.pathname) || /^\/(api|sub)/.test(url.pathname)) return;
  if (url.pathname === '/panel' || url.pathname === '/panel/' || url.pathname === '/') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SW_CACHE);
        try {
          const fresh = await fetch(event.request);
          if (fresh && fresh.ok) cache.put(event.request, fresh.clone());
          return fresh;
        } catch (e) {
          const hit = await cache.match(event.request);
          if (hit) return hit;
          throw e;
        }
      })()
    );
  }
});
`;

function extractColo(request) {
  const direct = request.cf && request.cf.colo ? String(request.cf.colo).trim() : '';
  if (direct && direct.toUpperCase() !== 'EDGE') return direct.toUpperCase();
  const ray = request.headers.get('cf-ray') || '';
  const dash = ray.lastIndexOf('-');
  if (dash > 0 && ray.length - dash <= 5) {
    const code = ray.slice(dash + 1).trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) return code;
  }
  return 'CF-GLOBAL';
}

const ISP_FRIENDLY_MAP = [
  [/mobile communication company of iran|mci\b|hamrah/i, 'همراه اول (MCI)', 'MCI (Hamrah-e Aval)'],
  [/irancell|mtn irancell/i, 'ایرانسل (Irancell)', 'MTN Irancell'],
  [/iran telecommunication|tci\b|mokhaberat/i, 'مخابرات ایران (TCI)', 'TCI (Mokhaberat)'],
  [/rightel|tamin telecom/i, 'رایتل (Rightel)', 'Rightel'],
  [/aria shatel|shatel/i, 'شاتل (Shatel)', 'Shatel'],
  [/asiatech/i, 'آسیاتک (Asiatech)', 'Asiatech'],
  [/mobinnet/i, 'مبین‌نت (Mobinnet)', 'Mobinnet'],
  [/hiweb|danehe|pars ارتباط|novin net/i, 'های‌وب (HiWEB)', 'HiWEB'],
  [/pars online|parsonline/i, 'پارس‌آنلاین (ParsOnline)', 'ParsOnline'],
  [/zitel/i, 'زیتل (Zitel)', 'Zitel'],
  [/pishgaman/i, 'پیشگامان (Pishgaman)', 'Pishgaman'],
  [/afranet/i, 'افرانت (Afranet)', 'Afranet'],
  [/respina/i, 'رسپینا (Respina)', 'Respina'],
  [/fanava/i, 'فن‌آوا (Fanava)', 'Fanava'],
  [/aptel|samantel|lotustel/i, 'اپراتور مجازی موبایل (MVNO)', 'Iran MVNO'],
];

function classifyIsp(rawOrg = '', asn = '') {
  const org = String(rawOrg || '').trim();
  for (const [rx, fa, en] of ISP_FRIENDLY_MAP) {
    if (rx.test(org)) return { fa, en, isIranIsp: true };
  }
  if (org) {
    return { fa: org, en: org, isIranIsp: false };
  }
  if (asn) {
    return { fa: `AS${asn}`, en: `AS${asn}`, isIranIsp: false };
  }
  return { fa: 'شبکه محلی / نامشخص', en: 'Local / Direct Network', isIranIsp: false };
}

const COUNTRY_MAP = {
  IR: ['ایران', 'Iran'],
  NL: ['هلند', 'Netherlands'],
  DE: ['آلمان', 'Germany'],
  US: ['آمریکا', 'United States'],
  GB: ['بریتانیا', 'United Kingdom'],
  FR: ['فرانسه', 'France'],
  TR: ['ترکیه', 'Turkey'],
  AE: ['امارات', 'UAE'],
  FI: ['فنلاند', 'Finland'],
  SE: ['سوئد', 'Sweden'],
  CA: ['کانادا', 'Canada'],
  SG: ['سنگاپور', 'Singapore'],
  JP: ['ژاپن', 'Japan'],
  RU: ['روسیه', 'Russia'],
  CN: ['چین', 'China'],
};

function extractClientInfo(request, url) {
  const cf = request.cf || {};
  const rawIp =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    '127.0.0.1';
  const hdrCountry = String(request.headers.get('cf-ipcountry') || '').trim().toUpperCase();
  const isLoopback = rawIp === '127.0.0.1' || rawIp === '::1';
  const country = hdrCountry || (isLoopback ? 'XX' : String(cf.country || 'XX').trim().toUpperCase());
  const cNames = COUNTRY_MAP[country] || [country === 'XX' ? 'محلی' : country, country === 'XX' ? 'Local' : country];
  const city = isLoopback && !hdrCountry ? '' : String(cf.city || '').trim();
  const region = isLoopback && !hdrCountry ? '' : String(cf.region || '').trim();
  const asnNum = isLoopback && !hdrCountry ? 0 : (Number(cf.asn) || 0);
  const asOrg = isLoopback && !hdrCountry ? '' : String(cf.asOrganization || '').trim();
  const isp = classifyIsp(asOrg, asnNum ? String(asnNum) : '');
  return {
    host: url.host,
    origin: url.origin,
    colo: extractColo(request),
    clientIp: rawIp,
    country,
    countryNameFa: cNames[0],
    countryNameEn: cNames[1],
    city,
    region,
    asn: asnNum,
    ispRaw: asOrg,
    asOrganization: asOrg,
    ispFa: isp.fa,
    ispEn: isp.en,
    isIranIsp: isp.isIranIsp || country === 'IR',
    httpProtocol: cf.httpProtocol || 'HTTP/2',
    tlsVersion: cf.tlsVersion || 'TLSv1.3',
  };
}

let speedBuf64K = null;
function getSpeedBuffer(byteLen) {
  if (!speedBuf64K) {
    speedBuf64K = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) speedBuf64K[i] = (i * 73 + 19) & 0xff;
  }
  const clamped = Math.max(1024, Math.min(262144, Number(byteLen) || 32768));
  if (clamped <= 65536) return speedBuf64K.subarray(0, clamped);
  const out = new Uint8Array(clamped);
  for (let off = 0; off < clamped; off += 65536) {
    const slice = speedBuf64K.subarray(0, Math.min(65536, clamped - off));
    out.set(slice, off);
  }
  return out;
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    try {
      const url = new URL(request.url);
      const path = url.pathname || '/';
      const upgradeHeader = (request.headers.get('upgrade') || '').toLowerCase();

      // 0) Fast zero-KV favicon response (branded emblem)
      if (upgradeHeader !== 'websocket' && path === '/favicon.ico') {
        return new Response(FAVICON_PNG_BYTES, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'cache-control': 'public, max-age=86400',
          },
        });
      }

      // 0a) Immutable brand assets (subset fonts + logo images) — browser-cached
      //     for a week, so repeat panel loads transfer zero extra font bytes.
      if (upgradeHeader !== 'websocket' && path.startsWith('/brand/')) {
        const name = path.slice('/brand/'.length);
        const b64 = Object.prototype.hasOwnProperty.call(BRAND_FILES, name) ? BRAND_FILES[name] : null;
        if (!b64) return new Response(null, { status: 404 });
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const ext = name.split('.').pop();
        const mime = ext === 'woff2' ? 'font/woff2' : ext === 'png' ? 'image/png' : 'application/octet-stream';
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': mime,
            'cache-control': 'public, max-age=604800, immutable',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      // 0b) PWA app manifest + service worker (installable panel)
      if (upgradeHeader !== 'websocket' && path === '/manifest.webmanifest') {
        return new Response(PWA_MANIFEST(request), {
          status: 200,
          headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }
      if (upgradeHeader !== 'websocket' && path === '/sw.js') {
        return new Response(PWA_SERVICE_WORKER, {
          status: 200,
          headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }

      // 0b) PWA app manifest + service worker (installable panel)
      if (upgradeHeader !== 'websocket' && path === '/manifest.webmanifest') {
        return new Response(PWA_MANIFEST(request), {
          status: 200,
          headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }
      if (upgradeHeader !== 'websocket' && path === '/sw.js') {
        return new Response(PWA_SERVICE_WORKER, {
          status: 200,
          headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }

      const runtime = await loadRuntimeState(env);

      // Publish the configured data repo for the pools layer so
      // clean-IP rotation / exit-proxy replacement actually use the GitHub repo.
      try { setActiveDataRepo(runtime.settings ? runtime.settings.dataRepo : ''); } catch {}

      // Optional Telegram API base override (E2E test harness only)
      try { if (env?.NL_TG_API_BASE) setTgApiBase(env.NL_TG_API_BASE); } catch {}

      // One-time background provisioning of data pools + default clean IPs
      // from the configured repo (Aral-Dev/Aral-Sulfur data/ folder). Cheap KV-flag check,
      // runs at most once per deployment, never blocks the request.
      try {
        if (runtime.kvBound && runtime.initialized && ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(provisionPoolsFromRepo(env, runtime, { persistState: saveRuntimeState }));
        }
      } catch {}

      // 1) WebSocket Upgrade: Official Telegram Web Proxy (`/api/v1/ws`) OR VLESS/Trojan Tunnel
      if (upgradeHeader === 'websocket') {
        const wsProto = request.headers.get('sec-websocket-protocol') || '';
        if (path === '/api/v1/ws' && wsProto.includes('tproxy-lane-v1.')) {
          return await handleTgWebSocket(request, url, runtime.settings);
        }
        return await handleTunnelWS(request, env, ctx, runtime);
      }

      // 1b) Official Telegram Web Proxy HTTP Bridge & Session Lease endpoints
      if (path === '/api/v1/session') {
        return await handleTgSessionApi(request, runtime.settings);
      }
      if (path === '/' && url.search.startsWith('?bridge=')) {
        const tgBridge = await maybeHandleTgBridgePage(request, url, runtime.settings);
        if (tgBridge) return tgBridge;
      }

      // 2) Health probe (`/health` & `/api/ping`)
      if (path === '/api/ping' || path === '/health') {
        return json(
          {
            ok: true,
            version: PANEL_VERSION,
            kvBound: runtime.kvBound,
            initialized: runtime.initialized,
            ts: Date.now(),
            colo: extractColo(request),
            country: request.cf?.country || '',
          },
          200,
          { 'access-control-allow-origin': '*' }
        );
      }

      // 3) Admin Panel REST API
      if (path.startsWith('/api/')) {
        return await handleApi(request, url, env, runtime, ctx);
      }

      // 4) Private DoH endpoint: /dns-query/:subToken
      if (path.startsWith('/dns-query/')) {
        const token = safeDecodeURIComponent(path.slice('/dns-query/'.length).split('/')[0], '').trim();
        const matched = findActiveTokenUser(runtime, token);
        if (!matched) {
          return new Response('Forbidden DoH token', { status: 403 });
        }
        // ULTRA: when the Family Filter is on (panel-wide or for this subscriber), the private
        // DoH resolver itself upgrades to Cloudflare Family so prohibited lookups fail at source.
        const gateDoH = (matched.blockAdult || runtime.settings.blockAdult)
          ? 'https://family.cloudflare-dns.com/dns-query'
          : runtime.settings.upstreamDoH;
        return await handlePrivateDoH(request, gateDoH);
      }

      // 5) Subscription endpoints: /sub/:token | /feed/:token (compat alias) | /sub?uuid=...
      if (path === '/sub' || path.startsWith('/sub/') || path === '/feed' || path.startsWith('/feed/')) {
        const isFeed = path.startsWith('/feed');
        const tokStart = path.indexOf('/', 1); // second path segment ("/sub/<tok>" -> 4)
        const rawTok = tokStart === -1
          ? (url.searchParams.get('token') || url.searchParams.get('uuid') || '')
          : path.slice(tokStart + 1).split('/')[0];
        const token = safeDecodeURIComponent(rawTok, '').trim();
        const matched = findSubscriptionUser(runtime, token);
        if (!matched) {
          return json({ ok: false, error: 'لینک اشتراک معتبر نیست یا منقضی شده است.' }, 404);
        }
        const subRes = await serveSubscription(request, matched, runtime.settings, await getInlineAssets(), env);
        // /feed alias keeps the payload identical to /sub but is never cached by proxies
        if (isFeed) {
          const headers = new Headers(subRes.headers);
          headers.set('cache-control', 'no-store');
          return new Response(subRes.body, { status: subRes.status, headers });
        }
        return subRes;
      }

      // 5b) ULTRA: direct subscriber status route (/status/:token → live Press Pass)
      if (path.startsWith('/status/')) {
        const rawTok = safeDecodeURIComponent(path.slice('/status/'.length).split('/')[0], '').trim();
        const matched = findSubscriptionUser(runtime, rawTok);
        if (!matched) {
          return new Response('وضعیت یافت نشد', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        return await serveSubscription(request, matched, runtime.settings, await getInlineAssets(), env);
      }

      // 6) Explicit Admin Panel route (/panel)
      if (path === '/panel' || path === '/panel/') {
        return await servePanelShell(request, env);
      }

      // 7) Camouflage / Root mode handling on `/`
      if (path === '/' && runtime.initialized) {
        if (runtime.settings.rootMode === 'gazette') {
          return new Response(renderDecoyGazette(await getInlineAssets()), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        if (runtime.settings.fallbackDomain) {
          if (runtime.settings.rootMode === 'fallback') {
            return await proxyFallbackDomain(request, runtime.settings.fallbackDomain, await getInlineAssets());
          }
        }
      }

      // 8) Fallback reverse-proxy for non-panel paths when fallbackDomain is configured
      if (
        runtime.initialized &&
        runtime.settings.rootMode === 'fallback' &&
        runtime.settings.fallbackDomain &&
        !path.startsWith('/panel')
      ) {
        return await proxyFallbackDomain(request, runtime.settings.fallbackDomain, await getInlineAssets());
      }

      // 9) Default: serve Admin Panel UI
      return await servePanelShell(request, env);
    } catch (err) {
      return json(
        {
          ok: false,
          error: 'خطای داخلی سرور رخ داد؛ درخواست با ایمنی مهار شد.',
          detail: err && err.message ? err.message : String(err),
        },
        500
      );
    }
  },
};

/* --------------------------------------------------------- REST API Router */

async function handleApi(request, url, env, runtime, ctx = {}) {
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const cfInfo = extractClientInfo(request, url);
  const clientIp = cfInfo.clientIp;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': url.origin,
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }

  // ---- GET /api/client-info ----
  if (path === '/api/client-info' && method === 'GET') {
    return json({ ok: true, cf: cfInfo, ts: Date.now() }, 200, { 'access-control-allow-origin': '*' });
  }

  // ---- GET /api/speed-probe ----
  if (path === '/api/speed-probe' && method === 'GET') {
    const reqBytes = Number(url.searchParams.get('bytes')) || 32768;
    const payload = getSpeedBuffer(reqBytes);
    return new Response(payload, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store, no-transform',
        'content-length': String(payload.byteLength),
        'access-control-allow-origin': '*',
      },
    });
  }

  // ---- POST /api/speed-probe (bounded same-origin upload observation) ----
  if (path === '/api/speed-probe' && method === 'POST') {
    const maxBytes = 131072;
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > maxBytes) return json({ ok: false, error: 'Probe too large' }, 413);
    const reader = request.body?.getReader();
    if (!reader) return json({ ok: false, error: 'Empty upload probe' }, 400);
    let received = 0;
    try {
      while (received <= maxBytes) {
        const { value, done } = await reader.read();
        if (done) return json({ ok: true, receivedBytes: received });
        received += value?.byteLength || 0;
      }
      await reader.cancel();
      return json({ ok: false, error: 'Probe too large' }, 413);
    } catch {
      return json({ ok: false, error: 'Upload probe failed' }, 400);
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  // ---- GET /api/bootstrap ----
  if (path === '/api/bootstrap' && method === 'GET') {
    const authed = await isAuthenticated(request, runtime);

    if (!runtime.kvBound) {
      return json({
        ok: true,
        version: PANEL_VERSION,
        state: runtime.initialized ? 'stateless' : 'needs_kv',
        mode: 'stateless',
        kvBound: false,
        hasEnvUuid: Boolean(runtime.envUuid),
        authenticated: false,
        host: url.host,
        edge: cfInfo.colo,
        cf: cfInfo,
        tgProxy:
          runtime.settings.enableTgProxy !== false
            ? await buildTgProxyFullLinks(url.host, runtime.settings.tgProxySecret, runtime.settings.tgProxyDomain)
            : null,
        statelessUser: runtime.users[0]
          ? buildAdminUserSummary(runtime.users[0], runtime.settings, url.host)
          : null,
      });
    }

    if (!runtime.initialized) {
      return json({
        ok: true,
        version: PANEL_VERSION,
        state: 'needs_setup',
        mode: 'setup',
        kvBound: true,
        kvName: runtime.kvName,
        authenticated: false,
        host: url.host,
        edge: cfInfo.colo,
        cf: cfInfo,
      });
    }

    if (!authed) {
      return json({
        ok: true,
        version: PANEL_VERSION,
        state: 'locked',
        mode: 'login',
        kvBound: true,
        kvName: runtime.kvName,
        authenticated: false,
        host: url.host,
        edge: cfInfo.colo,
        cf: cfInfo,
      });
    }

    const fresh = await loadRuntimeState(env, true);
    const reset = applyAutoResets(fresh);
    if (reset.changed) {
      try { await saveRuntimeState(env, reset.state); } catch {}
      return json(await buildFullAdminPayload(reset.state, url.host, cfInfo));
    }
    return json(await buildFullAdminPayload(fresh, url.host, cfInfo));
  }

  // ---- POST /api/setup ----
  if (path === '/api/setup' && method === 'POST') {
    if (!runtime.kvBound) {
      return json(
        {
          ok: false,
          error: 'ابتدا یک فضای KV با نام KV در تنظیمات ورکر (Settings → Bindings) متصل کنید.',
        },
        400
      );
    }
    if (runtime.initialized) {
      return json({ ok: false, error: 'پنل قبلاً راه‌اندازی شده است. لطفاً وارد شوید.' }, 403);
    }

    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);

    const password = String(body.password || '');
    if (password.length < 6) {
      return json({ ok: false, error: 'گذرواژه مدیریت باید دست‌کم ۶ نویسه باشد.' }, 400);
    }

    const created = await initializePanelState(env, {
      password,
      firstUserName: body.firstUserName || 'سردبیر (اصلی)',
      preferredUuid: body.preferredUuid || body.uuid || '',
      // ULTRA: password-recovery flow — preserve every existing subscriber & setting
      existing: Array.isArray(runtime.users) && runtime.users.length ? runtime : null,
    });

    const token = await signSession(
      { sub: 'admin', ver: created.auth.ver, exp: Date.now() + SESSION_TTL_MS },
      created.auth.secret
    );

    return json(await buildFullAdminPayload(created, url.host, cfInfo), 200, {
      'set-cookie': formatSessionCookie(token, url.protocol === 'https:'),
    });
  }

  // ---- POST /api/recover (Password recovery via Cloudflare API token) ----
  // Proves the caller owns THIS worker (valid CF token + matching script/account) and
  // then clears the admin password — the panel falls back to first-run setup while
  // all subscribers, settings and logs stay intact. Intentionally unauthenticated.
  if (path === '/api/recover' && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);

    if (!runtime.kvBound || !runtime.initialized) {
      return json({ ok: false, error: 'بازیابی رمز در این حالت پنل معتبر نیست.' }, 400);
    }

    const token = String(body.token || '').trim();
    if (!token || token.length < 20) {
      return json({ ok: false, error: 'لطفاً یک Cloudflare API Token معتبر وارد کنید.' }, 400);
    }

    const scriptName = inferWorkerNameFromHost(url.host);
    const check = await verifyAndProbeCloudflareToken({
      token,
      accountId: String(body.accountId || '').trim(),
      scriptName,
      env,
    });
    if (!check.ok) {
      return json({ ok: false, error: check.error || 'توکن کلادفلر قابل قبول نیست.' }, 400);
    }

    // Ownership proof: token must control THIS worker script (workers.dev host) or,
    // on custom domains, carry Workers-edit capability over the account.
    const scripts = (Array.isArray(check.availableScripts) ? check.availableScripts : []).map((s) => String(s || '').toLowerCase());
    const ownsScript = !scriptName || scripts.includes(String(scriptName).toLowerCase());
    if (!ownsScript && !check.canEditWorkers) {
      return json(
        { ok: false, error: 'این توکن به ورکر این پنل دسترسی ندارد؛ مالکیت اثبات نشد.' },
        400
      );
    }

    const recState = await loadRuntimeState(env, true);
    if (!recState || recState.mode !== 'kv') {
      return json({ ok: false, error: 'وضعیت پنل قابل بازیابی نیست.' }, 400);
    }
    const recovered = beginPasswordRecovery(recState);
    const saved = await saveRuntimeState(env, recovered);
    return json({
      ok: true,
      state: 'needs_setup',
      account: check.accountName || '',
      preservedUsers: saved.users.length,
    });
  }

  // ---- POST /api/login ----
  if (path === '/api/login' && method === 'POST') {
    if (!runtime.initialized || !runtime.auth) {
      return json({ ok: false, error: 'پنل هنوز راه‌اندازی نشده است.' }, 400);
    }

    const limit = checkLoginRateLimit(clientIp);
    if (!limit.allowed) {
      return json(
        { ok: false, error: `تلاش‌های ناموفق بیش از حد مجاز. ${limit.retrySec} ثانیه صبر کنید.` },
        429
      );
    }

    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);

    const rawPw = String(body.password || '');
    const valid = await verifyPassword(rawPw, runtime.auth);
    if (!valid) {
      recordLoginFailure(clientIp);
      return json({ ok: false, error: 'گذرواژه اشتباه است.' }, 401);
    }

    clearLoginFailures(clientIp);
    let fresh = await loadRuntimeState(env, true);

    // Auto-migrate legacy high-iteration PBKDF2 records down to Free-Tier-safe 10,000 iterations
    if ((fresh.auth?.iter || 0) > PBKDF2_DEFAULT_ITER) {
      const upgraded = await hashPassword(rawPw, null, PBKDF2_DEFAULT_ITER);
      fresh.auth = { ...fresh.auth, ...upgraded };
      fresh = await saveRuntimeState(env, fresh);
    }

    const token = await signSession(
      { sub: 'admin', ver: fresh.auth.ver, exp: Date.now() + SESSION_TTL_MS },
      fresh.auth.secret
    );

    return json(await buildFullAdminPayload(fresh, url.host, cfInfo), 200, {
      'set-cookie': formatSessionCookie(token, url.protocol === 'https:'),
    });
  }

  // ---- POST /api/logout ----
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, {
      'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    });
  }

  // ---- POST /api/tgbot/hook/:secret — Telegram webhook (public, secret-verified) ----
  // Telegram POSTs updates here; the path secret + Telegram's own secret header must
  // both match settings.tgBotHookSecret (checked inside the handler).
  if (path.startsWith('/api/tgbot/hook/') && method === 'POST') {
    return await handleTgBotUpdate(request, url, env, runtime, { persistState: saveRuntimeState });
  }
  if (path.startsWith('/api/tgbot/hook/') && method === 'GET') {
    return json({ ok: false, error: 'این مسیر فقط برای وبهوک تلگرام است (POST).' }, 405);
  }

  // =========================================================================
  // Authenticated admin endpoints below
  // =========================================================================
  if (!(await isAuthenticated(request, runtime))) {
    return json({ ok: false, error: 'نشست مدیریتی منقضی شده یا وارد نشده‌اید.' }, 401);
  }

  const state = await loadRuntimeState(env, true);

  // ---- GET /api/cf/ip-ranges: official public Cloudflare CIDRs, no CF token ----
  if (path === '/api/cf/ip-ranges' && method === 'GET') {
    if (cfIpRangesCache && Date.now() - cfIpRangesCache.fetchedAt < 6 * 3600_000) {
      return json({ ok: true, ...cfIpRangesCache, cached: true });
    }
    // Only the local E2E harness sets this override; production uses Cloudflare's public API.
    const feedUrl = env?.NL_CF_IP_RANGES_TEST_URL || CF_IP_RANGES_URL;
    const upstream = await fetchJsonWithTimeout(feedUrl, {}, 6500);
    const raw = upstream.data?.result;
    const ipv4 = Array.isArray(raw?.ipv4_cidrs) ? raw.ipv4_cidrs.filter((cidr) => {
      const parts = String(cidr).split('/');
      const bytes = parts[0].split('.').map(Number);
      return parts.length === 2 && bytes.length === 4 && bytes.every((x) => Number.isInteger(x) && x >= 0 && x < 256) &&
        /^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1]);
    }).slice(0, 48) : [];
    const ipv6 = Array.isArray(raw?.ipv6_cidrs) ? raw.ipv6_cidrs.filter((cidr) =>
      /^[0-9a-f:]+\/(?:\d{1,2}|1[01]\d|12[0-8])$/i.test(String(cidr)) && String(cidr).includes(':')
    ).slice(0, 32) : [];
    if (!upstream.ok || upstream.data?.success !== true || !ipv4.length || !ipv6.length) {
      if (cfIpRangesCache) return json({ ok: true, ...cfIpRangesCache, cached: true, stale: true });
      return json({ ok: false, error: 'منبع رسمی رنج‌های کلادفلر در دسترس نیست؛ هیچ رنج حدسی جایگزین نشد.' }, 502);
    }
    cfIpRangesCache = { ipv4, ipv6, source: feedUrl, etag: String(raw.etag || ''), fetchedAt: Date.now() };
    return json({ ok: true, ...cfIpRangesCache, cached: false });
  }

  // ---- POST /api/killswitch ----
  if (path === '/api/killswitch' && method === 'POST') {
    const body = await readJsonBody(request);
    const nextKill =
      !body.__parseError && typeof body.killSwitch === 'boolean'
        ? body.killSwitch
        : !state.settings.killSwitch;
    state.settings = sanitizeSettings(
      { ...state.settings, killSwitch: nextKill },
      state.settings
    );
    appendLog(
      state,
      'killswitch',
      state.settings.killSwitch ? 'کلید قطع اضطراری فعال شد' : 'کلید قطع اضطراری غیرفعال شد'
    );
    const saved = await saveRuntimeState(env, state);
    return json(await buildFullAdminPayload(saved, url.host, cfInfo));
  }

  // ---- PUT /api/settings ----
  if (path === '/api/settings' && (method === 'PUT' || method === 'POST')) {
    const patch = await readJsonBody(request);
    if (patch.__parseError) return json({ ok: false, error: patch.__parseError }, 400);

    state.settings = sanitizeSettings(patch, state.settings);
    appendLog(state, 'settings', 'تنظیمات هسته و مسیریابی به‌روزرسانی شد');
    const saved = await saveRuntimeState(env, state);
    return json(await buildFullAdminPayload(saved, url.host, cfInfo));
  }

  // ---- POST /api/password ----
  if (path === '/api/password' && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);

    const currentOk = await verifyPassword(String(body.currentPassword || ''), state.auth);
    if (!currentOk) {
      return json({ ok: false, error: 'گذرواژه فعلی نادرست است.' }, 400);
    }
    const nextPw = String(body.newPassword || '');
    if (nextPw.length < 6) {
      return json({ ok: false, error: 'گذرواژه جدید باید دست‌کم ۶ نویسه باشد.' }, 400);
    }
    const pwRec = await hashPassword(nextPw, null, PBKDF2_DEFAULT_ITER);
    state.auth = {
      ...state.auth,
      ...pwRec,
      ver: (state.auth.ver || 1) + 1,
      updatedAt: Date.now(),
    };
    appendLog(state, 'security', 'گذرواژه مدیریت تغییر یافت');
    const saved = await saveRuntimeState(env, state);
    const token = await signSession(
      { sub: 'admin', ver: saved.auth.ver, exp: Date.now() + SESSION_TTL_MS },
      saved.auth.secret
    );
    return json({ ok: true }, 200, {
      'set-cookie': formatSessionCookie(token, url.protocol === 'https:'),
    });
  }

  // ---- POST /api/users ----
  if (path === '/api/users' && method === 'POST') {
    if (state.users.length >= 200) {
      return json({ ok: false, error: 'حداکثر ۲۰۰ مشترک در یک ورکر پشتیبانی می‌شود.' }, 400);
    }
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);

    const requestedUuid = String(body.uuid || '').trim().toLowerCase();
    const requestedTrojan = String(body.trojanPassword || '').trim();
    if (requestedUuid && state.users.some((u) => String(u.uuid || '').toLowerCase() === requestedUuid)) {
      return json({ ok: false, error: 'این شناسه UUID قبلاً به مشترک دیگری اختصاص یافته است.' }, 400);
    }
    if (requestedTrojan && state.users.some((u) => String(u.trojanPassword || '') === requestedTrojan)) {
      return json({ ok: false, error: 'این گذرواژه Trojan قبلاً به مشترک دیگری اختصاص یافته است.' }, 400);
    }

    let candidateUuid = requestedUuid || randomUUID();
    while (state.users.some((u) => String(u.uuid || '').toLowerCase() === candidateUuid.toLowerCase())) {
      candidateUuid = randomUUID();
    }
    let candidateTrojan = requestedTrojan || randomPassword(14);
    while (state.users.some((u) => String(u.trojanPassword || '') === candidateTrojan)) {
      candidateTrojan = randomPassword(14);
    }
    let candidateSubToken = randomToken(16);
    while (state.users.some((u) => u.subToken === candidateSubToken)) {
      candidateSubToken = randomToken(16);
    }

    const newUser = normalizeUser({
      id: '',
      name: body.name || `مشترک ${state.users.length + 1}`,
      note: body.note || '',
      uuid: candidateUuid,
      trojanPassword: candidateTrojan,
      subToken: candidateSubToken,
      trafficLimitGB: Number(body.trafficLimitGB || 0),
      usedUpBytes: 0,
      usedDownBytes: 0,
      connections: 0,
      usedRequests: 0,
      firstConnectedAt: 0,
      lastSeenAt: 0,
      expiryDays: Number(body.expiryDays || 0),
      startOnFirstUse: Boolean(body.startOnFirstUse),
      enabled: body.enabled !== false,
      /* ULTRA fields */
      requestLimit: body.requestLimit,
      ipLimit: body.ipLimit,
      autoResetDays: body.autoResetDays,
      protocols: body.protocols,
      fingerprint: body.fingerprint,
      fragPackets: body.fragPackets,
      fragLength: body.fragLength,
      fragInterval: body.fragInterval,
      fragDisabled: Boolean(body.fragDisabled),
      advancedFrag: body.advancedFrag,
      cipherSuites: body.cipherSuites,
      tlsMask: body.tlsMask,
      ech: body.ech,
      proxyList: normalizeProxyList(body.proxyList),
      autoRotateProxy: Boolean(body.autoRotateProxy),
      ips: body.ips,
      autoRotateIps: Boolean(body.autoRotateIps),
      ipCount: body.ipCount,
      // ULTRA: rotation pool type + per-user port override
      poolType: body.poolType,
      ports: body.ports,
      autoResetReqDays: body.autoResetReqDays,
      blockAdult: Boolean(body.blockAdult),
      blockAds: Boolean(body.blockAds),
    });
    clearPendingUsage(newUser.id);
    state.users = [...state.users, newUser];
    appendLog(state, 'user:add', `مشترک جدید ساخته شد: ${newUser.name}`);
    const saved = await saveRuntimeState(env, state);
    return json({ ...(await buildFullAdminPayload(saved, url.host, cfInfo)), createdId: newUser.id });
  }

  // ---- GET /api/users/:id/nodes ----
  const userNodesMatch = path.match(/^\/api\/users\/([^/]+)\/nodes$/);
  if (userNodesMatch && method === 'GET') {
    const uid = safeDecodeURIComponent(userNodesMatch[1], '');
    const target = state.users.find((u) => u.id === uid);
    if (!target) return json({ ok: false, error: 'مشترک یافت نشد.' }, 404);
    const uView = await hydrateUserAddresses(env, enrichUserView(target), state.settings);
    return json({
      ok: true,
      user: buildAdminUserSummary(target, state.settings, url.host),
      nodes: buildNodeDescriptors(uView, state.settings, url.host),
      xrayPreview: buildXrayConfigs(uView, state.settings, url.host)[0] || null,
      singboxPreview: buildSingboxConfig(uView, state.settings, url.host),
      clashPreview: buildClashYaml(uView, state.settings, url.host),
    });
  }

  // ---- PUT / DELETE / POST actions on /api/users/:id (never matches /api/users/bulk) ----
  const userMatch = path.match(/^\/api\/users\/(?!bulk$)([^/]+)$/);
  if (userMatch) {
    const uid = safeDecodeURIComponent(userMatch[1], '');
    const idx = state.users.findIndex((u) => u.id === uid);
    if (idx === -1) return json({ ok: false, error: 'مشترک یافت نشد.' }, 404);

    if (method === 'DELETE') {
      if (state.users.length <= 1) {
        return json({ ok: false, error: 'حداقل یک حسابِ مشترک باید در پنل باقی بماند.' }, 400);
      }
      const nextUsers = [...state.users];
      const removed = nextUsers.splice(idx, 1)[0];
      const pend = pendingUsageBytesOf(removed.id);
      clearPendingUsage(removed.id);
      // ULTRA: preserve the deleted subscriber's LIFETIME traffic in the
      // server-wide accounting so historical usage remains honest after deletion
      // (lifetime survives manual/automatic resets, so nothing is ever lost).
      state.deletedBytes = (Number(state.deletedBytes) || 0)
        + (removed.lifetimeUpBytes || 0) + (removed.lifetimeDownBytes || 0) + pend;
      state.users = nextUsers;
      appendLog(state, 'user:del', `مشترک حذف شد: ${removed.name}`);
      const saved = await saveRuntimeState(env, state);
      return json(await buildFullAdminPayload(saved, url.host, cfInfo));
    }

    if (method === 'PUT' || method === 'POST') {
      const body = await readJsonBody(request);
      if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);

      const cur = { ...state.users[idx] };
      const nextUsers = [...state.users];
      const doReset = body.action === 'reset_traffic' || Boolean(body.resetTraffic);
      const doResetReq = body.action === 'reset_requests';
      const doResetTime = body.action === 'reset_time';
      const doRotate = body.action === 'rotate_keys' || Boolean(body.rotateKeys);

      if (doReset) {
        clearPendingUsage(cur.id);
        cur.usedUpBytes = 0;
        cur.usedDownBytes = 0;
        cur.connections = 0;
        nextUsers[idx] = normalizeUser(cur, true);
        state.users = nextUsers;
        appendLog(state, 'user:reset', `ریست مصرف ترافیک: ${cur.name}`);
      } else if (doResetReq) {
        clearPendingUsage(cur.id);
        cur.usedRequests = 0;
        nextUsers[idx] = normalizeUser(cur, true);
        state.users = nextUsers;
        appendLog(state, 'user:reset', `ریست سهمیهٔ اتصال: ${cur.name}`);
      } else if (doResetTime) {
        const expiryDays = Number(cur.expiryDays) || 0;
        cur.firstConnectedAt = 0;
        cur.expiresAt = expiryDays > 0 && !cur.startOnFirstUse ? Date.now() + expiryDays * 86_400_000 : 0;
        nextUsers[idx] = normalizeUser(cur, true);
        state.users = nextUsers;
        appendLog(state, 'user:reset', `ریست شمارندهٔ زمان: ${cur.name}`);
      } else if (doRotate) {
        cur.uuid = randomUUID();
        cur.trojanPassword = randomPassword(14);
        cur.subToken = randomToken(16);
        nextUsers[idx] = normalizeUser(cur);
        state.users = nextUsers;
        appendLog(state, 'user:rotate', `چرخش کلیدهای امنیتی: ${cur.name}`);
      } else {
        const nextUuid = String(body.uuid || cur.uuid || '').trim().toLowerCase();
        const nextTrojan = String(body.trojanPassword || cur.trojanPassword || '').trim();
        if (nextUuid && state.users.some((u, i) => i !== idx && String(u.uuid || '').toLowerCase() === nextUuid)) {
          return json({ ok: false, error: 'این شناسه UUID متعلق به مشترک دیگری است.' }, 400);
        }
        if (nextTrojan && state.users.some((u, i) => i !== idx && String(u.trojanPassword || '') === nextTrojan)) {
          return json({ ok: false, error: 'این گذرواژه Trojan متعلق به مشترک دیگری است.' }, 400);
        }

        const expiryDays = body.expiryDays !== undefined ? Math.max(0, Number(body.expiryDays) || 0) : cur.expiryDays;
        const startOnFirstUse = body.startOnFirstUse !== undefined ? Boolean(body.startOnFirstUse) : cur.startOnFirstUse;
        let expiresAt = cur.expiresAt;

        if (body.expiryDays !== undefined || body.startOnFirstUse !== undefined) {
          if (expiryDays === 0) expiresAt = 0;
          else if (startOnFirstUse) expiresAt = 0;
          else expiresAt = Date.now() + expiryDays * 86_400_000;
        }

        const pwUnchanged = !body.trojanPassword || body.trojanPassword === cur.trojanPassword;
        nextUsers[idx] = normalizeUser(
          {
            ...cur,
            name: body.name !== undefined ? body.name : cur.name,
            note: body.note !== undefined ? body.note : cur.note,
            enabled: body.enabled !== undefined ? Boolean(body.enabled) : cur.enabled,
            uuid: body.uuid || cur.uuid,
            trojanPassword: body.trojanPassword || cur.trojanPassword,
            trafficLimitGB: body.trafficLimitGB !== undefined ? Number(body.trafficLimitGB) : cur.trafficLimitGB,
            expiryDays,
            startOnFirstUse,
            expiresAt,
            clearExpiry: expiryDays === 0,
            /* ULTRA fields */
            requestLimit: body.requestLimit !== undefined ? body.requestLimit : cur.requestLimit,
            ipLimit: body.ipLimit !== undefined ? body.ipLimit : cur.ipLimit,
            autoResetDays: body.autoResetDays !== undefined ? body.autoResetDays : cur.autoResetDays,
            lastResetAt: body.autoResetDays !== undefined && !Number(body.autoResetDays) ? 0 : cur.lastResetAt,
            // ULTRA: separate request-counter reset schedule + clean-pool type + port override
            autoResetReqDays: body.autoResetReqDays !== undefined ? body.autoResetReqDays : cur.autoResetReqDays,
            lastReqResetAt: body.autoResetReqDays !== undefined && !Number(body.autoResetReqDays) ? 0 : cur.lastReqResetAt,
            poolType: body.poolType !== undefined ? body.poolType : cur.poolType,
            ports: body.ports !== undefined ? body.ports : cur.ports,
            protocols: body.protocols !== undefined ? body.protocols : cur.protocols,
            fingerprint: body.fingerprint !== undefined ? body.fingerprint : cur.fingerprint,
            fragPackets: body.fragPackets !== undefined ? body.fragPackets : cur.fragPackets,
            fragLength: body.fragLength !== undefined ? body.fragLength : cur.fragLength,
            fragInterval: body.fragInterval !== undefined ? body.fragInterval : cur.fragInterval,
            fragDisabled: body.fragDisabled !== undefined ? Boolean(body.fragDisabled) : cur.fragDisabled,
            advancedFrag: body.advancedFrag !== undefined ? body.advancedFrag : cur.advancedFrag,
            cipherSuites: body.cipherSuites !== undefined ? body.cipherSuites : cur.cipherSuites,
            tlsMask: body.tlsMask !== undefined ? body.tlsMask : cur.tlsMask,
            ech: body.ech !== undefined ? body.ech : cur.ech,
            proxyList: body.proxyList !== undefined ? normalizeProxyList(body.proxyList) : cur.proxyList,
            autoRotateProxy: body.autoRotateProxy !== undefined ? Boolean(body.autoRotateProxy) : cur.autoRotateProxy,
            ips: body.ips !== undefined ? body.ips : cur.ips,
            autoRotateIps: body.autoRotateIps !== undefined ? Boolean(body.autoRotateIps) : cur.autoRotateIps,
            ipCount: body.ipCount !== undefined ? body.ipCount : cur.ipCount,
            blockAdult: body.blockAdult !== undefined ? Boolean(body.blockAdult) : cur.blockAdult,
            blockAds: body.blockAds !== undefined ? Boolean(body.blockAds) : cur.blockAds,
          },
          pwUnchanged
        );
        state.users = nextUsers;
        appendLog(state, 'user:edit', `ویرایش مشترک: ${state.users[idx].name}`);
      }

      const saved = await saveRuntimeState(env, state);
      return json(await buildFullAdminPayload(saved, url.host, cfInfo));
    }
  }

  // ---- ULTRA: POST /api/users/bulk (batch enable/disable/reset/delete) ----
  if (path === '/api/users/bulk' && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const action = String(body.action || '');
    if (!ids.length) return json({ ok: false, error: 'هیچ مشترکی انتخاب نشده است.' }, 400);
    if (!['enable', 'disable', 'reset_traffic', 'reset_requests', 'reset_time', 'delete'].includes(action)) {
      return json({ ok: false, error: 'عملیات گروهی نامعتبر است.' }, 400);
    }
    if (action === 'delete' && state.users.length - ids.length < 1) {
      return json({ ok: false, error: 'حداقل یک حسابِ مشترک باید در پنل باقی بماند.' }, 400);
    }
    let affected = 0;
    const now = Date.now();
    if (action === 'delete') {
      const keep = state.users.filter((u) => !ids.includes(u.id));
      affected = state.users.length - keep.length;
      for (const removed of state.users) {
        if (ids.includes(removed.id)) {
          const pend = pendingUsageBytesOf(removed.id);
          clearPendingUsage(removed.id);
          state.deletedBytes = (Number(state.deletedBytes) || 0)
            + (removed.lifetimeUpBytes || 0) + (removed.lifetimeDownBytes || 0) + pend;
        }
      }
      state.users = keep;
      appendLog(state, 'user:bulk', `حذف گروهی ${affected} مشترک`);
    } else {
      for (const u of state.users) {
        if (!ids.includes(u.id)) continue;
        if (action === 'enable' || action === 'disable') {
          u.enabled = action === 'enable';
        } else if (action === 'reset_traffic') {
          clearPendingUsage(u.id);
          u.usedUpBytes = 0;
          u.usedDownBytes = 0;
          u.connections = 0;
        } else if (action === 'reset_requests') {
          clearPendingUsage(u.id);
          u.usedRequests = 0;
        } else if (action === 'reset_time') {
          const expiryDays = Number(u.expiryDays) || 0;
          u.firstConnectedAt = 0;
          u.expiresAt = expiryDays > 0 && !u.startOnFirstUse ? now + expiryDays * 86_400_000 : 0;
        }
        affected += 1;
      }
      state.users = state.users.map((u) => normalizeUser(u, true));
      appendLog(state, 'user:bulk', `عملیات گروهی «${action}» روی ${affected} مشترک`);
    }
    const saved = await saveRuntimeState(env, state);
    return json({ ...(await buildFullAdminPayload(saved, url.host, cfInfo)), affected });
  }

  // ---- ULTRA: pools API (community clean-IP & exit-proxy databases) ----
  if (path === '/api/pools' && method === 'GET') {
    // ULTRA: `?sample=proxy&count=N` — random probe candidates for the smart
    // multi-location provisioner (one-tap provisioning)
    const sampleKind = String(url.searchParams.get('sample') || '').trim();
    if (sampleKind === 'proxy') {
      const want = Math.max(1, Math.min(40, Number(url.searchParams.get('count')) || 15));
      const pool = await getPool(env, 'proxy');
      const picked = sampleFrom(pool, want);
      return json({ ok: true, kind: 'proxy', count: picked.length, candidates: picked });
    }
    const kinds = ['proxy', 'ips4', 'ips6', 'dom'];
    const out = {};
    for (const kind of kinds) {
      const data = await getPool(env, kind);
      out[kind] = { count: data.length, sample: kind === 'proxy' ? data.slice(0, 3) : data.slice(0, 8) };
    }
    return json({ ok: true, pools: out, dataRepo: state.settings.dataRepo || '' });
  }

  // ---- POST /api/restart-core (flush caches, re-read authoritative KV) ----
  if (path === '/api/restart-core' && method === 'POST') {
    // Flush un-persisted traffic accounting first so nothing is lost
    await saveRuntimeState(env, state);
    clearRuntimeMemoryCaches();
    invalidatePoolCache();
    cfUsageMemCache = null;
    appendLog(state, 'core', 'هستهٔ پنل ری‌استارت شد (کش‌های حافظه تخلیه شد)');
    const fresh = await loadRuntimeState(env, true);
    return json({ ok: true, restarted: true, version: PANEL_VERSION, users: fresh.users.length });
  }

  if (path === '/api/pools' && (method === 'PUT' || method === 'POST')) {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);
    const kind = String(body.kind || '');
    if (!['proxy', 'ips4', 'ips6', 'dom'].includes(kind)) {
      return json({ ok: false, error: 'نوع مخزن نامعتبر است.' }, 400);
    }
    const text = String(body.text || '');
    if (text.length > 4_500_000) return json({ ok: false, error: 'حجم داده بیش از حد مجاز است.' }, 413);
    const parsed = parseListText(text, kind);
    const persisted = await savePool(env, kind, parsed);
    appendLog(state, 'pools', `مخزن ${kind} با ${parsed.length} ورودی ذخیره شد`);
    return json({ ok: true, kind, count: parsed.length, persisted });
  }

  if (path === '/api/pools' && method === 'DELETE') {
    const kind = url.searchParams.get('kind') || '';
    if (!['proxy', 'ips4', 'ips6', 'dom'].includes(kind)) {
      return json({ ok: false, error: 'نوع مخزن نامعتبر است.' }, 400);
    }
    await clearPool(env, kind);
    appendLog(state, 'pools', `مخزن ${kind} پاک شد`);
    return json({ ok: true, kind });
  }

  if (path === '/api/pools/fetch' && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);
    const repo = String(body.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
      return json({ ok: false, error: 'قالب مخزن باید owner/repo باشد.' }, 400);
    }
    const kinds = ['ips4', 'ips6', 'dom', 'proxy'];
    const results = {};
    for (const kind of kinds) {
      const data = await getPool({ ...env, __settingsDataRepo: repo }, kind, { forceRepo: true });
      results[kind] = data.length;
      if (data.length) await savePool(env, kind, data);
    }
    state.settings = sanitizeSettings({ ...state.settings, dataRepo: repo }, state.settings);
    appendLog(state, 'pools', `دریافت مخازن از ${repo} انجام شد`);
    await saveRuntimeState(env, state);
    return json({ ok: true, repo, results });
  }

  // ---- POST /api/tgproxy/rotate ----
  if (path === '/api/tgproxy/rotate' && method === 'POST') {
    state.settings = sanitizeSettings(
      { ...state.settings, tgProxySecret: generateTgSecret() },
      state.settings
    );
    appendLog(state, 'tgproxy', 'کلید مخفی پروکسی تلگرام بازتولید شد');
    const saved = await saveRuntimeState(env, state);
    return json(await buildFullAdminPayload(saved, url.host, cfInfo));
  }

  // ---- ULTRA v4.2: Telegram management bot ----
  if (path === '/api/tgbot/save' && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);
    const token = String(body.token || '').trim();
    const adminIds = String(body.adminIds || '').trim();
    if (!token && !state.settings.tgBotToken) {
      return json({ ok: false, error: 'توکن بات را از @BotFather وارد کنید.' }, 400);
    }
    if (!adminIds && !state.settings.tgBotAdminIds) {
      return json({ ok: false, error: 'آیدی عددی ادمین بات لازم است (از @userinfobot).' }, 400);
    }
    const effectiveToken = token || state.settings.tgBotToken;
    const effectiveAdmins = adminIds || state.settings.tgBotAdminIds;

    const result = await tgBotConnect(env, state, {
      token: effectiveToken,
      adminIds: effectiveAdmins,
      host: url.host,
      persistState: saveRuntimeState,
    });
    if (!result.ok) {
      appendLog(state, 'tgbot', `اتصال بات تلگرام ناموفق: ${result.error}`);
      try { await saveRuntimeState(env, state); } catch {}
      return json({ ok: false, error: result.error }, 400);
    }
    appendLog(state, 'tgbot', `بات تلگرام @${result.bot.username} متصل و وبهوک ست شد`);
    const saved = await saveRuntimeState(env, state);
    return json({ ok: true, ...result, payload: await buildFullAdminPayload(saved, url.host, cfInfo) });
  }

  if (path === '/api/tgbot/disconnect' && method === 'POST') {
    const result = await tgBotDisconnect(env, state, { persistState: saveRuntimeState });
    appendLog(state, 'tgbot', 'بات تلگرام قطع و وبهوک حذف شد');
    const saved = await saveRuntimeState(env, state);
    return json({ ok: true, ...result, payload: await buildFullAdminPayload(saved, url.host, cfInfo) });
  }

  if (path === '/api/tgbot/status' && method === 'GET') {
    const status = await tgBotStatus(state);
    return json(status);
  }

  if (path === '/api/pools/provision' && method === 'POST') {
    // Force one clean-IP / pool provisioning pass from the configured data repo
    const result = await provisionPoolsFromRepo(env, state, { force: true, persistState: saveRuntimeState });
    appendLog(state, 'pools', result ? `نصب پیش‌فرض‌ها از مخزن ${result.repo} انجام شد` : 'دریافت پیش‌فرض‌ها انجام نشد (مخزن نامعتبر یا در دسترس نیست)');
    const saved = await saveRuntimeState(env, state);
    return json({ ok: Boolean(result), result: result || null, payload: await buildFullAdminPayload(saved, url.host, cfInfo) });
  }

  // ---- POST /api/tools/probe-proxy & /api/test-proxyip ----
  if ((path === '/api/tools/probe-proxy' || path === '/api/test-proxyip') && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);
    const result = await probeOutboundEndpoint(body.target || '');
    if (result.ok && body.withCountry && /^(socks5?|http):\/\//i.test(String(body.target || ''))) {
      try {
        const country = await probeProxyCountry(body.target.trim());
        if (country) result.country = country;
      } catch {}
    }
    return json(result);
  }

  // ---- GET /api/backup ----
  if (path === '/api/backup' && method === 'GET') {
    return new Response(
      JSON.stringify(
        {
          ok: true,
          version: 2,
          aralBackupVersion: 2,
          exportedAt: new Date().toISOString(),
          settings: state.settings,
          users: state.users,
        },
        null,
        2
      ),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="aral-backup-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      }
    );
  }

  // ---- POST /api/restore ----
  if (path === '/api/restore' && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);
    if (!body || (!body.settings && !Array.isArray(body.users))) {
      return json({ ok: false, error: 'فایل پشتیبان معتبر نیست.' }, 400);
    }
    if (body.settings && typeof body.settings === 'object') {
      state.settings = sanitizeSettings(body.settings, state.settings);
    }
    if (Array.isArray(body.users) && body.users.length > 0) {
      state.users = body.users.slice(0, 200).map((u) => normalizeUser(u));
    }
    appendLog(state, 'restore', 'نسخه پشتیبان با موفقیت بازیابی شد');
    const saved = await saveRuntimeState(env, state);
    return json(await buildFullAdminPayload(saved, url.host, cfInfo));
  }

  // ---- POST /api/cf/config (Verify / Save / Clear Cloudflare API Token) ----
  if (path === '/api/cf/config' && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);

    if (body.action === 'clear') {
      state.cfApi = {
        token: '',
        accountId: '',
        accountName: '',
        scriptName: '',
        dailyLimit: 100000,
        canEditWorkers: false,
        updatedAt: Date.now(),
      };
      cfUsageMemCache = null;
      appendLog(state, 'cf:clear', 'توکن API کلادفلر از پنل حذف شد');
      const saved = await saveRuntimeState(env, state);
      return json({
        ok: true,
        cleared: true,
        cfIntegration: sanitizeCfPublicInfo(saved.cfApi, url.host),
      });
    }

    const rawInputToken = String(body.token || '').trim();
    const effectiveToken =
      rawInputToken && rawInputToken !== '__SAVED__'
        ? rawInputToken
        : String(state.cfApi?.token || '').trim();

    if (!effectiveToken || effectiveToken.length < 20) {
      return json(
        {
          ok: false,
          error: 'لطفاً یک Cloudflare API Token معتبر وارد کنید.',
        },
        400
      );
    }

    const preferredAccountId = String(body.accountId || state.cfApi?.accountId || '').trim();
    const preferredScript =
      String(body.scriptName || state.cfApi?.scriptName || '').trim() || inferWorkerNameFromHost(url.host);
    const dailyLimit = Math.max(1000, Math.min(100_000_000, Number(body.dailyLimit) || state.cfApi?.dailyLimit || 100000));

    const check = await verifyAndProbeCloudflareToken({
      token: effectiveToken,
      accountId: preferredAccountId,
      scriptName: preferredScript,
      dailyLimit,
      env,
    });

    if (!check.ok) {
      return json(check, 400);
    }

    const shouldSave = body.action !== 'verify';
    let cfPublic = sanitizeCfPublicInfo(
      {
        token: effectiveToken,
        accountId: check.accountId,
        accountName: check.accountName,
        scriptName: check.scriptName,
        dailyLimit,
        canEditWorkers: check.canEditWorkers,
        updatedAt: Date.now(),
      },
      url.host
    );

    if (shouldSave) {
      state.cfApi = {
        token: effectiveToken,
        accountId: check.accountId,
        accountName: check.accountName,
        scriptName: check.scriptName,
        dailyLimit,
        canEditWorkers: check.canEditWorkers,
        updatedAt: Date.now(),
      };
      cfUsageMemCache = check.usage ? { at: Date.now(), accountId: check.accountId, data: check.usage } : null;
      appendLog(state, 'cf:token', `توکن کلادفلر متصل شد (${check.accountName || check.accountId})`);
      const saved = await saveRuntimeState(env, state);
      cfPublic = sanitizeCfPublicInfo(saved.cfApi, url.host);
    }

    return json({
      ok: true,
      saved: shouldSave,
      verified: true,
      tokenStatus: check.tokenStatus,
      accountId: check.accountId,
      accountName: check.accountName,
      scriptName: check.scriptName,
      availableScripts: check.availableScripts || [],
      canReadAnalytics: check.canReadAnalytics,
      canEditWorkers: check.canEditWorkers,
      cfIntegration: cfPublic,
      usage: check.usage || null,
    });
  }

  // ---- GET /api/cf/usage (Daily Request Limit Telemetry) ----
  if (path === '/api/cf/usage' && method === 'GET') {
    const cfApi = state.cfApi || {};
    if (!cfApi.token || !cfApi.accountId) {
      return json({
        ok: false,
        needsToken: true,
        cfIntegration: sanitizeCfPublicInfo(cfApi, url.host),
      });
    }
    const forceFresh = url.searchParams.get('fresh') === '1';
    if (
      !forceFresh &&
      cfUsageMemCache &&
      cfUsageMemCache.accountId === cfApi.accountId &&
      Date.now() - cfUsageMemCache.at < 45_000
    ) {
      return json({
        ok: true,
        cached: true,
        cfIntegration: sanitizeCfPublicInfo(cfApi, url.host),
        usage: {
          ...cfUsageMemCache.data,
          dailyLimit: cfApi.dailyLimit || 100000,
          pct: Math.min(
            100,
            Math.round(((cfUsageMemCache.data.usedToday || 0) / Math.max(1, cfApi.dailyLimit || 100000)) * 1000) / 10
          ),
        },
      });
    }

    const usageRes = await queryCloudflareDailyRequests({
      token: cfApi.token,
      accountId: cfApi.accountId,
      scriptName: cfApi.scriptName || inferWorkerNameFromHost(url.host),
      dailyLimit: cfApi.dailyLimit || 100000,
      env,
    });
    if (!usageRes.ok) {
      return json(
        {
          ok: false,
          error: usageRes.error,
          cfIntegration: sanitizeCfPublicInfo(cfApi, url.host),
        },
        400
      );
    }
    cfUsageMemCache = { at: Date.now(), accountId: cfApi.accountId, data: usageRes.usage };
    return json({
      ok: true,
      cached: false,
      cfIntegration: sanitizeCfPublicInfo(cfApi, url.host),
      usage: usageRes.usage,
    });
  }

  // ---- GET /api/update/check (Hardcoded GitHub: Aral-Dev/Aral-Sulfur) ----
  if (path === '/api/update/check' && method === 'GET') {
    const info = await checkOfficialGitHubUpdate(state.cfApi, url.host, env);
    return json(info, info.ok ? 200 : 502);
  }

  // ---- POST /api/update/apply (In-Panel Self-Update from Aral-Dev/Aral-Sulfur) ----
  if (path === '/api/update/apply' && method === 'POST') {
    const body = await readJsonBody(request);
    if (body.__parseError) return json({ ok: false, error: body.__parseError }, 400);

    const token =
      body.token && String(body.token).trim() && String(body.token).trim() !== '__SAVED__'
        ? String(body.token).trim()
        : String(state.cfApi?.token || '').trim();
    const accountId = String(body.accountId || state.cfApi?.accountId || '').trim();
    const scriptName =
      String(body.scriptName || state.cfApi?.scriptName || '').trim() || inferWorkerNameFromHost(url.host);

    if (!token) {
      return json(
        {
          ok: false,
          needsToken: true,
          error:
            'برای بروزرسانی خودکار از داخل پنل، ابتدا توکن API کلادفلر (دارای دسترسی Workers Scripts: Edit) را ثبت کنید.',
        },
        400
      );
    }

    const result = await applyOfficialGitHubSelfUpdate({
      token,
      accountId,
      scriptName,
      env,
    });
    if (!result.ok) {
      return json(result, 400);
    }

    state.cfApi = {
      ...(state.cfApi || {}),
      token,
      accountId: result.accountId,
      accountName: result.accountName || state.cfApi?.accountName || '',
      scriptName: result.scriptName,
      dailyLimit: state.cfApi?.dailyLimit || 100000,
      canEditWorkers: true,
      updatedAt: Date.now(),
    };
    appendLog(
      state,
      'system:update',
      `بروزرسانی هسته از مخزن رسمی به نسخه ${result.targetVersion} روی ورکر ${result.scriptName} انجام شد`
    );
    await saveRuntimeState(env, state);
    return json(result);
  }

  return json({ ok: false, error: 'مسیر API یافت نشد.' }, 404);
}

/* --------------------------------------------------------------- Utilities */

function buildAdminUserSummary(user, settings, host) {
  const v = enrichUserView(user);
  const subBase = `https://${host}/sub/${encodeURIComponent(v.subToken)}`;
  const quickMeta = computeQuickUserNodeMeta(v, settings, host);
  return {
    id: v.id,
    name: v.name,
    note: v.note,
    enabled: v.enabled,
    status: v.status,
    uuid: v.uuid,
    trojanPassword: v.trojanPassword,
    subToken: v.subToken,
    trafficLimitGB: v.trafficLimitGB,
    usedUpBytes: v.usedUpBytes,
    usedDownBytes: v.usedDownBytes,
    usedBytes: v.usedBytes,
    limitBytes: v.limitBytes,
    connections: v.connections,
    expiryDays: v.expiryDays,
    expiresAt: v.expiresAt,
    effectiveExpiresAt: v.effectiveExpiresAt,
    remainingDays: v.remainingDays,
    startOnFirstUse: v.startOnFirstUse,
    firstConnectedAt: v.firstConnectedAt,
    lastSeenAt: v.lastSeenAt,
    /* ULTRA fields */
    requestLimit: v.requestLimit || 0,
    usedRequests: v.usedRequests || 0,
    ipLimit: v.ipLimit || 0,
    activeIpCount: v.activeIpCount || 0,
    autoResetDays: v.autoResetDays || 0,
    lastResetAt: v.lastResetAt || 0,
    // ULTRA v4.1: separate request reset + rotation pool type + port override + lifetime
    autoResetReqDays: v.autoResetReqDays || 0,
    poolType: v.poolType || '',
    ports: v.ports || '',
    lifetimeUpBytes: v.lifetimeUpBytes || 0,
    lifetimeDownBytes: v.lifetimeDownBytes || 0,
    protocols: v.protocols || '',
    fingerprint: v.fingerprint || '',
    fragPackets: v.fragPackets || '',
    fragLength: v.fragLength || '',
    fragInterval: v.fragInterval || '',
    fragDisabled: Boolean(v.fragDisabled),
    advancedFrag: v.advancedFrag || '',
    cipherSuites: v.cipherSuites || '',
    tlsMask: v.tlsMask || '',
    ech: v.ech || '',
    proxyList: Array.isArray(v.proxyList) ? v.proxyList : [],
    autoRotateProxy: Boolean(v.autoRotateProxy),
    ips: Array.isArray(v.ips) ? v.ips : [],
    autoRotateIps: Boolean(v.autoRotateIps),
    ipCount: v.ipCount || 0,
    blockAdult: Boolean(v.blockAdult),
    blockAds: Boolean(v.blockAds),
    statusUrl: `https://${host}/status/${encodeURIComponent(v.subToken)}`,
    nodeCount: quickMeta.nodeCount,
    urls: {
      pressPass: subBase,
      normalSub: `${subBase}?format=b64`,
      rawSub: `${subBase}?format=raw`,
      xrayFragmentSub: `${subBase}?format=xray`,
      singboxSub: `${subBase}?format=singbox`,
      clashSub: `${subBase}?format=clash`,
      privateDoH: `https://${host}/dns-query/${encodeURIComponent(v.subToken)}`,
      primaryVless: quickMeta.primaryVless,
      primaryTrojan: quickMeta.primaryTrojan,
    },
  };
}

async function buildFullAdminPayload(state, host, cf = null) {
  const users = (state.users || []).map((u) => buildAdminUserSummary(u, state.settings, host));
  const totals = users.reduce(
    (acc, u) => {
      acc.totalUsedBytes += u.usedBytes;
      acc.totalConnections += u.connections;
      if (u.status === 'active') acc.activeUsers += 1;
      return acc;
    },
    { totalUsedBytes: 0, totalConnections: 0, activeUsers: 0 }
  );
  // ULTRA: lifetime traffic of already-deleted subscribers
  totals.deletedBytes = Math.max(0, Number(state.deletedBytes) || 0);
  totals.inclDeletedBytes = totals.totalUsedBytes + totals.deletedBytes;

  const firstRaw = state.users && state.users[0] ? enrichUserView(state.users[0]) : null;
  const initialNodes = firstRaw ? buildNodeDescriptors(firstRaw, state.settings, host) : [];
  const tgProxy =
    state.settings.enableTgProxy !== false && state.settings.tgProxySecret
      ? await buildTgProxyFullLinks(host, state.settings.tgProxySecret, state.settings.tgProxyDomain)
      : null;

  // ULTRA v4.2: never ship the raw bot token to the UI — masked form only
  // (the stored value in KV is untouched; re-connecting needs a fresh paste).
  const rawToken = String(state.settings.tgBotToken || '');
  const publicSettings = rawToken
    ? { ...state.settings, tgBotToken: rawToken.slice(0, 8) + '••••••••' + rawToken.slice(-4) }
    : state.settings;

  return {
    ok: true,
    version: PANEL_VERSION,
    state: 'ready',
    mode: 'admin',
    host,
    edge: cf?.colo || 'CF-GLOBAL',
    kvBound: state.kvBound,
    kvName: state.kvName,
    authenticated: true,
    brand: PANEL_BRAND,
    settings: publicSettings,
    cfIntegration: sanitizeCfPublicInfo(state.cfApi, host),
    tgBot: tgBotPublicInfo(state.settings),
    updater: {
      repo: GITHUB_REPO,
      repoUrl: GITHUB_REPO_URL,
      currentVersion: PANEL_VERSION,
    },
    tgProxy,
    users,
    initialNodes,
    totals,
    logs: state.logs || [],
    ...(cf ? { cf } : {}),
  };
}

function findSubscriptionUser(runtime, token) {
  if (!token || !Array.isArray(runtime?.users)) return null;
  const low = token.toLowerCase();
  return (
    runtime.users.find(
      (u) => u && (u.subToken === token || String(u.uuid || '').toLowerCase() === low)
    ) || null
  );
}

function findActiveTokenUser(runtime, token) {
  const u = findSubscriptionUser(runtime, token);
  if (!u) return null;
  return enrichUserView(u).status === 'active' ? u : null;
}

async function isAuthenticated(request, runtime) {
  if (!runtime || !runtime.initialized || !runtime.auth || !runtime.auth.secret) return false;
  const cookie = readCookie(request.headers.get('cookie') || '', SESSION_COOKIE);
  if (!cookie) return false;
  const session = await verifySession(cookie, runtime.auth.secret, runtime.auth.ver || 1);
  return Boolean(session && session.sub === 'admin');
}

function readCookie(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return '';
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return safeDecodeURIComponent(part.slice(idx + 1).trim(), '');
  }
  return '';
}

function formatSessionCookie(token, isHttps) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
}

async function readJsonBody(request) {
  try {
    const lenHeader = Number(request.headers.get('content-length') || 0);
    if (lenHeader > MAX_JSON_BODY_BYTES) {
      return { __parseError: 'حجم داده ارسالی بیش از حد مجاز است.' };
    }
    const text = await request.text();
    if (!text || !text.trim()) return {};
    if (text.length > MAX_JSON_BODY_BYTES) {
      return { __parseError: 'حجم داده ارسالی بیش از حد مجاز است.' };
    }
    const parsed = safeJsonParse(text, undefined);
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { __parseError: 'ساختار JSON ارسالی معتبر نیست.' };
    }
    return parsed;
  } catch {
    return { __parseError: 'خطا در خواندن بدنه درخواست.' };
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function proxyFallbackDomain(request, fallbackDomain, inlineAssets) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => {
    try { ctrl.abort(); } catch {}
  }, 8000);
  try {
    const srcUrl = new URL(request.url);
    const targetUrl = new URL(`https://${fallbackDomain}${srcUrl.pathname}${srcUrl.search}`);
    const headers = new Headers(request.headers);
    headers.set('host', targetUrl.host);
    headers.delete('cookie');
    const resp = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method.toUpperCase()) ? undefined : request.body,
      redirect: 'manual',
      signal: ctrl.signal,
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: new Headers(resp.headers),
    });
  } catch {
    return new Response(renderDecoyGazette(inlineAssets), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  } finally {
    clearTimeout(tid);
  }
}

/** ULTRA: resolve the exit country of a socks/http proxy by bouncing an HTTP request through it. */
async function probeProxyCountry(proxySpec) {
  const chained = await dialChainProxy(String(proxySpec), 'ip-api.com', 80);
  const { socket, leftover } = chained;
  try {
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    const req = 'GET /json/?fields=countryCode HTTP/1.1\r\nHost: ip-api.com\r\nUser-Agent: ARAL-Ultra/4.0\r\nConnection: close\r\n\r\n';
    await writer.write(new TextEncoder().encode(req));
    let raw = new Uint8Array(0);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && raw.byteLength < 8192) {
      const { value, done } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(raw.byteLength + value.byteLength);
      merged.set(raw, 0);
      merged.set(value, raw.byteLength);
      raw = merged;
      const text = new TextDecoder().decode(raw);
      const m = text.match(/"countryCode"\s*:\s*"([A-Z]{2})"/);
      if (m) {
        try { writer.releaseLock(); } catch {}
        try { reader.releaseLock(); } catch {}
        return m[1];
      }
    }
    try { writer.releaseLock(); } catch {}
    try { reader.releaseLock(); } catch {}
  } finally {
    try { socket.close(); } catch {}
  }
  return '';
}

async function servePanelShell(request, env) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
    try {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = '/index.html';
      const assetResp = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
      if (assetResp && assetResp.ok) return assetResp;
    } catch {}
  }
  const html = await getPanelHtml();
  if (typeof html === 'string' && html.length > 0) {
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      },
    });
  }
  return new Response('ARAL UI bundle missing — run `npm run build`.', { status: 500 });
}

/* ---------------- Cloudflare Daily Quota & Hardcoded GitHub Self-Updater ---------------- */

let cfUsageMemCache = null;

function inferWorkerNameFromHost(host) {
  const clean = String(host || '').split(':')[0].trim().toLowerCase();
  if (clean.endsWith('.workers.dev')) {
    const parts = clean.split('.');
    if (parts.length >= 4) return parts[0];
  }
  return '';
}

function sanitizeCfPublicInfo(cfApi, host) {
  const raw = cfApi && typeof cfApi === 'object' ? cfApi : {};
  const tok = String(raw.token || '').trim();
  const inferredScript = String(raw.scriptName || '').trim() || inferWorkerNameFromHost(host);
  return {
    hasToken: Boolean(tok),
    maskedToken: tok ? `••••••••${tok.slice(-4)}` : '',
    accountId: String(raw.accountId || '').trim(),
    accountName: String(raw.accountName || '').trim(),
    scriptName: inferredScript,
    dailyLimit: Math.max(1000, Number(raw.dailyLimit) || 100000),
    canEditWorkers: Boolean(raw.canEditWorkers),
    updatedAt: Number(raw.updatedAt) || 0,
    tokensDashboardUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  };
}

async function fetchJsonWithTimeout(urlStr, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => {
    try { ctrl.abort(); } catch {}
  }, timeoutMs);
  try {
    const res = await fetch(urlStr, { ...options, signal: ctrl.signal });
    const text = await res.text();
    const data = safeJsonParse(text, null);
    return { ok: res.ok, status: res.status, data, text };
  } catch (err) {
    return { ok: false, status: 0, data: null, text: '', error: err?.message || String(err) };
  } finally {
    clearTimeout(tid);
  }
}

async function resolveCloudflareAccount(cfBase, token, preferredAccountId = '') {
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (preferredAccountId) {
    const accRes = await fetchJsonWithTimeout(
      `${cfBase}/accounts/${encodeURIComponent(preferredAccountId)}`,
      { headers }
    );
    if (accRes.ok && accRes.data?.success && accRes.data?.result?.id) {
      return {
        ok: true,
        accountId: accRes.data.result.id,
        accountName: accRes.data.result.name || '',
      };
    }
  }
  const listRes = await fetchJsonWithTimeout(`${cfBase}/accounts?per_page=10`, { headers });
  if (listRes.ok && listRes.data?.success && Array.isArray(listRes.data.result) && listRes.data.result.length > 0) {
    const chosen = preferredAccountId
      ? listRes.data.result.find((a) => a.id === preferredAccountId) || listRes.data.result[0]
      : listRes.data.result[0];
    return {
      ok: true,
      accountId: chosen.id,
      accountName: chosen.name || '',
    };
  }
  const cfErr = listRes.data?.errors?.[0]?.message || '';
  return {
    ok: false,
    error: cfErr
      ? `عدم دسترسی به اکانت کلادفلر: ${cfErr}`
      : 'توکن معتبر نیست یا دسترسی خواندن اکانت (Account Settings / Analytics: Read) را ندارد.',
  };
}

async function verifyAndProbeCloudflareToken({ token, accountId, scriptName, dailyLimit = 100000, env }) {
  const cfBase = String(env?.NL_CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };

  let tokenStatus = 'unknown';
  const userVerify = await fetchJsonWithTimeout(`${cfBase}/user/tokens/verify`, { headers });
  if (userVerify.ok && userVerify.data?.success) {
    tokenStatus = userVerify.data?.result?.status || 'active';
    if (tokenStatus && tokenStatus !== 'active') {
      return { ok: false, error: `وضعیت توکن کلادفلر فعال نیست (${tokenStatus}).` };
    }
  }

  const accInfo = await resolveCloudflareAccount(cfBase, token, accountId);
  if (!accInfo.ok) {
    if (!userVerify.ok) {
      const msg = userVerify.data?.errors?.[0]?.message || accInfo.error;
      return { ok: false, error: `خطا در اعتبارسنجی توکن کلادفلر: ${msg}` };
    }
    if (!accountId) {
      return {
        ok: false,
        error:
          'توکن معتبر است اما شناسه اکانت خودکار یافت نشد. لطفاً دسترسی Account Settings: Read بدهید یا Account ID را وارد کنید.',
      };
    }
  }

  const resolvedAccountId = accInfo.ok ? accInfo.accountId : accountId;
  const resolvedAccountName = accInfo.ok ? accInfo.accountName : '';

  if (tokenStatus === 'unknown' && resolvedAccountId) {
    const accVerify = await fetchJsonWithTimeout(
      `${cfBase}/accounts/${encodeURIComponent(resolvedAccountId)}/tokens/verify`,
      { headers }
    );
    if (accVerify.ok && accVerify.data?.success) {
      tokenStatus = accVerify.data?.result?.status || 'active';
    } else if (accInfo.ok) {
      tokenStatus = 'active';
    }
  }

  let availableScripts = [];
  let resolvedScript = scriptName || '';
  let canEditWorkers = false;
  if (resolvedAccountId) {
    const scriptsRes = await fetchJsonWithTimeout(
      `${cfBase}/accounts/${encodeURIComponent(resolvedAccountId)}/workers/scripts`,
      { headers }
    );
    if (scriptsRes.ok && scriptsRes.data?.success && Array.isArray(scriptsRes.data.result)) {
      availableScripts = scriptsRes.data.result.map((s) => s.id).filter(Boolean).slice(0, 30);
      if (!resolvedScript && availableScripts.length === 1) {
        resolvedScript = availableScripts[0];
      } else if (resolvedScript && !availableScripts.includes(resolvedScript)) {
        const ci = availableScripts.find((s) => s.toLowerCase() === resolvedScript.toLowerCase());
        if (ci) resolvedScript = ci;
      }
      const probeTarget = resolvedScript || availableScripts[0] || '';
      if (probeTarget) {
        const setRes = await fetchJsonWithTimeout(
          `${cfBase}/accounts/${encodeURIComponent(resolvedAccountId)}/workers/scripts/${encodeURIComponent(probeTarget)}/settings`,
          { headers }
        );
        if (setRes.ok && setRes.data?.success) {
          canEditWorkers = true;
        }
      } else {
        canEditWorkers = true;
      }
    }
  }

  const usageRes = await queryCloudflareDailyRequests({
    token,
    accountId: resolvedAccountId,
    scriptName: resolvedScript,
    dailyLimit,
    env,
  });

  if (!usageRes.ok) {
    return {
      ok: false,
      error:
        usageRes.error ||
        'توکن شناسایی شد اما دسترسی خواندن آمار (Account Analytics: Read) روی آن فعال نیست.',
    };
  }

  return {
    ok: true,
    tokenStatus: tokenStatus || 'active',
    accountId: resolvedAccountId,
    accountName: resolvedAccountName,
    scriptName: resolvedScript,
    availableScripts,
    canReadAnalytics: true,
    canEditWorkers,
    usage: usageRes.usage,
  };
}

async function queryCloudflareDailyRequests({ token, accountId, scriptName = '', dailyLimit = 100000, env }) {
  const cfBase = String(env?.NL_CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  const now = new Date();
  const startOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const nextUtcMidnight = new Date(startOfUtcDay.getTime() + 86_400_000);

  const gqlQuery = `
    query AralDailyQuota($accountTag: string!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(limit: 200, filter: { datetime_geq: $since, datetime_leq: $until }) {
            dimensions { scriptName }
            sum { requests subrequests errors }
          }
        }
      }
    }
  `;

  const res = await fetchJsonWithTimeout(
    `${cfBase}/graphql`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: gqlQuery,
        variables: {
          accountTag: accountId,
          since: startOfUtcDay.toISOString(),
          until: now.toISOString(),
        },
      }),
    },
    10000
  );

  if (!res.ok || !res.data) {
    return {
      ok: false,
      error: 'عدم دریافت پاسخ از GraphQL کلادفلر. دسترسی Account Analytics: Read توکن را بررسی کنید.',
    };
  }

  if (Array.isArray(res.data.errors) && res.data.errors.length > 0 && !res.data.data) {
    return {
      ok: false,
      error: `خطای دسترسی آمار کلادفلر: ${res.data.errors[0]?.message || 'GraphQL Error'}`,
    };
  }

  const accounts = res.data?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return {
      ok: false,
      error: 'دسترسی به آمار اکانت کلادفلر مجاز نیست (Account Analytics: Read نیاز است).',
    };
  }

  const rows = Array.isArray(accounts[0]?.workersInvocationsAdaptive)
    ? accounts[0].workersInvocationsAdaptive
    : [];

  let usedToday = 0;
  let subrequestsToday = 0;
  let errorsToday = 0;
  let scriptRequests = 0;

  for (const row of rows) {
    const reqs = Math.max(0, Number(row?.sum?.requests) || 0);
    const subs = Math.max(0, Number(row?.sum?.subrequests) || 0);
    const errs = Math.max(0, Number(row?.sum?.errors) || 0);
    usedToday += reqs;
    subrequestsToday += subs;
    errorsToday += errs;
    if (scriptName && row?.dimensions?.scriptName === scriptName) {
      scriptRequests += reqs;
    }
  }

  const safeLimit = Math.max(1000, Number(dailyLimit) || 100000);
  const pct = Math.min(100, Math.round((usedToday / safeLimit) * 1000) / 10);

  return {
    ok: true,
    usage: {
      usedToday,
      scriptRequests,
      subrequestsToday,
      errorsToday,
      dailyLimit: safeLimit,
      remainingToday: Math.max(0, safeLimit - usedToday),
      pct,
      sinceUtc: startOfUtcDay.toISOString(),
      resetAtUtc: nextUtcMidnight.toISOString(),
      resetInSec: Math.max(0, Math.floor((nextUtcMidnight.getTime() - now.getTime()) / 1000)),
      fetchedAt: Date.now(),
    },
  };
}

function normalizeVersionString(v) {
  return String(v || '')
    .trim()
    .replace(/^[vV]+/, '')
    .split('-')[0]
    .trim();
}

function compareSemver(a, b) {
  const pa = normalizeVersionString(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersionString(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function checkOfficialGitHubUpdate(cfApi, host, env) {
  const ghApiBase = String(env?.NL_GH_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
  const ghRawBase = String(env?.NL_GH_RAW_BASE || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
  const ghHeaders = {
    accept: 'application/vnd.github+json',
    'user-agent': `ARAL-Updater/${PANEL_VERSION}`,
  };

  let latestVersion = '';
  let releaseUrl = GITHUB_REPO_URL;
  let releaseNotes = '';
  let publishedAt = '';
  let assetWorkerUrl = '';
  let tagRef = 'main';

  const relRes = await fetchJsonWithTimeout(
    `${ghApiBase}/repos/${GITHUB_REPO}/releases/latest`,
    { headers: ghHeaders },
    9000
  );

  if (relRes.ok && relRes.data && relRes.data.tag_name) {
    tagRef = String(relRes.data.tag_name).trim();
    latestVersion = normalizeVersionString(tagRef);
    releaseUrl = String(relRes.data.html_url || `${GITHUB_REPO_URL}/releases`);
    releaseNotes = String(relRes.data.body || '').slice(0, 1500);
    publishedAt = String(relRes.data.published_at || '');
    if (Array.isArray(relRes.data.assets)) {
      const workerAsset = relRes.data.assets.find(
        (a) => a && a.name === 'worker-single-file.js' && a.browser_download_url
      );
      if (workerAsset) {
        assetWorkerUrl = String(workerAsset.browser_download_url);
      }
    }
  }

  // Also check main branch package.json if no release exists yet or main has newer version
  const pkgRes = await fetchJsonWithTimeout(
    `${ghRawBase}/${GITHUB_REPO}/main/package.json`,
    { headers: { 'user-agent': `ARAL-Updater/${PANEL_VERSION}` } },
    8000
  );
  if (pkgRes.ok && pkgRes.data && pkgRes.data.version) {
    const mainVer = normalizeVersionString(pkgRes.data.version);
    if (!latestVersion || compareSemver(mainVer, latestVersion) > 0) {
      latestVersion = mainVer;
      tagRef = 'main';
      if (!assetWorkerUrl) {
        assetWorkerUrl = `${ghRawBase}/${GITHUB_REPO}/main/worker-single-file.js`;
      }
    }
  }

  if (!latestVersion) {
    if (relRes.status === 404 || pkgRes.status === 404) {
      return {
        ok: true,
        repo: GITHUB_REPO,
        repoUrl: GITHUB_REPO_URL,
        currentVersion: PANEL_VERSION,
        latestVersion: PANEL_VERSION,
        updateAvailable: false,
        notPublishedYet: true,
        releaseUrl: GITHUB_REPO_URL,
        releaseNotes: '',
        publishedAt: '',
        scriptUrl: `${ghRawBase}/${GITHUB_REPO}/main/worker-single-file.js`,
        cfConfigured: Boolean(cfApi?.token),
        scriptName: String(cfApi?.scriptName || '').trim() || inferWorkerNameFromHost(host),
      };
    }
    return {
      ok: false,
      repo: GITHUB_REPO,
      repoUrl: GITHUB_REPO_URL,
      currentVersion: PANEL_VERSION,
      error: 'عدم برقراری ارتباط با مخزن گیت‌هاب جهت بررسی نسخه جدید.',
    };
  }

  if (!assetWorkerUrl) {
    assetWorkerUrl = `${ghRawBase}/${GITHUB_REPO}/${encodeURIComponent(tagRef)}/worker-single-file.js`;
  }

  const updateAvailable = compareSemver(latestVersion, PANEL_VERSION) > 0;
  return {
    ok: true,
    repo: GITHUB_REPO,
    repoUrl: GITHUB_REPO_URL,
    currentVersion: PANEL_VERSION,
    latestVersion,
    updateAvailable,
    releaseUrl,
    releaseNotes,
    publishedAt,
    scriptUrl: assetWorkerUrl,
    cfConfigured: Boolean(cfApi?.token),
    canEditWorkers: Boolean(cfApi?.canEditWorkers),
    scriptName: String(cfApi?.scriptName || '').trim() || inferWorkerNameFromHost(host),
  };
}

async function applyOfficialGitHubSelfUpdate({ token, accountId, scriptName, env }) {
  const cfBase = String(env?.NL_CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  const ghRawBase = String(env?.NL_GH_RAW_BASE || 'https://raw.githubusercontent.com').replace(/\/+$/, '');

  // 1. Resolve Cloudflare Account
  const accInfo = await resolveCloudflareAccount(cfBase, token, accountId);
  if (!accInfo.ok) {
    return { ok: false, error: accInfo.error };
  }
  const resolvedAccountId = accInfo.accountId;

  // 2. Resolve Worker Script Name
  const cfHeaders = { authorization: `Bearer ${token}` };
  let targetScript = String(scriptName || '').trim();
  if (!targetScript) {
    const listRes = await fetchJsonWithTimeout(
      `${cfBase}/accounts/${encodeURIComponent(resolvedAccountId)}/workers/scripts`,
      { headers: cfHeaders }
    );
    if (listRes.ok && Array.isArray(listRes.data?.result) && listRes.data.result.length === 1) {
      targetScript = listRes.data.result[0].id;
    }
  }
  if (!targetScript) {
    return {
      ok: false,
      error: 'نام ورکر (Worker Name) مشخص نیست. لطفاً نام دقیق ورکر خود در کلادفلر را وارد کنید.',
    };
  }

  // 3. Check official GitHub release / main bundle from Aral-Dev/Aral-Sulfur
  const updateInfo = await checkOfficialGitHubUpdate({ token, scriptName: targetScript }, '', env);
  if (!updateInfo.ok) {
    return { ok: false, error: updateInfo.error || 'خطا در دریافت اطلاعات مخزن گیت‌هاب.' };
  }

  const candidateUrls = [
    updateInfo.scriptUrl,
    `${ghRawBase}/${GITHUB_REPO}/main/worker-single-file.js`,
  ].filter(Boolean);

  let workerCode = '';
  for (const dlUrl of candidateUrls) {
    const dlRes = await fetchJsonWithTimeout(
      dlUrl,
      { headers: { 'user-agent': `ARAL-Updater/${PANEL_VERSION}` } },
      15000
    );
    if (dlRes.ok && typeof dlRes.text === 'string' && dlRes.text.length > 15000 && dlRes.text.includes('export')) {
      workerCode = dlRes.text;
      break;
    }
  }

  if (!workerCode) {
    return {
      ok: false,
      error: `فایل اجرایی worker-single-file.js در مخزن رسمی (${GITHUB_REPO}) یافت نشد یا هنوز منتشر نشده است.`,
    };
  }

  // 4. Read existing Worker settings so KV bindings, vars & compatibility flags are 100% preserved
  const settingsUrl = `${cfBase}/accounts/${encodeURIComponent(resolvedAccountId)}/workers/scripts/${encodeURIComponent(targetScript)}/settings`;
  const curSettingsRes = await fetchJsonWithTimeout(settingsUrl, { headers: cfHeaders }, 10000);
  if (!curSettingsRes.ok || !curSettingsRes.data?.success) {
    const cfMsg = curSettingsRes.data?.errors?.[0]?.message || '';
    return {
      ok: false,
      error: cfMsg
        ? `عدم دسترسی به تنظیمات ورکر (${targetScript}): ${cfMsg} — مطمئن شوید نام ورکر صحیح است و توکن دسترسی Workers Scripts: Edit دارد.`
        : `ورکر «${targetScript}» یافت نشد یا توکن کلادفلر دسترسی Workers Scripts: Edit را ندارد.`,
    };
  }

  const existing = curSettingsRes.data.result || {};
  const preservedBindings = Array.isArray(existing.bindings)
    ? existing.bindings
        .filter((b) => b && b.name)
        .map((b) => (b.type === 'secret_text' || b.type === 'secret_key' ? { type: 'inherit', name: b.name } : b))
    : [];

  const metadata = {
    main_module: 'worker.js',
    compatibility_date: existing.compatibility_date || '2025-09-01',
    compatibility_flags: Array.isArray(existing.compatibility_flags) && existing.compatibility_flags.length > 0
      ? existing.compatibility_flags
      : ['nodejs_compat'],
    bindings: preservedBindings,
    keep_bindings: ['secret_text', 'secret_key'],
  };
  if (existing.usage_model) metadata.usage_model = existing.usage_model;
  if (existing.placement && typeof existing.placement === 'object') metadata.placement = existing.placement;

  // 5. Upload new ES Module Worker bundle via Cloudflare Workers API
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    'worker.js',
    new Blob([workerCode], { type: 'application/javascript+module' }),
    'worker.js'
  );

  const uploadUrl = `${cfBase}/accounts/${encodeURIComponent(resolvedAccountId)}/workers/scripts/${encodeURIComponent(targetScript)}`;
  const uploadRes = await fetchJsonWithTimeout(
    uploadUrl,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    },
    20000
  );

  if (!uploadRes.ok || !uploadRes.data?.success) {
    const errMsg = uploadRes.data?.errors?.[0]?.message || 'خطا در بارگذاری کد جدید روی کلادفلر.';
    return {
      ok: false,
      error: `بروزرسانی ورکر ناموفق بود: ${errMsg}`,
    };
  }

  return {
    ok: true,
    updated: true,
    previousVersion: PANEL_VERSION,
    targetVersion: updateInfo.latestVersion || PANEL_VERSION,
    scriptName: targetScript,
    accountId: resolvedAccountId,
    accountName: accInfo.accountName || '',
    repoUrl: GITHUB_REPO_URL,
    reloadAfterMs: 2200,
  };
}
