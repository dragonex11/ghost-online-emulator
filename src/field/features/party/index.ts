/**
 * Party system — C# PartyHandler / PartyPacket parity (Messages.cs opcodes).
 *
 * Client:  PARTY_INVITE_REQ 0x9B, RESPONSES 0x9C, LEAVE 0x9F
 * Server:  PARTY_INVITE 0x9B, RESPONSES 0x9C, UPDATE 0x9D, HP 0xA1, DISMISS 0xA2
 */
import { writeHeader, writeCString } from "../../../net/packet.js";

export type PartyMemberSnap = {
  charId: number;
  name: string;
  level: number;
  maxHp: number;
  hp: number;
  maxMp: number;
  mp: number;
  /** IPv4 bytes for the 8-byte peer block (duplicated in packet). */
  ip: [number, number, number, number];
};

/** charId → ordered party members (index 0 = leader). Shared list refs across members. */
const parties = new Map<number, number[]>();

export function getParty(charId: number): number[] | undefined {
  return parties.get(charId);
}

export function clearParty(charId: number): void {
  const list = parties.get(charId);
  if (!list) return;
  for (const id of [...list]) parties.delete(id);
}

export function setSharedParty(memberIds: number[]): void {
  const list = [...memberIds];
  for (const id of list) parties.set(id, list);
}

export function removeFromParty(charId: number): number[] {
  const list = parties.get(charId);
  if (!list) return [];
  const next = list.filter((id) => id !== charId);
  parties.delete(charId);
  if (next.length <= 1) {
    for (const id of next) parties.delete(id);
    return next;
  }
  for (const id of next) parties.set(id, next);
  return next;
}

export function buildPartyInvite(inviterCharId: number): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x009b, 16);
  b.writeInt32LE(inviterCharId | 0, 12);
  return b;
}

export function buildPartyInviteResponses(response: number): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x009c, 16);
  b.writeInt32LE(response | 0, 12);
  return b;
}

/** PARTY_UPDATE 0x9D — 6 member slots × 44 bytes + 12 header = 276 */
export function buildPartyUpdate(members: PartyMemberSnap[]): Buffer {
  const b = Buffer.alloc(276, 0);
  writeHeader(b, 0x009d, 276);
  for (let i = 0; i < 6; i++) {
    const off = 12 + i * 44;
    const m = members[i];
    if (!m) {
      b.writeInt32LE(-1, off);
      continue;
    }
    b.writeInt32LE(m.charId | 0, off);
    b.writeUInt16LE(m.level & 0xffff, off + 4);
    writeCString(b, off + 6, m.name, 20);
    b.writeUInt16LE(m.maxHp & 0xffff, off + 26);
    b.writeUInt16LE(m.hp & 0xffff, off + 28);
    b.writeUInt16LE(m.maxMp & 0xffff, off + 30);
    b.writeUInt16LE(m.mp & 0xffff, off + 32);
    b.writeUInt16LE(0x401f, off + 34); // C# WriteHexString("1F 40")
    const [a, bb, c, d] = m.ip;
    b.writeUInt8(a & 0xff, off + 36);
    b.writeUInt8(bb & 0xff, off + 37);
    b.writeUInt8(c & 0xff, off + 38);
    b.writeUInt8(d & 0xff, off + 39);
    b.writeUInt8(a & 0xff, off + 40);
    b.writeUInt8(bb & 0xff, off + 41);
    b.writeUInt8(c & 0xff, off + 42);
    b.writeUInt8(d & 0xff, off + 43);
  }
  return b;
}

export function buildPartyHpUpdate(charId: number, maxHp: number, hp: number, maxMp: number, mp: number): Buffer {
  const b = Buffer.alloc(28, 0);
  writeHeader(b, 0x00a1, 28);
  b.writeInt32LE(charId | 0, 12);
  b.writeUInt16LE(maxHp & 0xffff, 16);
  b.writeUInt16LE(hp & 0xffff, 18);
  b.writeUInt16LE(maxMp & 0xffff, 20);
  b.writeUInt16LE(mp & 0xffff, 22);
  return b;
}

export function buildPartyDismiss(): Buffer {
  const b = Buffer.alloc(12, 0);
  writeHeader(b, 0x00a2, 12);
  return b;
}

export function isPartyOpcode(op: number): boolean {
  return op === 0x009b || op === 0x009c || op === 0x009f || op === 0x00a0;
}
