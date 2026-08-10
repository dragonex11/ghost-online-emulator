/**
 * Ghost Online client password wire codec (Ghost Online client).
 *
 * Client packs the password into 4-byte LE chunks, adds a per-login key
 * (u16 in 1000..9999, also embedded in the login packet), bit-permutes,
 * then emits 7 base36 digits (alphabet 0-9A-Z, least-significant digit first)
 * per chunk.
 */

const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Bit-position permutation used when encode flag=1 (login path). */
const FLAG1 = [
  26, 31, 17, 10, 30, 16, 24, 2, 29, 8, 20, 15, 28, 11, 13, 4, 19, 23, 0, 12, 14,
  27, 6, 18, 21, 3, 9, 7, 22, 1, 25, 5,
];

const INV1 = (() => {
  const inv = new Array<number>(32);
  for (let i = 0; i < 32; i++) inv[FLAG1[i]!] = i;
  return inv;
})();

function transform(value: number, table: number[]): number {
  let v = value >>> 0;
  if (v === 0) return 0;
  let out = 0;
  let bitIndex = 0;
  while (v) {
    if (v & 1) out += 1 << table[bitIndex]!;
    v >>>= 1;
    bitIndex++;
  }
  return out >>> 0;
}

function toB36Lsd(n: number, width = 7): string {
  let x = n >>> 0;
  let s = "";
  for (let i = 0; i < width; i++) {
    s += ALPHA[x % 36];
    x = Math.floor(x / 36);
  }
  return s;
}

function fromB36Lsd(s: string): number {
  let n = 0;
  let p = 1;
  for (const ch of s) {
    const idx = ALPHA.indexOf(ch);
    if (idx < 0) return 0;
    n += idx * p;
    p *= 36;
  }
  return n >>> 0;
}

/** Encode plaintext password with the client session key. */
export function encodePassword(plain: string, key: number): string {
  const data = Buffer.alloc(plain.length + 4, 0);
  data.write(plain, "ascii");
  let out = "";
  for (let esi = 0; esi < plain.length; esi += 4) {
    const chunk = data.readUInt32LE(esi);
    const val = (chunk + (key >>> 0)) >>> 0;
    out += toB36Lsd(transform(val, FLAG1));
  }
  return out;
}

/** Best-effort decode of wire password back to plaintext (for auto-create). */
export function decodePassword(wire: string, key: number): string | null {
  if (!wire || wire.length % 7 !== 0) return null;
  if (![...wire].every((c) => ALPHA.includes(c))) return null;
  const parts: number[] = [];
  for (let i = 0; i < wire.length; i += 7) {
    const n = fromB36Lsd(wire.slice(i, i + 7));
    const chunk = (transform(n, INV1) - (key >>> 0)) >>> 0;
    parts.push(chunk);
  }
  const buf = Buffer.alloc(parts.length * 4);
  for (let i = 0; i < parts.length; i++) buf.writeUInt32LE(parts[i]!, i * 4);
  const nul = buf.indexOf(0);
  const raw = nul >= 0 ? buf.subarray(0, nul) : buf;
  const text = raw.toString("ascii");
  if (!text || ![...text].every((c) => c >= " " && c <= "~")) return null;
  return text;
}

/** Read encode key from login frame (u16 LE right after password bytes). */
export function readPasswordKey(frame: Buffer, pOff: number, pLen: number): number | null {
  const keyOff = pOff + pLen;
  if (frame.length < keyOff + 2) return null;
  const key = frame.readUInt16LE(keyOff);
  // Client uses (time % 9000) + 1000
  if (key < 1000 || key > 9999) return null;
  return key;
}
