/**
 * ARAL SULFUR — Data Pools Layer.
 *
 * Community data pools used by per-user Clean-IP rotation, exit-proxy locations and the
 * automated proxy fallback. Sources (in priority order):
 *   1. KV-uploaded pools   (admin pastes/uploads from the panel — instant, no repo needed)
 *   2. GitHub data repo    (settings.dataRepo = `owner/repo`, files under data/, 1h cache)
 *   3. Built-in defaults   (small safe fallback set shipped inside the worker)
 *
 * Pool kinds:
 *   ips4  → clean IPv4 addresses (one per line)
 *   ips6  → clean IPv6 addresses (one per line)
 *   dom   → clean domains (one per line)
 *   proxy → exit-proxy list, JSON [{p:"socks5://host:port", c:"DE", vip:true?}]
 */

import { DEFAULT_DATA_REPO, POOL_KEYS, POOL_LIMITS, POOL_PROVISION_KEY, safeJsonParseGuard } from './poolutil.js';

const RAM_TTL_MS = 10 * 60_000;
const REPO_TTL_MS = 60 * 60_000;

const ramCache = new Map(); // kind -> { data, at }
const repoFetchAt = new Map(); // kind -> ts

/* ULTRA v4.2 BUGFIX: `getPool` previously read `env.__settingsDataRepo`, a key that was
 * only injected by the manual /api/pools/fetch route. Clean-IP rotation during real
 * subscription serving therefore NEVER used the configured GitHub repo and silently
 * fell back to the near-empty built-in defaults. The settings layer now publishes the
 * active repo here once per request lifecycle via setActiveDataRepo(). */
let activeDataRepo = '';

/** Publish the panel's configured data repo (called by the worker once settings are loaded). */
export function setActiveDataRepo(repo) {
  const clean = String(repo || '').trim();
  if (clean && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(clean)) {
    if (clean !== activeDataRepo) {
      activeDataRepo = clean;
      repoFetchAt.clear();
    }
  } else if (!clean) {
    activeDataRepo = '';
  }
}

export function getActiveDataRepo() {
  return activeDataRepo;
}

export function findKVBinding(env) {
  try {
    if (!env || typeof env !== 'object') return null;
    for (const name of ['KV', 'kv', 'NL_KV', 'ARAL_KV']) {
      const binding = env[name];
      if (binding && typeof binding.get === 'function' && typeof binding.put === 'function') {
        return binding;
      }
    }
  } catch {}
  return null;
}

export function parseProxyLine(raw) {
  let s = String(raw || '').trim();
  if (!s || s.startsWith('#') || s.startsWith('//')) return null;
  // t.me/socks?server=host&port=p&user=u&pass=w normalization
  const tg = s.match(/t\.me\/socks\?(\S+)/i);
  if (tg) {
    const q = new URLSearchParams(tg[1].replace(/&amp;/g, '&'));
    const server = q.get('server');
    const port = q.get('port');
    if (!server || !port) return null;
    const user = q.get('user');
    const pass = q.get('pass');
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : '';
    s = `socks5://${auth}${server}:${port}`;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s) || /^[a-z0-9.-]+:\d+$/i.test(s)) s = `socks5://${s}`;
  if (!/^(socks5?|http):\/\//i.test(s)) return null;
  const proto = s.match(/^(socks5?|http):\/\//i)[1].toLowerCase();
  const rest = s.slice(proto.length + 3);
  const at = rest.lastIndexOf('@');
  const hostPart = at >= 0 ? rest.slice(at + 1) : rest;
  const host = hostPart.split(':')[0].trim();
  const port = Number(hostPart.split(':')[1]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (host.length > 200) return null;
  return { p: `${proto}://${rest}`, c: '' };
}

export function parseListText(text, kind) {
  const lines = String(text || '').split(/[\r\n]+/);
  if (kind === 'proxy') {
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      const parsed = parseProxyLine(line);
      if (!parsed || seen.has(parsed.p)) continue;
      seen.add(parsed.p);
      out.push(parsed);
      if (out.length >= POOL_LIMITS.proxy) break;
    }
    return out;
  }
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const s = line.trim().split('#')[0].trim();
    if (!s || s.length > 200 || seen.has(s)) continue;
    if (kind === 'ips4' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) continue;
    if (kind === 'ips6' && !/^[0-9a-f:]{3,45}$/i.test(s)) continue;
    if (kind === 'dom' && !/^[a-z0-9.-]{3,200}$/i.test(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= POOL_LIMITS[kind]) break;
  }
  return out;
}

export async function getPool(env, kind, { forceRepo = false } = {}) {
  const cached = ramCache.get(kind);
  const now = Date.now();
  if (cached && now - cached.at < RAM_TTL_MS) return cached.data;

  let data = null;
  const kv = findKVBinding(env);
  if (kv) {
    try {
      const raw = await kv.get(POOL_KEYS[kind], 'text');
      if (raw) {
        if (kind === 'proxy') {
          const arr = safeJsonParseGuard(raw, []);
          if (Array.isArray(arr)) data = arr.filter((x) => x && typeof x.p === 'string').slice(0, POOL_LIMITS.proxy);
        } else {
          const arr = safeJsonParseGuard(raw, []);
          if (Array.isArray(arr)) data = arr.filter((x) => typeof x === 'string').slice(0, POOL_LIMITS[kind]);
        }
      }
    } catch {}
  }

  if ((!data || !data.length) && env) {
    const repo = String(env.__settingsDataRepo || activeDataRepo || '').trim();
    if (repo && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
      const lastFetch = repoFetchAt.get(kind) || 0;
      if (forceRepo || now - lastFetch > REPO_TTL_MS) {
        repoFetchAt.set(kind, now);
        const remote = await fetchRepoPool(env, repo, kind);
        if (remote && remote.length) data = remote;
      }
    }
  }

  if (!data) data = DEFAULT_POOLS[kind] || [];
  ramCache.set(kind, { data, at: now });
  return data;
}

export function invalidatePoolCache(kind) {
  if (kind) ramCache.delete(kind);
  else ramCache.clear();
}

async function fetchRepoPool(env, repo, kind) {
  const rawBase = String(env?.NL_GH_RAW_BASE || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
  const files = {
    proxy: ['data/proxy/ALL.txt'],
    ips4: ['data/ips.txt'],
    ips6: ['data/ip6.txt'],
    dom: ['data/dom.txt'],
  };
  const ctrl = new AbortController();
  const tid = setTimeout(() => { try { ctrl.abort(); } catch {} }, 8000);
  try {
    for (const file of files[kind] || []) {
      const res = await fetch(`${rawBase}/${repo}/main/${file}`, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'ARAL-Sulfur-Pool/1.0' },
      });
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseListText(text, kind);
      if (parsed.length) return parsed;
    }
  } catch {} finally {
    clearTimeout(tid);
  }
  return null;
}

export async function savePool(env, kind, parsed) {
  const kv = findKVBinding(env);
  const capped = parsed.slice(0, POOL_LIMITS[kind]);
  ramCache.set(kind, { data: capped, at: Date.now() });
  if (kv) {
    try {
      await kv.put(POOL_KEYS[kind], JSON.stringify(capped));
      return true;
    } catch {}
  }
  return false;
}

export async function clearPool(env, kind) {
  const kv = findKVBinding(env);
  ramCache.delete(kind);
  if (kv) {
    try { await kv.delete(POOL_KEYS[kind]); } catch {}
  }
  return true;
}

/** Fisher–Yates partial shuffle sample (uniform, O(n)) */
export function sampleFrom(list, count) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length <= count) return [...arr];
  const out = [...arr];
  const n = out.length;
  for (let i = 0; i < Math.min(count, n - 1); i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out.slice(0, count);
}

/** Build a fresh per-user clean address list: rotation mixes IPv4/IPv6/domains.
 *  ULTRA: user.poolType narrows the rotation to a single pool kind
 *  ('ipv4' | 'ipv6' | 'domain'); '' (default) keeps the proportional mix. */
export async function rotateCleanAddresses(env, user, settings) {
  const want = Math.max(1, Math.min(120, Number(user.ipCount) || 15));
  const pools = await Promise.all([
    getPool(env, 'ips4'),
    getPool(env, 'ips6'),
    getPool(env, 'dom'),
  ]);
  let [p4, p6, pd] = pools;
  const kind = String(user.poolType || '').trim();
  if (kind === 'ipv4') { p6 = []; pd = []; }
  else if (kind === 'ipv6') { p4 = []; pd = []; }
  else if (kind === 'domain') { p4 = []; p6 = []; }
  const total = p4.length + p6.length + pd.length;
  if (!total) {
    return { list: (user.ips && user.ips.length ? user.ips : settings.cleanIPs || []), rotated: false };
  }
  const n4 = p4.length ? Math.ceil(want * (p4.length / total)) : 0;
  const n6 = p6.length ? Math.ceil(want * (p6.length / total)) : 0;
  const nd = pd.length ? Math.ceil(want * (pd.length / total)) : 0;
  const picked = [
    ...sampleFrom(p4, n4),
    ...sampleFrom(p6, n6),
    ...sampleFrom(pd, nd),
  ].slice(0, want);
  return { list: picked, rotated: true };
}

/** Pick the best-scoring replacement candidates for a broken exit proxy. */
export async function pickProxyReplacements(env, countryHint = '', excludeSet = new Set(), count = 5) {
  const pool = await getPool(env, 'proxy');
  if (!pool.length) return [];
  const wanted = (countryHint || '').toUpperCase();
  const sameCountry = wanted
    ? pool.filter((x) => (x.c || '').toUpperCase() === wanted && !excludeSet.has(x.p))
    : [];
  const others = pool.filter((x) => !excludeSet.has(x.p) && !sameCountry.includes(x));
  const candidates = [
    ...sampleFrom(sameCountry, Math.max(3, count)),
    ...sampleFrom(others, count),
  ];
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.p)) continue;
    seen.add(c.p);
    out.push({ p: c.p, c: c.c || wanted || '' });
    if (out.length >= count) break;
  }
  return out;
}

export const DEFAULT_POOLS = {
  ips4: [],
  ips6: [],
  dom: ['www.speedtest.net', 'www.cloudflare.com', 'cp.cloudflare.com'],
  proxy: [],
};

/* ─────────────────────────── ULTRA v4.2: one-time repo provisioning ─────────────────────────── */

/**
 * Reservoir-sample up to `want` non-empty lines from a potentially huge text WITHOUT
 * materialising a giant split() array (keeps Worker CPU budget tiny even on multi-MB
 * pool files like a 80k-line proxy list). Returns sampled raw lines.
 */
export function sampleLinesFromText(text, want) {
  const src = String(text || '');
  const out = [];
  if (!src || want <= 0) return out;
  const maxScan = Math.min(src.length, 6_000_000);
  let seen = 0;
  let start = 0;
  while (start < maxScan) {
    let nl = src.indexOf('\n', start);
    let end = nl === -1 ? maxScan : nl;
    // trim trailing \r
    let lineEnd = end;
    if (lineEnd > start && src.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
    if (lineEnd > start) {
      const line = src.slice(start, lineEnd);
      seen += 1;
      if (out.length < want) {
        out.push(line);
      } else {
        const i = Math.floor(Math.random() * seen);
        if (i < want) out[i] = line;
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

const PROVISION_TARGETS = [
  { kind: 'ips4', file: 'data/ips.txt', sample: 4000 },
  { kind: 'ips6', file: 'data/ip6.txt', sample: 1600 },
  { kind: 'dom', file: 'data/dom.txt', sample: 1200 },
  { kind: 'proxy', file: 'data/proxy/ALL.txt', sample: 2600 },
];

const provisionMem = { checkedAt: 0, done: false };

/**
 * ULTRA v4.2 — “clean IPs ready by default”:
 * Runs once per deployment (KV flag + RAM cache). Pulls a bounded sample of the pool
 * files from the configured GitHub repo (default: Aral-Dev/Aral-Sulfur data/ folder) and
 * persists them into KV, then samples the fresh IPv4 pool into the panel's default
 * clean-IP list so rotation & node generation have real clean addresses immediately.
 * Designed for `ctx.waitUntil()` — never throws, never blocks the response.
 */
export async function provisionPoolsFromRepo(env, state, { force = false, persistState = null } = {}) {
  const now = Date.now();
  try {
    if (!force) {
      if (provisionMem.done && now - provisionMem.checkedAt < 30 * 60_000) return null;
      provisionMem.checkedAt = now;
    }
    const kv = findKVBinding(env);
    if (!kv) return null;

    // Test/dev escape hatch: deterministic E2E suites disable background provisioning
    if (env?.NL_DISABLE_POOL_PROVISION === '1') {
      provisionMem.done = true;
      provisionMem.checkedAt = now;
      return null;
    }

    if (!force) {
      try {
        const flag = await kv.get(POOL_PROVISION_KEY, 'text');
        if (flag) {
          provisionMem.done = true;
          provisionMem.checkedAt = now;
          return null;
        }
      } catch {}
    }

    if (!state || !state.settings) return null;
    const repo = String(state.settings.dataRepo || '').trim();
    if (!repo || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
      // Admin disabled repo fetching — mark done so we stop checking
      try { await kv.put(POOL_PROVISION_KEY, JSON.stringify({ at: now, repo: '', skipped: true })); } catch {}
      provisionMem.done = true;
      provisionMem.checkedAt = now;
      return null;
    }

    const results = {};
    let ips4Sample = [];
    for (const target of PROVISION_TARGETS) {
      // Skip kinds that already have KV data (admin may have uploaded custom pools)
      try {
        const existing = await kv.get(POOL_KEYS[target.kind], 'text');
        if (existing) {
          results[target.kind] = -1; // kept existing
          if (target.kind === 'ips4') {
            const arr = safeJsonParseGuard(existing, []);
            if (Array.isArray(arr) && arr.length) ips4Sample = arr;
          }
          continue;
        }
      } catch {}

      let text = '';
      try {
        const rawBase = String(env?.NL_GH_RAW_BASE || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
        const res = await fetch(`${rawBase}/${repo}/main/${target.file}`, {
          headers: { 'user-agent': 'ARAL-Sulfur-Provision/1.0' },
          signal: AbortSignal.timeout ? AbortSignal.timeout(9000) : undefined,
        });
        if (res.ok) text = await res.text();
      } catch {}
      if (!text) {
        results[target.kind] = 0;
        continue;
      }
      const lines = sampleLinesFromText(text, target.sample);
      const parsed = parseListText(lines.join('\n'), target.kind);
      results[target.kind] = parsed.length;
      if (parsed.length) {
        if (target.kind === 'ips4') ips4Sample = parsed;
        await savePool(env, target.kind, parsed);
      }
    }

    // Seed the panel's default clean-IP list with a fresh sample from the repo pool,
    // but never overwrite a list the admin has customized.
    let cleanSeeded = 0;
    const curClean = Array.isArray(state.settings.cleanIPs) ? state.settings.cleanIPs : [];
    const factoryDefault = curClean.length === 0 ||
      (curClean.length === 1 && /^www\.speedtest\.net(#|$)/.test(curClean[0]));
    if (factoryDefault && ips4Sample.length) {
      const picks = sampleFrom(ips4Sample, Math.min(24, ips4Sample.length));
      const merged = ['www.speedtest.net#Speedtest'];
      for (const p of picks) {
        const addr = String(p).split('#')[0].trim();
        if (addr && !merged.some((m) => m.split('#')[0] === addr)) merged.push(addr);
      }
      state.settings.cleanIPs = merged.slice(0, 80);
      cleanSeeded = merged.length - 1;
    }

    try {
      await kv.put(POOL_PROVISION_KEY, JSON.stringify({ at: now, repo, results, cleanSeeded }));
    } catch {}
    invalidatePoolCache();
    provisionMem.done = true;
    provisionMem.checkedAt = now;

    if (typeof persistState === 'function') {
      try { await persistState(env, state); } catch {}
    }
    return { repo, results, cleanSeeded };
  } catch {
    return null;
  }
}
