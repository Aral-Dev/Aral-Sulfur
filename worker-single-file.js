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


/* ============================================================
 * TUNNEL CORE — the BPB-VPN pattern, verbatim in spirit:
 *   • settings as a parameter (never shared globals)
 *   • TCP only (command must be 1) — DNS travels as DoH over TCP
 *   • every fire-and-forget promise carries a .catch
 *   • safeClose* never throws
 * ============================================================ */

function handleWebsocket(request, settings) {
    const pathname = new URL(request.url).pathname;
    const proto = pathname.split('/')[1];

    if (proto === 'vl') return vOverWS(request, settings);
    if (proto === 'tr') return trOverWS(request, settings);
    return wsFallback(request, settings);
}

async function wsFallback(request, settings) {
    if (settings.fallback) {
        try {
            const target = new URL(settings.fallback.startsWith('http') ? settings.fallback : `https://${settings.fallback}`);
            const url = new URL(request.url);
            url.protocol = 'https:';
            url.hostname = target.hostname;
            url.port = target.port;
            return fetch(new Request(url, request));
        } catch { /* fall through */ }
    }
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}

async function vOverWS(request, settings) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    webSocket.binaryType = 'arraybuffer';

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

    const remoteSocket = { value: null };

    readableWebSocketStream
        .pipeTo(new WritableStream({
            async write(chunk) {
                if (remoteSocket.value) {
                    const writer = remoteSocket.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const header = parseVlHeader(chunk, settings.vlUUID);
                if (header.hasError) throw new Error(header.message);

                const responseHeader = new Uint8Array([header.version[0], 0]);
                const rawClientData = chunk.slice(header.rawDataIndex);

                handleTCPOutBound(remoteSocket, header.addressRemote, header.portRemote, rawClientData, webSocket, responseHeader, settings);
            },
            close() {
                safeCloseTcpSocket(remoteSocket.value);
            },
        }))
        .catch(() => safeCloseTcpSocket(remoteSocket.value));

    // Xray drops a connection whose early-data subprotocol is not echoed.
    const headers = earlyDataHeader ? { 'Sec-WebSocket-Protocol': earlyDataHeader } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
}

async function trOverWS(request, settings) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    webSocket.binaryType = 'arraybuffer';

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

    const remoteSocket = { value: null };

    readableWebSocketStream
        .pipeTo(new WritableStream({
            async write(chunk) {
                if (remoteSocket.value) {
                    const writer = remoteSocket.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const header = parseTrHeader(chunk, settings.trPass);
                if (header.hasError) throw new Error(header.message);

                handleTCPOutBound(remoteSocket, header.addressRemote, header.portRemote, header.rawClientData, webSocket, null, settings);
            },
            close() {
                safeCloseTcpSocket(remoteSocket.value);
            },
        }))
        .catch(() => safeCloseTcpSocket(remoteSocket.value));

    const headers = earlyDataHeader ? { 'Sec-WebSocket-Protocol': earlyDataHeader } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
}

function parseVlHeader(buffer, userId) {
    if (buffer.byteLength < 24) return { hasError: true, message: 'invalid data' };

    const bytes = new Uint8Array(buffer);
    const version = bytes.slice(0, 1);
    if (uuidFromBytes(bytes, 1) !== userId) return { hasError: true, message: 'invalid user' };

    const optLength = bytes[17];
    const command = bytes[18 + optLength];
    // TCP only, exactly like BPB-VPN: DNS resolves as DoH over the tunnel itself.
    if (command !== 1) return { hasError: true, message: `command ${command} is not supported` };

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(buffer.slice(portIndex, portIndex + 2)).getUint16(0);

    const addressType = bytes[portIndex + 2];
    let addressValueIndex = portIndex + 3;
    let addressLength = 0;
    let addressRemote = '';

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressRemote = bytes.slice(addressValueIndex, addressValueIndex + 4).join('.');
            break;
        case 2:
            addressLength = bytes[addressValueIndex];
            addressValueIndex += 1;
            addressRemote = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3: {
            addressLength = 16;
            const view = new DataView(buffer.slice(addressValueIndex, addressValueIndex + 16));
            const parts = [];
            for (let i = 0; i < 8; i++) parts.push(view.getUint16(i * 2).toString(16));
            addressRemote = parts.join(':');
            break;
        }
        default:
            return { hasError: true, message: `invalid address type ${addressType}` };
    }

    if (!addressRemote) return { hasError: true, message: 'empty address' };

    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        version,
    };
}

function parseTrHeader(buffer, trPass) {
    if (buffer.byteLength < 56) return { hasError: true, message: 'invalid data' };

    let crLfIndex = 56;
    const cr = new Uint8Array(buffer.slice(crLfIndex, crLfIndex + 1))[0];
    const lf = new Uint8Array(buffer.slice(crLfIndex + 1, crLfIndex + 2))[0];

    if (cr !== 0x0d || lf !== 0x0a) {
        return { hasError: true, message: 'invalid header format (missing CR LF)' };
    }

    const password = new TextDecoder().decode(buffer.slice(0, crLfIndex));
    if (password !== sha224Hex(trPass)) {
        return { hasError: true, message: 'invalid password' };
    }

    const socks5DataBuffer = buffer.slice(crLfIndex + 2);
    if (socks5DataBuffer.byteLength < 6) {
        return { hasError: true, message: 'invalid SOCKS5 request data' };
    }

    const view = new DataView(socks5DataBuffer);
    const cmd = view.getUint8(0);
    if (cmd !== 1) {
        return { hasError: true, message: 'unsupported command, only TCP (CONNECT) is allowed' };
    }

    const atype = view.getUint8(1);
    let addressLength = 0;
    let addressIndex = 2;
    let addressRemote = '';

    switch (atype) {
        case 1:
            addressLength = 4;
            addressRemote = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + 1))[0];
            addressIndex += 1;
            addressRemote = new TextDecoder().decode(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            break;
        case 3: {
            addressLength = 16;
            const dataView = new DataView(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
            addressRemote = ipv6.join(':');
            break;
        }
        default:
            return { hasError: true, message: `invalid addressType is ${atype}` };
    }

    if (!addressRemote) {
        return { hasError: true, message: `addressValue is empty, addressType is ${atype}` };
    }

    const portIndex = addressIndex + addressLength;
    const portRemote = new DataView(socks5DataBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawClientData: socks5DataBuffer.slice(portIndex + 2),
    };
}

const BYTE_TO_HEX = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));

function uuidFromBytes(arr, offset) {
    const h = (i) => BYTE_TO_HEX[arr[offset + i]];
    return (
        h(0) + h(1) + h(2) + h(3) + '-' + h(4) + h(5) + '-' + h(6) + h(7) + '-' +
        h(8) + h(9) + '-' + h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
    );
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, settings) {
    async function connectAndWrite(address, port) {
        if (address.includes(':') && !address.startsWith('[')) address = `[${address}]`;
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    function safeWsClose(code, reason) {
        try {
            webSocket.close(code, reason);
        } catch { /* already closed */ }
    }

    // The retry path — every step inside try/catch, including the DoH
    // resolution used by prefix mode (the classic 1101 source in the old panels).
    async function retry() {
        let retryAddress = addressRemote;
        let retryPort = portRemote;

        try {
            if (settings.proxyIpMode === 'prefix' && settings.prefixes.length) {
                const prefix = settings.prefixes[Math.floor(Math.random() * settings.prefixes.length)];
                const dynamic = await getDynamicNAT64(addressRemote, prefix, settings.dohUrl);
                if (dynamic) retryAddress = dynamic;
                else return safeWsClose(1011, 'Retry connection failed: Invalid Prefix');
            } else if (settings.proxyIPs.length) {
                const endpoint = settings.proxyIPs[Math.floor(Math.random() * settings.proxyIPs.length)];
                const { host, port } = parseHostPort(endpoint);
                if (host) retryAddress = host;
                if (port) retryPort = port;
            }

            const tcpSocket = await connectAndWrite(retryAddress, retryPort);
            tcpSocket.closed
                .catch(() => { })
                .finally(() => safeCloseWebSocket(webSocket));
            remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, settings);
        } catch (error) {
            safeWsClose(1011, `Retry failed: ${safeError(error)}`);
        }
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, settings);
    } catch (error) {
        safeWsClose(1011, `Connection failed: ${safeError(error)}`);
    }
}

async function remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, settings) {
    let header = responseHeader;
    let hasIncomingData = false;

    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk, controller) {
                hasIncomingData = true;
                if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                    controller.error('WebSocket is not open');
                }
                if (header) {
                    webSocket.send(await new Blob([header, chunk]).arrayBuffer());
                    header = null;
                } else {
                    webSocket.send(chunk);
                }
            },
            abort() {
                safeCloseTcpSocket(remoteSocket);
            },
        }));
    } catch {
        safeCloseTcpSocket(remoteSocket);
        safeCloseWebSocket(webSocket);
        return;
    }

    if (!hasIncomingData && retry) {
        try {
            await retry();
        } catch { /* retry guards itself */ }
    }
}

function makeReadableWebSocketStream(webSocket, earlyDataHeader) {
    let cancelled = false;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => {
                if (!cancelled) controller.enqueue(event.data);
            });
            webSocket.addEventListener('close', () => {
                safeCloseWebSocket(webSocket);
                if (!cancelled) controller.close();
            });
            webSocket.addEventListener('error', (err) => controller.error(err));

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel(reason) {
            if (cancelled) return;
            cancelled = true;
            safeCloseWebSocket(webSocket);
        },
    });
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { earlyData: null, error: null };
    try {
        const decoded = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        return { earlyData: Uint8Array.from(decoded, (c) => c.charCodeAt(0)).buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

function safeCloseTcpSocket(socket) {
    try {
        if (socket) socket.close();
    } catch { /* ignore */ }
}

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch { /* ignore */ }
}

function parseHostPort(input) {
    const match = String(input).trim().match(/^(?:\[(?<ipv6>.+?)\]|(?<host>[^:]+))(?::(?<port>\d+))?$/);
    if (!match) return { host: String(input).trim(), port: 443 };
    const { ipv6, host, port } = match.groups;
    return {
        host: ipv6 ? `[${ipv6}]` : host,
        port: port ? Number(port) : 443,
    };
}

function isIPv4(str) {
    const parts = String(str).split('.');
    return parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** Resolve an A record through DoH — used ONLY inside the guarded retry path. */
async function resolveIPv4viaDoH(domain, dohUrl) {
    const base = dohUrl || 'https://cloudflare-dns.com/dns-query';
    const url = base.includes('?')
        ? `${base}&name=${encodeURIComponent(domain)}&type=A`
        : `${base}?name=${encodeURIComponent(domain)}&type=A`;
    const resp = await fetch(url, { headers: { accept: 'application/dns-json' } });
    const data = await resp.json();
    if (!data || !Array.isArray(data.Answer)) return null;
    const record = data.Answer.find((r) => r.type === 1);
    return record ? record.data : null;
}

function convertToNAT64IPv6(ipv4Address, prefix) {
    const parts = ipv4Address.split('.');
    if (parts.length !== 4) throw new Error('Invalid IPv4 address');
    const hex = parts.map((p) => {
        const n = Number(p);
        if (Number.isNaN(n) || n < 0 || n > 255) throw new Error('Invalid IPv4 address');
        return n.toString(16).padStart(2, '0');
    });
    const match = prefix.match(/^\[([0-9A-Fa-f:]+)\]$/);
    if (match) return `[${match[1]}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
    const bare = prefix.replace(/^\[|\]$/g, '');
    return `[${bare}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
}

async function getDynamicNAT64(address, prefix, dohUrl) {
    let finalAddress = address;
    if (!isIPv4(address)) {
        const ipv4 = await resolveIPv4viaDoH(address, dohUrl);
        if (!ipv4) return null;
        finalAddress = ipv4;
    }
    return convertToNAT64IPv6(finalAddress, prefix);
}


/* ============================================================
 * Cloudflare API — ENV secret sync + self-update (bindings preserved)
 * ============================================================ */

async function cfApi(token, url, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init.headers || {}),
        },
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`Cloudflare API returned status ${res.status}`);
    if (!data.success) throw new Error(data?.errors?.[0]?.message || `Cloudflare API error ${res.status}`);
    return data;
}

async function resolveAccountId(token) {
    const data = await cfApi(token, 'https://api.cloudflare.com/client/v4/accounts');
    const accounts = data.result || [];
    if (!accounts.length) throw new Error('No Cloudflare accounts found for this token.');
    return accounts[0].id;
}

function workerNameFromHost(host) {
    const name = String(host || '').split('.')[0];
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error('Could not resolve the worker name from the current host.');
    }
    return name;
}

/** Pushes tunnel settings into the worker's ENV secret (no redeploy, other bindings untouched). */
async function syncTunnelEnv(state, request) {
    if (!state.apiToken) throw new Error('Cloudflare API token is not configured.');
    const host = new URL(request.url).hostname;
    const scriptName = workerNameFromHost(host);
    const accountId = state.accID || await resolveAccountId(state.apiToken);

    await cfApi(state.apiToken,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'ENV',
                text: encodeTunnelEnv(stateToTunnelSettings(state)),
                type: 'secret_text',
            }),
        }
    );
}

async function fetchWithTimeout(url, ms, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { headers, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function compareSemver(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da > db) return 1;
        if (da < db) return -1;
    }
    return 0;
}

/** Self-update: read the deployed script's settings (bindings), download the
 *  latest worker from GitHub, redeploy via multipart keeping every binding. */
async function applySelfUpdate(state, request) {
    const host = new URL(request.url).hostname;
    const scriptName = workerNameFromHost(host);
    const accountId = state.accID || await resolveAccountId(state.apiToken);
    const apiBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`;

    // current deployment settings → reuse bindings + compatibility date
    const settingsResp = await cfApi(state.apiToken, `${apiBase}/settings`);
    const current = settingsResp.result || {};
    const compatibilityDate = current.compatibility_date || '2025-01-01';
    let bindings = Array.isArray(current.bindings) ? current.bindings : [];

    // keep KV etc.; replace ENV with the fresh value so the sync tunnel path survives the update
    bindings = bindings.filter((b) => b.name !== 'ENV');
    bindings.push({
        type: 'secret_text',
        name: 'ENV',
        text: encodeTunnelEnv(stateToTunnelSettings(state)),
    });

    // latest published worker
    const pkgResp = await fetchWithTimeout(PACKAGE_RAW_URL, 10000);
    if (!pkgResp.ok) throw new Error('Could not fetch the latest package.json from GitHub.');
    const pkg = await pkgResp.json();
    const latest = String(pkg.version || '');
    if (!latest) throw new Error('Latest version not found in GitHub package.json.');
    if (compareSemver(latest, PANEL_VERSION) <= 0) {
        return { updated: false, version: PANEL_VERSION, latest };
    }

    const workerResp = await fetchWithTimeout(WORKER_RAW_URL, 20000);
    if (!workerResp.ok) throw new Error('Could not fetch the latest worker from GitHub.');
    const code = await workerResp.text();
    if (!code.includes('ARAL SULFUR')) throw new Error('The downloaded file is not an Aral Sulfur worker.');

    const metadata = {
        main_module: 'worker.js',
        compatibility_date: compatibilityDate,
        bindings,
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');

    await cfApi(state.apiToken, apiBase, { method: 'PUT', body: form });
    return { updated: true, version: latest, previous: PANEL_VERSION };
}

/** Version probe for the dashboard badge (no deploy). */
async function checkUpdateInfo() {
    try {
        const resp = await fetchWithTimeout(PACKAGE_RAW_URL, 8000);
        if (!resp.ok) return { updateAvailable: false, latest: PANEL_VERSION };
        const pkg = await resp.json();
        const latest = String(pkg.version || PANEL_VERSION);
        return { updateAvailable: compareSemver(latest, PANEL_VERSION) > 0, latest };
    } catch {
        return { updateAvailable: false, latest: PANEL_VERSION };
    }
}

/* ============================================================
 * Subscription builders — VLESS + Trojan over WS (path /vl and /tr)
 * ============================================================ */

function buildVlessLink(host, uuid, name) {
    const params = new URLSearchParams({
        encryption: 'none',
        security: 'tls',
        sni: host,
        fp: 'chrome',
        type: 'ws',
        host: host,
        path: '/vl',
    });
    return `vless://${uuid}@${host}:443?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildTrojanLink(host, password, name) {
    const params = new URLSearchParams({
        security: 'tls',
        sni: host,
        fp: 'chrome',
        type: 'ws',
        host: host,
        path: '/tr',
    });
    return `trojan://${password}@${host}:443?${params.toString()}#${encodeURIComponent(name)}`;
}

function buildClashConfig(host, uuid, trojanPass) {
    return [
        'proxies:',
        `  - name: "ARAL-VLESS"`,
        '    type: vless',
        `    server: ${host}`,
        '    port: 443',
        `    uuid: ${uuid}`,
        '    tls: true',
        '    servername: ' + host,
        '    client-fingerprint: chrome',
        '    network: ws',
        '    ws-opts:',
        '      path: /vl',
        '      headers:',
        `        Host: ${host}`,
        `  - name: "ARAL-TROJAN"`,
        '    type: trojan',
        `    server: ${host}`,
        '    port: 443',
        `    password: ${trojanPass}`,
        '    sni: ' + host,
        '    client-fingerprint: chrome',
        '    network: ws',
        '    ws-opts:',
        '      path: /tr',
        '      headers:',
        `        Host: ${host}`,
        'proxy-groups:',
        '  - name: "ARAL-SULFUR"',
        '    type: select',
        '    proxies:',
        '      - "ARAL-VLESS"',
        '      - "ARAL-TROJAN"',
        'rules:',
        '  - MATCH,ARAL-SULFUR',
    ].join('\n');
}

function buildXrayOutbounds(host, uuid, trojanPass) {
    return {
        log: { loglevel: 'warning' },
        outbounds: [
            {
                tag: 'proxy-vless',
                protocol: 'vless',
                settings: {
                    vnext: [{
                        address: host,
                        port: 443,
                        users: [{ id: uuid, encryption: 'none', flow: '' }],
                    }],
                },
                streamSettings: {
                    network: 'ws',
                    security: 'tls',
                    tlsSettings: { serverName: host, fingerprint: 'chrome' },
                    wsSettings: { path: '/vl', headers: { Host: host } },
                },
            },
            {
                tag: 'proxy-trojan',
                protocol: 'trojan',
                settings: {
                    servers: [{ address: host, port: 443, password: trojanPass }],
                },
                streamSettings: {
                    network: 'ws',
                    security: 'tls',
                    tlsSettings: { serverName: host, fingerprint: 'chrome' },
                    wsSettings: { path: '/tr', headers: { Host: host } },
                },
            },
            { tag: 'direct', protocol: 'freedom' },
            { tag: 'block', protocol: 'blackhole' },
        ],
    };
}

function buildSingBoxConfig(host, uuid, trojanPass) {
    return {
        log: { level: 'warn' },
        outbounds: [
            {
                tag: 'aral-vless',
                type: 'vless',
                server: host,
                server_port: 443,
                uuid: uuid,
                tls: { enabled: true, server_name: host, utls: { enabled: true, fingerprint: 'chrome' } },
                transport: { type: 'ws', path: '/vl', headers: { Host: host } },
            },
            {
                tag: 'aral-trojan',
                type: 'trojan',
                server: host,
                server_port: 443,
                password: trojanPass,
                tls: { enabled: true, server_name: host, utls: { enabled: true, fingerprint: 'chrome' } },
                transport: { type: 'ws', path: '/tr', headers: { Host: host } },
            },
            { tag: 'direct', type: 'direct' },
        ],
    };
}

/** Subscription endpoint. ?app=links|xray|sing-box|clash (default: base64 links) */
async function handleSubscription(request, state) {
    const host = new URL(request.url).hostname;
    const app = new URL(request.url).searchParams.get('app') || 'links';
    const name = `ARAL-SULFUR`;

    if (app === 'clash') {
        return new Response(buildClashConfig(host, state.vlUUID, state.trPass), {
            headers: {
                'Content-Type': 'text/yaml; charset=utf-8',
                'Profile-Update-Interval': '24',
                'Subscription-Userinfo': 'upload=0; download=0; total=107374182400; expire=0',
            },
        });
    }

    if (app === 'xray') {
        return new Response(JSON.stringify(buildXrayOutbounds(host, state.vlUUID, state.trPass), null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
    }

    if (app === 'sing-box') {
        return new Response(JSON.stringify(buildSingBoxConfig(host, state.vlUUID, state.trPass), null, 2), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
    }

    const links = [
        buildVlessLink(host, state.vlUUID, `${name}-VLESS`),
        buildTrojanLink(host, state.trPass, `${name}-TROJAN`),
    ].join('\n');
    return new Response(utf8ToBase64(links), {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Profile-Update-Interval': '24',
            'Subscription-Userinfo': 'upload=0; download=0; total=107374182400; expire=0',
        },
    });
}


/* ============================================================
 * UI — Sulfur yellow design system (Aral visual language)
 * ============================================================ */

const SULFUR_CSS = `
:root{
  --bg:#0a0a08; --gold:#f5c518; --gold-soft:rgba(245,197,24,.14);
  --neon:#7cff5e; --neon-soft:rgba(124,255,94,.07);
  --err:#ff5545; --ok:#43d17c;
  --txt:#ece8dd; --body-txt:#cfc9ba; --mut:#948d7c; --dim:#5c564a;
  --panel:#141209; --field:#0e0d07; --glass:rgba(20,18,9,.66);
  --line:rgba(245,197,24,.16); --line-soft:rgba(245,197,24,.08);
  --mono:'JetBrains Mono',monospace; --sans:'Vazirmatn',system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);color:var(--body-txt);font-family:var(--sans);min-height:100vh}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(600px 400px at 85% -5%,var(--gold-soft),transparent 65%),
             radial-gradient(500px 350px at 10% 105%,var(--neon-soft),transparent 60%)}
.wrap{position:relative;z-index:1;max-width:520px;margin:0 auto;padding:28px 20px 48px}
.logo{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:6px}
.logo .gem{width:34px;height:34px;flex:none}
.logo h1{font-family:var(--mono);font-size:1.35rem;font-weight:800;letter-spacing:.14em;color:var(--txt)}
.logo h1 b{color:var(--gold)}
.tag{text-align:center;font-size:.78rem;color:var(--mut);margin-bottom:26px}
.card{background:var(--glass);border:1px solid var(--line);border-radius:14px;padding:22px 20px;backdrop-filter:blur(14px)}
.card + .card{margin-top:16px}
.card h2{font-size:.95rem;color:var(--txt);margin-bottom:14px;display:flex;align-items:center;gap:8px}
.card h2::before{content:'';width:8px;height:8px;background:var(--gold);transform:rotate(45deg);flex:none}
label{display:block;font-size:.78rem;color:var(--mut);margin:12px 0 6px}
input,select{width:100%;background:var(--field);border:1px solid var(--line-soft);border-radius:9px;
  color:var(--txt);font-family:var(--sans);font-size:.92rem;padding:11px 13px;outline:none;transition:.2s}
input:focus,select:focus{border-color:var(--gold);box-shadow:0 0 0 3px var(--gold-soft)}
input::placeholder{color:var(--dim)}
.row{display:flex;gap:10px}
.row > *{flex:1}
.btn{width:100%;margin-top:18px;background:var(--gold);color:#1a1605;border:none;border-radius:10px;
  font-family:var(--sans);font-weight:800;font-size:.95rem;padding:13px;cursor:pointer;transition:.2s}
.btn:hover{filter:brightness(1.1);box-shadow:0 6px 24px var(--gold-soft)}
.btn.ghost{background:transparent;color:var(--gold);border:1px solid var(--line)}
.btn.small{width:auto;margin-top:0;padding:11px 16px;font-size:.82rem}
.msg{border-radius:9px;padding:11px 13px;font-size:.82rem;margin-top:14px;display:none}
.msg.show{display:block}
.msg.ok{background:rgba(67,209,124,.1);color:var(--ok);border:1px solid rgba(67,209,124,.25)}
.msg.err{background:rgba(255,85,69,.1);color:var(--err);border:1px solid rgba(255,85,69,.25)}
.links{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:22px}
.links a{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 4px;border-radius:10px;
  background:var(--field);border:1px solid var(--line-soft);color:var(--mut);font-size:.66rem;text-decoration:none;transition:.2s}
.links a:hover{color:var(--gold);border-color:var(--line)}
.links svg{width:20px;height:20px}
.foot{text-align:center;font-size:.7rem;color:var(--dim);margin-top:26px;font-family:var(--mono)}
.badge{display:inline-block;font-family:var(--mono);font-size:.68rem;color:var(--gold);
  border:1px solid var(--line);border-radius:6px;padding:3px 8px;margin-right:auto}
.subbox{background:var(--field);border:1px solid var(--line-soft);border-radius:9px;padding:12px;
  font-family:var(--mono);font-size:.72rem;color:var(--body-txt);word-break:break-all;direction:ltr;text-align:left}
.kv{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px dashed var(--line-soft);font-size:.82rem}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--mut)} .kv .v{font-family:var(--mono);color:var(--txt);font-size:.76rem}
.copy{cursor:pointer;color:var(--gold)}
.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.tabs button{flex:1;background:var(--field);border:1px solid var(--line-soft);color:var(--mut);
  border-radius:8px;padding:8px 6px;font-size:.72rem;font-family:var(--sans);cursor:pointer}
.tabs button.on{color:var(--gold);border-color:var(--line);background:var(--gold-soft)}
`;

const ARAL_ICON_SVG = `<svg viewBox="0 0 32 32" fill="none"><rect x="9" y="9" width="14" height="14" transform="rotate(45 16 16)" fill="#f5c518"/><rect x="13.5" y="13.5" width="5" height="5" transform="rotate(45 16 16)" fill="#0a0a08"/></svg>`;

const LINKS_HTML = `
<div class="links">
  <a href="https://t.me/AralDev" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.6 19 19.3c-.2 1-.8 1.2-1.6.8l-4.5-3.3-2.2 2.1c-.24.24-.44.44-.9.44l.33-4.6L18.7 7.4c.37-.33-.08-.51-.57-.19L7.24 13.3l-4.4-1.4c-.96-.3-.98-.96.2-1.42L20.4 3.2c.8-.29 1.5.19 1.24 1.4Z"/></svg>
    <span>Developer</span></a>
  <a href="https://t.me/AralPanel" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.9 6.9-1.7 8.1c-.13.57-.47.71-.95.44l-2.6-1.9-1.3 1.2c-.14.14-.26.26-.53.26l.2-2.7 4.9-4.4c.2-.2-.05-.3-.33-.1l-6 3.8-2.6-.8c-.6-.2-.6-.6.12-.9l10-3.9c.5-.2.94.1.78.9Z"/></svg>
    <span>Channel</span></a>
  <a href="https://youtube.com/@Aral-Dev" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.5 12 4.5 12 4.5s-7 0-8.9.6A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12 31 31 0 0 0 1 16.8a3 3 0 0 0 2.1 2.1c1.9.6 8.9.6 8.9.6s7 0 8.9-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 23.5 12 31 31 0 0 0 23 7.2ZM9.8 15.3V8.7l5.8 3.3-5.8 3.3Z"/></svg>
    <span>YouTube</span></a>
  <a href="https://github.com/Aral-Dev/Aral-Sulfur" target="_blank" rel="noopener">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.2-.4-1.2.1-2.6 0 0 .8-.3 2.8 1a9.4 9.4 0 0 1 5 0c2-1.3 2.7-1 2.7-1 .6 1.4.2 2.4.1 2.6.7.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg>
    <span>GitHub</span></a>
</div>`;

function pageShell(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Aral Sulfur</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='9' y='9' width='14' height='14' transform='rotate(45 16 16)' fill='%23f5c518'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Vazirmatn:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>${SULFUR_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="logo">${ARAL_ICON_SVG}<h1>ARAL <b>SULFUR</b></h1></div>
  <div class="tag">⚗️ پنل شخصی‌سازی‌شده VLESS + Trojan روی Cloudflare Workers</div>
  ${bodyHtml}
  ${LINKS_HTML}
  <div class="foot">ARAL SULFUR · v${'${PANEL_VERSION}'} · Aral-Dev</div>
</div>
</body>
</html>`;
}

function renderKVGuide() {
    return new Response(pageShell('راهنمای نصب', `
<div class="card">
  <h2>ذخیره‌سازی متصل نیست</h2>
  <p style="font-size:.84rem;line-height:2">
    برای کار پنل باید یک فضای KV به این ورکر متصل شود:<br>
    ۱) در داشبورد Cloudflare وارد بخش <b>KV → Create namespace</b> شوید و یک namespace با نام
    <b>aral</b> بسازید.<br>
    ۲) در تنظیمات همین ورکر (Settings → Bindings → Add) آن را با
    <b>Variable name کوتاه: <span style="color:var(--gold);font-family:var(--mono)">KV</span></b> متصل کنید.<br>
    ۳) صفحه را دوباره باز کنید — ویزارد نصب خودکار ظاهر می‌شود.
  </p>
</div>
<div class="card">
  <h2>چرا این پنل 1101 نمی‌گیرد؟</h2>
  <p style="font-size:.84rem;line-height:2">
    مسیر تونل تنظیمات را به‌صورت <b>همزمان (sync)</b> از ENV می‌خواند، تونل فقط TCP است،
    و تک‌تک promiseهای بدون await یک catch دارند. حتی اگر KV لحظه‌ای قطع شود، تونل‌ها از ENV
    ادامه می‌دهند.
  </p>
</div>`).replaceAll('${PANEL_VERSION}', PANEL_VERSION), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function renderSetupPage() {
    return new Response(pageShell('نصب', `
<div class="card">
  <h2>فعال‌سازی پنل</h2>
  <label>ایمیل حساب Cloudflare</label>
  <input id="accEmail" type="email" placeholder="you@example.com" dir="ltr">
  <label>API Token (دسترسی Workers / Zone)</label>
  <input id="apiToken" type="text" placeholder="v1.0 - ..." dir="ltr">
  <label>رمز ورود پنل (حداقل ۶ کاراکتر)</label>
  <input id="panelPass" type="password" placeholder="••••••" dir="ltr">
  <div class="row">
    <div>
      <label>VLESS UUID</label>
      <input id="vlUUID" type="text" dir="ltr" placeholder="click generate">
    </div>
    <div style="flex:0 0 auto;display:flex;align-items:flex-end">
      <button class="btn small ghost" type="button" onclick="gen()">🎲</button>
    </div>
  </div>
  <div class="row">
    <div>
      <label>رمز Trojan</label>
      <input id="trPass" type="text" dir="ltr">
    </div>
    <div style="flex:0 0 auto;display:flex;align-items:flex-end">
      <button class="btn small ghost" type="button" onclick="genTr()">🎲</button>
    </div>
  </div>
  <label>Secure Path (مسیر مخفی پنل)</label>
  <input id="securePath" type="text" dir="ltr" placeholder="mySecretPath">
  <button class="btn" onclick="apply()">⚗️ فعال‌سازی پنل</button>
  <div id="msg" class="msg"></div>
</div>
<script>
function gen(){document.getElementById('vlUUID').value=crypto.randomUUID()}
function genTr(){const c='abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';const a=new Uint8Array(14);crypto.getRandomValues(a);document.getElementById('trPass').value=Array.from(a,n=>c[n%c.length]).join('')}
function genSp(){document.getElementById('securePath').value=Array.from(crypto.getRandomValues(new Uint8Array(10)),n=>'abcdefghijklmnopqrstuvwxyz0123456789'[n%36]).join('')}
gen();genTr();genSp();
async function apply(){
  const msg=document.getElementById('msg');
  const body={
    accEmail:v('accEmail'),apiToken:v('apiToken'),panelPass:v('panelPass'),
    vlUUID:v('vlUUID'),trPass:v('trPass'),securePath:v('securePath')
  };
  if(!body.accEmail||!body.apiToken||!body.panelPass||!body.vlUUID||!body.trPass||!body.securePath){show('err','همه فیلدها لازم هستند.');return}
  msg.className='msg';msg.textContent='در حال فعال‌سازی…';msg.classList.add('show');
  try{
    const r=await fetch('/setup/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.success){show('ok','پنل فعال شد! در حال انتقال به صفحه ورود…');setTimeout(()=>location.href='/'+d.body.securePath+'/login',1200)}
    else show('err',d.message||'خطا در فعال‌سازی');
  }catch(e){show('err','ارتباط با سرور برقرار نشد.')}
}
function v(id){return document.getElementById(id).value.trim()}
function show(t,m){const msg=document.getElementById('msg');msg.className='msg show '+t;msg.textContent=m}
</script>`).replaceAll('${PANEL_VERSION}', PANEL_VERSION), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function renderLoginPage() {
    return new Response(pageShell('ورود', `
<div class="card">
  <h2>ورود به پنل</h2>
  <label>نام کاربری (ایمیل Cloudflare)</label>
  <input id="username" type="text" dir="ltr" autocomplete="username">
  <label>رمز عبور</label>
  <input id="password" type="password" dir="ltr" autocomplete="current-password">
  <button class="btn" onclick="login()">🔓 ورود</button>
  <div id="msg" class="msg"></div>
</div>
<script>
async function login(){
  const msg=document.getElementById('msg');
  msg.className='msg';msg.textContent='در حال بررسی…';msg.classList.add('show');
  try{
    const r=await fetch(location.pathname+'/authenticate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:v('username'),password:v('password')})});
    const d=await r.json();
    if(d.success)location.href=location.pathname.replace(/\\/login$/,'/panel');
    else{msg.className='msg show err';msg.textContent=d.message||'خطا'}
  }catch(e){msg.className='msg show err';msg.textContent='ارتباط با سرور برقرار نشد.'}
}
function v(id){return document.getElementById(id).value}
document.addEventListener('keydown',e=>{if(e.key==='Enter')login()});
</script>`).replaceAll('${PANEL_VERSION}', PANEL_VERSION), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

function renderPanelPage(state) {
    return new Response(pageShell('داشبورد', `
<div class="card">
  <h2>وضعیت پنل <span class="badge">v${'${PV}'}</span></h2>
  <div class="kv"><span class="k">حالت تونل</span><span class="v">VLESS + Trojan · TCP-only · sync ENV</span></div>
  <div class="kv"><span class="k">Proxy IP Mode</span><span class="v" id="modeView"></span></div>
  <div class="kv"><span class="k">نسخه جدید</span><span class="v" id="updView">در حال بررسی…</span></div>
  <button class="btn ghost" style="margin-top:14px" onclick="doUpdate(this)">⬆️ بررسی و نصب آپدیت</button>
  <div id="umsg" class="msg"></div>
</div>
<div class="card">
  <h2>لینک اشتراک</h2>
  <div class="tabs">
    <button class="on" onclick="setTab(this,'subbox','links')">لینک‌ها</button>
    <button onclick="setTab(this,'subbox','clash')">Clash</button>
    <button onclick="setTab(this,'subbox','xray')">Xray</button>
    <button onclick="setTab(this,'subbox','sing-box')">sing-box</button>
  </div>
  <div class="subbox" id="subbox"></div>
  <button class="btn ghost" style="margin-top:14px" onclick="copySub(this)">📋 کپی</button>
</div>
<div class="card">
  <h2>تنظیمات تونل</h2>
  <label>VLESS UUID</label><input id="vlUUID" dir="ltr">
  <label>رمز Trojan</label><input id="trPass" dir="ltr">
  <label>حالت اتصال مجدد</label>
  <select id="proxyIpMode">
    <option value="proxyip">Proxy IP (دامنه/آی‌پی واسط)</option>
    <option value="prefix">NAT64 Prefix (DNS روی IPv6)</option>
  </select>
  <label>لیست Proxy IP / NAT64 Prefix (هر خط یکی)</label>
  <textarea id="proxyList" rows="3" dir="ltr" style="width:100%;background:var(--field);border:1px solid var(--line-soft);border-radius:9px;color:var(--txt);font-family:var(--mono);font-size:.78rem;padding:11px 13px;outline:none"></textarea>
  <label>دامنه Fallback (اختیاری)</label>
  <input id="fallback" dir="ltr" placeholder="example.com">
  <label>DoH Server</label>
  <input id="dohUrl" dir="ltr">
  <button class="btn" onclick="saveSettings(this)">💾 ذخیره تنظیمات</button>
  <div id="smsg" class="msg"></div>
</div>
<div class="card">
  <h2>خروج</h2>
  <button class="btn ghost" onclick="location.href=location.pathname.replace(/\\/panel$/,'/logout')">🚪 خروج از حساب</button>
</div>
<script>
const SUB_BASE=location.pathname.replace(/\\/panel$/,'/sub');
let currentApp='links';
async function loadSettings(){
  const r=await fetch(location.pathname+'/settings');const d=await r.json();
  const s=d.body.proxySettings;
  document.getElementById('vlUUID').value=s.vlUUID;
  document.getElementById('trPass').value=s.trPass;
  document.getElementById('proxyIpMode').value=s.proxyIpMode;
  document.getElementById('proxyList').value=(s.proxyIpMode==='prefix'?s.prefixes:s.proxyIPs).join('\\n');
  document.getElementById('fallback').value=s.fallback||'';
  document.getElementById('dohUrl').value=s.dohUrl||'';
  document.getElementById('modeView').textContent=s.proxyIpMode;
  const u=document.getElementById('updView');
  if(d.body.updateInfo&&d.body.updateInfo.updateAvailable){u.textContent='آپدیت موجود: v'+d.body.updateInfo.latest;u.style.color='var(--gold)'}
  else{u.textContent='شما در آخرین نسخه هستید';u.style.color='var(--ok)'}
}
async function loadSub(){
  const r=await fetch(SUB_BASE+'?app='+currentApp);
  let t=await r.text();
  if(currentApp==='links'){try{t=atob(t)}catch(e){}}
  document.getElementById('subbox').textContent=t;
}
function setTab(btn,_,app){document.querySelectorAll('.tabs button').forEach(b=>b.classList.remove('on'));btn.classList.add('on');currentApp=app;loadSub()}
function copySub(btn){
  const t=document.getElementById('subbox').textContent;
  navigator.clipboard.writeText(t).then(()=>{btn.textContent='✅ کپی شد';setTimeout(()=>btn.textContent='📋 کپی',1200)});
}
async function saveSettings(btn){
  const msg=document.getElementById('smsg');
  const list=document.getElementById('proxyList').value.split('\\n').map(s=>s.trim()).filter(Boolean);
  const body={
    vlUUID:val('vlUUID'),trPass:val('trPass'),proxyIpMode:val('proxyIpMode'),
    proxyIPs:val('proxyIpMode')==='proxyip'?list:[],
    prefixes:val('proxyIpMode')==='prefix'?list:[],
    fallback:val('fallback'),dohUrl:val('dohUrl')
  };
  msg.className='msg';msg.textContent='در حال ذخیره…';msg.classList.add('show');
  const r=await fetch(location.pathname+'/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  msg.className='msg show '+(d.success?'ok':'err');msg.textContent=d.message;
  if(d.success)loadSub();
}
async function doUpdate(btn){
  const msg=document.getElementById('umsg');
  msg.className='msg';msg.textContent='در حال بررسی…';msg.classList.add('show');
  try{
    const r=await fetch(location.pathname+'/update-panel',{method:'POST'});
    const d=await r.json();
    msg.className='msg show '+(d.success?'ok':'err');msg.textContent=d.message;
    if(d.success&&d.body&&d.body.updated)setTimeout(()=>location.reload(),1500);
  }catch(e){msg.className='msg show err';msg.textContent='ارتباط با سرور برقرار نشد.'}
}
function val(id){return document.getElementById(id).value.trim()}
loadSettings();loadSub();
</script>`).replaceAll('${PV}', PANEL_VERSION).replaceAll('${PANEL_VERSION}', PANEL_VERSION), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}


/* ============================================================
 * Auth
 * ============================================================ */

async function getKVSecretKey(env) {
    let secretKey = await env.KV.get('secretKey');
    if (!secretKey) {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        secretKey = Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
        await env.KV.put('secretKey', secretKey);
    }
    return secretKey;
}

async function isAuthed(request, env) {
    try {
        const cookie = request.headers.get('Cookie') || '';
        const match = cookie.match(/jwtToken=([^;]+)/);
        if (!match) return false;
        const secretKey = await getKVSecretKey(env);
        const payload = await verifyJWT(match[1], secretKey);
        return !!payload;
    } catch {
        return false;
    }
}

/* ============================================================
 * Setup wizard (first activation)
 * ============================================================ */

async function handleSetupApply(request, env) {
    if (request.method !== 'POST') {
        return respond(false, 405, 'Method not allowed.');
    }
    if (!(env && env.KV)) {
        return respond(false, 500, 'KV storage is not bound. Bind a KV namespace (variable name KV) to this worker first.');
    }
    if (await readState(env)) {
        return respond(false, 403, 'Panel is already set up. Please log in instead.');
    }

    try {
        const data = await request.json();
        const accEmail = String(data.accEmail || '').trim().toLowerCase();
        const apiToken = String(data.apiToken || '').trim();
        const panelPass = String(data.panelPass || '').trim();
        const vlUUID = String(data.vlUUID || '').trim().toLowerCase();
        const trPass = String(data.trPass || '').trim();
        const securePath = String(data.securePath || '').trim().replace(/^\/+|\/+$/g, '');

        if (!accEmail || !accEmail.includes('@')) return respond(false, 400, 'Please enter a valid Cloudflare email.');
        if (!apiToken || apiToken.length < 20) return respond(false, 400, 'Please enter a valid Cloudflare API token.');
        if (!panelPass || panelPass.length < 6) return respond(false, 400, 'Panel password must be at least 6 characters.');
        if (!isValidUUID(vlUUID)) return respond(false, 400, 'Please enter a valid VLESS UUID (use the random button).');
        if (!trPass) return respond(false, 400, 'Trojan password is required.');
        if (!securePath || !/^[a-zA-Z0-9_-]+$/.test(securePath)) {
            return respond(false, 400, 'Secure path must contain only letters, numbers, - and _.');
        }

        // validate the token against the Cloudflare API before storing anything
        const accID = await resolveAccountId(apiToken);

        const state = {
            accID,
            accEmail,
            apiToken,
            vlUUID,
            trPass,
            securePath,
            proxyIpMode: 'proxyip',
            proxyIPs: [],
            prefixes: [],
            fallback: '',
            dohUrl: 'https://cloudflare-dns.com/dns-query',
            createdAt: new Date().toISOString(),
        };
        await saveState(env, state);
        await env.KV.put('pwd', panelPass);

        // BPB-VPN pattern: push tunnel settings into the ENV secret so the
        // websocket path becomes fully synchronous. Best-effort — KV stays
        // the source of truth and still serves tunnels if this fails.
        let envSynced = false;
        try {
            await syncTunnelEnv(state, request);
            envSynced = true;
        } catch (error) {
            console.log('ENV sync during setup failed (KV stays authoritative):', safeError(error));
        }

        return respond(true, 200, 'Panel activated successfully!', { securePath, envSynced });
    } catch (error) {
        return respond(false, 400, safeError(error) || 'Setup failed.');
    }
}

/* ============================================================
 * Login / logout
 * ============================================================ */

async function handleLoginAuth(request, env, state) {
    if (request.method !== 'POST') return respond(false, 405, 'Method not allowed.');

    try {
        const data = await request.json();
        const savedPass = await env.KV.get('pwd');
        const username = String(data.username || '').toLowerCase();
        if (username !== state.accEmail || data.password !== savedPass) {
            return respond(false, 401, 'Wrong credentials.');
        }

        const secretKey = await getKVSecretKey(env);
        const jwtToken = await signJWT({ id: state.accID }, secretKey, 24 * 60 * 60);
        return respond(true, 200, 'Successfully generated Auth token.', null, {
            'Set-Cookie': `jwtToken=${jwtToken}; Path=/; HttpOnly; Secure; Max-Age=86400; SameSite=Strict`,
        });
    } catch (error) {
        return respond(false, 500, 'Login failed, please try again.');
    }
}

/* ============================================================
 * Settings (GET/PUT) — re-syncs the ENV secret after every change
 * ============================================================ */

async function handleSettings(request, env, state) {
    if (request.method === 'GET') {
        const updateInfo = await checkUpdateInfo();
        return respond(true, 200, null, {
            proxySettings: {
                vlUUID: state.vlUUID,
                trPass: state.trPass,
                proxyIpMode: state.proxyIpMode,
                proxyIPs: state.proxyIPs,
                prefixes: state.prefixes,
                fallback: state.fallback,
                dohUrl: state.dohUrl,
            },
            securePath: state.securePath,
            panelVersion: PANEL_VERSION,
            updateInfo,
        });
    }

    if (request.method !== 'PUT') return respond(false, 405, 'Method not allowed.');

    try {
        const data = await request.json();
        const cleanList = (arr) =>
            (Array.isArray(arr) ? arr : [arr]).flatMap((s) => String(s || '').split(/[\n,]+/))
                .map((s) => s.trim()).filter(Boolean);

        const nextUUID = String(data.vlUUID || state.vlUUID).trim().toLowerCase();
        if (!isValidUUID(nextUUID)) return respond(false, 400, 'Invalid VLESS UUID.');
        const nextTrPass = String(data.trPass || state.trPass).trim();
        if (!nextTrPass) return respond(false, 400, 'Trojan password cannot be empty.');
        const nextMode = String(data.proxyIpMode || 'proxyip');
        if (!['proxyip', 'prefix'].includes(nextMode)) return respond(false, 400, 'Invalid proxy IP mode.');

        const nextState = {
            ...state,
            vlUUID: nextUUID,
            trPass: nextTrPass,
            proxyIpMode: nextMode,
            proxyIPs: cleanList(data.proxyIPs),
            prefixes: cleanList(data.prefixes),
            fallback: String(data.fallback || '').trim(),
            dohUrl: String(data.dohUrl || 'https://cloudflare-dns.com/dns-query').trim(),
        };

        await saveState(env, nextState);

        let envSynced = true;
        try {
            await syncTunnelEnv(nextState, request);
        } catch (error) {
            envSynced = false;
            console.log('ENV sync after settings update failed (KV stays authoritative):', safeError(error));
        }

        return respond(true, 200, 'Settings updated successfully.', { envSynced });
    } catch (error) {
        return respond(false, 500, `An error occurred while updating settings: ${safeError(error)}`);
    }
}

/* ============================================================
 * Entry point — ONE outer try/catch; nothing escapes to the runtime.
 * ============================================================ */

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="9" y="9" width="14" height="14" transform="rotate(45 16 16)" fill="#f5c518"/></svg>`;

export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            const path = decodeURIComponent(url.pathname || '/').replace(/\/+$/, '') || '/';
            const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();

            // ---------- tunnel: sync settings from ENV, KV only as fallback ----------
            if (upgrade === 'websocket') {
                let settings = readTunnelSettings(env);
                if (!settings) {
                    const state = await readState(env);
                    settings = stateToTunnelSettings(state);
                }
                if (!settings) return new Response('Not Found', { status: 404 });
                return handleWebsocket(request, settings);
            }

            // ---------- zero-KV static ----------
            if (path === '/favicon.ico') {
                return new Response(FAVICON_SVG, {
                    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
                });
            }

            // ---------- setup wizard ----------
            if (path === '/setup' || path === '/setup/') {
                if (await readState(env)) {
                    return Response.redirect(new URL('/', request.url), 302);
                }
                return renderSetupPage();
            }
            if (path === '/setup/apply') return handleSetupApply(request, env);

            // ---------- KV required for everything below ----------
            if (!(env && env.KV)) return renderKVGuide();

            const state = await readState(env);
            if (!state) {
                if (path === '/' || path === '') {
                    return Response.redirect(new URL('/setup', request.url), 302);
                }
                return Response.redirect(new URL('/setup', request.url), 302);
            }

            const { securePath } = state;
            const route = path.split('/').slice(0, 3).join('/');
            const method = request.method;

            if (path === '/' || path === '') {
                return Response.redirect(new URL(`/${securePath}/panel`, request.url), 302);
            }

            switch (route) {
                case `/${securePath}/login`:
                    if (method === 'POST') return handleLoginAuth(request, env, state);
                    if (await isAuthed(request, env)) {
                        return Response.redirect(new URL(`/${securePath}/panel`, request.url), 302);
                    }
                    return renderLoginPage();

                case `/${securePath}/logout`:
                    return new Response(null, {
                        status: 302,
                        headers: {
                            'Set-Cookie': 'jwtToken=; Path=/; HttpOnly; Secure; Max-Age=0; SameSite=Strict',
                            Location: new URL(`/${securePath}/login`, request.url).toString(),
                        },
                    });

                case `/${securePath}/panel`:
                    if (!(await isAuthed(request, env))) {
                        return Response.redirect(new URL(`/${securePath}/login`, request.url), 302);
                    }
                    if (path === `/${securePath}/panel/settings`) return handleSettings(request, env, state);
                    if (path === `/${securePath}/panel/update-panel`) {
                        if (method !== 'POST') return respond(false, 405, 'Method not allowed.');
                        const result = await applySelfUpdate(state, request);
                        return respond(true, 200, result.updated
                            ? `Panel updated successfully from v${result.previous} to v${result.version}.`
                            : `You are already on the latest version (v${result.version}).`, result);
                    }
                    return renderPanelPage(state);

                case `/${securePath}/sub`:
                    if (path === `/${securePath}/sub`) return handleSubscription(request, state);
                    return new Response('Not Found', { status: 404 });

                default:
                    return bpFallback(request, state);
            }
        } catch (error) {
            console.log('fetch handler error:', safeError(error));
            // last line of defense — an exception here is a 500, never a 1101
            return new Response('Internal error', { status: 500 });
        }
    },
};

/** BPB-VPN style fallback: proxy unknown paths to the configured origin. */
async function bpFallback(request, state) {
    if (state && state.fallback) {
        try {
            const raw = String(state.fallback).trim();
            const target = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
            const url = new URL(request.url);
            url.protocol = 'https:';
            url.hostname = target.hostname;
            url.port = target.port;
            return fetch(new Request(url, request));
        } catch { /* fall through */ }
    }
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}
