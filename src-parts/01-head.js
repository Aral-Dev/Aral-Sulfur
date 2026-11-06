// ⚗️ ARAL SULFUR — Cloudflare Workers VPN Panel
// Built from scratch, November 2026.
// Sources:
//   • Tunnel core + settings pattern: BPB-VPN worker (github.com/bia-pain-bache/BPB-VPN, Nov 2026 rewrite)
//   • Panel DNA: aral-ultra, Aral-panel, Aral-Uranium (Aral-Dev)
//
// Architecture rules (why this cannot produce Error 1101):
//   1. The tunnel path reads settings SYNCHRONOUSLY from the ENV binding
//      (base64 JSON) — no KV, no async storage, no shared mutable globals.
//   2. Settings travel as a plain parameter through the whole tunnel chain.
//   3. The tunnel is TCP-only (like BPB-VPN): DNS travels as DoH over the
//      tunnel itself; there is no UDP machinery in the worker.
//   4. Every promise that is not awaited has a .catch: pipeTo, socket.closed,
//      retry — all of them. One outer try/catch wraps the whole fetch.
//   5. The panel (login, settings, subscriptions, self-update) runs on a
//      single KV blob ("aral" namespace, variable name KV) and pushes the
//      tunnel settings into the ENV secret after every change (best-effort;
//      KV remains the source of truth).

import { connect } from 'cloudflare:sockets';

const PANEL_VERSION = '4.0.0';
const GITHUB_REPO = 'Aral-Dev/Aral-Sulfur';
const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;
const WORKER_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/worker-single-file.js`;
const PACKAGE_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json`;

const ARAL_LINKS = {
    telegram: 'https://t.me/AralDev',
    channel: 'https://t.me/AralPanel',
    youtube: 'https://youtube.com/@Aral-Dev',
    github: GITHUB_REPO_URL,
};

const STATE_KEY = 'aralState';
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

/* ============================================================
 * Common helpers
 * ============================================================ */

function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    });
}

function respond(success, status, message, body = null, extraHeaders = {}) {
    return json({ success, message, body }, status, extraHeaders);
}

function safeError(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    } catch {
        return 'Unknown error';
    }
}

function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function base64ToUtf8(b64) {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

function generateUUID() {
    return crypto.randomUUID();
}

function isValidUUID(str) {
    const s = String(str || '').toLowerCase().trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

function randomPassword(length = 14) {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, (n) => chars[n % chars.length]).join('');
}

function randomPath(length = 10) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, (n) => chars[n % chars.length]).join('');
}

/* ============================================================
 * Pure-JS SHA-224 (SubtleCrypto has no SHA-224; Trojan needs it)
 * ============================================================ */

const SHA224_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SHA224_H = [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4];

function rotr32(x, n) {
    return (x >>> n) | (x << (32 - n));
}

function sha224Hex(message) {
    const bytes = new TextEncoder().encode(message);
    const bitLen = bytes.length * 8;
    const withOne = bytes.length + 1;
    const paddedLen = ((withOne + 8 + 63) >> 6) << 6;
    const padded = new Uint8Array(paddedLen);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    padded[paddedLen - 8] = (hi >>> 24) & 0xff;
    padded[paddedLen - 7] = (hi >>> 16) & 0xff;
    padded[paddedLen - 6] = (hi >>> 8) & 0xff;
    padded[paddedLen - 5] = hi & 0xff;
    padded[paddedLen - 4] = (lo >>> 24) & 0xff;
    padded[paddedLen - 3] = (lo >>> 16) & 0xff;
    padded[paddedLen - 2] = (lo >>> 8) & 0xff;
    padded[paddedLen - 1] = lo & 0xff;

    const h = [...SHA224_H];
    const w = new Uint32Array(64);

    for (let off = 0; off < paddedLen; off += 64) {
        for (let i = 0; i < 16; i++) {
            const j = off + i * 4;
            w[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + SHA224_K[i] + w[i]) >>> 0;
            const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e;
            e = (d + t1) >>> 0;
            d = c; c = b; b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
        h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0;
        h[7] = (h[7] + hh) >>> 0;
    }

    return h.slice(0, 7).map((x) => x.toString(16).padStart(8, '0')).join('');
}

/* ============================================================
 * Minimal HS256 JWT (WebCrypto only)
 * ============================================================ */

function base64UrlEncode(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(str) {
    const b64 = str.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmacSign(keyStr, data) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(keyStr),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

async function signJWT(payload, secretKey, maxAgeSeconds) {
    const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64UrlEncode(JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
    }));
    const signature = base64UrlEncode(await hmacSign(secretKey, `${header}.${body}`));
    return `${header}.${body}.${signature}`;
}

async function verifyJWT(token, secretKey) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const expected = base64UrlEncode(await hmacSign(secretKey, `${parts[0]}.${parts[1]}`));
        if (expected !== parts[2]) return null;
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

/* ============================================================
 * Tunnel settings codec — the BPB-VPN ENV binding pattern.
 * ENV value: base64 of JSON { v, id, tr, mode, pips, prefixes, fb, doh }
 * ============================================================ */

function decodeTunnelEnv(raw) {
    try {
        const data = JSON.parse(base64ToUtf8(raw));
        if (!data || typeof data !== 'object' || typeof data.id !== 'string' || !data.id) return null;
        const clean = (arr) =>
            (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean);
        return {
            v: 1,
            vlUUID: data.id.toLowerCase(),
            trPass: String(data.tr || ''),
            proxyIpMode: String(data.mode || 'proxyip'),
            proxyIPs: clean(data.pips),
            prefixes: clean(data.prefixes),
            fallback: String(data.fb || '').trim(),
            dohUrl: String(data.doh || 'https://cloudflare-dns.com/dns-query'),
        };
    } catch {
        return null;
    }
}

function encodeTunnelEnv(settings) {
    return utf8ToBase64(JSON.stringify({
        v: 1,
        id: settings.vlUUID,
        tr: settings.trPass,
        mode: settings.proxyIpMode,
        pips: settings.proxyIPs || [],
        prefixes: settings.prefixes || [],
        fb: settings.fallback || '',
        doh: settings.dohUrl || 'https://cloudflare-dns.com/dns-query',
    }));
}

/** Synchronous tunnel settings from the ENV binding. NEVER throws. */
function readTunnelSettings(env) {
    try {
        const raw = env && env.ENV;
        if (typeof raw === 'string' && raw.length > 0) {
            const settings = decodeTunnelEnv(raw);
            if (settings && isValidUUID(settings.vlUUID)) return settings;
        }
    } catch { /* fall through */ }
    return null;
}

/** Panel state blob in KV (async — panel path only). */
async function readState(env) {
    try {
        const kv = env && env.KV;
        if (!kv) return null;
        const raw = await kv.get(STATE_KEY);
        if (!raw) return null;
        const state = JSON.parse(raw);
        if (!state || typeof state !== 'object' || !state.vlUUID) return null;
        return state;
    } catch {
        return null;
    }
}

async function saveState(env, state) {
    await env.KV.put(STATE_KEY, JSON.stringify(state));
}

function stateToTunnelSettings(state) {
    if (!state || !state.vlUUID) return null;
    return {
        v: 1,
        vlUUID: String(state.vlUUID).toLowerCase(),
        trPass: String(state.trPass || ''),
        proxyIpMode: String(state.proxyIpMode || 'proxyip'),
        proxyIPs: Array.isArray(state.proxyIPs) ? state.proxyIPs : [],
        prefixes: Array.isArray(state.prefixes) ? state.prefixes : [],
        fallback: String(state.fallback || '').trim(),
        dohUrl: String(state.dohUrl || 'https://cloudflare-dns.com/dns-query'),
    };
}
