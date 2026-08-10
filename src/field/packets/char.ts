import type { RowDataPacket } from "mysql2";
import { config } from "../../config.js";
import { query } from "../../db.js";
import { writeHeader, writeCString } from "../../net/packet.js";
import { job3ToWireGuild } from "../skills.js";
import { OP_FIELD_CHAR_ALL, OP_FIELD_ENTER_PLAYER } from "../../protocol/opcodes.js";
import { SELECT_CHARACTERS_BY_ID, SELECT_EQUIP_BY_CHARID_7, SELECT_EQUIP_BY_CHARID_8, SELECT_PETS_BY_CID_AND_TYPE_2 } from "../../db/queries/index.js";

export async function loadCharRow(charId: number): Promise<RowDataPacket | null> {
  const rows = await query<RowDataPacket[]>(SELECT_CHARACTERS_BY_ID, [charId]);
  return rows[0] ?? null;
}

export function u8(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback & 0xff;
  if (v < 0) return 0xff; // legacy: job2/job3 -1 → 0xFF
  return v & 0xff;
}

export function u16(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback & 0xffff;
  return v & 0xffff;
}

export function u32(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback >>> 0;
  return v >>> 0;
}

export async function charAll(charId: number): Promise<Buffer> {
  const c = await loadCharRow(charId);
  const b = Buffer.alloc(132, 0);
  writeHeader(b, OP_FIELD_CHAR_ALL, 132);
  if (!c) return b;
  writeCString(b, 12, String(c.name ?? ""), 40);
  b.writeUInt8(u8(c.sex, 0), 52);
  b.writeUInt8(u8(c.level, 1), 53);
  b.writeUInt8(u8(c.job, 0), 54);
  b.writeUInt8(u8(c.job2, 255), 55);
  // Guild: wire 0=Order / 1=Chaos (DB job3 is 1/2)
  b.writeUInt8(job3ToWireGuild(Number(c.job3 ?? -1)), 56);
  b.writeUInt16LE(u16(c.cmhp, 50), 58);
  b.writeUInt16LE(u16(c.chp, 50), 60);
  b.writeUInt16LE(u16(c.cmmp, 50), 62);
  b.writeUInt16LE(u16(c.cmp, 50), 64);
  b.writeUInt32LE(u32(c.mexp, 30), 68);
  b.writeUInt32LE(u32(c.exp, 0), 76);
  b.writeUInt16LE(u16(c.honor, 0), 84);
  b.writeUInt16LE(u16(c.maxsoul, 20), 86);
  b.writeUInt16LE(u16(c.soul, 0), 88);
  b.writeUInt16LE(771, 90);
  b.writeUInt16LE(u16(c.str, 3), 92);
  b.writeUInt16LE(u16(c.dex, 3), 94);
  b.writeUInt16LE(u16(c.vit, 3), 96);
  b.writeUInt16LE(u16(c.intel, 3), 98);
  b.writeUInt16LE(u16(c.maxdamphy, 10), 100);
  b.writeUInt16LE(u16(c.mindamphy, 10), 102);
  b.writeUInt16LE(u16(c.maxdamw, 0), 104);
  b.writeUInt16LE(u16(c.mindamw, 0), 106);
  b.writeUInt16LE(u16(c.def, 0), 108);
  b.writeUInt16LE(258, 110);
  b.writeUInt16LE(u16(c.st_point, 0), 114);
  b.writeUInt16LE(u16(c.sk_point, 0), 116);
  b.writeUInt16LE(u16(c.p_str, 0), 118);
  b.writeUInt16LE(u16(c.p_dex, 0), 120);
  b.writeUInt16LE(u16(c.p_vit, 0), 122);
  b.writeUInt16LE(u16(c.p_int, 0), 124);
  b.writeUInt16LE(u16(c.p_damphy, 0), 126);
  b.writeUInt16LE(u16(c.p_damw, 0), 128);
  b.writeUInt16LE(u16(c.p_def, 0), 130);
  return b;
}

export async function getEquipMap(charId: number): Promise<Record<number, number>> {
  const rows = await query<RowDataPacket[]>(SELECT_EQUIP_BY_CHARID_7, [charId]);
  const m: Record<number, number> = {};
  for (const r of rows) m[Number(r.pos2)] = Number(r.type);
  return m;
}

export async function enterPlayer(
  charId: number,
  opts?: { x?: number; y?: number; petUseSlot?: number; map?: number; region?: number },
): Promise<Buffer> {
  const c = await loadCharRow(charId);
  const b = Buffer.alloc(274, 0);
  writeHeader(b, OP_FIELD_ENTER_PLAYER, 274);
  if (!c) return b;
  const eq = await getEquipMap(charId);
  const x = opts?.x ?? Number(c.charX ?? 0);
  const y = opts?.y ?? Number(c.charY ?? 0);
  // Prefer live field map — cash UI sync (0x45bc20) only runs when map==77 in this packet.
  const map = opts?.map ?? Number(c.map ?? 1);
  const region = opts?.region ?? Number(c.region ?? 1);
  b.writeUInt32LE(charId, 12);
  writeCString(b, 16, String(c.name ?? ""), 40);
  b.writeUInt16LE(u16(map, 1), 56);
  b.writeUInt16LE(u16(region, 1), 58);
  b.writeUInt16LE(u16(x, 0), 60);
  b.writeUInt16LE(u16(y, 0), 62);
  b.writeUInt8(u8(c.sex, 0), 64);
  b.writeUInt8(u8(c.level, 1), 65);
  b.writeUInt8(u8(c.job, 0), 66);
  b.writeUInt8(u8(c.job2, 255), 67);
  // Guild: wire 0=Order / 1=Chaos (DB job3 is 1/2)
  b.writeUInt8(job3ToWireGuild(Number(c.job3 ?? -1)), 68);
  b.writeUInt32LE(0, 72);
  b.writeUInt32LE(eq[7] ?? 0, 76); // hair
  b.writeUInt32LE(eq[9] ?? 0, 80);
  b.writeUInt32LE(eq[12] ?? 0, 84);
  b.writeUInt32LE(eq[6] ?? 0, 88);
  b.writeUInt32LE(eq[8] ?? 0, 92);
  b.writeUInt32LE(eq[1] ?? 0, 96);
  b.writeUInt32LE(eq[11] ?? 0, 100);
  b.writeUInt32LE(eq[0] ?? 0, 104);
  b.writeUInt32LE(eq[4] ?? 0, 108);
  const petRows = await query<RowDataPacket[]>(
    SELECT_PETS_BY_CID_AND_TYPE_2,
    [charId],
  );
  let weaponGlow = 0;
  const wrows = await query<RowDataPacket[]>(
    SELECT_EQUIP_BY_CHARID_8,
    [charId],
  );
  if (wrows.length) {
    const w = [20, 15, 12, 9, 7, 5, 4, 3, 2, 1];
    const lv = [
      wrows[0]!.p_10, wrows[0]!.p_9, wrows[0]!.p_8, wrows[0]!.p_7, wrows[0]!.p_6,
      wrows[0]!.p_5, wrows[0]!.p_4, wrows[0]!.p_3, wrows[0]!.p_2, wrows[0]!.p_1,
    ].map((x) => Number(x ?? 0));
    weaponGlow = lv.reduce((a, v, i) => a + v * w[i]!, 0);
  }
  if (petRows.length) {
    const pr = petRows[0]!;
    b.writeUInt32LE(Number(pr.itemId), 112);
    b.writeUInt32LE(eq[15] ?? 0, 116); // toy
    writeCString(b, 120, String(pr.name || "Pet"), 20);
    b.writeUInt32LE(Number(pr.level ?? 1), 140);
    b.writeUInt32LE(Number(pr.hp ?? 100), 144);
    b.writeUInt32LE(Number(pr.mp ?? 100), 148);
    b.writeUInt32LE(Number(pr.exp ?? 0), 152);
    b.writeUInt32LE(Number(pr.decorateId ?? 0), 156);
    let use = opts?.petUseSlot ?? 0;
    if (use === 0xff) use = 0;
    b.writeUInt32LE(use, 160);
  } else {
    b.writeUInt32LE(0, 112);
    b.writeUInt32LE(eq[15] ?? 0, 116);
  }
  b.writeUInt16LE(0, 200);
  b.writeUInt16LE(weaponGlow & 0xffff, 202);
  b.writeUInt16LE(0, 204);
  b.writeUInt8(127, 206);
  b.writeUInt8(0, 207);
  b.writeUInt8(0, 208);
  b.writeUInt8(1, 209);
  b.writeUInt8(127, 210);
  b.writeUInt8(0, 211);
  b.writeUInt8(0, 212);
  b.writeUInt8(1, 213);
  b.writeUInt16LE(config.udpPort, 214);
  return b;
}

