import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { writeHeader, writeCString } from "../net/packet.js";

/** Bag slot used when pet was last equipped (legacy $PET_USESLOT) */
const petUseSlots = new Map<number, number>();
/** Spend-bag UseSlot for 飛鏢 / bait (York chr.UseSlot[Spend3]) */
const spendUseSlots = new Map<number, number>();

export function getPetUseSlot(charId: number): number {
  const v = petUseSlots.get(charId);
  return v === undefined ? 0xff : v;
}

export function setPetUseSlot(charId: number, slot: number): void {
  petUseSlots.set(charId, slot);
}

export function getSpendUseSlot(charId: number): number {
  const v = spendUseSlots.get(charId);
  return v === undefined ? 0xff : v;
}

export function setSpendUseSlot(charId: number, slot: number): void {
  spendUseSlots.set(charId, slot);
}

/** en-client (magic 0x37) uses 20 bag slots; Game4 uses 24. */
export function isEnClient(magic: number): boolean {
  return (magic & 0xffff) === 0x0037;
}

export function invSlotsForMagic(magic: number): number {
  return isEnClient(magic) ? 20 : 24;
}

/** ItemId/100000 → bag: 0 worn unused, 1/2 equip bags, 3 spend, 4 other, 5 pet */
export function getItemType(itemId: number): number {
  const g = Math.floor(itemId / 100000);
  if ([79, 80, 81, 93, 95].includes(g)) return 1;
  if ([75, 82, 83, 84, 85, 86, 87, 94].includes(g)) return 2;
  if (g === 11 || g === 88) return 3;
  if (g === 89) return 4;
  if (g === 92 || itemId === 7820501) return 5;
  return 0;
}

async function freeSlot(charId: number, pos1: number, maxSlots = 24): Promise<number> {
  const max = pos1 === 0 ? 13 : maxSlots;
  let rows: RowDataPacket[] = [];
  if (pos1 < 3) {
    rows = await query<RowDataPacket[]>("SELECT pos2 FROM equip WHERE charid=? AND pos1=?", [charId, pos1]);
  } else if (pos1 === 3) {
    rows = await query<RowDataPacket[]>("SELECT pos2 FROM spend WHERE charid=? AND pos1=3", [charId]);
  } else if (pos1 === 4) {
    rows = await query<RowDataPacket[]>("SELECT pos2 FROM other WHERE charid=? AND pos1=4", [charId]);
  } else if (pos1 === 5) {
    rows = await query<RowDataPacket[]>("SELECT slot AS pos2 FROM pets WHERE cid=? AND type=5", [charId]);
  }
  const used = new Set(rows.map((r) => Number(r.pos2)));
  for (let s = 0; s < max; s++) if (!used.has(s)) return s;
  return -1;
}

export async function buildEquip(charId: number): Promise<Buffer> {
  const b = Buffer.alloc(458, 0);
  writeHeader(b, 0x0065, 458);
  const rows = await query<RowDataPacket[]>("SELECT * FROM equip WHERE charid=? AND pos1=0 ORDER BY pos2", [charId]);
  for (const r of rows) {
    const slot = Number(r.pos2);
    if (slot < 0 || slot > 15) continue;
    b.writeUInt32LE(Number(r.type), 12 + 4 * slot);
    b.writeUInt8(Number(r.slot ?? 0) & 0xff, 80 + slot);
    const levels = [r.p_10, r.p_9, r.p_8, r.p_7, r.p_6, r.p_5, r.p_4, r.p_3, r.p_2, r.p_1];
    for (let k = 0; k < 10; k++) b.writeUInt8(Number(levels[k] ?? 0) & 0xff, 97 + slot * 10 + k);
    b.writeUInt16LE(Number(r.soulperc ?? 0) & 0xffff, 268 + 2 * slot);
  }
  const pet = await query<RowDataPacket[]>("SELECT * FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1", [charId]);
  if (pet.length) {
    const p = pet[0];
    b.writeUInt32LE(Number(p.itemId), 12 + 4 * 10);
    writeCString(b, 406, String(p.name || "Pet"), 20);
    b.writeUInt8(Number(p.level ?? 1) & 0xff, 426);
    b.writeUInt32LE(Number(p.hp ?? 100), 428);
    b.writeUInt32LE(Number(p.mp ?? 100), 432);
    b.writeUInt32LE(Number(p.exp ?? 0), 436);
    let use = getPetUseSlot(charId);
    if (use === 0xff) use = 0;
    b.writeInt32LE(use, 440);
    b.writeInt32LE(-1, 444);
    b.writeInt32LE(-1, 448);
  } else {
    b.writeInt32LE(-1, 440);
    b.writeInt32LE(-1, 444);
    b.writeInt32LE(-1, 448);
  }
  return b;
}

async function buildEquipBag(charId: number, pos1: number, opcode: number, magic: number): Promise<Buffer> {
  const en = isEnClient(magic);
  const slots = invSlotsForMagic(magic);
  // en-client: len 692, iscash@0x160; Game4: 610/630, iscash@420
  const len = en ? 692 : pos1 === 1 ? 610 : 630;
  const offSlotByte = en ? 0x5c : 108;
  const offLevels = en ? 0x70 : 132;
  const offSoul = en ? 0x138 : 372;
  const offCash = en ? 0x160 : 420;
  const offTime = en ? 0x174 : 444;
  const offSpecial = en ? 0x1c4 : 492;
  const b = Buffer.alloc(len, 0);
  writeHeader(b, opcode, len);
  if (en) {
    for (let s = 0; s < slots; s++) b.writeInt32LE(-1, offTime + 4 * s);
  }
  const rows = await query<RowDataPacket[]>("SELECT * FROM equip WHERE charid=? AND pos1=? ORDER BY pos2", [charId, pos1]);
  for (const r of rows) {
    const slot = Number(r.pos2);
    if (slot < 0 || slot >= slots) continue;
    b.writeUInt32LE(Number(r.type), 12 + 4 * slot);
    b.writeUInt8(Number(r.slot ?? 0) & 0xff, offSlotByte + slot);
    const levels = [r.p_10, r.p_9, r.p_8, r.p_7, r.p_6, r.p_5, r.p_4, r.p_3, r.p_2, r.p_1];
    for (let k = 0; k < 10; k++) b.writeUInt8(Number(levels[k] ?? 0) & 0xff, offLevels + slot * 10 + k);
    b.writeUInt16LE(Number(r.soulperc ?? 0) & 0xffff, offSoul + 2 * slot);
    b.writeUInt8(Number(r.iscash ?? 0) & 0xff, offCash + slot);
    if (en) b.writeInt32LE(Number(r.timeuse ?? -1), offTime + 4 * slot);
    else {
      b.writeUInt16LE(Number(r.timeuse ?? 0) & 0xffff, offTime + 2 * slot);
      b.writeUInt32LE(Number(r.isspecial ?? 0), offSpecial + 4 * slot);
    }
  }
  return b;
}

export function buildEquip1(charId: number, magic = 0x0037): Promise<Buffer> {
  return buildEquipBag(charId, 1, 0x0066, magic);
}
export function buildEquip2(charId: number, magic = 0x0037): Promise<Buffer> {
  return buildEquipBag(charId, 2, 0x0067, magic);
}

export async function buildSpend3(charId: number, magic = 0x0037): Promise<Buffer> {
  const en = isEnClient(magic);
  const slots = invSlotsForMagic(magic);
  // en: 276 iscash@0xD4 UseSlot@0xE8; Game4: 466 iscash@252
  const len = en ? 276 : 466;
  const b = Buffer.alloc(len, 0);
  writeHeader(b, 0x0068, len);
  const rows = await query<RowDataPacket[]>("SELECT * FROM spend WHERE charid=? AND pos1=3 ORDER BY pos2", [charId]);
  let dartSlot = 0xff;
  for (const r of rows) {
    const slot = Number(r.pos2);
    if (slot < 0 || slot >= slots) continue;
    const itemId = Number(r.itemid);
    b.writeUInt32LE(itemId, 12 + 4 * slot);
    if (en) {
      b.writeUInt16LE(Number(r.amount ?? 1) & 0xffff, 0x5c + 2 * slot);
      b.writeUInt32LE(Number(r.per ?? 0), 0x84 + 4 * slot);
      b.writeUInt8(Number(r.iscash ?? 0) & 0xff, 0xd4 + slot);
      b.writeUInt16LE(Number(r.timeuse ?? 0) & 0xffff, 0xea + 2 * slot);
    } else {
      b.writeUInt16LE(Number(r.amount ?? 1) & 0xffff, 108 + 2 * slot);
      b.writeUInt32LE(Number(r.per ?? 0), 156 + 4 * slot);
      b.writeUInt8(Number(r.iscash ?? 0) & 0xff, 252 + slot);
      b.writeInt32LE(Number(r.timeuse ?? 0), 276 + 4 * slot);
      b.writeUInt16LE(Number(r.isspecial ?? 0) & 0xffff, 374 + 2 * slot);
    }
    // 飛鏢 8880011–8880101 — preferred UseSlot for throw skills
    if (dartSlot === 0xff && itemId >= 8880011 && itemId <= 8880101 && Number(r.amount ?? 0) >= 1) {
      dartSlot = slot;
    }
  }
  if (en) {
    // York INVEN_SPEND3: after iscash → UseSlot byte + 0xFF, then term/timeuse shorts.
    // EN layout: iscash ends 0xE8, timeuse @0xEA → UseSlot lives at 0xE8.
    let use = getSpendUseSlot(charId);
    if (use === 0xff || use < 0 || use >= slots) use = dartSlot;
    if (use !== 0xff && (use < 0 || use >= slots)) use = 0xff;
    b.writeUInt8(use & 0xff, 0xe8);
    b.writeUInt8(0xff, 0xe9);
    if (use !== 0xff && getSpendUseSlot(charId) === 0xff) setSpendUseSlot(charId, use);
  }
  return b;
}

export async function buildOther4(charId: number, magic = 0x0037): Promise<Buffer> {
  const en = isEnClient(magic);
  const slots = invSlotsForMagic(magic);
  // en: 232 iscash@0x84; Game4: 462 iscash@156
  const len = en ? 232 : 462;
  const b = Buffer.alloc(len, 0);
  writeHeader(b, 0x0069, len);
  const rows = await query<RowDataPacket[]>("SELECT * FROM other WHERE charid=? AND pos1=4 ORDER BY pos2", [charId]);
  for (const r of rows) {
    const slot = Number(r.pos2);
    if (slot < 0 || slot >= slots) continue;
    b.writeUInt32LE(Number(r.type), 12 + 4 * slot);
    if (en) {
      b.writeUInt16LE(Number(r.amount ?? 1) & 0xffff, 0x5c + 2 * slot);
      b.writeUInt8(Number(r.iscash ?? 0) & 0xff, 0x84 + slot);
      b.writeInt32LE(Number(r.timeuse ?? 0), 0x98 + 4 * slot);
    } else {
      b.writeUInt16LE(Number(r.amount ?? 1) & 0xffff, 108 + 2 * slot);
      b.writeUInt8(Number(r.iscash ?? 0) & 0xff, 156 + slot);
      b.writeInt32LE(Number(r.timeuse ?? 0), 180 + 4 * slot);
      b.writeUInt16LE(Number(r.isspecial ?? 0) & 0xffff, 278 + 2 * slot);
    }
  }
  return b;
}

export async function buildPet5(charId: number, magic = 0x0037): Promise<Buffer> {
  const en = isEnClient(magic);
  const slots = invSlotsForMagic(magic);
  // en-client: len 972 / 20 slots — IsLocked bytes at +0x3B8 (NOT Game4's 1308/@996).
  const len = en ? 972 : 1308;
  const b = Buffer.alloc(len, 0);
  writeHeader(b, 0x006a, len);
  const rows = await query<RowDataPacket[]>(
    "SELECT slot, itemId, name, level, hp, mp, exp, iscash FROM pets WHERE cid=? AND type=5",
    [charId],
  );
  if (en) {
    for (let i = 0; i < slots; i++) b.writeInt32LE(-1, 0x2f0 + 4 * i);
    for (const r of rows) {
      const s = Number(r.slot);
      if (s < 0 || s >= slots) continue;
      b.writeUInt32LE(Number(r.itemId), 0x0c + 4 * s);
      writeCString(b, 0x5c + 20 * s, String(r.name || "Pet"), 20);
      b.writeUInt8(Number(r.level ?? 1) & 0xff, 0x1ec + s);
      b.writeUInt32LE(Number(r.hp ?? 100), 0x200 + 4 * s);
      b.writeUInt32LE(Number(r.exp ?? 0), 0x250 + 4 * s);
      b.writeUInt32LE(Number(r.mp ?? 100), 0x2a0 + 4 * s);
      b.writeUInt16LE(1, 0x340 + 2 * s); // occupied flag
      b.writeUInt8(Number(r.iscash ?? 0) ? 1 : 0, 0x3b8 + s); // IsLocked
    }
  } else {
    for (let i = 0; i < slots; i++) b.writeInt32LE(-1, 900 + 4 * i);
    for (const r of rows) {
      const s = Number(r.slot);
      if (s < 0 || s >= slots) continue;
      b.writeUInt32LE(Number(r.itemId), 12 + 4 * s);
      writeCString(b, 108 + 20 * s, String(r.name || "Pet"), 20);
      b.writeUInt8(Number(r.level ?? 1) & 0xff, 588 + s);
      b.writeUInt32LE(Number(r.hp ?? 100), 612 + 4 * s);
      b.writeUInt32LE(Number(r.exp ?? 0), 708 + 4 * s);
      b.writeUInt32LE(Number(r.mp ?? 100), 804 + 4 * s);
      b.writeUInt16LE(Number(r.iscash ?? 0) ? 1 : 0, 996 + 2 * s);
    }
  }
  return b;
}

export async function buildSetAvatar(charId: number): Promise<Buffer> {
  const b = Buffer.alloc(178, 0);
  writeHeader(b, 0x005c, 178);
  b.writeUInt32LE(charId, 12);
  const rows = await query<RowDataPacket[]>("SELECT * FROM equip WHERE charid=? AND pos1=0", [charId]);
  const arr = new Array(16).fill(0);
  let glow = 0;
  for (const r of rows) {
    const slot = Number(r.pos2);
    if (slot < 0 || slot > 15) continue;
    arr[slot] = Number(r.type);
    if (slot === 0) {
      const lv = [r.p_10, r.p_9, r.p_8, r.p_7, r.p_6, r.p_5, r.p_4, r.p_3, r.p_2, r.p_1].map((x) => Number(x ?? 0));
      const w = [20, 15, 12, 9, 7, 5, 4, 3, 2, 1];
      glow = lv.reduce((a, v, i) => a + v * w[i], 0);
    }
  }
  const pet = await query<RowDataPacket[]>("SELECT * FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1", [charId]);
  const petId = pet.length ? Number(pet[0].itemId) : 0;
  // hair, faceU, faceL, hat, eye, armor, clothes, weapon, cape, pet, toy
  b.writeUInt32LE(arr[7], 16);
  b.writeUInt32LE(arr[9], 20);
  b.writeUInt32LE(arr[12], 24);
  b.writeUInt32LE(arr[6], 28);
  b.writeUInt32LE(arr[8], 32);
  b.writeUInt32LE(arr[1], 36);
  b.writeUInt32LE(arr[11], 40);
  b.writeUInt32LE(arr[0], 44);
  b.writeUInt32LE(arr[4], 48);
  b.writeUInt32LE(petId, 52);
  b.writeUInt32LE(arr[15], 56);
  if (pet.length) {
    const p = pet[0];
    writeCString(b, 60, String(p.name || "Pet"), 20);
    b.writeUInt32LE(Number(p.level ?? 1), 80);
    b.writeUInt32LE(Number(p.hp ?? 100), 84);
    b.writeUInt32LE(Number(p.mp ?? 100), 88);
    b.writeUInt32LE(Number(p.exp ?? 0), 92);
    b.writeUInt32LE(Number(p.decorateId ?? 0), 96);
    let use = getPetUseSlot(charId);
    if (use === 0xff) use = 0;
    b.writeUInt32LE(use, 100);
  } else {
    b.writeInt32LE(-1, 100);
  }
  b.writeUInt16LE(glow & 0xffff, 142);
  return b;
}

export async function buildAllBags(charId: number, magic = 0x0037): Promise<Buffer[]> {
  const bags = [
    await buildEquip(charId),
    await buildEquip1(charId, magic),
    await buildEquip2(charId, magic),
    await buildSpend3(charId, magic),
    await buildOther4(charId, magic),
    await buildPet5(charId, magic),
  ];
  if (isEnClient(magic)) {
    console.log(
      `[inv] bags en char=${charId} lens=${bags.map((b) => b.length).join(",")} ` +
        `(expect 458,692,692,276,232,972)`,
    );
  }
  return bags;
}

/** Returns bag type refreshed, or -1 on failure */
export async function addItemToInventory(
  charId: number,
  itemId: number,
  qty: number,
  isCash = 0,
  term = -1,
  magic = 0x0037,
): Promise<number> {
  let bag = getItemType(itemId);
  if (bag === 0 || bag === 5) bag = 1;
  const amount = Math.max(1, qty);
  const maxSlots = invSlotsForMagic(magic);

  if (bag === 3 || bag === 4) {
    const table = bag === 3 ? "spend" : "other";
    const col = bag === 3 ? "itemid" : "type";
    const exist = await query<RowDataPacket[]>(
      `SELECT * FROM ${table} WHERE ${col}=? AND charid=? AND pos1=? AND iscash=?`,
      [itemId, charId, bag, isCash ? 1 : 0],
    );
    for (const r of exist) {
      const cur = Number(r.amount ?? 0);
      if (cur + amount <= 100) {
        await execute(`UPDATE ${table} SET amount=? WHERE ${col}=? AND charid=? AND pos1=? AND pos2=?`, [
          cur + amount,
          itemId,
          charId,
          bag,
          r.pos2,
        ]);
        return bag;
      }
    }
  }

  const slot = await freeSlot(charId, bag, maxSlots);
  if (slot < 0) return -1;

  if (bag === 1 || bag === 2) {
    const m = await query<RowDataPacket[]>("SELECT COALESCE(MAX(equipid),0) AS m FROM equip");
    const id = Number(m[0]?.m ?? 0) + 1;
    await execute(
      `INSERT INTO equip (equipid,type,charid,pos1,pos2,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse,isspecial)
       VALUES (?,?,?,?,?,0,0,0,0,0,0,0,0,0,0,0,0,?,?,0)`,
      [id, itemId, charId, bag, slot, isCash, term],
    );
  } else if (bag === 3) {
    const m = await query<RowDataPacket[]>("SELECT COALESCE(MAX(spendid),0) AS m FROM spend");
    const id = Number(m[0]?.m ?? 0) + 1;
    await execute(
      "INSERT INTO spend (spendid,itemid,charid,pos1,pos2,amount,iscash,timeuse,isspecial,per) VALUES (?,?,?,?,?,?,?,?,0,0)",
      [id, itemId, charId, bag, slot, amount, isCash, term],
    );
  } else if (bag === 4) {
    const m = await query<RowDataPacket[]>("SELECT COALESCE(MAX(otherid),0) AS m FROM other");
    const id = Number(m[0]?.m ?? 0) + 1;
    await execute(
      "INSERT INTO other (otherid,type,charid,pos1,pos2,amount,iscash,timeuse,isspecial) VALUES (?,?,?,?,?,?,?,?,0)",
      [id, itemId, charId, bag, slot, amount, isCash, term],
    );
  } else return -1;
  return bag;
}

export function isPetItem(itemId: number): boolean {
  return Math.floor(itemId / 100000) === 92 || itemId === 7820501;
}

export async function addPetToBag(
  charId: number,
  itemId: number,
  name = "Pet",
  isCash = 0,
  magic = 0x0037,
): Promise<number> {
  const slot = await freeSlot(charId, 5, invSlotsForMagic(magic));
  if (slot < 0) return -1;
  await execute(
    "INSERT INTO pets (cid, itemId, decorateId, name, level, hp, mp, exp, iscash, type, slot) VALUES (?,?,0,?,1,100,100,0,?,5,?)",
    [charId, itemId, name, isCash ? 1 : 0, slot],
  );
  return 5;
}

export async function removeInvQty(charId: number, type: number, slot: number, qty: number): Promise<number> {
  if (qty < 1) return 0;
  if (type < 3) {
    const rows = await query<RowDataPacket[]>("SELECT type FROM equip WHERE charid=? AND pos1=? AND pos2=?", [
      charId,
      type,
      slot,
    ]);
    if (!rows.length) return 0;
    const iid = Number(rows[0].type);
    await execute("DELETE FROM equip WHERE charid=? AND pos1=? AND pos2=?", [charId, type, slot]);
    return iid;
  }
  if (type === 3) {
    const rows = await query<RowDataPacket[]>("SELECT itemid, amount FROM spend WHERE charid=? AND pos1=3 AND pos2=?", [
      charId,
      slot,
    ]);
    if (!rows.length) return 0;
    const iid = Number(rows[0].itemid);
    const cur = Number(rows[0].amount ?? 1);
    if (qty >= cur) await execute("DELETE FROM spend WHERE charid=? AND pos1=3 AND pos2=?", [charId, slot]);
    else await execute("UPDATE spend SET amount=? WHERE charid=? AND pos1=3 AND pos2=?", [cur - qty, charId, slot]);
    return iid;
  }
  if (type === 4) {
    const rows = await query<RowDataPacket[]>("SELECT type, amount FROM other WHERE charid=? AND pos1=4 AND pos2=?", [
      charId,
      slot,
    ]);
    if (!rows.length) return 0;
    const iid = Number(rows[0].type);
    const cur = Number(rows[0].amount ?? 1);
    if (qty >= cur) await execute("DELETE FROM other WHERE charid=? AND pos1=4 AND pos2=?", [charId, slot]);
    else await execute("UPDATE other SET amount=? WHERE charid=? AND pos1=4 AND pos2=?", [cur - qty, charId, slot]);
    return iid;
  }
  return 0;
}

export type ChangeItemResult = {
  packets: Buffer[];
  /** Avatar packet to broadcast to map (excluding self already sent in packets) */
  broadcastAvatar?: Buffer;
  drop?: { itemId: number; qty: number };
  /** World pet life/end packets to broadcast (no mid-map ENTERPLAYER) */
  petWorld?: Buffer[];
  petUseSlot?: number;
  /** Pet bag/wear move — insert CHAR_ALL after EQUIP */
  petRefresh?: boolean;
  /** legacy sends ENTERPLAYER after every pet move (world follower spawn) */
  petReenter?: boolean;
};

/** Mirror worn pet into equip.pos1=0 pos2=10 so EQUIP/avatar always see it */
export async function petSyncEquipSlot(charId: number): Promise<void> {
  await execute("DELETE FROM equip WHERE charid=? AND pos1=0 AND pos2=10", [charId]);
  const pet = await query<RowDataPacket[]>(
    "SELECT itemId FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1",
    [charId],
  );
  if (!pet.length) return;
  const itemId = Number(pet[0]!.itemId);
  if (!itemId) return;
  const m = await query<RowDataPacket[]>("SELECT COALESCE(MAX(equipid),0) AS m FROM equip");
  await execute(
    "INSERT INTO equip (equipid,type,charid,pos1,pos2,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse,isspecial) VALUES (?,?,?,0,10,0,0,0,0,0,0,0,0,0,0,0,0,0,-1,0)",
    [Number(m[0]?.m ?? 0) + 1, itemId, charId],
  );
}

/** PET_LIFE 0x107 — itemId, hp, mp, charId, life (legacy working hex) */
export function buildPetLife(
  charId: number,
  itemId: number,
  hp = 100,
  mp = 100,
): Buffer {
  const b = Buffer.alloc(32, 0);
  writeHeader(b, 0x0107, 32);
  b.writeUInt32LE(itemId, 12);
  b.writeUInt32LE(hp, 16);
  b.writeUInt32LE(mp, 20);
  b.writeUInt32LE(charId, 24);
  b.writeUInt32LE(hp > 0 ? hp : 100, 28);
  return b;
}

/** PET_LIFE_END 0x108 */
export function buildPetLifeEnd(charId: number): Buffer {
  const b = Buffer.alloc(28, 0);
  writeHeader(b, 0x0108, 28);
  b.writeUInt32LE(0, 12);
  b.writeUInt32LE(0, 16);
  b.writeUInt32LE(0, 20);
  b.writeUInt32LE(charId, 24);
  return b;
}

export async function buildPetWorldState(charId: number): Promise<Buffer> {
  const pet = await query<RowDataPacket[]>(
    "SELECT itemId, hp, mp FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1",
    [charId],
  );
  if (!pet.length) return buildPetLifeEnd(charId);
  const hp = Number(pet[0]!.hp ?? 100) || 100;
  const mp = Number(pet[0]!.mp ?? 100) || 100;
  return buildPetLife(charId, Number(pet[0]!.itemId), hp, mp);
}

async function petMoveItem(
  charId: number,
  srcType: number,
  srcSlot: number,
  dstType: number,
  dstSlot: number,
  magic = 0x0037,
): Promise<ChangeItemResult> {
  const rawDstSlot = dstSlot;
  if (dstType === 0) dstSlot = 10;
  if (srcType === 0) srcSlot = 10;
  const maxSlots = invSlotsForMagic(magic);
  console.log(
    `[pet] move char=${charId} ${srcType}:${srcSlot} -> ${dstType}:${dstSlot} (rawDst=${rawDstSlot})`,
  );
  const src = await query<RowDataPacket[]>("SELECT id FROM pets WHERE cid=? AND type=? AND slot=?", [
    charId,
    srcType,
    srcSlot,
  ]);
  if (!src.length) {
    console.log(`[pet] move rejected: no source`);
    return { packets: [] };
  }
  const dst = await query<RowDataPacket[]>("SELECT id FROM pets WHERE cid=? AND type=? AND slot=?", [
    charId,
    dstType,
    dstSlot,
  ]);
  let petUseSlot = getPetUseSlot(charId);
  if (!dst.length) {
    let slot = dstSlot;
    if (dstType === 5) {
      // Honor clicked bag slot when valid; otherwise restore prior useslot / first free
      if (slot >= maxSlots) {
        const prefer = getPetUseSlot(charId);
        if (prefer < maxSlots) {
          const occ = await query<RowDataPacket[]>(
            "SELECT id FROM pets WHERE cid=? AND type=5 AND slot=?",
            [charId, prefer],
          );
          slot = occ.length ? await freeSlot(charId, 5, maxSlots) : prefer;
        } else {
          slot = await freeSlot(charId, 5, maxSlots);
        }
        if (slot < 0) return { packets: [] };
      }
    }
    await execute("UPDATE pets SET type=?, slot=? WHERE id=?", [dstType, slot, src[0].id]);
    if (srcType === 5 && dstType === 0) petUseSlot = srcSlot;
    else if (dstType === 5) petUseSlot = 0xff;
    console.log(`[pet] moved to type=${dstType} slot=${slot}`);
  } else {
    const srcId = Number(src[0].id);
    const dstId = Number(dst[0].id);
    await execute("UPDATE pets SET type=99, slot=99 WHERE id=?", [srcId]);
    await execute("UPDATE pets SET type=?, slot=? WHERE id=?", [srcType, srcSlot, dstId]);
    await execute("UPDATE pets SET type=?, slot=? WHERE id=?", [dstType, dstSlot, srcId]);
    if (dstType === 0) petUseSlot = srcSlot;
    else if (srcType === 0) petUseSlot = 0xff;
    console.log(`[pet] swapped with dest type=${dstType} slot=${dstSlot}`);
  }
  setPetUseSlot(charId, petUseSlot);
  await petSyncEquipSlot(charId);
  const wearChange = srcType === 0 || dstType === 0;
  const avatar = wearChange ? await buildSetAvatar(charId) : undefined;
  const packets: Buffer[] = [await buildPet5(charId, magic)];
  if (wearChange) {
    packets.push(await buildEquip(charId));
    if (avatar) packets.push(avatar);
  }
  let petWorld: Buffer[] | undefined;
  if (wearChange) {
    const world = await buildPetWorldState(charId);
    petWorld = [world];
    console.log(
      `[pet] equip char=${charId} useslot=${petUseSlot} worldOp=0x${world.readUInt16LE(2).toString(16)}`,
    );
  } else {
    console.log(`[pet] bag-move char=${charId} ${srcType}:${srcSlot} -> ${dstType}:${dstSlot}`);
  }
  return {
    packets,
    broadcastAvatar: avatar,
    petWorld,
    petUseSlot,
    petRefresh: true,
    petReenter: wearChange,
  };
}

/**
 * CHANGEITEM 0x6C — legacy offsets:
 * +12 srcBag, +13 srcSlot, +14 dstBag, +15 dstSlot, +16 qty u32
 */
export async function changeItem(charId: number, pkt: Buffer, magic = 0x0037): Promise<ChangeItemResult> {
  const srcBag = pkt.readUInt8(12);
  const srcSlot = pkt.readUInt8(13);
  const dstBag = pkt.readUInt8(14);
  const dstSlot = pkt.readUInt8(15);
  let qty = pkt.length >= 20 ? pkt.readUInt32LE(16) : 1;
  if (qty < 1) qty = 1;
  const maxSlots = invSlotsForMagic(magic);

  // Drop to ground
  if (dstBag === 0x63 && dstSlot === 0x63) {
    if (srcBag >= 5) return { packets: [] };
    const itemId = await removeInvQty(charId, srcBag, srcSlot, qty);
    if (!itemId) return { packets: [] };
    const dropQty = srcBag < 3 ? 1 : qty;
    return {
      packets: await refreshBagPackets(charId, srcBag, magic),
      drop: { itemId, qty: dropQty },
    };
  }

  // Pet bag (5) <-> worn pet (0 slot 10) / bag rearrange
  if ((srcBag === 0 || srcBag === 5) && (dstBag === 0 || dstBag === 5)) {
    return petMoveItem(charId, srcBag, srcSlot, dstBag, dstSlot, magic);
  }

  // Equip bags 0/1/2
  if (srcBag < 3 && dstBag < 3) {
    await execute("UPDATE equip SET pos1=22,pos2=22 WHERE pos1=? AND pos2=? AND charid=?", [dstBag, dstSlot, charId]);
    await execute("UPDATE equip SET pos1=?,pos2=? WHERE pos1=? AND pos2=? AND charid=?", [
      dstBag,
      dstSlot,
      srcBag,
      srcSlot,
      charId,
    ]);
    await execute("UPDATE equip SET pos1=?,pos2=? WHERE pos1=22 AND pos2=22 AND charid=?", [srcBag, srcSlot, charId]);
    const packets: Buffer[] = [];
    let broadcastAvatar: Buffer | undefined;
    if (srcBag === 0 || dstBag === 0) {
      packets.push(await buildEquip(charId));
      const av = await buildSetAvatar(charId);
      packets.push(av);
      broadcastAvatar = av;
    }
    if (srcBag === 1 || dstBag === 1) packets.push(await buildEquip1(charId, magic));
    if (srcBag === 2 || dstBag === 2) packets.push(await buildEquip2(charId, magic));
    return { packets, broadcastAvatar };
  }

  if (srcBag === 3) {
    await execute("UPDATE spend SET pos1=22,pos2=22 WHERE pos1=? AND pos2=? AND charid=?", [dstBag, dstSlot, charId]);
    await execute("UPDATE spend SET pos1=?,pos2=? WHERE pos1=? AND pos2=? AND charid=?", [
      dstBag,
      dstSlot,
      srcBag,
      srcSlot,
      charId,
    ]);
    await execute("UPDATE spend SET pos1=?,pos2=? WHERE pos1=22 AND pos2=22 AND charid=?", [srcBag, srcSlot, charId]);
    return { packets: [await buildSpend3(charId, magic)] };
  }

  if (srcBag === 4) {
    await execute("UPDATE other SET pos1=22,pos2=22 WHERE pos1=? AND pos2=? AND charid=?", [dstBag, dstSlot, charId]);
    await execute("UPDATE other SET pos1=?,pos2=? WHERE pos1=? AND pos2=? AND charid=?", [
      dstBag,
      dstSlot,
      srcBag,
      srcSlot,
      charId,
    ]);
    await execute("UPDATE other SET pos1=?,pos2=? WHERE pos1=22 AND pos2=22 AND charid=?", [srcBag, srcSlot, charId]);
    return { packets: [await buildOther4(charId, magic)] };
  }

  return { packets: [] };
}

export async function refreshBagPackets(charId: number, bag: number, magic = 0x0037): Promise<Buffer[]> {
  switch (bag) {
    case 0:
      return [await buildEquip(charId), await buildSetAvatar(charId)];
    case 1:
      return [await buildEquip1(charId, magic)];
    case 2:
      return [await buildEquip2(charId, magic)];
    case 3:
      return [await buildSpend3(charId, magic)];
    case 4:
      return [await buildOther4(charId, magic)];
    case 5:
      return [await buildPet5(charId, magic)];
    default:
      return await buildAllBags(charId, magic);
  }
}

export async function dismantle(
  charId: number,
  type: number,
  slot: number,
  magic = 0x0037,
): Promise<{ packets: Buffer[]; warehouse?: boolean }> {
  // Clear IsLocked / iscash. Sealed (1) = tradeable/auctionable; opened (0) = bound.
  if (type === 6) {
    const r = await execute("UPDATE cash_inven SET islocked=0 WHERE charid=? AND slot=?", [charId, slot]);
    console.log(`[cashshop] unseal warehouse char=${charId} slot=${slot} affected=${r.affectedRows}`);
    return { packets: [], warehouse: true };
  }
  if (type === 5) {
    const pet = await query<RowDataPacket[]>("SELECT id, iscash FROM pets WHERE cid=? AND type=5 AND slot=?", [
      charId,
      slot,
    ]);
    if (pet.length) {
      await execute("UPDATE pets SET iscash=0 WHERE cid=? AND type=5 AND slot=?", [charId, slot]);
      console.log(`[cashshop] unseal pet char=${charId} slot=${slot}`);
      return { packets: [await buildPet5(charId, magic)] };
    }
    const r = await execute(
      "UPDATE cash_inven SET islocked=0 WHERE charid=? AND slot=? AND FLOOR(itemid/100000)=92",
      [charId, slot],
    );
    console.log(`[cashshop] unseal cash-pet char=${charId} slot=${slot} affected=${r.affectedRows}`);
    return { packets: [], warehouse: true };
  }
  if (type < 3) {
    const r = await execute("UPDATE equip SET iscash=0 WHERE charid=? AND pos1=? AND pos2=?", [charId, type, slot]);
    console.log(`[cashshop] unseal equip char=${charId} type=${type} slot=${slot} affected=${r.affectedRows}`);
    return { packets: await refreshBagPackets(charId, type, magic) };
  }
  if (type === 3) {
    const r = await execute("UPDATE spend SET iscash=0 WHERE charid=? AND pos1=3 AND pos2=?", [charId, slot]);
    console.log(`[cashshop] unseal spend char=${charId} slot=${slot} affected=${r.affectedRows}`);
    return { packets: [await buildSpend3(charId, magic)] };
  }
  if (type === 4) {
    const r = await execute("UPDATE other SET iscash=0 WHERE charid=? AND pos1=4 AND pos2=?", [charId, slot]);
    console.log(`[cashshop] unseal other char=${charId} slot=${slot} affected=${r.affectedRows}`);
    return { packets: [await buildOther4(charId, magic)] };
  }
  console.log(`[cashshop] unseal ignored char=${charId} type=${type} slot=${slot}`);
  return { packets: [] };
}

export function buyPrice(itemId: number, prices: Map<number, number>): number {
  if (prices.has(itemId)) return prices.get(itemId)!;
  const g = Math.floor(itemId / 100000);
  if (g === 88) return 100;
  if (g === 89) return 50;
  if ([79, 80, 81, 93, 95].includes(g)) return 5000;
  return 500;
}

export function sellPrice(itemId: number, prices: Map<number, number>): number {
  if ([8880011, 8880021, 8880031, 8880041, 8880051, 8880061, 8880071, 8880081, 8880091, 8880101].includes(itemId)) {
    return 0;
  }
  const buy = buyPrice(itemId, prices);
  const g = Math.floor(itemId / 100000);
  if (g === 89 || g === 11) return buy;
  return Math.floor(buy / 5);
}
