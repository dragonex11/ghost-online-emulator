import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { config } from "../../config.js";
import { query, execute } from "../../db.js";
import { writeHeader } from "../../net/packet.js";
import { PACKET_MAGIC } from "../../protocol/magic.js";
import { INSERT_CASH_INVEN, SELECT_CASH_INVEN_BY_CHARID, SELECT_CASH_INVEN_BY_CHARID_2, SELECT_CASH_INVEN_BY_CHARID_3, SELECT_CASH_SHOP, SELECT_GIFTS_BY_NAME_AND_RECEIVE, SELECT_USERS_BY_ACCOUNTID, SELECT_USERS_BY_ACCOUNTID_2, UPDATE_GIFTS_BY_ID, UPDATE_USERS_BY_ACCOUNTID } from "../../db/queries/index.js";

import {
  CAT_NAMES,
  CASH_CATEGORY_COUNT,
  CASH_SLOTS_PER_CATEGORY,
  COMPANION_PET_ID_MAX,
  COMPANION_PET_ID_MIN,
  ENSURE_PETS,
  FASHION_CATEGORY_INDICES,
  HOT_TREASURE_ITEMS,
  LUCKBAG_CATEGORY_INDEX,
  MAX_ITEMS_PER_CATEGORY,
  PET_CATEGORY_INDEX,
  PET_EQ_CATEGORY_INDEX,
  PET_EQ_DEFAULTS,
  PET_EQ_SUPPORTED,
  PILL_CATEGORY_INDEX,
  PRODUCE_CATEGORY_INDEX,
  RUN_TRAIL_IDS,
  TREASURE_CATEGORY_INDEX,
  UNSUPPORTED_PRODUCE_IDS,
  cashBuyAmount,
} from "./constants.js";

export type CashItem = {
  category: number;
  itemId: number;
  bargain: number;
  term: number;
  price: number;
  flag: number;
};

const byCat: CashItem[][] = Array.from({ length: CASH_CATEGORY_COUNT }, () => []);
let catalog: CashItem[] = [];

function pushItem(cat: number, item: Omit<CashItem, "category">, seen: Set<number>): void {
  if (cat < 0 || cat > 19) return;
  if (seen.has(item.itemId)) return;
  if (byCat[cat]!.length >= MAX_ITEMS_PER_CATEGORY) return;
  if (!Number.isFinite(item.itemId) || item.itemId <= 0) return;
  seen.add(item.itemId);
  const full: CashItem = { category: cat, ...item };
  byCat[cat]!.push(full);
  catalog.push(full);
}

/** Parse client item.itm → set of item IDs (u32 immediately before a UTF-16 name). */
function loadItemItmIds(): Set<number> {
  const itmPaths = [
    path.join(config.dataDir, "client", "table", "item.itm"),
    path.join(config.rootDir, "data", "client", "table", "item.itm"),
  ];
  const ids = new Set<number>();
  let itm: Buffer | null = null;
  for (const p of itmPaths) {
    if (fs.existsSync(p)) {
      itm = fs.readFileSync(p);
      break;
    }
  }
  if (!itm) return ids;
  for (let i = 0; i + 8 < itm.length; ) {
    if (itm[i]! >= 32 && itm[i]! < 127 && itm[i + 1] === 0 && itm[i + 2]! >= 32 && itm[i + 2]! < 127 && itm[i + 3] === 0) {
      if (i >= 4) {
        const id = itm.readUInt32LE(i - 4);
        if (id >= 1_000_000 && id <= 99_999_999) ids.add(id);
      }
      let j = i;
      while (j + 1 < itm.length && !(itm[j] === 0 && itm[j + 1] === 0)) j += 2;
      i = j + 2;
      continue;
    }
    i++;
  }
  return ids;
}

/** Pet preview id: (itemId/10)%1000 must match data/client/data/OBJ/PET/pet_NNN_*.spr */
function loadPetSpriteIds(): Set<number> {
  const ids = new Set<number>();
  const dirs = [
    path.join(config.dataDir, "client", "data", "OBJ", "PET"),
    path.join(config.rootDir, "data", "client", "data", "OBJ", "PET"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = /^pet_(\d+)/i.exec(name);
      if (m) ids.add(Number(m[1]));
    }
    if (ids.size) break;
  }
  return ids;
}

function isCompanionPetId(itemId: number): boolean {
  return itemId >= COMPANION_PET_ID_MIN && itemId < COMPANION_PET_ID_MAX;
}

function isPetEquipmentId(itemId: number): boolean {
  return PET_EQ_SUPPORTED.has(itemId);
}

/**
 * Drop items the original client cannot show (no third-party client assets):
 * - fashion/eyes/hair/face/mantle: must exist in item.itm
 * - pets: must have OBJ/PET sprite (icon may be blank for spr>=31)
 * - peteq: only Name Tag + Red/Blue/Yellow muffler
 */
function filterClientItems(): void {
  const itmIds = loadItemItmIds();
  const petSpr = loadPetSpriteIds();
  const fashionCats = FASHION_CATEGORY_INDICES;
  let removed = 0;
  for (let c = 0; c < byCat.length; c++) {
    const before = byCat[c]!.length;
    if (c === PET_CATEGORY_INDEX) {
      byCat[c] = byCat[c]!.filter((it) => {
        if (!isCompanionPetId(it.itemId)) return false;
        const spr = Math.floor(it.itemId / 10) % 1000;
        return petSpr.has(spr) && spr > 0;
      });
    } else if (c === PET_EQ_CATEGORY_INDEX) {
      byCat[c] = byCat[c]!.filter((it) => PET_EQ_SUPPORTED.has(it.itemId));
    } else if (fashionCats.has(c) && itmIds.size > 0) {
      byCat[c] = byCat[c]!.filter((it) => itmIds.has(it.itemId));
    }
    removed += before - byCat[c]!.length;
  }
  catalog = byCat.flat();
  if (removed > 0) {
    console.log(
      `[cashshop] removed ${removed} unsupported client items (item.itm / PET sprites)`,
    );
  }
}

/** Move mufflers / name tag out of Pets into Pet Equipment; ensure pets 001–003 + 201–207. */
function rearrangePetEquipment(): void {
  const pets = byCat[PET_CATEGORY_INDEX] ?? [];
  const keepPets: CashItem[] = [];
  const peteq: CashItem[] = [];
  const peteqSeen = new Set<number>();
  const petSeen = new Set<number>();

  for (const it of pets) {
    if (isPetEquipmentId(it.itemId) || (it.itemId >= 9220000 && it.itemId < 9230000) || it.itemId === 7820501) {
      if (PET_EQ_SUPPORTED.has(it.itemId) && !peteqSeen.has(it.itemId)) {
        peteq.push({ ...it, category: PET_EQ_CATEGORY_INDEX });
        peteqSeen.add(it.itemId);
      }
      // drop unsupported 9220021–9220091 (invisible in client)
    } else if (isCompanionPetId(it.itemId)) {
      keepPets.push(it);
      petSeen.add(it.itemId);
    }
  }

  for (const d of ENSURE_PETS) {
    if (!petSeen.has(d.itemId)) {
      keepPets.push({ category: PET_CATEGORY_INDEX, ...d });
      petSeen.add(d.itemId);
    }
  }

  for (const d of PET_EQ_DEFAULTS) {
    if (!peteqSeen.has(d.itemId)) {
      peteq.push({ category: PET_EQ_CATEGORY_INDEX, ...d });
      peteqSeen.add(d.itemId);
    }
  }

  byCat[PET_CATEGORY_INDEX] = keepPets;
  byCat[PET_EQ_CATEGORY_INDEX] = peteq;
  catalog = byCat.flat();
  const sprs = new Set(keepPets.map((p) => Math.floor(p.itemId / 10) % 1000));
  console.log(
    `[cashshop] Pet remap: pets=${keepPets.length} (spr ${[...sprs].sort((a, b) => a - b).join(",")}), peteq=${peteq.length}`,
  );
}

/**
 * Split Mileage produce into:
 *   produce (11) = name-frame decorations → HOT New
 *   pill (13)    = run trails → HOT Event
 * treasure (19)  = boxes / buffs / Server Scroll → HOT Hot
 *
 * NOTE: client's visible "HOT" New/Event/Hot radios are fed by opcode 0x126
 * (same 3-slot shape as Charm). 0x124 is the Best/HOT list in docs; we fill both.
 */
function rearrangeHotMileageTabs(): void {
  const produce = byCat[PRODUCE_CATEGORY_INDEX] ?? [];
  const trails: CashItem[] = [];
  const frames: CashItem[] = [];
  for (const it of produce) {
    if (UNSUPPORTED_PRODUCE_IDS.has(it.itemId)) continue;
    if (RUN_TRAIL_IDS.has(it.itemId)) {
      trails.push({ ...it, category: PILL_CATEGORY_INDEX });
    } else {
      frames.push(it);
    }
  }
  byCat[PRODUCE_CATEGORY_INDEX] = frames;
  const existingPill = (byCat[PILL_CATEGORY_INDEX] ?? []).filter((it) => !RUN_TRAIL_IDS.has(it.itemId));
  byCat[PILL_CATEGORY_INDEX] = [...trails, ...existingPill];

  const treasureIds = new Set(HOT_TREASURE_ITEMS.map((i) => i.itemId));
  byCat[LUCKBAG_CATEGORY_INDEX] = (byCat[LUCKBAG_CATEGORY_INDEX] ?? []).filter((it) => !treasureIds.has(it.itemId));
  const treasure: CashItem[] = [];
  const seen = new Set<number>();
  for (const d of HOT_TREASURE_ITEMS) {
    if (seen.has(d.itemId)) continue;
    treasure.push({ category: TREASURE_CATEGORY_INDEX, ...d });
    seen.add(d.itemId);
  }
  byCat[TREASURE_CATEGORY_INDEX] = treasure;

  catalog = byCat.flat();
  console.log(
    `[cashshop] HOT remap: New/frames=${frames.length}, Event/trails=${trails.length}, Hot/treasure=${treasure.length}`,
  );
}

function finalizeCashCatalog(): void {
  rearrangePetEquipment();
  filterClientItems();
  rearrangeHotMileageTabs();
}

/** Load cash shop catalog from MySQL `cash_shop` only (seeded by database/schema.sql). */
export async function loadCashShopFromDb(): Promise<void> {
  catalog = [];
  for (let i = 0; i < CASH_CATEGORY_COUNT; i++) byCat[i] = [];
  const seen = new Map<number, Set<number>>();
  let fromDb = 0;

  try {
    const rows = await query<RowDataPacket[]>(
      SELECT_CASH_SHOP,
    );
    for (const r of rows) {
      const cat = Number(r.category);
      const set = seen.get(cat) ?? new Set<number>();
      seen.set(cat, set);
      pushItem(
        cat,
        {
          itemId: Number(r.itemId),
          bargain: Number(r.bargain),
          term: Number(r.term),
          price: Number(r.price),
          flag: Number(r.flag),
        },
        set,
      );
      fromDb++;
    }
  } catch (e) {
    console.warn("[cashshop] failed to load cash_shop from DB:", e);
  }

  finalizeCashCatalog();
  const counts = byCat.map((c, i) => (c.length ? `${CAT_NAMES[i]}=${c.length}` : "")).filter(Boolean);
  console.log(`[cashshop] loaded ${catalog.length} items from DB (${fromDb} rows; ${counts.join(", ")})`);
}

/** Empty cash-list slots use term=-1 (matches client list constructors). */
function emptyTermFor(_cat: number): number {
  return -1;
}

export function cashSlotCount(_magic?: number): number {
  return CASH_SLOTS_PER_CATEGORY;
}

function writeListOpcode(cats: number[], opcode: number, slotsPer: number): Buffer {
  const body = cats.length * slotsPer * 28;
  const total = 12 + body;
  const buf = Buffer.alloc(total, 0);
  // unk must be 0 — matches client cash list templates.
  writeHeader(buf, opcode, total, PACKET_MAGIC, 0);
  let off = 12;
  for (const cat of cats) {
    const items = cat >= 0 && cat <= 19 ? byCat[cat]! : [];
    const emptyTerm = emptyTermFor(cat);
    for (let i = 0; i < slotsPer; i++) {
      const it = items[i];
      buf.writeUInt32LE(it ? it.itemId : 0, off);
      buf.writeUInt32LE(1, off + 4);
      buf.writeInt32LE(it ? it.bargain : 0, off + 8);
      buf.writeInt32LE(it ? it.term : emptyTerm, off + 12);
      buf.writeInt32LE(it ? it.price : 0, off + 16);
      buf.writeInt32LE(it ? it.flag : 0, off + 20);
      buf.writeInt32LE(0, off + 24);
      off += 28;
    }
  }
  return buf;
}

/**
 * client tab → opcode (from game.exe list ctors + UI jump table):
 *   0x11F Look (7)  0x120 Equip (5)  0x121 Ability (3)  0x122 Pet (3)
 *   0x123 ticket (1)  0x124 Best/HOT (3)  0x125 Mileage (2)
 *   0x126 Charm / visible HOT New·Event·Hot (3)  0x127 pad (1)
 *
 * HOT: New=frames(11), Event=trails(13), Hot=treasure boxes+Server Scroll(19)
 * Pet: Pets(15), Equipment(16), —
 * Mileage emptied. Ticket = fireworks luckbags only.
 */
export function buildCashLists(slotsPer = 200): Buffer[] {
  const hotCats = [11, 13, 19];
  return [
    writeListOpcode([0, 1, 2, 3, 4, 5, 6], 0x11f, slotsPer), // Look
    writeListOpcode([7, 8, 9, -1, 11], 0x120, slotsPer), // Equip
    writeListOpcode([12, -1, 14], 0x121, slotsPer), // Ability
    writeListOpcode([15, 16, -1], 0x122, slotsPer), // Pet: pets / equipment / —
    writeListOpcode([10], 0x123, slotsPer), // ticket: fireworks
    writeListOpcode(hotCats, 0x124, slotsPer), // Best/HOT
    writeListOpcode([-1, -1], 0x125, slotsPer), // Mileage empty
    writeListOpcode(hotCats, 0x126, slotsPer), // visible HOT
    writeListOpcode([-1], 0x127, slotsPer),
  ];
}

/** @deprecated alias — use buildCashLists */
export function buildCashListsCompact(): Buffer[] {
  return buildCashLists();
}

export async function buildBalance(accountId: number): Promise<Buffer[]> {
  const rows = await query<RowDataPacket[]>(
    SELECT_USERS_BY_ACCOUNTID,
    [accountId],
  );
  const gp = Number(rows[0]?.game_points ?? 0);
  const gift = Number(rows[0]?.gift_points ?? 0);
  const bonus = Number(rows[0]?.bonus_points ?? 0);
  const f3 = Buffer.alloc(20, 0);
  writeHeader(f3, 0x00f3, 20);
  f3.writeInt32LE(gp, 12);
  f3.writeInt32LE(gift, 16);
  const f2 = Buffer.alloc(16, 0);
  writeHeader(f2, 0x00f2, 16);
  f2.writeInt32LE(bonus, 12);
  return [f3, f2];
}

export async function buildWarehouse(charId: number): Promise<Buffer> {
  const rows = await query<RowDataPacket[]>(
    SELECT_CASH_INVEN_BY_CHARID,
    [charId],
  );
  const b = Buffer.alloc(932, 0);
  writeHeader(b, 0x00e6, 932);
  for (const r of rows) {
    const s = Number(r.slot);
    if (s < 0 || s >= 20) continue;
    b.writeUInt32LE(Number(r.itemid), 12 + s * 4);
    b.writeUInt16LE(Number(r.amount ?? 1), 392 + s * 2);
    b.writeUInt8(Number(r.islocked ?? 1), 432 + s);
    const term = Number(r.term ?? -1);
    b.writeInt32LE(term === -1 ? 0 : term, 452 + s * 4);
  }
  return b;
}

export async function cashBuy(accountId: number, charId: number, itemId: number): Promise<boolean> {
  const item = catalog.find((c) => c.itemId === itemId);
  if (!item) return false;
  const rows = await query<RowDataPacket[]>(SELECT_USERS_BY_ACCOUNTID_2, [accountId]);
  const gp = Number(rows[0]?.game_points ?? 0);
  if (gp < item.bargain) return false;
  const used = await query<RowDataPacket[]>(SELECT_CASH_INVEN_BY_CHARID_2, [charId]);
  const usedSlots = new Set(used.map((r) => Number(r.slot)));
  let slot = -1;
  for (let i = 0; i < 20; i++) if (!usedSlots.has(i)) { slot = i; break; }
  if (slot < 0) return false;
  const amount = cashBuyAmount(itemId);
  // All mall purchases arrive sealed (IsLocked=1) — tradeable until 0x140 unseal.
  const locked = 1;
  await execute(UPDATE_USERS_BY_ACCOUNTID, [item.bargain, accountId]);
  await execute(
    INSERT_CASH_INVEN,
    [charId, slot, itemId, amount, locked, item.term],
  );
  return true;
}

export function findCashItem(itemId: number): CashItem | undefined {
  return catalog.find((c) => c.itemId === itemId);
}

export async function deliverCashGifts(charId: number, charName: string): Promise<number> {
  const gifts = await query<RowDataPacket[]>(
    SELECT_GIFTS_BY_NAME_AND_RECEIVE,
    [charName],
  );
  if (!gifts.length) return 0;
  const used = await query<RowDataPacket[]>(SELECT_CASH_INVEN_BY_CHARID_3, [charId]);
  const usedSlots = new Set(used.map((r) => Number(r.slot)));
  let count = 0;
  for (const g of gifts) {
    let slot = -1;
    for (let i = 0; i < 20; i++) {
      if (!usedSlots.has(i)) {
        slot = i;
        break;
      }
    }
    if (slot < 0) break;
    const amount = Math.max(1, Number(g.amount ?? 1));
    await execute(
      INSERT_CASH_INVEN,
      [charId, slot, Number(g.itemid), amount, Number(g.islocked ?? 1), Number(g.term ?? -1)],
    );
    await execute(UPDATE_GIFTS_BY_ID, [g.id]);
    usedSlots.add(slot);
    count++;
  }
  if (count > 0) console.log(`[cashshop] delivered ${count} gift(s) to char=${charId}`);
  return count;
}
