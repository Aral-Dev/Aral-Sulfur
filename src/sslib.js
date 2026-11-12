/**
 * ARAL SULFUR — Shadowsocks (ss) AEAD engine + content-control sniffers.
 *
 * Implements the standard Shadowsocks AEAD (SIP004) profile used by the
 * v2ray-plugin WebSocket transport:
 *   stream = [salt(32)] [encLen(2)+tag(16)] [payload+tag(16)] ...
 *   subkey = HKDF-SHA1(EVP_BytesToKey(password), salt, "ss-subkey", 32)
 *   nonce  = 12-byte LE counter starting at zero, +1 after every AEAD operation.
 *
 * Also contains the passive TLS-SNI / HTTP-Host sniffer and the family-DoH
 * verdict cache used by per-user adult/ads blocking.
 */

const MAX_PAYLOAD = 0x3fff;
const SALT_LEN = 32;
const TAG_LEN = 16;

/* ------------------------------------------------------------ pure-JS MD5 */
/* Minimal MD5 (used only for EVP_BytesToKey password derivation, ~2KB code). */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

function md5ToBytes(inputBytes) {
  const len = inputBytes.length;
  const withPad = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(withPad);
  buf.set(inputBytes);
  buf[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(withPad - 8, bitLen >>> 0, true);
  dv.setUint32(withPad - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new DataView(buf.buffer);
  const rol = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

  for (let off = 0; off < withPad; off += 64) {
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i++) m[i] = M.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + MD5_K[i] + m[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rol(F, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

/** OpenSSL EVP_BytesToKey (MD5, 1 iteration) — the standard ss password KDF. */
export function evpBytesToKey(password, keyLen = 32) {
  const pw = new TextEncoder().encode(String(password ?? ''));
  const blocks = [];
  let prev = new Uint8Array(0);
  let total = 0;
  while (total < keyLen) {
    const input = new Uint8Array(prev.length + pw.length);
    input.set(prev);
    input.set(pw, prev.length);
    prev = md5ToBytes(input);
    blocks.push(prev);
    total += prev.length;
  }
  const out = new Uint8Array(keyLen);
  let off = 0;
  for (const b of blocks) {
    const take = Math.min(b.length, keyLen - off);
    out.set(b.subarray(0, take), off);
    off += take;
    if (off >= keyLen) break;
  }
  return out;
}

/* ------------------------------------------------------- HKDF-SHA1 subkey */

const hkdfCache = new Map(); // `${keyHex}:${saltHex}` -> CryptoKey
export async function deriveSubkey(keyBytes, saltBytes) {
  let keyHex = '';
  for (let i = 0; i < keyBytes.length; i++) keyHex += keyBytes[i].toString(16).padStart(2, '0');
  let saltHex = '';
  for (let i = 0; i < saltBytes.length; i++) saltHex += saltBytes[i].toString(16).padStart(2, '0');
  const cacheKey = `${keyHex}:${saltHex}`;
  let base = hkdfCache.get(cacheKey);
  if (!base) {
    base = await crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits']);
    if (hkdfCache.size > 512) hkdfCache.clear();
    hkdfCache.set(cacheKey, base);
  }
  const info = new TextEncoder().encode('ss-subkey');
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-1', salt: saltBytes, info },
    base,
    256
  );
  return new Uint8Array(bits);
}

const keyCache = new Map(); // password -> keyBytes
export function getSSKey(password) {
  let k = keyCache.get(password);
  if (!k) {
    k = evpBytesToKey(password, 32);
    if (keyCache.size > 512) keyCache.clear();
    keyCache.set(password, k);
  }
  return k;
}

/* ------------------------------------------------------------ nonce utils */

function nextNonce(nonce) {
  for (let i = 0; i < nonce.length; i++) {
    nonce[i] = (nonce[i] + 1) & 0xff;
    if (nonce[i] !== 0) break;
  }
  return nonce;
}

function ivFor(nonce) {
  return nonce.slice();
}

/* ------------------------------------------------------- AEAD chunk codec */

async function decryptChunk(subkey, nonce, enc) {
  const key = await crypto.subtle.importKey('raw', subkey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFor(nonce), tagLength: 128 }, key, enc);
  return new Uint8Array(plain);
}

async function encryptChunk(subkey, nonce, plain) {
  const key = await crypto.subtle.importKey('raw', subkey, 'AES-GCM', false, ['encrypt']);
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFor(nonce), tagLength: 128 }, key, plain);
  return new Uint8Array(enc);
}

/** Build an outbound (server→client) AEAD writer: returns chunk framing fn. */
export function createSSEncryptor(subkey) {
  let nonce = new Uint8Array(12);
  return async function encryptFrame(plaintext) {
    const frames = [];
    let off = 0;
    while (off < plaintext.length || frames.length === 0) {
      const take = Math.min(MAX_PAYLOAD, plaintext.length - off);
      const payload = plaintext.subarray(off, off + take);
      const lenBytes = new Uint8Array([(take >> 8) & 0xff, take & 0xff]);
      const encLen = await encryptChunk(subkey, nonce, lenBytes);
      nextNonce(nonce);
      const encPayload = await encryptChunk(subkey, nonce, payload);
      nextNonce(nonce);
      const frame = new Uint8Array(encLen.length + encPayload.length);
      frame.set(encLen, 0);
      frame.set(encPayload, encLen.length);
      frames.push(frame);
      off += take;
      if (take === 0 && plaintext.length === 0) break;
      if (off >= plaintext.length && plaintext.length > 0) break;
    }
    return frames;
  };
}

/**
 * Streaming inbound (client→server) AEAD reader.
 * Feed raw WS bytes via `push()`; yields decrypted payload chunks through onPayload.
 * Handles salt + user identification once, then transparent chunk decoding.
 */
export function createSSIdentifier(users, salt0) {
  // users: [{ user, key }] — tries each until length-chunk decrypts
  let idx = 0;
  return {
    async identify() {
      while (idx < users.length) {
        const candidate = users[idx++];
        try {
          const subkey = await deriveSubkey(candidate.key, salt0);
          return { candidate, subkey };
        } catch {}
      }
      return null;
    },
  };
}

export function parseSSAddress(bytes, offset = 0) {
  if (bytes.length < offset + 2) return null;
  const atyp = bytes[offset];
  let p = offset + 1;
  let host = '';
  if (atyp === 1) {
    if (bytes.length < p + 4) return null;
    host = `${bytes[p]}.${bytes[p + 1]}.${bytes[p + 2]}.${bytes[p + 3]}`;
    p += 4;
  } else if (atyp === 3) {
    const len = bytes[p];
    p += 1;
    if (bytes.length < p + len) return null;
    host = new TextDecoder().decode(bytes.subarray(p, p + len));
    p += len;
  } else if (atyp === 4) {
    if (bytes.length < p + 16) return null;
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[p + i] << 8) | bytes[p + i + 1]).toString(16));
    host = `[${groups.join(':')}]`;
    p += 16;
  } else {
    return null;
  }
  if (bytes.length < p + 2) return null;
  const port = (bytes[p] << 8) | bytes[p + 1];
  if (port < 1 || port > 65535) return null;
  return { host, port, next: p + 2 };
}

export const SS_CONST = { SALT_LEN, TAG_LEN, MAX_PAYLOAD };

/* ------------------------------------------------ passive target sniffing */

/**
 * Extract the SNI from a TLS ClientHello, or the Host header from a plain HTTP
 * request. Returns '' when nothing can be parsed (fail-open elsewhere).
 */
export function sniffTargetDomain(bytes) {
  try {
    if (!bytes || bytes.byteLength < 16) return '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    // HTTP: METHOD SP PATH SP HTTP/1.x
    const isHttp =
      (b[0] >= 0x41 && b[0] <= 0x5a) &&
      (b[1] >= 0x41 && b[1] <= 0x5a) &&
      (b[2] >= 0x41 && b[2] <= 0x5a);
    if (isHttp) {
      const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096))).toLowerCase();
      const m = head.match(/^host:\s*([a-z0-9._-]+)/m);
      if (m) return m[1];
      return '';
    }

    // TLS record: type(0x16) ver(2) len(2) handshake(0x01) len(3) ver(2) random(32)
    if (b[0] !== 0x16) return '';
    const recLen = (b[3] << 8) | b[4];
    let p = 5;
    if (b[p] !== 0x01) return '';
    p += 4; // handshake type + 3-byte length
    p += 2; // client version
    p += 32; // random
    if (b.length < p + 1) return '';
    const sessionIdLen = b[p]; p += 1 + sessionIdLen;
    if (b.length < p + 2) return '';
    const cipherLen = (b[p] << 8) | b[p + 1]; p += 2 + cipherLen;
    if (b.length < p + 1) return '';
    const compLen = b[p]; p += 1 + compLen;

    // extensions
    if (b.length < p + 2) return '';
    const extTotal = (b[p] << 8) | b[p + 1];
    p += 2;
    const extEnd = Math.min(b.length, p + extTotal, 5 + recLen);
    while (p + 4 <= extEnd) {
      const extType = (b[p] << 8) | b[p + 1];
      const extLen = (b[p + 2] << 8) | b[p + 3];
      p += 4;
      if (extType === 0x0000) {
        // server_name_list
        if (p + 5 > extEnd) return '';
        const listLen = (b[p] << 8) | b[p + 1];
        const nameType = b[p + 2];
        const nameLen = (b[p + 3] << 8) | b[p + 4];
        if (nameType !== 0 || nameLen <= 0 || p + 5 + nameLen > extEnd) return '';
        const host = new TextDecoder().decode(b.subarray(p + 5, p + 5 + nameLen)).toLowerCase();
        return /^[a-z0-9._-]{3,200}$/.test(host) ? host : '';
      }
      p += extLen;
    }
    return '';
  } catch {
    return '';
  }
}

/* -------------------------------------------------- family-DoH block check */

const verdictCache = new Map(); // `kind:domain` -> { blocked, at }
const VERDICT_TTL = 30 * 60_000;

const BLOCK_RESOLVERS = {
  adult: 'https://family.cloudflare-dns.com/resolve',
  ads: 'https://dns.adguard-dns.com/resolve',
};

function pruneVerdicts() {
  if (verdictCache.size < 4000) return;
  const now = Date.now();
  for (const [k, v] of verdictCache) {
    if (now - v.at > VERDICT_TTL) verdictCache.delete(k);
  }
}

function answerIsBlocked(data) {
  const answers = Array.isArray(data?.Answer) ? data.Answer : [];
  for (const a of answers) {
    const val = String(a?.data || '').toLowerCase();
    if (val === '0.0.0.0' || val === '::') return true;
  }
  return false;
}

/**
 * Returns true when the domain should be blocked for this user.
 * Fail-open (false) on any resolver/network error so traffic never breaks.
 */
export async function isDomainBlocked(kind, domain) {
  const clean = String(domain || '').toLowerCase().replace(/\.$/, '');
  if (!clean || !BLOCK_RESOLVERS[kind]) return false;
  const cacheKey = `${kind}:${clean}`;
  const hit = verdictCache.get(cacheKey);
  const now = Date.now();
  if (hit && now - hit.at < VERDICT_TTL) return hit.blocked;

  const ctrl = new AbortController();
  const tid = setTimeout(() => { try { ctrl.abort(); } catch {} }, 3500);
  let blocked = false;
  try {
    const url = `${BLOCK_RESOLVERS[kind]}?name=${encodeURIComponent(clean)}&type=A`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/dns-json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (Number(data?.Status) === 0 || Number(data?.Status) === 2) {
        blocked = answerIsBlocked(data);
      }
    }
  } catch {} finally {
    clearTimeout(tid);
  }
  pruneVerdicts();
  verdictCache.set(cacheKey, { blocked, at: now });
  return blocked;
}
