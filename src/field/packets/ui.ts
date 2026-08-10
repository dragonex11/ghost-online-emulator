import type { Player } from "../player.js";
import { players, send } from "../player.js";
import { writeHeader, writeCString } from "../../net/packet.js";
import { OP_FIELD_MAP_INFO } from "../../protocol/opcodes.js";
import { getParty, buildPartyHpUpdate } from "../features/party/index.js";

export function writeChangeMapPacket(p: Player, map: number, region: number, x: number, y: number): Buffer {
  // CHANGEMAP 0x86: map/region as u16 @+16/+18 (unlike mapInfo 0x1c u8 packing).
  const chg = Buffer.alloc(46, 0);
  writeHeader(chg, 0x0086, 46);
  chg.writeUInt32LE(1, 12);
  chg.writeUInt16LE(map & 0xffff, 16);
  chg.writeUInt16LE(region & 0xffff, 18);
  chg.writeUInt16LE(x & 0xffff, 20);
  chg.writeUInt16LE(y & 0xffff, 22);
  chg.writeUInt16LE(map & 0xffff, 24);
  chg.writeUInt16LE(region & 0xffff, 26);
  chg.writeUInt16LE(x & 0xffff, 28);
  chg.writeUInt16LE(y & 0xffff, 30);
  return chg;
}


export function mapInfo(p: Player): Buffer {
  const b = Buffer.alloc(42, 0);
  writeHeader(b, OP_FIELD_MAP_INFO, 42);
  // MAP_INFO: map/region as adjacent u8 @+12/+13 (u16 packing loads wrong .prj).
  b.writeUInt8(p.map & 0xff, 12);
  b.writeUInt8(p.region & 0xff, 13);
  b.writeUInt16LE(p.x & 0xffff, 14);
  b.writeUInt16LE(p.y & 0xffff, 16);
  b.writeUInt8(p.map & 0xff, 18);
  b.writeUInt8(p.region & 0xff, 19);
  b.writeUInt16LE(p.x & 0xffff, 20);
  b.writeUInt16LE(p.y & 0xffff, 22);
  return b;
}


export function leavePacket(charId: number): Buffer {
  const b = Buffer.alloc(38, 0);
  writeHeader(b, 0x001f, 38);
  b.writeUInt32LE(charId, 12);
  return b;
}


export function notice(msg: string, type = 3): Buffer {
  const b = Buffer.alloc(80, 0);
  writeHeader(b, 0x0012, 80);
  b.writeUInt8(type, 12);
  writeCString(b, 13, msg.slice(0, 59), 60);
  return b;
}


export function moneyPacket(money: number, delta: number): Buffer {
  const b = Buffer.alloc(28, 0);
  writeHeader(b, 0x006b, 28);
  b.writeInt32LE(money, 12);
  b.writeInt32LE(delta, 20);
  return b;
}


export function hpMpPacket(p: Player): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x0051, 20);
  b.writeUInt16LE(p.hp & 0xffff, 12);
  b.writeUInt16LE(p.mp & 0xffff, 14);
  // fury fields — client divides by max; 0/0 crashes death UI
  const maxSoul = Math.max(1, p.maxSoul | 0);
  b.writeUInt16LE((p.soul | 0) & 0xffff, 16);
  b.writeUInt16LE(maxSoul & 0xffff, 18);
  return b;
}


export function sendVital(p: Player): void {
  send(p, hpMpPacket(p));
  const list = getParty(p.charId);
  if (!list || list.length < 2) return;
  const pkt = buildPartyHpUpdate(p.charId, p.maxHp, p.hp, p.maxMp, p.mp);
  for (const id of list) {
    if (id === p.charId) continue;
    const o = players.get(id);
    if (o?.loggedIn) send(o, pkt);
  }
}


export function lvExpPacket(level: number, exp: number): Buffer {
  const b = Buffer.alloc(54, 0);
  writeHeader(b, 0x005b, 54);
  b.writeUInt32LE(level, 12);
  b.writeUInt32LE(exp, 16);
  return b;
}


export function levelUpPacket(charId: number): Buffer {
  const b = Buffer.alloc(42, 0);
  writeHeader(b, 0x005d, 42);
  b.writeUInt32LE(charId, 12);
  return b;
}

export function playerDeadAck(p: Player): Buffer {
  // opcode 0x48 len 32 — header 0501480020006D01
  const b = Buffer.alloc(32, 0);
  writeHeader(b, 0x0048, 32);
  b.writeUInt32LE(p.charId, 12);
  b.writeUInt16LE(p.map, 16);
  b.writeUInt16LE(p.region, 18);
  b.writeUInt16LE(p.x, 20);
  b.writeUInt16LE(p.y, 22);
  b.writeUInt16LE(p.map, 24);
  b.writeUInt16LE(p.region, 26);
  b.writeUInt16LE(p.x, 28);
  b.writeUInt16LE(p.y, 30);
  return b;
}

