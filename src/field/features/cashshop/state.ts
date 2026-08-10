import type { RowDataPacket } from "mysql2";
import { query, execute } from "../../../db/index.js";
import { writeHeader } from "../../../net/packet.js";
import { PACKET_MAGIC } from "../../../protocol/magic.js";
import { INSERT_CASH_INVEN, SELECT_CASH_INVEN_BY_CHARID, SELECT_CASH_INVEN_BY_CHARID_2, SELECT_CASH_INVEN_BY_CHARID_3, SELECT_CASH_SHOP, SELECT_GIFTS_BY_NAME_AND_RECEIVE, SELECT_USERS_BY_ACCOUNTID, SELECT_USERS_BY_ACCOUNTID_2, UPDATE_GIFTS_BY_ID, UPDATE_USERS_BY_ACCOUNTID } from "../../../db/queries/index.js";

import {
  CAT_NAMES,
  CASH_CATEGORY_COUNT,
  CASH_SLOTS_PER_CATEGORY,
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
  if (byCat[cat]!.length >= 300) return;
  if (!Number.isFinite(item.itemId) || item.itemId <= 0) return;
  seen.add(item.itemId);
  const full: CashItem = { category: cat, ...item };
  byCat[cat]!.push(full);
  catalog.push(full);
}

/** Load cash shop catalog from MySQL `cash_shop` (seed is pre-pruned in schema.sql). */
export async function loadCashShopFromDb(): Promise<void> {
  catalog = [];
  for (let i = 0; i < CASH_CATEGORY_COUNT; i++) byCat[i] = [];
  const seen = new Map<number, Set<number>>();
  let fromDb = 0;

  try {
    const rows = await query<RowDataPacket[]>(SELECT_CASH_SHOP);
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

  const counts = byCat.map((c, i) => (c.length ? `${CAT_NAMES[i]}=${c.length}` : "")).filter(Boolean);
  console.log(`[cashshop] loaded ${catalog.length} items (${counts.join(", ")})`);
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
    writeListOpcode([0, 1, 2, 3, 4, 5, 6], 0x11f, slotsPer),
    writeListOpcode([7, 8, 9, -1, 11], 0x120, slotsPer),
    writeListOpcode([12, -1, 14], 0x121, slotsPer),
    writeListOpcode([15, 16, -1], 0x122, slotsPer),
    writeListOpcode([10], 0x123, slotsPer),
    writeListOpcode(hotCats, 0x124, slotsPer),
    writeListOpcode([-1, -1], 0x125, slotsPer),
    writeListOpcode(hotCats, 0x126, slotsPer),
    writeListOpcode([-1], 0x127, slotsPer),
  ];
}

/** @deprecated alias — use buildCashLists */
export function buildCashListsCompact(): Buffer[] {
  return buildCashLists();
}

export async function buildBalance(accountId: number): Promise<Buffer[]> {
  const rows = await query<RowDataPacket[]>(SELECT_USERS_BY_ACCOUNTID, [accountId]);
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
  const rows = await query<RowDataPacket[]>(SELECT_CASH_INVEN_BY_CHARID, [charId]);
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
  const locked = 1;
  await execute(UPDATE_USERS_BY_ACCOUNTID, [item.bargain, accountId]);
  await execute(INSERT_CASH_INVEN, [charId, slot, itemId, amount, locked, item.term]);
  return true;
}

export function findCashItem(itemId: number): CashItem | undefined {
  return catalog.find((c) => c.itemId === itemId);
}

export async function deliverCashGifts(charId: number, charName: string): Promise<number> {
  const gifts = await query<RowDataPacket[]>(SELECT_GIFTS_BY_NAME_AND_RECEIVE, [charName]);
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
    await execute(INSERT_CASH_INVEN, [charId, slot, Number(g.itemid), amount, Number(g.islocked ?? 1), Number(g.term ?? -1)]);
    await execute(UPDATE_GIFTS_BY_ID, [g.id]);
    usedSlots.add(slot);
    count++;
  }
  if (count > 0) console.log(`[cashshop] delivered ${count} gift(s) to char=${charId}`);
  return count;
}
