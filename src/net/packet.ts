import { config } from "../config.js";

export function hexToBuf(hex: string): Buffer {
  const clean = hex.replace(/^0x/i, "").replace(/\s+/g, "");
  return Buffer.from(clean, "hex");
}

export function bufToHex(buf: Buffer): string {
  return buf.toString("hex").toUpperCase();
}

export function logPkt(dir: "IN" | "OUT", tag: string, buf: Buffer): void {
  if (!config.pktLog) return;
  const preview = bufToHex(buf.subarray(0, Math.min(buf.length, 64)));
  console.log(`[pkt ${dir}] ${tag} len=${buf.length} ${preview}${buf.length > 64 ? "..." : ""}`);
}

/** Login framing: AA 55 | u16le len | payload | 55 AA */
export function frameAA55(payload: Buffer): Buffer {
  const out = Buffer.alloc(4 + payload.length + 2);
  out[0] = 0xaa;
  out[1] = 0x55;
  out.writeUInt16LE(payload.length, 2);
  payload.copy(out, 4);
  out[out.length - 2] = 0x55;
  out[out.length - 1] = 0xaa;
  return out;
}

export function peelAA55(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let off = 0;
  while (off + 6 <= buf.length) {
    if (buf[off] !== 0xaa || buf[off + 1] !== 0x55) {
      off++;
      continue;
    }
    const len = buf.readUInt16LE(off + 2);
    const total = 4 + len + 2;
    if (off + total > buf.length) break;
    if (buf[off + total - 2] !== 0x55 || buf[off + total - 1] !== 0xaa) {
      off++;
      continue;
    }
    frames.push(buf.subarray(off, off + total));
    off += total;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * Game framing: magic u16 | opcode u16 | totalLen u16 | crc u16 | unk u32 | body
 * - Game4 / TW: magic = 0x0105 (bytes 05 01), crc = opcode + totalLen + magic
 * - en-client:  magic = 0x0037 (bytes 37 00), same crc formula
 * Outbound replies keep Game4 magic; clients validate CRC from the packet's own magic.
 */
export function writeHeader(buf: Buffer, opcode: number, totalLen: number, magic = 0x0105, unk = 0): void {
  buf.writeUInt16LE(magic & 0xffff, 0);
  buf.writeUInt16LE(opcode & 0xffff, 2);
  buf.writeUInt16LE(totalLen & 0xffff, 4);
  buf.writeUInt16LE((opcode + totalLen + magic) & 0xffff, 6);
  buf.writeUInt32LE(unk >>> 0, 8);
}

export function makePacket(opcode: number, bodyLen: number, fill?: (buf: Buffer) => void): Buffer {
  const total = 12 + bodyLen;
  const buf = Buffer.alloc(total, 0);
  writeHeader(buf, opcode, total);
  if (fill) fill(buf);
  return buf;
}

/**
 * legacy SPLITDATA parity: frame by totalLen at +4; do not require 05 01 magic.
 * en-client field compression uses opcode 0x81 where length = body size after the
 * 12-byte header (total wire size = 12 + length).
 */
export function peelGame(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    const opcode = buf.readUInt16LE(off + 2);
    const lenField = buf.readUInt16LE(off + 4);
    const total = opcode === 0x81 ? 12 + lenField : lenField;
    if (total < 12 || total > 0x8000 || lenField > 0x8000) {
      off++;
      continue;
    }
    if (off + total > buf.length) break;
    frames.push(buf.subarray(off, off + total));
    off += total;
  }
  return { frames, rest: buf.subarray(off) };
}

export function opcodeOf(pkt: Buffer): number {
  return pkt.readUInt16LE(2);
}

export function writeCString(buf: Buffer, offset: number, str: string, maxLen: number): void {
  const slice = Buffer.alloc(maxLen, 0);
  Buffer.from(str, "ascii").copy(slice, 0, 0, maxLen - 1);
  slice.copy(buf, offset);
}

export function readCString(buf: Buffer, offset: number, maxLen = 64): string {
  const end = Math.min(buf.length, offset + maxLen);
  let i = offset;
  while (i < end && buf[i] !== 0) i++;
  return buf.subarray(offset, i).toString("ascii");
}
