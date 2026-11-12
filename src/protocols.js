/**
 * ARAL SULFUR — Hardened Multi-Protocol Relay Engine (VLESS + Trojan + Shadowsocks + DoH + ProxyIP/NAT64/Chain/Locations).
 *
 * Every socket (`opened`/`closed`), WebSocket (`send`/`close`), ReadableStream controller,
 * writer lock, timeout timer, and background promise is explicitly guarded against
 * unhandled rejections and race conditions.
 *
 * ULTRA V4 additions:
 *   - Shadowsocks AEAD data-plane (per-user ss protocol, v2ray-plugin WebSocket framing)
 *   - Multi-location exit proxies (`/loc-N` path contract, per-user proxyList + auto-replace)
 *   - Request (connection) quota + concurrent client-IP limit enforcement
 *   - Per-user adult/ads blocking via passive SNI sniff + family-DoH verdicts (fail-open)
 */

import { DEFAULT_NAT64_PREFIXES, DEFAULT_PROXY_IPS, PANEL_VERSION, evaluateUserStatus, liveActiveIps, liveIpCount, loadRuntimeState, recordTraffic, registerLiveConn, saveRuntimeState, unregisterLiveConn } from './storage.js';
import { DEC, ENC, safeDecodeURIComponent, utf8ToBase64 } from './crypto.js';
import { createSSEncryptor, deriveSubkey, getSSKey, isDomainBlocked, parseSSAddress, sniffTargetDomain, SS_CONST } from './sslib.js';
import { pickProxyReplacements } from './pools.js';

const WS_OPEN = 1;
const WS_CLOSING = 2;

let cachedConnectFn = null;
async function getSocketConnect() {
  if (cachedConnectFn) return cachedConnectFn;
  try {
    const spec = ['cloudflare', 'sockets'].join(':');
    const mod = await import(spec);
    if (!mod || typeof mod.connect !== 'function') {
      throw new Error('socket connect unavailable');
    }
    cachedConnectFn = mod.connect;
    return cachedConnectFn;
  } catch (err) {
    throw new Error(
      `ماژول شبکه فعال نیست (Compatibility Date را در Settings روی 2024-09-23 یا جدیدتر بگذارید): ${err?.message || err}`
    );
  }
}

function isValidSocketHost(host) {
  if (!host || host.length > 255) return false;
  if (host.startsWith('[') && host.endsWith(']')) {
    return /^\[[0-9a-fA-F:.]+\]$/.test(host);
  }
  return /^[a-zA-Z0-9._-]+$/.test(host);
}

/**
 * Safely open a Cloudflare TCP socket via lazy `cloudflare:sockets` import and
 * disarm asynchronous `.opened`/`.closed` unhandled promise rejections.
 */
async function safeConnect(hostname, port) {
  const cleanHost = String(hostname || '').trim();
  const cleanPort = Number(port);
  if (!isValidSocketHost(cleanHost) || !Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) {
    throw new Error(`Invalid target endpoint: ${cleanHost}:${port}`);
  }
  const connectFn = await getSocketConnect();
  const sock = connectFn({ hostname: cleanHost, port: cleanPort });
  if (sock && sock.opened && typeof sock.opened.catch === 'function') {
    sock.opened.catch(() => {});
  }
  if (sock && sock.closed && typeof sock.closed.catch === 'function') {
    sock.closed.catch(() => {});
  }
  return sock;
}

function safeCloseSocket(sock) {
  if (!sock) return;
  try {
    const p = sock.close();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  } catch {
    /* ignore already-closed socket */
  }
}

function safeCloseWS(ws) {
  if (!ws) return;
  try {
    if (ws.readyState === WS_OPEN || ws.readyState === WS_CLOSING) {
      ws.close(1000, 'closed');
    }
  } catch {
    /* ignore */
  }
}

function safeSendWS(ws, payload) {
  if (!ws || ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(payload);
    return true;
  } catch {
    safeCloseWS(ws);
    return false;
  }
}

async function safeWriteSocket(sock, bytes) {
  if (!sock || !sock.writable || !bytes || bytes.byteLength === 0) return;
  let writer = null;
  try {
    if (sock.opened) await sock.opened;
    writer = sock.writable.getWriter();
    if (writer.closed && typeof writer.closed.catch === 'function') writer.closed.catch(() => {});
    if (writer.ready && typeof writer.ready.catch === 'function') writer.ready.catch(() => {});
    await writer.write(bytes);
  } finally {
    if (writer) {
      try {
        writer.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}

async function fetchWithTimeout(input, init = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => {
    try { ctrl.abort(); } catch {}
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

/* ─────────── ULTRA: server-side Family Filter enforcement (tunnel-level backstop) ───────────
 * When the panel-level or per-user "Block Adult Content" toggle is on, the worker itself
 * resolves every target through Cloudflare's Family DoH resolver and drops/rewrites
 * prohibited targets — even for clients that ignore subscription routing rules.
 * Fully opt-in (default OFF ⇒ zero extra lookups and zero behavior change). */

const FAMILY_GATE_DOH = 'https://family.cloudflare-dns.com/dns-query';
const BYPASS_RESOLVER_IPS = new Set([
  '8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '149.112.112.112',
  '208.67.222.222', '208.67.220.220', '94.140.14.14', '94.140.15.15',
  '2001:4860:4860::8888', '2001:4860:4860::8844',
  '2606:4700:4700::1111', '2606:4700:4700::1001',
]);
const GATE_BLOCKED_ANSWERS = new Set(['0.0.0.0', '::', '94.140.14.14', '94.140.15.15']);
const GATE_SEARCH_RX = /(google\.|bing\.com|yandex\.|yahoo\.|duckduckgo\.com)/i;
const GATE_TTL_MS = 30 * 60_000;
const GATE_CACHE_MAX = 2048;
const gateCache = new Map(); // "doh|domain" -> { expires, answers }

/* Registered so storage.clearRuntimeMemoryCaches() ("restart core") can drop every
 * protocol-level cache (family gate DoH verdicts + heartbeat snapshot). */
try {
  globalThis.__aralUltraGateClear = () => {
    try { gateCache.clear(); } catch {}
    try {
      heartbeatState.state = null;
      heartbeatState.at = 0;
    } catch {}
  };
} catch {}

function gateConcat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Minimal DNS wire-format A-record query over DoH with a 30-minute cache. Returns [{type, data}] or []. */
async function gateDohQuery(domain, targetDoh) {
  const clean = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!clean || clean.length > 253) return [];
  const key = `${clean}`;
  const hit = gateCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.answers;
  if (hit) gateCache.delete(key);
  try {
    const parts = [];
    for (const label of clean.split('.')) {
      const enc = ENC.encode(label);
      if (!enc.length || enc.length > 63) return [];
      parts.push(new Uint8Array([enc.length]), enc);
    }
    parts.push(new Uint8Array([0]));
    const qname = gateConcat(...parts);
    const query = new Uint8Array(12 + qname.length + 4);
    const qv = new DataView(query.buffer);
    qv.setUint16(0, crypto.getRandomValues(new Uint16Array(1))[0]);
    qv.setUint16(2, 0x0100); // RD
    qv.setUint16(4, 1);      // 1 question
    query.set(qname, 12);
    qv.setUint16(12 + qname.length, 1); // QTYPE=A
    qv.setUint16(14 + qname.length, 1); // QCLASS=IN
    const res = await fetchWithTimeout(targetDoh, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
      body: query,
    }, 5000);
    if (!res.ok) return [];
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 20) return [];
    const qd = (buf[4] << 8) | buf[5];
    const an = (buf[6] << 8) | buf[7];
    if (!qd) return [];
    let pos = 12;
    for (let i = 0; i < qd && pos < buf.byteLength; i++) { // skip questions
      while (pos < buf.byteLength && buf[pos] !== 0) pos += buf[pos] + 1;
      pos += 5;
    }
    const answers = [];
    for (let i = 0; i < an && pos + 12 <= buf.byteLength; i++) {
      while (pos < buf.byteLength && buf[pos] !== 0) { // name (never compressed in answers we parse)
        if ((buf[pos] & 0xc0) === 0xc0) { pos += 2; break; }
        pos += buf[pos] + 1;
      }
      if ((buf[pos] & 0xc0) === 0xc0) pos += 2; else pos += 1;
      const type = (buf[pos] << 8) | buf[pos + 1];
      const rdlen = (buf[pos + 8] << 8) | buf[pos + 9];
      pos += 10;
      if (pos + rdlen > buf.byteLength) break;
      if (type === 1 && rdlen === 4) {
        answers.push({ type: 1, data: `${buf[pos]}.${buf[pos + 1]}.${buf[pos + 2]}.${buf[pos + 3]}` });
      } else if (type === 28 && rdlen === 16) {
        const seg = [];
        for (let j = 0; j < 16; j += 2) seg.push(buf[pos + j].toString(16) + buf[pos + j + 1].toString(16).padStart(2, '0'));
        answers.push({ type: 28, data: seg.join(':') });
      }
      pos += rdlen;
    }
    if (gateCache.size >= GATE_CACHE_MAX) {
      const oldest = gateCache.keys().next().value;
      if (oldest) gateCache.delete(oldest);
    }
    gateCache.set(key, { expires: Date.now() + GATE_TTL_MS, answers });
    return answers;
  } catch {
    return [];
  }
}

/** Extract SNI domain from a TLS ClientHello record, or null. */
export function sniffSniDomain(bytes) {
  try {
    if (!bytes || bytes.byteLength < 60) return null;
    if (bytes[0] !== 0x16 || bytes[5] !== 0x01) return null;
    let pos = 43;
    if (pos >= bytes.byteLength) return null;
    const sessionIdLen = bytes[pos];
    pos += 1 + sessionIdLen;
    if (pos + 2 > bytes.byteLength) return null;
    const cipherSuitesLen = (bytes[pos] << 8) | bytes[pos + 1];
    pos += 2 + cipherSuitesLen;
    if (pos + 1 > bytes.byteLength) return null;
    const compMethodsLen = bytes[pos];
    pos += 1 + compMethodsLen;
    if (pos + 2 > bytes.byteLength) return null;
    const extensionsLen = (bytes[pos] << 8) | bytes[pos + 1];
    pos += 2;
    const endPos = Math.min(pos + extensionsLen, bytes.byteLength);
    while (pos + 4 <= endPos) {
      const extType = (bytes[pos] << 8) | bytes[pos + 1];
      const extLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += 4;
      if (extType === 0x0000) {
        if (pos + 2 > bytes.byteLength) return null;
        if (bytes[pos] === 0x00) {
          const sniLen = (bytes[pos + 1] << 8) | bytes[pos + 2];
          return DEC.decode(bytes.subarray(pos + 3, pos + 3 + sniLen)).toLowerCase();
        }
      }
      pos += extLen;
    }
    return null;
  } catch {
    return null;
  }
}

function familyGateActive(user, settings) {
  return Boolean((user && user.blockAdult) || (settings && settings.blockAdult));
}

/** Per-user family gate. Returns {blocked:true} or {blocked:false, rewriteIp}. */
async function checkContentGate(user, settings, domain, port) {
  if (!domain || port === 53) return { blocked: false, rewriteIp: '' };
  const answers = await gateDohQuery(domain, FAMILY_GATE_DOH);
  if (!answers.length) return { blocked: false, rewriteIp: '' }; // fail-open: never break browsing
  const blocked = answers.some((r) => GATE_BLOCKED_ANSWERS.has(r.data));
  if (blocked) return { blocked: true, rewriteIp: '' };
  let rewriteIp = '';
  if (answers.length && GATE_SEARCH_RX.test(domain)) {
    const rec = answers.find((r) => r.type === 1 || r.type === 28);
    if (rec && !GATE_BLOCKED_ANSWERS.has(rec.data)) rewriteIp = rec.data;
  }
  return { blocked: false, rewriteIp };
}

/** Tunnel-level family filter (porn). Closes prohibited targets, pins search engines to the safe answer. */
async function applyContentGate(user, settings, address, port, firstPayload) {
  const bareAddr = String(address || '').replace(/^\[|\]$/g, '');
  if (!familyGateActive(user, settings)) return { close: false, address };
  if (BYPASS_RESOLVER_IPS.has(bareAddr)) return { close: true, address };
  const isIpAddr = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bareAddr) || bareAddr.includes(':');
  let domain = isIpAddr ? '' : bareAddr;
  if (!domain && port === 443 && firstPayload && firstPayload.byteLength > 43) {
    domain = sniffSniDomain(firstPayload) || '';
  }
  if (!domain) return { close: false, address };
  try {
    const verdict = await checkContentGate(user, settings, domain, port);
    if (verdict.blocked) return { close: true, address };
    if (verdict.rewriteIp) return { close: false, address: verdict.rewriteIp };
  } catch { /* fail-open */ }
  return { close: false, address };
}

/* ─────────── end ULTRA family gate ─────────── */

export function parseEndpoint(raw, fallbackPort = 443) {
  const clean = String(raw || '').split('#')[0].trim();
  if (!clean) return null;

  const v6Match = clean.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6Match) {
    const p = v6Match[2] ? Number(v6Match[2]) : fallbackPort;
    if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
    const host = `[${v6Match[1]}]`;
    if (!isValidSocketHost(host)) return null;
    return {
      host,
      port: p,
      explicitPort: Boolean(v6Match[2]),
    };
  }

  const colonCount = (clean.match(/:/g) || []).length;
  if (colonCount > 1) {
    const host = `[${clean}]`;
    if (!isValidSocketHost(host)) return null;
    return { host, port: fallbackPort, explicitPort: false };
  }

  const idx = clean.lastIndexOf(':');
  if (idx > 0) {
    const portNum = Number(clean.slice(idx + 1));
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return null;
    }
    const host = clean.slice(0, idx);
    if (!isValidSocketHost(host)) return null;
    return { host, port: portNum, explicitPort: true };
  }

  if (!isValidSocketHost(clean)) return null;
  return { host: clean, port: fallbackPort, explicitPort: false };
}

function extractPathProxyOverride(url) {
  try {
    const qProxy = url.searchParams.get('proxyip');
    if (qProxy) return qProxy.trim();
    const m = url.pathname.match(/\/proxyip=([^/]+)/i);
    if (m) return safeDecodeURIComponent(m[1], '').trim();
  } catch {
    /* ignore malformed query/path */
  }
  return '';
}

/* ULTRA: /loc-N multi-location path contract (appended to the clean WS path) */
function extractLocationIndex(url) {
  try {
    const qLoc = url.searchParams.get('loc');
    if (qLoc !== null && /^\d+$/.test(qLoc)) return Number(qLoc);
    const m = url.pathname.match(/\/loc-(\d+)$/);
    if (m) return Number(m[1]);
  } catch {}
  return -1;
}

/* ULTRA: normalize a client IP to a fairness prefix (IPv4 → /24, IPv6 → /64) */
export function normalizeIpPrefix(rawIp) {
  const ip = String(rawIp || '').trim();
  if (!ip) return '';
  if (ip.includes(':')) {
    const clean = ip.replace(/^\[|\]$/g, '').split('%')[0];
    const groups = clean.split(':').filter(Boolean);
    return `${groups.slice(0, 4).join(':')}::/64`;
  }
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return ip.slice(0, 45);
}

function extractRequestIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    ''
  );
}

/**
 * ULTRA admission control: request-quota and concurrent-IP checks.
 * Returns null when admitted, or a Persian rejection reason.
 */
export function checkAdmission(user, st, ipPrefix) {
  if ((user.requestLimit || 0) > 0 && (st.usedRequests || 0) >= user.requestLimit) {
    return 'سهمیهٔ تعداد اتصال این اشتراک به پایان رسیده است';
  }
  const limit = user.ipLimit || 0;
  if (limit > 0) {
    const known = new Set(Object.keys(user.activeIps || {}));
    const live = liveActiveIps.get(user.id);
    if (live) for (const k of live.keys()) known.add(k);
    if (!known.has(ipPrefix) && known.size >= limit) {
      return 'حداکثر تعداد دستگاه‌های همزمان این اشتراک اشغال است';
    }
  }
  return null;
}

export async function handleTunnelWS(request, env, ctx, runtime) {
  const settings = runtime?.settings || {};
  const users = Array.isArray(runtime?.users) ? runtime.users : [];

  if (settings.killSwitch) {
    return new Response('ARAL SULFUR: Kill Switch active — tunnel paused.', { status: 503 });
  }

  const now = Date.now();
  const vlessMap = new Map();
  const trojanMap = new Map();
  const ssPool = [];

  for (const u of users) {
    if (!u) continue;
    const st = evaluateUserStatus(u, now);
    if (!st.ok) continue;
    const protoSet = userProtocolSetOf(u, settings);
    if (protoSet.has('vless') && u.uuid) {
      vlessMap.set(String(u.uuid).toLowerCase(), u);
    }
    if (protoSet.has('trojan') && u.trojanHash) {
      trojanMap.set(String(u.trojanHash).toLowerCase(), u);
    }
    if (protoSet.has('ss') && u.uuid) {
      ssPool.push({ user: u, key: getSSKey(u.uuid) });
    }
  }

  let url = null;
  let pathProxy = '';
  let locIdx = -1;
  try {
    url = new URL(request.url);
    pathProxy = extractPathProxyOverride(url);
    locIdx = extractLocationIndex(url);
  } catch {
    pathProxy = '';
    locIdx = -1;
  }
  const selfHost = url ? url.host.toLowerCase() : '';
  const ipPrefix = normalizeIpPrefix(extractRequestIp(request));

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readable = makeReadableWS(server, earlyDataHeader);

  const MAX_REPLAY_BYTES = 65536;
  const remote = {
    socket: null,
    activeSocket: null,
    confirmed: false,
    canFallback: true,
    dead: false,
    replayChunks: [],
    replayBytes: 0,
    transformIn: null,
    transformOut: null,
  };
  let headerProcessed = false;
  let ssBuf = null; // ULTRA: buffered bytes while identifying a Shadowsocks stream
  let udpWrite = null;
  let matchedUser = null;
  let admitted = false;
  let upBytes = 0;
  let downBytes = 0;
  let accounted = false;

  const finalizeAccounting = () => {
    if (accounted) return;
    accounted = true;
    if (matchedUser) {
      unregisterLiveConn(matchedUser.id);
      recordTraffic(env, ctx, matchedUser, upBytes, downBytes, { countRequest: admitted });
    }
  };

  /** ULTRA: admit a matched user (quotas + IP limit); closes WS with reason on rejection. */
  const admitUser = (user) => {
    matchedUser = user;
    const st = evaluateUserStatus(user, Date.now());
    const reject = checkAdmission(user, st, ipPrefix);
    if (reject) {
      try { server.close(1008, reject); } catch { safeCloseWS(server); }
      accounted = true;
      return false;
    }
    registerLiveConn(user.id, ipPrefix);
    admitted = true;
    return true;
  };

  readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          let bytes = await toBytes(chunk);
          if (!bytes || bytes.byteLength === 0) {
            if (!headerProcessed) throw new Error('empty initial frame');
            return;
          }
          upBytes += bytes.byteLength;

          if (udpWrite) {
            await udpWrite(bytes);
            return;
          }

          if (headerProcessed) {
            if (remote.dead) {
              throw new Error('Outbound TCP socket unavailable');
            }
            if (remote.transformIn) {
              const plain = await remote.transformIn(bytes);
              bytes = plain && plain.byteLength > 0 ? plain : null;
            }
            if (!bytes) return;
            if (!remote.confirmed) {
              if (remote.replayBytes + bytes.byteLength <= MAX_REPLAY_BYTES) {
                remote.replayChunks.push(bytes.slice());
                remote.replayBytes += bytes.byteLength;
              } else {
                remote.confirmed = true;
                remote.replayChunks.length = 0;
                remote.replayBytes = 0;
              }
            }
            if (!remote.activeSocket) {
              // Currently dialing or switching to ProxyIP/NAT64 fallback; buffered in replayChunks
              return;
            }
            try {
              await safeWriteSocket(remote.activeSocket, bytes);
            } catch (writeErr) {
              if (remote.confirmed || !remote.canFallback) {
                throw writeErr;
              }
            }
            return;
          }

          headerProcessed = true;
          const parsed = parseTunnelHeader(bytes, vlessMap, trojanMap);

          if (parsed.hasError) {
            // ULTRA: not VLESS/Trojan — attempt Shadowsocks AEAD identification (buffered)
            const ssResult = await identifySSStream(bytes, ssPool, () => ssBuf, (b) => { ssBuf = b; });
            if (ssResult === 'need-more') {
              headerProcessed = false;
              return;
            }
            if (!ssResult || ssResult.hasError) {
              throw new Error(parsed.message);
            }

            if (!admitUser(ssResult.user)) return;

            const { addressRemote: ssAddr, portRemote: ssPort } = ssResult;
            if (isSelfTarget(ssAddr, selfHost)) {
              throw new Error('loop target rejected');
            }
            const ssGate = await applyContentGate(ssResult.user, settings, ssAddr, ssPort, ssResult.firstPayload);
            if (ssGate.close) {
              finalizeAccounting();
              safeCloseWS(server);
              return;
            }
            remote.transformIn = ssResult.push;
            remote.transformOut = createSSEncryptor(ssResult.subkey);
            if (ssResult.firstPayload && ssResult.firstPayload.byteLength > 0) {
              remote.replayChunks.push(ssResult.firstPayload.slice());
              remote.replayBytes += ssResult.firstPayload.byteLength;
            }
            startTcpSession({
              remote,
              addressRemote: ssGate.address,
              portRemote: ssPort,
              ws: server,
              responseHeader: null,
              settings,
              pathProxy,
              locIdx,
              user: ssResult.user,
              env,
              selfHost,
              onDownBytes: (n) => { downBytes += n; },
              onClose: finalizeAccounting,
            }).catch(() => {
              remote.dead = true;
              remote.activeSocket = null;
              finalizeAccounting();
              safeCloseSocket(remote.socket);
              safeCloseWS(server);
            });
            return;
          }

          if (!admitUser(parsed.user)) return;

          const {
            protocol,
            addressRemote,
            portRemote,
            rawClientData,
            responseHeader,
            isUDP,
          } = parsed;

          if (isUDP) {
            if (protocol === 'vless' && portRemote !== 53) {
              throw new Error('UDP relay is supported for DNS (port 53) only');
            }
            const dnsHandler = createDnsRelay(
              server,
              responseHeader,
              protocol,
              settings.upstreamDoH,
              (n) => { downBytes += n; }
            );
            udpWrite = dnsHandler.write;
            if (rawClientData && rawClientData.byteLength > 0) {
              await udpWrite(rawClientData);
            }
            return;
          }

          if (isSelfTarget(addressRemote, selfHost)) {
            throw new Error('loop target rejected');
          }

          const gate = await applyContentGate(parsed.user, settings, addressRemote, portRemote, rawClientData);
          if (gate.close) {
            finalizeAccounting();
            safeCloseWS(server);
            return;
          }

          if (rawClientData && rawClientData.byteLength > 0) {
            remote.replayChunks.push(rawClientData.slice());
            remote.replayBytes += rawClientData.byteLength;
          }

          startTcpSession({
            remote,
            addressRemote: gate.address,
            portRemote,
            ws: server,
            responseHeader,
            settings,
            pathProxy,
            locIdx,
            user: parsed.user,
            env,
            selfHost,
            onDownBytes: (n) => { downBytes += n; },
            onClose: finalizeAccounting,
          }).catch(() => {
            remote.dead = true;
            remote.activeSocket = null;
            finalizeAccounting();
            safeCloseSocket(remote.socket);
            safeCloseWS(server);
          });
        },
        close() {
          remote.dead = true;
          remote.activeSocket = null;
          finalizeAccounting();
          safeCloseSocket(remote.socket);
        },
        abort() {
          remote.dead = true;
          remote.activeSocket = null;
          finalizeAccounting();
          safeCloseSocket(remote.socket);
        },
      })
    )
    .catch(() => {
      remote.dead = true;
      remote.activeSocket = null;
      finalizeAccounting();
      safeCloseSocket(remote.socket);
      safeCloseWS(server);
    });

  return new Response(null, { status: 101, webSocket: client });
}

function isSelfTarget(address, selfHost) {
  if (!selfHost || !address) return false;
  const clean = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  return clean === selfHost.split(':')[0] && Boolean(selfHost);
}

function userProtocolSetOf(u, settings) {
  if (u && u.protocols) {
    const set = new Set();
    for (const p of String(u.protocols).split(',')) if (p) set.add(p);
    return set;
  }
  const set = new Set();
  if (!settings || settings.enableVless !== false) set.add('vless');
  if (settings && settings.enableTrojan) set.add('trojan');
  if (settings && settings.enableSS) set.add('ss');
  return set;
}

/* --------------------------------------------- Shadowsocks identification */

const SS_MIN_BYTES = SS_CONST.SALT_LEN + 2 + SS_CONST.TAG_LEN;

/**
 * Buffered Shadowsocks stream identification.
 * Returns 'need-more' while the stream is too short, null when definitively not ss,
 * or an ss session descriptor { user, subkey, addressRemote, portRemote, firstPayload, push }.
 */
async function identifySSStream(bytes, ssPool, getBuf, setBuf) {
  if (!ssPool.length) return null;
  let buf = getBuf() || new Uint8Array(0);
  const merged = new Uint8Array(buf.byteLength + bytes.byteLength);
  merged.set(buf, 0);
  merged.set(bytes, buf.byteLength);
  buf = merged;
  setBuf(buf);

  if (buf.byteLength < SS_MIN_BYTES) return 'need-more';

  const salt = buf.subarray(0, SS_CONST.SALT_LEN);
  const pos = SS_CONST.SALT_LEN;

  for (const entry of ssPool) {
    let subkey = null;
    try {
      subkey = await deriveSubkey(entry.key, salt);
    } catch {
      continue;
    }
    let lenArr = null;
    try {
      lenArr = await sslibDecrypt(subkey, buf.subarray(pos, pos + 2 + SS_CONST.TAG_LEN), new Uint8Array(12));
    } catch {
      continue;
    }
    if (!lenArr) continue;
    const len = (lenArr[0] << 8) | lenArr[1];
    if (len <= 0 || len > SS_CONST.MAX_PAYLOAD) continue;
    if (buf.byteLength < pos + 2 + SS_CONST.TAG_LEN + len + SS_CONST.TAG_LEN) return 'need-more';

    const nonce = new Uint8Array(12);
    incrementNonce(nonce); // payload chunk uses nonce 1
    let payload = null;
    try {
      payload = await sslibDecrypt(subkey, buf.subarray(pos + 2 + SS_CONST.TAG_LEN, pos + 2 + SS_CONST.TAG_LEN + len + SS_CONST.TAG_LEN), nonce);
    } catch {
      continue;
    }
    const addr = parseSSAddress(payload, 0);
    if (!addr) continue;

    // streaming reader for subsequent client frames (nonce continues from here)
    let readBuf = buf.byteLength > pos + 2 + SS_CONST.TAG_LEN + len + SS_CONST.TAG_LEN
      ? buf.subarray(pos + 2 + SS_CONST.TAG_LEN + len + SS_CONST.TAG_LEN)
      : new Uint8Array(0);

    const push = async (chunkBytes) => {
      const merged2 = new Uint8Array(readBuf.byteLength + chunkBytes.byteLength);
      merged2.set(readBuf, 0);
      merged2.set(chunkBytes, readBuf.byteLength);
      readBuf = merged2;
      const outs = [];
      while (true) {
        if (readBuf.byteLength < 2 + SS_CONST.TAG_LEN) break;
        let lenView = null;
        try {
          lenView = await sslibDecrypt(subkey, readBuf.subarray(0, 2 + SS_CONST.TAG_LEN), nonce.slice());
        } catch {
          throw new Error('ss stream integrity failure');
        }
        const ln = (lenView[0] << 8) | lenView[1];
        if (ln > SS_CONST.MAX_PAYLOAD) throw new Error('ss frame too large');
        if (readBuf.byteLength < 2 + SS_CONST.TAG_LEN + ln + SS_CONST.TAG_LEN) break;
        incrementNonce(nonce);
        const plain = await sslibDecrypt(subkey, readBuf.subarray(0, 2 + SS_CONST.TAG_LEN + ln + SS_CONST.TAG_LEN), nonce.slice());
        incrementNonce(nonce);
        readBuf = readBuf.subarray(2 + SS_CONST.TAG_LEN + ln + SS_CONST.TAG_LEN);
        if (plain.byteLength > 0) outs.push(plain);
        if (readBuf.byteLength === 0) break;
      }
      if (!outs.length) return new Uint8Array(0);
      if (outs.length === 1) return outs[0];
      let total = 0;
      for (const o of outs) total += o.byteLength;
      const all = new Uint8Array(total);
      let off = 0;
      for (const o of outs) { all.set(o, off); off += o.byteLength; }
      return all;
    };

    return {
      user: entry.user,
      subkey,
      addressRemote: addr.host,
      portRemote: addr.port,
      firstPayload: payload.subarray(addr.next),
      push,
    };
  }
  return null;
}

/* Direct AES-GCM helpers bound to a fixed 32-byte subkey (local to ss flow). */
async function importAesKey(subkey) {
  return crypto.subtle.importKey('raw', subkey, 'AES-GCM', false, ['decrypt']);
}
async function sslibDecrypt(subkey, encBytes, nonce) {
  const key = await importAesKey(subkey);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    key,
    encBytes
  );
  return new Uint8Array(plain);
}
function incrementNonce(nonce) {
  for (let i = 0; i < nonce.length; i++) {
    nonce[i] = (nonce[i] + 1) & 0xff;
    if (nonce[i] !== 0) break;
  }
}

/* ----------------------------------------------------- protocol auto-parse */

export function parseTunnelHeader(bytes, vlessMap, trojanMap) {
  try {
    if (!bytes || bytes.byteLength < 24) {
      return { hasError: true, message: 'frame too short' };
    }

    // 1) Trojan: [56 hex chars][0x0d 0x0a][CMD][ATYP][DST.ADDR][DST.PORT][0x0d 0x0a][PAYLOAD]
    if (bytes.byteLength >= 64 && bytes[56] === 0x0d && bytes[57] === 0x0a) {
      let isHex = true;
      for (let i = 0; i < 56; i++) {
        const c = bytes[i];
        if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46))) {
          isHex = false;
          break;
        }
      }
      if (isHex) {
        const hashHex = DEC.decode(bytes.subarray(0, 56)).toLowerCase();
        const user = trojanMap.get(hashHex);
        if (!user) return { hasError: true, message: 'invalid trojan user' };

        const cmd = bytes[58];
        if (cmd !== 1 && cmd !== 3) {
          return { hasError: true, message: 'unsupported trojan command' };
        }
        const isUDP = cmd === 3;
        const atyp = bytes[59];
        let addrIdx = 60;
        let addrLen = 0;
        let addressRemote = '';

        if (atyp === 1) {
          addrLen = 4;
          if (bytes.byteLength < addrIdx + addrLen + 4) return { hasError: true, message: 'truncated trojan ipv4' };
          addressRemote = `${bytes[addrIdx]}.${bytes[addrIdx + 1]}.${bytes[addrIdx + 2]}.${bytes[addrIdx + 3]}`;
        } else if (atyp === 3) {
          if (bytes.byteLength < addrIdx + 1) return { hasError: true, message: 'truncated trojan domain len' };
          addrLen = bytes[addrIdx];
          addrIdx += 1;
          if (bytes.byteLength < addrIdx + addrLen + 4) return { hasError: true, message: 'truncated trojan domain' };
          addressRemote = DEC.decode(bytes.subarray(addrIdx, addrIdx + addrLen));
        } else if (atyp === 4) {
          addrLen = 16;
          if (bytes.byteLength < addrIdx + addrLen + 4) return { hasError: true, message: 'truncated trojan ipv6' };
          addressRemote = `[${formatIPv6(bytes.subarray(addrIdx, addrIdx + 16))}]`;
        } else {
          return { hasError: true, message: 'invalid trojan atyp' };
        }

        const portIdx = addrIdx + addrLen;
        const portRemote = (bytes[portIdx] << 8) | bytes[portIdx + 1];
        if (portRemote < 1 || portRemote > 65535) {
          return { hasError: true, message: 'invalid trojan port' };
        }
        if (bytes[portIdx + 2] !== 0x0d || bytes[portIdx + 3] !== 0x0a) {
          return { hasError: true, message: 'missing trojan crlf' };
        }

        return {
          hasError: false,
          protocol: 'trojan',
          user,
          addressRemote,
          portRemote,
          rawClientData: bytes.subarray(portIdx + 4),
          responseHeader: null,
          isUDP,
        };
      }
    }

    // 2) VLESS: [ver(1)][uuid(16)][optLen(1)][cmd(1)][port(2)][atyp(1)][addr...][payload]
    const version = bytes[0];
    const uuid = stringifyUUID(bytes.subarray(1, 17));
    const user = vlessMap.get(uuid);
    if (!user) {
      return { hasError: true, message: 'invalid vless user' };
    }

    const optLength = bytes[17];
    const cmdIdx = 18 + optLength;
    // Note: in VLESS v0, byte 17 is optLength, followed by [optBytes (optLength)][cmd(1)][port(2)][atyp(1)]!
    if (bytes.byteLength < cmdIdx + 4) {
      return { hasError: true, message: 'truncated vless header' };
    }
    const command = bytes[cmdIdx];
    if (command !== 1 && command !== 2) {
      return { hasError: true, message: 'unsupported vless command' };
    }
    const isUDP = command === 2;

    const portIndex = cmdIdx + 1;
    const portRemote = (bytes[portIndex] << 8) | bytes[portIndex + 1];
    if (portRemote < 1 || portRemote > 65535) {
      return { hasError: true, message: 'invalid vless port' };
    }

    const addressIndex = portIndex + 2;
    const addressType = bytes[addressIndex];
    let addressValueIndex = addressIndex + 1;
    let addressLength = 0;
    let addressRemote = '';

    if (addressType === 1) {
      addressLength = 4;
      if (bytes.byteLength < addressValueIndex + 4) return { hasError: true, message: 'truncated ipv4' };
      addressRemote = `${bytes[addressValueIndex]}.${bytes[addressValueIndex + 1]}.${bytes[addressValueIndex + 2]}.${bytes[addressValueIndex + 3]}`;
    } else if (addressType === 2) {
      if (bytes.byteLength < addressValueIndex + 1) return { hasError: true, message: 'truncated domain len' };
      addressLength = bytes[addressValueIndex];
      addressValueIndex += 1;
      if (bytes.byteLength < addressValueIndex + addressLength) return { hasError: true, message: 'truncated domain' };
      addressRemote = DEC.decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength));
    } else if (addressType === 3) {
      addressLength = 16;
      if (bytes.byteLength < addressValueIndex + 16) return { hasError: true, message: 'truncated ipv6' };
      addressRemote = `[${formatIPv6(bytes.subarray(addressValueIndex, addressValueIndex + 16))}]`;
    } else {
      return { hasError: true, message: 'unsupported vless address type' };
    }

    if (!addressRemote) {
      return { hasError: true, message: 'empty target address' };
    }

    return {
      hasError: false,
      protocol: 'vless',
      user,
      addressRemote,
      portRemote,
      rawClientData: bytes.subarray(addressValueIndex + addressLength),
      responseHeader: new Uint8Array([version, 0]),
      isUDP,
    };
  } catch (err) {
    return { hasError: true, message: err && err.message ? err.message : 'header parse failed' };
  }
}

function formatIPv6(slice16) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(((slice16[i] << 8) | slice16[i + 1]).toString(16));
  }
  return groups.join(':');
}

function stringifyUUID(bytes) {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function concatChunksSlice(chunks, startIdx) {
  let total = 0;
  for (let i = startIdx; i < chunks.length; i++) {
    total += chunks[i].byteLength;
  }
  if (total === 0) return new Uint8Array(0);
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = startIdx; i < chunks.length; i++) {
    out.set(chunks[i], off);
    off += chunks[i].byteLength;
  }
  return out;
}

/* ---------------------------------------------------- outbound TCP dialing */

/* Shared isolate-wide heartbeat state snapshot (refreshed at most every 40s so that
 * N concurrent tunnels still cost only ~1 KV read per refresh window). */
const heartbeatState = { at: 0, state: null, loading: null };
async function loadHeartbeatState(env) {
  const now = Date.now();
  if (heartbeatState.state && now - heartbeatState.at < 40_000) return heartbeatState.state;
  if (heartbeatState.loading) return heartbeatState.loading;
  heartbeatState.loading = (async () => {
    try {
      const fresh = await loadRuntimeState(env);
      if (fresh && Array.isArray(fresh.users)) {
        heartbeatState.state = fresh;
        heartbeatState.at = Date.now();
        return fresh;
      }
    } catch {}
    return heartbeatState.state;
  })();
  try {
    return await heartbeatState.loading;
  } finally {
    heartbeatState.loading = null;
  }
}

async function startTcpSession({
  remote,
  addressRemote,
  portRemote,
  ws,
  responseHeader,
  settings,
  pathProxy,
  locIdx = -1,
  user = null,
  env = null,
  selfHost = '',
  onDownBytes,
  onClose,
}) {
  // ULTRA: per-user multi-location exit proxy (/loc-N contract) — resolved below, after helpers
  const locProxy = resolveLocProxy(user, locIdx);

  // Build deduplicated fallback relay queue: path override -> admin ProxyIPs -> built-in verified relays
  const rawRelays = pathProxy
    ? [pathProxy, ...(Array.isArray(settings.proxyIPs) ? settings.proxyIPs : []), ...DEFAULT_PROXY_IPS]
    : [...(Array.isArray(settings.proxyIPs) ? settings.proxyIPs : []), ...DEFAULT_PROXY_IPS];
  const relayQueue = [];
  const seenRelays = new Set();
  for (const r of rawRelays) {
    const key = String(r || '').trim();
    if (!key || seenRelays.has(key.toLowerCase())) continue;
    seenRelays.add(key.toLowerCase());
    relayQueue.push(key);
    if (relayQueue.length >= 6) break;
  }
  let relayCursor = 0;
  let nat64Tried = false;

  const terminateSession = () => {
    remote.dead = true;
    remote.canFallback = false;
    remote.activeSocket = null;
    remote.replayChunks.length = 0;
    remote.replayBytes = 0;
    onClose();
    safeCloseWS(ws);
  };

  /* ── ULTRA: mid-connection enforcement heartbeat ──
   * Live enforcement: every ~22s the subscriber's live status (quota / expiry / disable /
   * deletion) is re-evaluated and exhausted tunnels are terminated mid-flight instead
   * of riding until natural socket close. State snapshots are shared isolate-wide and
   * refreshed at most every 40s, so the heartbeat costs ~1 extra KV read per isolate
   * per 40 seconds regardless of live connection count. */
  if (user && env) {
    let lastBeat = Date.now();
    const beat = async () => {
      try {
        if (remote.dead || ws.readyState !== WS_OPEN) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          return;
        }
        if (Date.now() - lastBeat < 20_000) return;
        lastBeat = Date.now();
        const fresh = await loadHeartbeatState(env);
        if (!fresh || !Array.isArray(fresh.users)) return;
        const live = fresh.users.find((u) => u && u.id === user.id);
        if (!live) {
          terminateSession(); // subscriber deleted mid-session
          return;
        }
        const st = evaluateUserStatus(live);
        if (!st.ok) {
          terminateSession(); // quota / expiry / pause enforced mid-flight
        }
      } catch {}
    };
    var heartbeatTimer = setInterval(beat, 7_000);
  }

  const attachAndPipe = async (socket, initialPreRead = null, allowRetry = false) => {
    remote.activeSocket = null;
    remote.canFallback = allowRetry;

    try {
      if (socket.opened) await socket.opened;
    } catch {
      safeCloseSocket(socket);
      if (allowRetry && !remote.dead && ws.readyState === WS_OPEN) return fallbackDial();
      terminateSession();
      return;
    }

    remote.socket = socket;
    try {
      let syncedIdx = 0;
      while (syncedIdx < remote.replayChunks.length) {
        const batch = concatChunksSlice(remote.replayChunks, syncedIdx);
        syncedIdx = remote.replayChunks.length;
        if (batch.byteLength > 0) {
          await safeWriteSocket(socket, batch);
        }
      }
      remote.activeSocket = socket;
    } catch {
      remote.activeSocket = null;
      safeCloseSocket(socket);
      if (allowRetry && !remote.dead && ws.readyState === WS_OPEN) return fallbackDial();
      terminateSession();
      return;
    }

    await pipeRemoteToWS({
      remote,
      remoteSocket: socket,
      ws,
      responseHeader,
      initialPreRead,
      onDownBytes,
      onClose: terminateSession,
      retryFn: allowRetry ? fallbackDial : null,
    });
  };

  const fallbackDial = async () => {
    remote.activeSocket = null;
    safeCloseSocket(remote.socket);
    remote.socket = null;

    if (remote.dead || ws.readyState !== WS_OPEN) {
      terminateSession();
      return;
    }

    // 1) Try ProxyIP relays sequentially (essential for Cloudflare-hosted targets like speedtest.net)
    while (relayCursor < relayQueue.length && relayCursor < 3) {
      const pick = relayQueue[relayCursor++];
      const ep = parseEndpoint(pick, portRemote);
      if (!ep) continue;
      const hasMoreFallbacks = relayCursor < Math.min(relayQueue.length, 3) || Boolean(settings.enableNAT64);
      try {
        const sock = await safeConnect(ep.host, ep.explicitPort ? ep.port : portRemote);
        await attachAndPipe(sock, null, hasMoreFallbacks);
        return;
      } catch {
        /* try next relay or NAT64 */
      }
    }

    // 2) Try NAT64 IPv6 synthesis (works on Cloudflare's dual-stack global network)
    if (!nat64Tried && settings.enableNAT64 !== false) {
      nat64Tried = true;
      const prefixes =
        Array.isArray(settings.nat64Prefixes) && settings.nat64Prefixes.length > 0
          ? settings.nat64Prefixes
          : DEFAULT_NAT64_PREFIXES;
      try {
        const natHost = await resolveNat64Target(addressRemote, prefixes, settings.upstreamDoH);
        if (natHost) {
          const sock = await safeConnect(natHost, portRemote);
          await attachAndPipe(sock, null, false);
          return;
        }
      } catch {
        /* ignore */
      }
    }

    terminateSession();
  };

  // ULTRA: per-user content guard (adult/ads via passive SNI sniff + family-DoH verdicts)
  if (user && (user.blockAdult || user.blockAds)) {
    const firstBytes = concatChunksSlice(remote.replayChunks, 0).subarray(0, 8192);
    const sniffed = sniffTargetDomain(firstBytes);
    if (sniffed) {
      let blocked = false;
      if (user.blockAdult && (await isDomainBlocked('adult', sniffed))) blocked = true;
      if (!blocked && user.blockAds && (await isDomainBlocked('ads', sniffed))) blocked = true;
      if (blocked) {
        remote.dead = true;
        remote.canFallback = false;
        onClose();
        safeCloseWS(ws);
        return;
      }
    }
  }

  try {
    if (locProxy) {
      try {
        const chained = await dialChainProxy(locProxy, addressRemote, portRemote);
        await attachAndPipe(chained.socket, chained.leftover, false);
        return;
      } catch (locErr) {
        // ULTRA: automated replacement of a broken exit proxy from the community pool
        if (user && user.autoRotateProxy && env) {
          const country = proxyCountryOf(user, locProxy);
          const exclude = new Set(user.proxyList.map((x) => x.proxy).filter(Boolean));
          let replacedOk = false;
          try {
            const candidates = await pickProxyReplacements(env, country, exclude, 3);
            for (const cand of candidates.slice(0, 2)) {
              try {
                const ch2 = await dialChainProxy(cand.p, addressRemote, portRemote);
                scheduleProxySwap(env, user, locProxy, cand.p, cand.c);
                await attachAndPipe(ch2.socket, ch2.leftover, false);
                replacedOk = true;
                break;
              } catch {}
            }
          } catch {}
          if (replacedOk) return;
        }
        // fall through to the standard chain below (direct + relays + NAT64)
      }
    }

    if (settings.chainProxy) {
      const chained = await dialChainProxy(settings.chainProxy, addressRemote, portRemote);
      await attachAndPipe(chained.socket, chained.leftover, true);
      return;
    }

    const directSocket = await safeConnect(addressRemote, portRemote);
    await attachAndPipe(directSocket, null, true);
  } catch {
    await fallbackDial();
  }
}

function resolveLocProxy(user, locIdx) {
  if (locIdx < 0 || !user || !Array.isArray(user.proxyList)) return '';
  const entry = user.proxyList[locIdx];
  if (!entry) return '';
  return String(entry.proxy || '').trim();
}

function proxyCountryOf(user, locProxy) {
  if (!user || !Array.isArray(user.proxyList)) return '';
  const hit = user.proxyList.find((x) => String(x.proxy || '').trim() === locProxy);
  return hit ? hit.country || '' : '';
}

/** Persist a healthy replacement proxy into the user's location list (background). */
function scheduleProxySwap(env, user, brokenProxy, healthyProxy, country) {
  try {
    if (!env || typeof env.__swapProxyScheduled === 'undefined') env.__swapProxyScheduled = new Set();
    const key = `${user.id}:${brokenProxy}`;
    if (env.__swapProxyScheduled.has(key)) return;
    env.__swapProxyScheduled.add(key);
    const swap = async () => {
      const fresh = await loadRuntimeState(env, true);
      if (!fresh || fresh.mode !== 'kv') return;
      const target = fresh.users.find((u) => u.id === user.id);
      if (!target || !Array.isArray(target.proxyList)) return;
      let changed = false;
      for (const item of target.proxyList) {
        if (String(item.proxy || '').trim() === brokenProxy) {
          item.proxy = healthyProxy;
          if (country) item.country = country;
          changed = true;
        }
      }
      if (changed) await saveRuntimeState(env, fresh);
    };
    swap().catch(() => {});
  } catch {}
}

async function pipeRemoteToWS({
  remote,
  remoteSocket,
  ws,
  responseHeader,
  initialPreRead,
  onDownBytes,
  onClose,
  retryFn,
}) {
  let header = responseHeader;
  let received = false;

  const emitChunk = async (chunkBytes) => {
    if (!chunkBytes || chunkBytes.byteLength === 0) return true;
    if (!received) {
      received = true;
      if (remote) {
        remote.confirmed = true;
        remote.canFallback = false;
        remote.replayChunks.length = 0;
        remote.replayBytes = 0;
      }
    }
    onDownBytes(chunkBytes.byteLength);
    let out = chunkBytes;
    if (remote && remote.transformOut) {
      out = await remote.transformOut(chunkBytes);
      if (!out || out.byteLength === 0) return true;
    }
    if (header) {
      const merged = new Uint8Array(header.byteLength + out.byteLength);
      merged.set(header, 0);
      merged.set(out, header.byteLength);
      header = null;
      return safeSendWS(ws, merged);
    }
    return safeSendWS(ws, out);
  };

  let reader = null;
  try {
    if (initialPreRead && initialPreRead.byteLength > 0) {
      if (!(await emitChunk(initialPreRead))) {
        onClose();
        return;
      }
    }

    reader = remoteSocket.readable.getReader();
    if (reader.closed && typeof reader.closed.catch === 'function') {
      reader.closed.catch(() => {});
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const bytes = await toBytes(value);
      if (!(await emitChunk(bytes))) break;
    }
  } catch {
    /* expected when remote or client closes */
  } finally {
    if (reader) {
      try {
        const cp = reader.cancel();
        if (cp && typeof cp.catch === 'function') await cp.catch(() => {});
      } catch {}
      try { reader.releaseLock(); } catch {}
    }
    safeCloseSocket(remoteSocket);
  }

  if (!received && retryFn && ws.readyState === WS_OPEN) {
    await retryFn();
    return;
  }

  onClose();
}

/* -------------------------------------------------- NAT64 & Chain Outbound */

export function ipv4ToNat64(ipv4, prefix = '2602:fc59:b0:64::') {
  const parts = String(ipv4 || '').trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  const hi = ((parts[0] << 8) | parts[1]).toString(16).padStart(4, '0');
  const lo = ((parts[2] << 8) | parts[3]).toString(16).padStart(4, '0');
  let cleanPrefix = String(prefix || '2602:fc59:b0:64::').trim().replace(/^\[|\]$/g, '');
  if (!cleanPrefix.endsWith(':')) cleanPrefix += ':';
  return `[${cleanPrefix}${hi}:${lo}]`;
}

async function resolveNat64Target(address, prefixes, upstreamDoH) {
  try {
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
      return ipv4ToNat64(address, prefix);
    }
    if (!address || address.startsWith('[')) return null;

    const baseJsonDoh =
      !upstreamDoH || String(upstreamDoH).includes('1.1.1.1')
        ? 'https://cloudflare-dns.com/dns-query'
        : upstreamDoH;
    const dohUrl = new URL(baseJsonDoh);
    dohUrl.searchParams.set('name', address);
    dohUrl.searchParams.set('type', 'A');
    const res = await fetchWithTimeout(
      dohUrl.toString(),
      { headers: { accept: 'application/dns-json' } },
      4500
    );
    if (!res.ok) return null;
    const data = await res.json();
    const aRec = (data?.Answer || []).find((r) => r && r.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(r.data));
    return aRec ? ipv4ToNat64(aRec.data, prefix) : null;
  } catch {
    return null;
  }
}

export async function dialChainProxy(chainSpec, targetHost, targetPort) {
  let spec = String(chainSpec || '').trim();
  // t.me/socks?server=…&port=…&user=…&pass=… normalization (TELEGRAM socks links)
  const tg = spec.match(/t\.me\/socks\?(\S+)/i);
  if (tg) {
    const q = new URLSearchParams(tg[1].replace(/&amp;/g, '&'));
    const server = q.get('server');
    const port = q.get('port');
    if (server && port) {
      const user = q.get('user');
      const pass = q.get('pass');
      spec = `socks5://${user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : ''}${server}:${port}`;
    }
  }
  const raw = /^https?:\/\/|^socks4a?:\/\//i.test(spec)
    ? spec
    : `socks5://${spec.replace(/^socks?:\/\//i, '')}`;

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid chain proxy URL');
  }

  const proto = u.protocol.replace(':', '').toLowerCase();
  const proxyHost = u.hostname;
  const proxyPort = Number(u.port) || (proto.startsWith('socks') ? 1080 : 8080);
  const username = u.username ? safeDecodeURIComponent(u.username) : '';
  const password = u.password ? safeDecodeURIComponent(u.password) : '';

  const socket = await safeConnect(proxyHost, proxyPort);
  try {
    if (socket.opened) await socket.opened;
  } catch (err) {
    safeCloseSocket(socket);
    throw err;
  }
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  if (writer.closed && typeof writer.closed.catch === 'function') writer.closed.catch(() => {});
  if (writer.ready && typeof writer.ready.catch === 'function') writer.ready.catch(() => {});
  if (reader.closed && typeof reader.closed.catch === 'function') reader.closed.catch(() => {});

  let rxBuf = new Uint8Array(0);
  const readAtLeast = async (n) => {
    while (rxBuf.byteLength < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Chain proxy closed prematurely');
      const chunk = await toBytes(value);
      const merged = new Uint8Array(rxBuf.byteLength + chunk.byteLength);
      merged.set(rxBuf, 0);
      merged.set(chunk, rxBuf.byteLength);
      rxBuf = merged;
    }
    const slice = rxBuf.subarray(0, n);
    rxBuf = rxBuf.subarray(n);
    return slice;
  };

  let succeeded = false;
  try {
    if (proto === 'socks5' || proto === 'socks') {
      const methods = username ? new Uint8Array([0x05, 0x02, 0x00, 0x02]) : new Uint8Array([0x05, 0x01, 0x00]);
      await writer.write(methods);
      const greet = await readAtLeast(2);
      if (greet[0] !== 0x05 || greet[1] === 0xff) throw new Error('SOCKS5 auth method rejected');

      if (greet[1] === 0x02) {
        const uBytes = ENC.encode(username);
        const pBytes = ENC.encode(password);
        if (uBytes.length > 255 || pBytes.length > 255) throw new Error('SOCKS5 credentials too long');
        const authFrame = new Uint8Array(3 + uBytes.length + pBytes.length);
        authFrame[0] = 0x01;
        authFrame[1] = uBytes.length;
        authFrame.set(uBytes, 2);
        authFrame[2 + uBytes.length] = pBytes.length;
        authFrame.set(pBytes, 3 + uBytes.length);
        await writer.write(authFrame);
        const authRes = await readAtLeast(2);
        if (authRes[1] !== 0x00) throw new Error('SOCKS5 credentials rejected');
      }

      const cleanTarget = String(targetHost || '').replace(/^\[|\]$/g, '');
      const hBytes = ENC.encode(cleanTarget);
      if (!hBytes.length || hBytes.length > 255) throw new Error('Target domain length invalid for SOCKS5');
      const req = new Uint8Array(7 + hBytes.length);
      req[0] = 0x05;
      req[1] = 0x01;
      req[2] = 0x00;
      req[3] = 0x03;
      req[4] = hBytes.length;
      req.set(hBytes, 5);
      req[5 + hBytes.length] = (targetPort >> 8) & 0xff;
      req[6 + hBytes.length] = targetPort & 0xff;
      await writer.write(req);

      const repHead = await readAtLeast(4);
      if (repHead[1] !== 0x00) throw new Error(`SOCKS5 connect failed (code ${repHead[1]})`);
      const atyp = repHead[3];
      if (atyp === 1) await readAtLeast(6);
      else if (atyp === 4) await readAtLeast(18);
      else if (atyp === 3) {
        const dlen = (await readAtLeast(1))[0];
        await readAtLeast(dlen + 2);
      }
    } else if (proto === 'socks4' || proto === 'socks4a') {
      // SOCKS4a: request with remote-DNS (ip = 0.0.0.0.x, hostname appended)
      const isDomainTarget = /^[a-z]/i.test(String(targetHost || '').replace(/^\[|\]$/g, ''));
      const cleanTarget4 = String(targetHost || '').replace(/^\[|\]$/g, '');
      const hBytes4 = ENC.encode(cleanTarget4);
      const userIdBytes = ENC.encode(username || '');
      const req4 = new Uint8Array(9 + userIdBytes.length + (isDomainTarget ? 1 + hBytes4.length : 0));
      req4[0] = 0x04;
      req4[1] = 0x01;
      req4[2] = (targetPort >> 8) & 0xff;
      req4[3] = targetPort & 0xff;
      if (isDomainTarget) {
        req4[4] = 0; req4[5] = 0; req4[6] = 0; req4[7] = 1; // SOCKS4a marker
      } else {
        const ipParts = cleanTarget4.split('.').map(Number);
        if (ipParts.length !== 4 || ipParts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          throw new Error('SOCKS4 requires an IPv4 target');
        }
        req4[4] = ipParts[0]; req4[5] = ipParts[1]; req4[6] = ipParts[2]; req4[7] = ipParts[3];
      }
      req4.set(userIdBytes, 8); // SOCKS4: userid right after the 8-byte header
      let wOff = 8 + userIdBytes.length;
      if (isDomainTarget) {
        req4[wOff] = 0x00; // hostname terminator after userid
        wOff += 1;
        req4.set(hBytes4, wOff);
        wOff += hBytes4.length;
        req4[wOff] = 0x00;
        wOff += 1;
      } else {
        req4[wOff] = 0x00;
        wOff += 1;
      }
      await writer.write(req4.subarray(0, wOff));
      const rep4 = await readAtLeast(8);
      if (rep4[1] !== 0x00) throw new Error(`SOCKS4 connect failed (code ${rep4[1]})`);
    } else if (proto === 'http') {
      const authHeader = username
        ? `Proxy-Authorization: Basic ${utf8ToBase64(`${username}:${password}`)}\r\n`
        : '';
      const connectReq =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        authHeader +
        `Proxy-Connection: Keep-Alive\r\n\r\n`;
      await writer.write(ENC.encode(connectReq));

      let headerText = '';
      while (!headerText.includes('\r\n\r\n')) {
        const b = await readAtLeast(1);
        headerText += String.fromCharCode(b[0]);
        if (headerText.length > 8192) throw new Error('HTTP proxy header overflow');
      }
      if (!/^HTTP\/1\.[01]\s+200\b/i.test(headerText)) {
        throw new Error('HTTP CONNECT rejected');
      }
    } else {
      throw new Error(`Unsupported chain protocol: ${proto}`);
    }
    succeeded = true;
  } finally {
    try { writer.releaseLock(); } catch {}
    try { reader.releaseLock(); } catch {}
    if (!succeeded) {
      safeCloseSocket(socket);
    }
  }

  return { socket, leftover: rxBuf };
}

/* -------------------------------------------------------- UDP DNS over DoH */

function createDnsRelay(ws, responseHeader, protocol, upstreamDoH, onDownBytes) {
  let sentVlessHeader = false;
  const dohEndpoint = upstreamDoH || 'https://1.1.1.1/dns-query';

  const resolveQuery = async (dnsWireBytes, trojanPrefix = null) => {
    try {
      if (!dnsWireBytes || dnsWireBytes.byteLength === 0) return;
      const res = await fetchWithTimeout(
        dohEndpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: dnsWireBytes,
        },
        7000
      );
      if (!res.ok) return;
      const answer = new Uint8Array(await res.arrayBuffer());
      if (ws.readyState !== WS_OPEN || answer.byteLength === 0) return;

      if (protocol === 'trojan' && trojanPrefix) {
        const frame = new Uint8Array(trojanPrefix.byteLength + 4 + answer.byteLength);
        frame.set(trojanPrefix, 0);
        frame[trojanPrefix.byteLength] = (answer.byteLength >> 8) & 0xff;
        frame[trojanPrefix.byteLength + 1] = answer.byteLength & 0xff;
        frame[trojanPrefix.byteLength + 2] = 0x0d;
        frame[trojanPrefix.byteLength + 3] = 0x0a;
        frame.set(answer, trojanPrefix.byteLength + 4);
        if (safeSendWS(ws, frame)) onDownBytes(frame.byteLength);
      } else {
        const frame = new Uint8Array(2 + answer.byteLength);
        frame[0] = (answer.byteLength >> 8) & 0xff;
        frame[1] = answer.byteLength & 0xff;
        frame.set(answer, 2);
        if (!sentVlessHeader && responseHeader) {
          sentVlessHeader = true;
          const merged = new Uint8Array(responseHeader.byteLength + frame.byteLength);
          merged.set(responseHeader, 0);
          merged.set(frame, responseHeader.byteLength);
          if (safeSendWS(ws, merged)) onDownBytes(merged.byteLength);
        } else if (safeSendWS(ws, frame)) {
          onDownBytes(frame.byteLength);
        }
      }
    } catch {
      /* ignore failed DoH query */
    }
  };

  const write = async (bytes) => {
    try {
      if (!bytes || bytes.byteLength < 2) {
        safeCloseWS(ws);
        return;
      }
      if (protocol === 'trojan') {
        let offset = 0;
        let parsedAny = false;
        while (offset + 8 <= bytes.byteLength) {
          const atyp = bytes[offset];
          let addrEnd = offset + 1;
          if (atyp === 1) addrEnd += 4;
          else if (atyp === 3) {
            if (offset + 2 > bytes.byteLength) break;
            addrEnd += 1 + bytes[offset + 1];
          } else if (atyp === 4) addrEnd += 16;
          else break;
          const prefixEnd = addrEnd + 2;
          if (prefixEnd + 4 > bytes.byteLength) break;
          const len = (bytes[prefixEnd] << 8) | bytes[prefixEnd + 1];
          const payloadStart = prefixEnd + 4;
          if (payloadStart + len > bytes.byteLength) break;
          const prefix = bytes.subarray(offset, prefixEnd);
          const query = bytes.subarray(payloadStart, payloadStart + len);
          offset = payloadStart + len;
          parsedAny = true;
          resolveQuery(query, prefix).catch(() => {});
        }
        if (!parsedAny) safeCloseWS(ws);
        return;
      }

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let parsedAny = false;
      for (let i = 0; i + 2 <= bytes.byteLength; ) {
        const len = view.getUint16(i, false);
        if (len === 0 || i + 2 + len > bytes.byteLength) break;
        const query = bytes.subarray(i + 2, i + 2 + len);
        i += 2 + len;
        parsedAny = true;
        resolveQuery(query, null).catch(() => {});
      }
      if (!parsedAny) safeCloseWS(ws);
    } catch {
      safeCloseWS(ws);
    }
  };

  return { write };
}

/* --------------------------------------------------- Private DoH HTTP route */

function escapeHtmlBasic(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderDoHGuideHtml({ dohUrl, upstream, ok, rttMs, sampleIp }) {
  const safeUrl = escapeHtmlBasic(dohUrl);
  const safeUp = escapeHtmlBasic(upstream);
  const safeIp = escapeHtmlBasic(sampleIp || '—');
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>ARAL SULFUR — Private DoH Resolver</title>
<style>
  :root{--bg:#eef3ee;--panel:#f7faf6;--field:#ffffff;--ink:#15211a;--mut:#5d6b62;--dim:#8b978e;--uranium:#00875a;--ur-soft:rgba(0,135,90,.1);--line:rgba(0,135,90,.32);--hairline:rgba(20,33,26,.14);--fire:#d94400;--ok:#00875a;--ok-bg:rgba(0,135,90,.1);--bad:#d63a2c;--bad-bg:rgba(214,58,44,.09);--mono:'JetBrains Mono',ui-monospace,Consolas,monospace;}
  [data-theme="dark"]{--bg:#050807;--panel:#0b110e;--field:#080d0a;--ink:#e9f2ec;--mut:#8b978e;--dim:#57645c;--uranium:#00ff9d;--ur-soft:rgba(0,255,157,.1);--line:rgba(0,255,157,.26);--hairline:rgba(255,255,255,.09);--fire:#ff4d00;--ok:#00ff9d;--ok-bg:rgba(0,255,157,.1);--bad:#ff5545;--bad-bg:rgba(255,85,69,.09);}
  *{box-sizing:border-box;margin:0;padding:0}
  /* FIX: the radial fade mask used to sit on the body element itself, so it masked
     the whole page — every element below ~75% of the ellipse (the entire "how to
     configure" section + footer) rendered semi-transparent/ghosted. The decorative
     grid + mask now live on a fixed ::before layer behind the content (same pattern
     as the panel .bg-grid), so only the grid artwork fades, never the text. */
  body{background:var(--bg);color:var(--ink);font-family:Vazirmatn,Tahoma,system-ui,sans-serif;line-height:1.9;padding:26px 14px}
  body::before{content:"";position:fixed;inset:0;z-index:-3;pointer-events:none;
    background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
    background-size:56px 56px;-webkit-mask-image:radial-gradient(ellipse 70% 55% at 50% 20%,#000 25%,transparent 75%);mask-image:radial-gradient(ellipse 70% 55% at 50% 20%,#000 25%,transparent 75%)}
  .sheet{max-width:760px;margin:0 auto;background:var(--panel);border:1px solid var(--hairline);padding:26px;position:relative;
    clip-path:polygon(16px 0,100% 0,100% calc(100% - 16px),calc(100% - 16px) 100%,0 100%,0 16px)}
  .sheet::before{content:"";position:absolute;top:0;right:0;width:80px;height:2px;background:linear-gradient(90deg,var(--uranium),transparent)}
  .top{display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px dashed var(--hairline);padding-bottom:14px;margin-bottom:16px;flex-wrap:wrap}
  .brand{font-family:var(--mono);font-weight:700;font-size:1.18rem;letter-spacing:.12em;direction:ltr}
  .brand b{color:var(--uranium)}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border:1px solid var(--line);font-family:var(--mono);font-weight:600;font-size:.78rem;background:${ok ? 'var(--ok-bg)' : 'var(--bad-bg)'};color:${ok ? 'var(--ok)' : 'var(--bad)'};direction:ltr}
  .url-box{direction:ltr;text-align:left;font-family:var(--mono);font-size:.86rem;background:var(--field);border:1px solid var(--line);padding:13px;word-break:break-all;margin:12px 0;box-shadow:0 0 18px var(--ur-soft)}
  .btns{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
  button,a.btn{cursor:pointer;background:var(--uranium);color:#03130b;border:1px solid var(--uranium);padding:9px 16px;font-weight:700;font-size:.85rem;text-decoration:none;display:inline-flex;align-items:center;gap:7px;font-family:inherit;clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px);transition:box-shadow .2s}
  button:hover,a.btn:hover{box-shadow:0 0 18px var(--ur-soft)}
  button.sec,a.btn.sec{background:var(--field);color:var(--ink);border-color:var(--hairline)}
  button.sec:hover,a.btn.sec:hover{color:var(--uranium);border-color:var(--line)}
  .ic{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:14px 0 18px}
  .kv{border:1px solid var(--hairline);padding:11px;background:var(--field)}
  .kv small{display:block;color:var(--dim);font-size:.74rem}
  .kv b{font-family:var(--mono);font-size:.9rem;direction:ltr;display:inline-block;color:var(--uranium)}
  h2{font-size:.98rem;border-bottom:1px solid var(--hairline);border-inline-start:2px solid var(--uranium);padding:2px 10px 6px;margin:16px 0 10px}
  ul{padding-right:20px;font-size:.9rem}
  li{margin-bottom:7px}
  code{font-family:var(--mono);background:var(--field);padding:1px 6px;border:1px solid var(--hairline);direction:ltr;display:inline-block;font-size:.8rem}
  .foot{margin-top:20px;padding-top:12px;border-top:1px dashed var(--hairline);font-size:.76rem;color:var(--mut);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
  .foot .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--uranium);box-shadow:0 0 8px var(--uranium);margin-inline-end:6px;vertical-align:middle}
</style>
</head>
<body>
  <div class="sheet">
    <div class="top">
      <div>
        <div class="brand">ARAL <b>SULFUR</b> · PRIVATE DoH</div>
        <div style="font-size:.82rem;color:var(--muted)">سرور اختصاصی DNS-over-HTTPS (ضد تحریم و ضد مسمومیت DNS) · V${PANEL_VERSION}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <span class="badge">${ok ? `<svg class="ic" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg> فعال و آماده (${rttMs}ms)` : `<svg class="ic" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg> خطای ارتباط بالادستی`}</span>
        <button class="sec" type="button" id="th-btn" title="تغییر تم"><svg class="ic" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>
      </div>
    </div>

    <p style="font-size:.92rem;">این آدرس یک <b>سرور استاندارد RFC 8484 DNS-over-HTTPS</b> است. باز کردن مستقیم آن در مرورگر این برگهٔ راهنما را نمایش می‌دهد؛ برای استفاده، آدرس زیر را در بخش <b>Secure DNS</b> مرورگر یا کلاینت خود قرار دهید:</p>

    <div class="url-box" id="doh-url">${safeUrl}</div>
    <div class="btns">
      <button type="button" id="copy-btn"><svg class="ic" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg><span id="copy-lbl">کپی آدرس DoH اختصاصی</span></button>
      <a class="btn sec" href="${safeUrl}?name=example.com&type=A" target="_blank" rel="noopener"><span>تست زندهٔ JSON DNS (example.com)</span><svg class="ic" viewBox="0 0 24 24"><path d="M7 17L17 7M7 7h10v10"/></svg></a>
    </div>

    <div class="grid">
      <div class="kv"><small>پروتکل‌های پشتیبانی‌شده</small><b>RFC 8484 (POST / ?dns=) + JSON</b></div>
      <div class="kv"><small>سرور بالادستی</small><b>${safeUp}</b></div>
      <div class="kv"><small>تست رزولوشن زنده</small><b>${safeIp} (${rttMs}ms)</b></div>
    </div>

    <h2>نحوهٔ تنظیم در مرورگرها و کلاینت‌ها</h2>
    <ul>
      <li><b>Chrome / Brave / Edge (ویندوز، مک و اندروید):</b> وارد <code>Settings → Privacy and security → Security → Use secure DNS</code> شوید، گزینهٔ <code>With Custom</code> را انتخاب کنید و لینک بالا را جای‌گذاری کنید.</li>
      <li><b>Firefox:</b> وارد <code>Settings → Privacy & Security → DNS over HTTPS → Max Protection</code> شوید، گزینهٔ <code>Custom</code> را بزنید و لینک بالا را وارد کنید.</li>
      <li><b>v2rayNG / MahsaNG / Hiddify / Streisand:</b> در تنظیمات <code>Remote DNS</code> یا <code>DoH</code> کلاینت، همین لینک کامل <code>https://...</code> را قرار دهید (در اشتراک‌های ARAL SULFUR به‌صورت خودکار تزریق شده است).</li>
      <li><b>نکتهٔ مهم اندروید:</b> بخش <i>Private DNS</i> در تنظیمات سیستم‌عامل اندروید فقط پروتکل قدیمی <code>DoT (پورت 853 بدون https://)</code> می‌پذیرد؛ برای اندروید لینک بالا را داخل <b>Chrome / Firefox</b> یا برنامهٔ <b>Intra / RethinkDNS</b> وارد کنید.</li>
    </ul>

    <div class="foot">
      <span style="display:inline-flex;align-items:center;gap:6px"><svg class="ic" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg> سرویس کاملاً رایگان و متن‌باز — غیرقابل فروش (100% Free &amp; Not For Sale)</span>
      <span dir="ltr" style="font-family:var(--mono)"><span class="dot"></span>ARAL SULFUR V${PANEL_VERSION}</span>
    </div>
  </div>
  <script>
    (function(){
      var root=document.documentElement;
      var saved=localStorage.getItem('nl_theme');
      if(saved==='dark')root.setAttribute('data-theme','dark');
      document.getElementById('th-btn').onclick=function(){
        var next=root.getAttribute('data-theme')==='dark'?'light':'dark';
        root.setAttribute('data-theme',next);
        localStorage.setItem('nl_theme',next);
      };
      document.getElementById('copy-btn').onclick=function(){
        var lbl=document.getElementById('copy-lbl');
        navigator.clipboard.writeText(document.getElementById('doh-url').textContent).then(function(){
          lbl.textContent='کپی شد';
          setTimeout(function(){lbl.textContent='کپی آدرس DoH اختصاصی';},1800);
        });
      };
    })();
  </script>
</body>
</html>`;
}

export async function handlePrivateDoH(request, upstreamDoH = 'https://1.1.1.1/dns-query') {
  try {
    const url = new URL(request.url);
    const safeUpstream = /^https:\/\//i.test(String(upstreamDoH || ''))
      ? upstreamDoH
      : 'https://1.1.1.1/dns-query';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, accept',
        },
      });
    }

    if (request.method === 'POST') {
      const body = await request.arrayBuffer();
      if (!body || body.byteLength === 0 || body.byteLength > 65535) {
        return new Response('Invalid DNS message size', { status: 400 });
      }
      const res = await fetchWithTimeout(
        safeUpstream,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/dns-message',
            accept: 'application/dns-message',
          },
          body,
        },
        8000
      );
      return new Response(res.body, {
        status: res.status,
        headers: {
          'content-type': res.headers.get('content-type') || 'application/dns-message',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
      });
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      // 1) RFC 8484 Wireformat DoH: GET /dns-query/<token>?dns=<base64url>
      if (url.searchParams.has('dns')) {
        const target = new URL(safeUpstream);
        target.searchParams.set('dns', url.searchParams.get('dns') || '');
        const res = await fetchWithTimeout(
          target.toString(),
          { method: 'GET', headers: { accept: 'application/dns-message' } },
          8000
        );
        return new Response(request.method === 'HEAD' ? null : res.body, {
          status: res.status,
          headers: {
            'content-type': res.headers.get('content-type') || 'application/dns-message',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          },
        });
      }

      // 2) JSON DoH API: GET /dns-query/<token>?name=example.com&type=A
      if (url.searchParams.has('name')) {
        const jsonBase = safeUpstream.includes('1.1.1.1')
          ? 'https://cloudflare-dns.com/dns-query'
          : safeUpstream;
        const target = new URL(jsonBase);
        for (const [k, v] of url.searchParams.entries()) {
          target.searchParams.set(k, v);
        }
        const res = await fetchWithTimeout(
          target.toString(),
          { method: 'GET', headers: { accept: 'application/dns-json' } },
          8000
        );
        return new Response(request.method === 'HEAD' ? null : res.body, {
          status: res.status,
          headers: {
            'content-type': 'application/dns-json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
          },
        });
      }

      // 3) Direct browser visit (`GET /dns-query/<token>` with no query params):
      //    Run a quick live upstream health check and render the interactive setup guide!
      const t0 = Date.now();
      let ok = false;
      let sampleIp = '';
      try {
        const probeBase = safeUpstream.includes('1.1.1.1')
          ? 'https://cloudflare-dns.com/dns-query'
          : safeUpstream;
        const probeUrl = new URL(probeBase);
        probeUrl.searchParams.set('name', 'example.com');
        probeUrl.searchParams.set('type', 'A');
        const probeRes = await fetchWithTimeout(
          probeUrl.toString(),
          { method: 'GET', headers: { accept: 'application/dns-json' } },
          3500
        );
        if (probeRes.ok) {
          const data = await probeRes.json();
          const aRec = (data?.Answer || []).find((r) => r && r.type === 1);
          ok = Number(data?.Status) === 0;
          sampleIp = aRec ? String(aRec.data) : 'OK';
        }
      } catch {
        ok = false;
      }
      const rttMs = Date.now() - t0;
      const cleanSelfUrl = `${url.origin}${url.pathname}`;
      const html = renderDoHGuideHtml({
        dohUrl: cleanSelfUrl,
        upstream: safeUpstream,
        ok,
        rttMs,
        sampleIp,
      });
      return new Response(request.method === 'HEAD' ? null : html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    return new Response('Method Not Allowed', { status: 405 });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Upstream DoH unreachable', detail: err?.message || String(err) }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
  }
}

/* ------------------------------------------- Server-side ProxyIP / Chain probe */

export async function probeOutboundEndpoint(spec) {
  const t0 = Date.now();
  let tid = null;
  let openedSock = null;

  try {
    const raw = String(spec || '').trim();
    if (!raw) return { ok: false, error: 'آدرس خالی است' };

    const timeoutPromise = new Promise((_, rej) => {
      tid = setTimeout(() => rej(new Error('Timeout (5s)')), 5000);
    });

    if (/^(socks5?|http):\/\//i.test(raw)) {
      const chainPromise = dialChainProxy(raw, 'example.com', 80);
      // Disarm late rejection/resolution if timeout wins
      chainPromise
        .then((res) => { if (openedSock !== res.socket) safeCloseSocket(res.socket); })
        .catch(() => {});

      const chained = await Promise.race([chainPromise, timeoutPromise]);
      openedSock = chained.socket;
      safeCloseSocket(chained.socket);
      return { ok: true, target: raw.replace(/\/\/.*@/, '//***@'), latencyMs: Date.now() - t0 };
    }

    const ep = parseEndpoint(raw, 443);
    if (!ep) return { ok: false, error: 'فرمت آدرس نامعتبر است' };

    openedSock = await safeConnect(ep.host, ep.port);
    await Promise.race([openedSock.opened, timeoutPromise]);
    const latencyMs = Date.now() - t0;
    safeCloseSocket(openedSock);
    return { ok: true, target: `${ep.host}:${ep.port}`, latencyMs };
  } catch (err) {
    safeCloseSocket(openedSock);
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      latencyMs: Date.now() - t0,
    };
  } finally {
    if (tid) clearTimeout(tid);
  }
}

/* ------------------------------------------------------- WebSocket helpers */

function makeReadableWS(ws, earlyDataHeader) {
  let streamDone = false;

  const safeEnqueue = (controller, data) => {
    if (streamDone || data == null) return;
    try {
      controller.enqueue(data);
    } catch {
      streamDone = true;
    }
  };

  const safeFinish = (controller) => {
    if (streamDone) return;
    streamDone = true;
    try {
      controller.close();
    } catch {
      /* ignore if already closed/errored */
    }
  };

  const safeFail = (controller, err) => {
    if (streamDone) return;
    streamDone = true;
    try {
      controller.error(err);
    } catch {
      /* ignore if already closed/errored */
    }
  };

  return new ReadableStream({
    start(controller) {
      ws.addEventListener('message', (event) => {
        safeEnqueue(controller, event.data);
      });
      ws.addEventListener('close', () => {
        safeCloseWS(ws);
        safeFinish(controller);
      });
      ws.addEventListener('error', (ev) => {
        try { if (ev && typeof ev.preventDefault === 'function') ev.preventDefault(); } catch {}
        safeCloseWS(ws);
        safeFinish(controller);
      });

      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        setTimeout(() => {
          safeCloseWS(ws);
          safeFinish(controller);
        }, 0);
      } else if (earlyData) {
        setTimeout(() => safeEnqueue(controller, earlyData), 0);
      }
    },
    cancel() {
      streamDone = true;
      safeCloseWS(ws);
    },
  });
}

async function toBytes(chunk) {
  try {
    if (!chunk) return new Uint8Array(0);
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer());
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (typeof chunk === 'string') return ENC.encode(chunk);
    return new Uint8Array(chunk);
  } catch {
    return new Uint8Array(0);
  }
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str || typeof base64Str !== 'string') return { earlyData: null, error: null };
  try {
    const trimmed = base64Str.split(',')[0].trim();
    if (!trimmed || /[^A-Za-z0-9+/_=-]/.test(trimmed)) {
      return { earlyData: null, error: null };
    }
    const norm = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const pad = norm + '==='.slice((norm.length + 3) % 4);
    const decoded = atob(pad);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    if (bytes.byteLength < 24) {
      return { earlyData: null, error: null };
    }
    return { earlyData: bytes, error: null };
  } catch {
    return { earlyData: null, error: null };
  }
}
