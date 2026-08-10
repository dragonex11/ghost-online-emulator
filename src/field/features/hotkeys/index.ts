import type { RowDataPacket } from "mysql2";
import { query, execute } from "../../../db/index.js";
import { writeHeader } from "../../../net/packet.js";
import { DELETE_SKILL_HOTKEYS_BY_CHARID_AND_KEYNAME, INSERT_SKILL_HOTKEYS, SELECT_SKILL_HOTKEYS_BY_CHARID } from "../../../db/queries/index.js";

const KEYS = [
  "Z", "X", "C", "V", "B", "N",
  "1", "2", "3", "4", "5", "6",
  "Insert", "Home", "PageUp", "Delete", "End", "PageDown",
  "7", "8", "9", "0", "-", "=",
];

export function quickSlotKeyName(type: number, slot: number): string {
  const map: Record<number, string[]> = {
    0: ["Z", "X", "C", "V", "B", "N"],
    1: ["1", "2", "3", "4", "5", "6"],
    2: ["Insert", "Home", "PageUp", "Delete", "End", "PageDown"],
    3: ["7", "8", "9", "0", "-", "="],
  };
  return map[type]?.[slot] ?? "";
}

export async function buildQuickSlotAll(charId: number): Promise<Buffer> {
  const b = Buffer.alloc(204, 0);
  writeHeader(b, 0x00a9, 204);
  for (let i = 0; i < 24; i++) {
    b.writeInt32LE(-1, 12 + i * 8);
    b.writeInt16LE(-1, 16 + i * 8);
    b.writeInt16LE(-1, 18 + i * 8);
  }
  try {
    const rows = await query<RowDataPacket[]>(
      SELECT_SKILL_HOTKEYS_BY_CHARID,
      [charId],
    );
    for (const r of rows) {
      const idx = KEYS.indexOf(String(r.keyname));
      if (idx < 0) continue;
      b.writeInt32LE(Number(r.skillid), 12 + idx * 8);
      b.writeInt16LE(Number(r.stype), 16 + idx * 8);
      b.writeInt16LE(Number(r.sslot), 18 + idx * 8);
    }
  } catch (e) {
    console.error("[hotkeys] buildQuickSlotAll", e);
  }
  return b;
}

export async function saveQuickSlot(charId: number, pkt: Buffer): Promise<void> {
  const ktype = pkt.readUInt16LE(12);
  const kslot = pkt.readUInt16LE(14);
  let sid = pkt.readInt32LE(16);
  let stype = pkt.readInt16LE(20);
  let sslot = pkt.readInt16LE(22);
  if ((stype & 0xffff) === 0xffff) stype = -1;
  if ((sslot & 0xffff) === 0xffff) sslot = -1;
  if ((sid >>> 0) === 0xffffffff) sid = -1;
  const key = quickSlotKeyName(ktype, kslot);
  if (!key) return;
  await execute(DELETE_SKILL_HOTKEYS_BY_CHARID_AND_KEYNAME, [charId, key]);
  if (!(sid === -1 && stype === -1 && sslot === -1)) {
    await execute(INSERT_SKILL_HOTKEYS, [
      charId,
      key,
      sid,
      stype,
      sslot,
    ]);
  }
}
