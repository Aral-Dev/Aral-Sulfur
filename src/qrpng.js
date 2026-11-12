/**
 * ARAL SULFUR — Server-side QR encoder + 1-bit PNG writer (zero dependencies).
 *
 * Used by the Telegram management bot to attach the subscriber's QR code as a real
 * photo (Telegram cannot render SVG photos). Implements:
 *   · QR Code model 2, byte (8-bit) mode, ECC level M, versions 1–20 (enough for
 *     any subscription URL the panel produces)
 *   · Classic Reed–Solomon over GF(256) + full 8-mask penalty scoring
 *   · Minimal 1-bit grayscale PNG encoder using stored (uncompressed) DEFLATE
 *     blocks — valid PNG, tiny CPU cost, ~2–4 KB output
 * The algorithm follows ISO/IEC 18004 (same structure as the Nayuki reference
 * implementation, MIT) — rewritten compactly for Cloudflare Workers.
 */

/* ─────────────────────────────── GF(256) arithmetic ─────────────────────────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1; // monomial x^degree
  let root = 1;
  for (let i = 0; i < degree; i++) {
    // multiply current polynomial by (x - α^i)
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

/* ─────────────────────────────── QR spec tables (ECC level M, versions 1–20) ─────────────────────────────── */

/** Reed–Solomon ECC codewords per block, versions 1..20 (ISO/IEC 18004, ECC level M). */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
/** Number of RS blocks per version, versions 1..20 (ECC level M). */
const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
/** Byte-mode payload capacity per version at ECC level M (bytes). */
const M_CAPACITY = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213,
  251, 287, 331, 362, 412, 450, 504, 560, 624, 666,
];

const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function getNumRawDataModules(ver) {
  // ISO/IEC 18004 — total data-capable modules (Nayuki reference formula)
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function getAlignmentPatternPositions(ver, size) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = (ver === 32) ? 26 : Math.floor((ver * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const result = new Array(numAlign);
  result[0] = 6;
  for (let i = numAlign - 1, pos = size - 7; i >= 1; i--, pos -= step) result[i] = pos;
  return result;
}

/* ─────────────────────────────── QR matrix construction ─────────────────────────────── */

function makeMatrix(ver, dataCodewords, eccLevel) {
  const size = 17 + ver * 4;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  function setModule(x, y, dark) {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  }

  function drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setModule(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawFormatBits(mask) {
    const data = (ECC_FORMAT_BITS[eccLevel] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const getBit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setModule(8, i, getBit(i));
    setModule(8, 7, getBit(6));
    setModule(8, 8, getBit(7));
    setModule(7, 8, getBit(8));
    for (let i = 9; i < 15; i++) setModule(14 - i, 8, getBit(i));
    for (let i = 0; i < 8; i++) setModule(size - 1 - i, 8, getBit(i));
    for (let i = 8; i < 15; i++) setModule(8, size - 15 + i, getBit(i));
    setModule(8, size - 8, true); // always-dark module
  }

  function drawVersionBits() {
    if (ver < 7) return;
    // 18-bit BCH-protected version info (generator 0x1F25), two mirrored copies
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setModule(a, b, bit); // top-right strip
      setModule(b, a, bit); // bottom-left strip
    }
  }

  function drawFunctionPatterns() {
    // timing patterns
    for (let i = 0; i < size; i++) {
      setModule(6, i, i % 2 === 0);
      setModule(i, 6, i % 2 === 0);
    }
    // finder patterns + separators
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);
    // alignment patterns
    const pos = getAlignmentPatternPositions(ver, size);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        const cx = pos[i];
        const cy = pos[j];
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    // reserve format info areas + version info areas
    drawFormatBits(0);
    drawVersionBits();
  }

  drawFunctionPatterns();

  // place data with zigzag scan
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < dataCodewords.length * 8) {
          modules[y][x] = ((dataCodewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }

  // try all 8 masks, keep the lowest-penalty one
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules = null;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const penalty = scorePenalty();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = modules.map((row) => [...row]);
    }
    applyMask(mask); // undo
  }
  drawFormatBits(bestMask);
  return bestModules || modules;

  function applyMask(mask) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        modules[y][x] = modules[y][x] !== invert;
      }
    }
  }

  function scorePenalty() {
    let result = 0;
    // rule 1: consecutive runs
    for (let y = 0; y < size; y++) {
      let runColor = modules[y][0];
      let runLen = 1;
      for (let x = 1; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += 3;
          else if (runLen > 5) result += 1;
        } else {
          runColor = modules[y][x];
          runLen = 1;
        }
      }
    }
    for (let x = 0; x < size; x++) {
      let runColor = modules[0][x];
      let runLen = 1;
      for (let y = 1; y < size; y++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (runLen === 5) result += 3;
          else if (runLen > 5) result += 1;
        } else {
          runColor = modules[y][x];
          runLen = 1;
        }
      }
    }
    // rule 2: 2x2 same-color blocks
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
      }
    }
    // rule 3: finder-like 1:1:3:1:1 patterns
    const PAT = [true, false, true, true, true, false, true];
    const checkLine = (get, len) => {
      let found = 0;
      for (let i = 0; i + 6 < len; i++) {
        let ok = true;
        for (let k = 0; k < 7; k++) if (get(i + k) !== PAT[k]) { ok = false; break; }
        if (!ok) continue;
        let before4 = true;
        let after4 = true;
        for (let k = 1; k <= 4; k++) if (i - k < 0 || get(i - k)) { before4 = false; break; }
        for (let k = 1; k <= 4; k++) if (i + 6 + k >= len || get(i + 6 + k)) { after4 = false; break; }
        if (before4 || after4) found++;
      }
      return found;
    };
    for (let y = 0; y < size; y++) result += checkLine((i) => modules[y][i], size) * 40;
    for (let x = 0; x < size; x++) result += checkLine((i) => modules[i][x], size) * 40;
    // rule 4: dark-module ratio
    let dark = 0;
    for (const row of modules) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += Math.max(0, k) * 10;
    return result;
  }
}

/* ─────────────────────────────── public encode API ─────────────────────────────── */

export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let ver = 0;
  for (let v = 1; v <= 20; v++) {
    if (bytes.length <= M_CAPACITY[v - 1]) {
      ver = v;
      break;
    }
  }
  if (!ver) throw new Error('QR payload too long');

  const numBlocks = NUM_BLOCKS[ver - 1];
  const blockEccLen = ECC_PER_BLOCK[ver - 1];
  const rawCw = Math.floor(getNumRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCw % numBlocks);
  const shortBlockLen = Math.floor(rawCw / numBlocks);
  const capacityBits = (rawCw - blockEccLen * numBlocks) * 8;

  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  // byte-mode indicator + character count + payload
  pushBits(4, 4);
  pushBits(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  // terminator + bit padding + pad codewords
  pushBits(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const padBytes = [0xEC, 0x11];
  for (let i = 0; bits.length < capacityBits; i++) {
    pushBits(padBytes[i % 2], 8);
  }

  const dataCw = new Uint8Array(bits.length / 8);
  for (let i = 0; i < dataCw.length; i++) {
    for (let j = 0; j < 8; j++) dataCw[i] = (dataCw[i] << 1) | bits[i * 8 + j];
  }

  const divisor = rsDivisor(blockEccLen);
  // Build each block exactly like the reference: [data..., (0 pad for short blocks), ecc...]
  // padded to shortBlockLen + 1, then interleave while SKIPPING the pad position of
  // short blocks (this is the exact ISO/IEC 18004 interleaving scheme).
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = dataCw.slice(k, k + dataLen);
    k += dataLen;
    const block = new Uint8Array(shortBlockLen + 1);
    block.set(dat, 0);
    block.set(rsRemainder(dat, divisor), shortBlockLen + 1 - blockEccLen);
    blocks.push(block);
  }

  const result = [];
  for (let i = 0; i <= shortBlockLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      // Skip the padding byte of short blocks at the boundary position
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(blocks[j][i]);
      }
    }
  }

  return { matrix: makeMatrix(ver, result, 'M'), size: 17 + ver * 4 };
}

/* ─────────────────────────────── PNG writer (1-bit grayscale) ─────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Stored-block DEFLATE inside a zlib wrapper (RFC 1950/1951) — valid, uncompressed. */
function zlibStored(raw) {
  const nBlocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + nBlocks * 5 + 4);
  let o = 0;
  out[o++] = 0x78;
  out[o++] = 0x01;
  let off = 0;
  for (let blockIdx = 0; blockIdx < nBlocks; blockIdx++) {
    const chunkLen = Math.min(65535, raw.length - off);
    const isLast = off + chunkLen >= raw.length;
    out[o++] = isLast ? 1 : 0;
    out[o++] = chunkLen & 0xFF;
    out[o++] = (chunkLen >>> 8) & 0xFF;
    const nlen = (~chunkLen) & 0xFFFF;
    out[o++] = nlen & 0xFF;
    out[o++] = (nlen >>> 8) & 0xFF;
    out.set(raw.subarray(off, off + chunkLen), o);
    o += chunkLen;
    off += chunkLen;
  }
  new DataView(out.buffer).setUint32(o, adler32(raw));
  return out.subarray(0, o + 4);
}

/**
 * Render the QR matrix as a PNG (Uint8Array). `scale` = pixels per module (2..12),
 * `margin` = quiet-zone modules (2..6, default 3). Valid 1-bit grayscale PNG.
 */
export function qrPngBytes(text, { scale = 8, margin = 3 } = {}) {
  const { matrix, size } = qrMatrix(text);
  const s = Math.max(2, Math.min(12, Number(scale) || 8));
  const m = Math.max(2, Math.min(6, Number(margin) || 3));
  const dim = (size + m * 2) * s;
  const rowBytes = Math.ceil(dim / 8);
  const raw = new Uint8Array((rowBytes + 1) * dim);
  // 1-bit grayscale: sample value 1 = white. Start fully white, clear bits for dark modules.
  raw.fill(0xff);
  for (let py = 0; py < dim; py++) {
    const rowStart = py * (rowBytes + 1);
    raw[rowStart] = 0; // filter: None
    const my = Math.floor(py / s) - m;
    for (let px = 0; px < dim; px++) {
      const mx = Math.floor(px / s) - m;
      const dark = my >= 0 && my < size && mx >= 0 && mx < size ? matrix[my][mx] : false;
      if (dark) {
        raw[rowStart + 1 + (px >> 3)] &= ~(0x80 >>> (px & 7)) & 0xFF;
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, dim);
  dv.setUint32(4, dim);
  ihdr[8] = 1; // bit depth: 1
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}
