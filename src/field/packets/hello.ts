import { config } from "../../config.js";
import { writeHeader } from "../../net/packet.js";
import { PACKET_MAGIC } from "../../protocol/magic.js";
import { OP_FIELD_HELLO } from "../../protocol/opcodes.js";
import type { FieldKeys } from "../../net/fieldCodec.js";

/** Default hello key material (layout +0x2C / +0x30). */
export const FIELD_HELLO_KEY1 = 0xa1085ba0;
export const FIELD_HELLO_KEY2 = 0x80be7de5;
/** Permanent halves of the field stream cipher. */
export const FIELD_CRYPTO_SEED_LO = 0xebd66b29;
export const FIELD_CRYPTO_SEED_HI = 0x2103a92c;
/** Client refuses field enter unless hello[+0x10] equals this build token. */
export const FIELD_HELLO_TOKEN = 0x1e488bf5;

export let nextHelloId = 200;

export function bumpHelloId(): number {
  const id = nextHelloId++;
  if (nextHelloId > 0x7fffffff) nextHelloId = 200;
  return id;
}

export function makeFieldKeys(key1: number, key2: number): FieldKeys {
  return {
    key1: (FIELD_CRYPTO_SEED_LO ^ key1) >>> 0,
    key2: (FIELD_CRYPTO_SEED_HI ^ key2) >>> 0,
  };
}

export function initPacket(
  id: number,
  magic = PACKET_MAGIC,
  keys?: { key1: number; key2: number },
): Buffer {
  const b = Buffer.alloc(40, 0);
  writeHeader(b, OP_FIELD_HELLO, 40, magic);
  b.writeUInt32LE(id, 12);
  const k1 = keys?.key1 ?? FIELD_HELLO_KEY1;
  const k2 = keys?.key2 ?? FIELD_HELLO_KEY2;
  // token@+0x10, udp@+0x14, prefix@+0x18, keys@+0x20/+0x24 (40B total)
  b.writeUInt32LE(FIELD_HELLO_TOKEN, 16);
  b.writeUInt16LE(config.udpPort & 0xffff, 20);
  b.writeUInt16LE(0, 22);
  Buffer.from("E2D315013ABB5D52", "hex").copy(b, 24);
  b.writeUInt32LE(k1 >>> 0, 0x20);
  b.writeUInt32LE(k2 >>> 0, 0x24);
  return b;
}

export { PACKET_MAGIC };
