/**
 * en-client field wire codec (opcode 0x81 frames):
 *   header(12) | encrypt( compress(packet) || crc32_raw )
 * Outer header: magic=uncompSize, opcode=0x81, length=bodyLen, crc=magic+0x81+bodyLen
 */

export type FieldKeys = { key1: number; key2: number };

/** Ghost Online field checksum = CRC-32 (poly 0xEDB88320) with init -1 and no final xor. */
export function fieldChecksum(data: Buffer): number {
  let a = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    a ^= data[i]!;
    for (let b = 0; b < 8; b++) {
      a = a & 1 ? (0xedb88320 ^ (a >>> 1)) >>> 0 : a >>> 1;
    }
  }
  return a >>> 0;
}

/** Symmetric stream cipher used by en-client 0x68f580 / 0x68f680. */
export function fieldCrypt(data: Buffer, keys: FieldKeys): Buffer {
  const ks = Buffer.alloc(8);
  ks.writeUInt32LE(keys.key1 >>> 0, 0);
  ks.writeUInt32LE(keys.key2 >>> 0, 4);
  const n = data.length;
  const seed = (n * 0x9d) & 0xff;
  let state = 0x86d;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const idx = i & 7;
    let bl = ks[idx]! ^ data[i]! ^ ((state >>> 8) & 0xff) ^ seed;
    out[i] = bl & 0xff;
    state = Math.imul(state, 2171) >>> 0;
  }
  return out;
}

/** LZ decompress (en-client 0x628370). */
export function fieldDecompress(src: Buffer, uncompSize: number): Buffer | null {
  const out = Buffer.alloc(uncompSize);
  let si = 0;
  let di = 0;
  try {
    while (di < uncompSize && si < src.length) {
      const token = src[si++]!;
      if (token < 0x20) {
        const n = token + 1;
        if (si + n > src.length || di + n > uncompSize) return null;
        src.copy(out, di, si, si + n);
        si += n;
        di += n;
      } else {
        let matchLen = token >>> 5;
        const hi = token & 0x1f;
        if (matchLen === 7) {
          if (si >= src.length) return null;
          matchLen = src[si++]! + 7;
        }
        if (si >= src.length) return null;
        const lo = src[si++]!;
        let srcIdx = di - ((hi << 8) + 1 + lo);
        const copyN = matchLen + 2;
        if (srcIdx < 0 || di + copyN > uncompSize) return null;
        for (let k = 0; k < copyN; k++) {
          out[di++] = out[srcIdx++]!;
        }
      }
    }
    if (di !== uncompSize) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * LZ compress matching en-client 0x628370.
 * Prefers back-references (cash lists are mostly empty slots → tiny wire size).
 */
export function fieldCompress(src: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    let bestLen = 0;
    let bestDist = 0;
    const maxDist = Math.min(i, 0x1fff);
    const maxLen = Math.min(src.length - i, 7 + 255);
    for (let dist = 1; dist <= maxDist; dist++) {
      let len = 0;
      while (len < maxLen && src[i + len] === src[i - dist + len]) len++;
      if (len > bestLen && len >= 3) {
        bestLen = len;
        bestDist = dist;
        if (bestLen >= maxLen) break;
      }
    }
    // matchLen 0 (copy 2) with small dist → token < 0x20, misread as literal. Need copy >= 3.
    if (bestLen >= 3) {
      const matchLen = bestLen - 2; // stored as matchLen; decompress adds +2
      const distCode = bestDist - 1; // decompress: (hi<<8)+1+lo
      const hi = (distCode >>> 8) & 0x1f;
      const lo = distCode & 0xff;
      if (matchLen < 7) {
        out.push((matchLen << 5) | hi);
      } else {
        out.push((7 << 5) | hi);
        out.push(matchLen - 7);
      }
      out.push(lo);
      i += bestLen;
    } else {
      // literal run up to 0x20 bytes
      const start = i;
      i++;
      while (i < src.length && i - start < 0x20) {
        // stop if a profitable match starts here
        let look = 0;
        const md = Math.min(i, 0x1fff);
        for (let d = 1; d <= md && look < 3; d++) {
          let len = 0;
          while (len < 4 && i + len < src.length && src[i + len] === src[i - d + len]) len++;
          if (len >= 3) {
            look = len;
            break;
          }
        }
        if (look >= 3) break;
        i++;
      }
      const n = i - start;
      out.push(n - 1);
      for (let k = start; k < i; k++) out.push(src[k]!);
    }
  }
  return Buffer.from(out);
}

/**
 * Wrap an inner game packet as outbound 0x81 for en-client.
 * Client peel (0x654ba1 / 0x666eaa) decompresses the body directly — no crypt/crc32.
 * Outer: magic=uncompSize, opcode=0x81, length=bodyLen (comp only), crc=magic+0x81+bodyLen.
 */
export function encodeFieldFrame(inner: Buffer, _keys?: FieldKeys): Buffer {
  if (inner.length > 0xffff) throw new Error(`field frame too large: ${inner.length}`);
  const compressed = fieldCompress(inner);
  const bodyLen = compressed.length;
  const total = 12 + bodyLen;
  if (total > 0xffff) throw new Error(`compressed frame too large: ${total}`);
  const out = Buffer.alloc(total);
  out.writeUInt16LE(inner.length & 0xffff, 0); // uncomp size
  out.writeUInt16LE(0x81, 2);
  out.writeUInt16LE(bodyLen & 0xffff, 4);
  out.writeUInt16LE((inner.length + 0x81 + bodyLen) & 0xffff, 6);
  out.writeUInt32LE(0, 8);
  compressed.copy(out, 12);
  return out;
}

/**
 * Decode one outer 0x81 frame into the inner game packet.
 * Frame layout: [12-byte hdr][encrypted body of length field].
 */
export function decodeFieldFrame(frame: Buffer, keys: FieldKeys): Buffer | null {
  if (frame.length < 16) return null;
  const opcode = frame.readUInt16LE(2);
  if (opcode !== 0x81) return frame;
  const uncompSize = frame.readUInt16LE(0);
  const bodyLen = frame.readUInt16LE(4);
  if (12 + bodyLen !== frame.length || bodyLen < 4) return null;
  const body = frame.subarray(12, 12 + bodyLen);
  const dec = fieldCrypt(body, keys);
  const payload = dec.subarray(0, bodyLen - 4);
  const expect = dec.readUInt32LE(bodyLen - 4);
  const got = fieldChecksum(payload);
  if (got !== expect) {
    console.warn(
      `[field-codec] checksum mismatch got=${got.toString(16)} expect=${expect.toString(16)} body=${bodyLen}`,
    );
    // still try decompress — some builds may differ
  }
  return fieldDecompress(payload, uncompSize);
}
