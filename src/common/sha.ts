/* Pure-JS SHA-224 for WebCrypto-less runtimes (SubtleCrypto has no SHA-224).
   Used only for the Trojan password hex digest (32 rounds per block, no secrets). */

const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

const H224 = [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4];

function rotr(x: number, n: number): number {
    return (x >>> n) | (x << (32 - n));
}

export function sha224Hex(message: string): string {
    const bytes = new TextEncoder().encode(message);
    const bitLen = bytes.length * 8;

    // padding: 0x80 then zeros until length ≡ 56 mod 64, then 8-byte big-endian bit length
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

    const h = [...H224];
    const w = new Uint32Array(64);

    for (let off = 0; off < paddedLen; off += 64) {
        for (let i = 0; i < 16; i++) {
            const j = off + i * 4;
            w[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
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

    // SHA-224 uses only the first 7 words (224 bits)
    return h.slice(0, 7).map(x => x.toString(16).padStart(8, '0')).join('');
}

/* X25519 key pair for Warp registration via the standard WebCrypto API —
   replaces node:crypto's generateKeyPairSync('x25519'). */
export async function generateX25519KeyPairBase64(): Promise<{ publicKey: string; privateKey: string }> {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveKey']) as CryptoKeyPair;

    const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

    return {
        publicKey: bytesToBase64(rawPublic),
        privateKey: jwk.d!
    };
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}
