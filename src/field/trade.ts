/**
 * Trade system — C# TradeHandler / TradePacket parity (Messages.cs opcodes).
 *
 * Client:  INVITE 0x92, RESPONSE 0x93, READY 0x94, CONFIRM 0x95, CANCEL 0x96, PUT 0x99
 * Server:  INVITE 0x92, RESPONSES 0x93, READY 0x94, CONFIRM 0x95, CANCEL 0x96,
 *          FAIL 0x97, SUCCESS 0x98, PUT 0x9A
 */
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";
import { addItemToInventory, removeInvQty, refreshBagPackets } from "./inventory.js";
import { SELECT_EQUIP_BY_CHARID_11, SELECT_EQUIP_BY_CHARID_AND_TYPE_2, SELECT_OTHER_BY_CHARID_5, SELECT_SPEND_BY_CHARID_6, UPDATE_EQUIP_BY_CHARID_7 } from "../db/queries/index.js";

export type TradeItem = {
  itemId: number;
  type: number;
  slot: number;
  quantity: number;
  sourceQuantity: number;
  spirit: number;
  levels: number[]; // 10
  fusion: number;
  isCash: number;
  term: number;
};

export type TradeSession = {
  partnerId: number;
  money: number;
  items: TradeItem[];
  ready: boolean;
};

const sessions = new Map<number, TradeSession>();

export function getTrade(charId: number): TradeSession | undefined {
  return sessions.get(charId);
}

export function clearTrade(charId: number): void {
  sessions.delete(charId);
}

export function beginTradePair(a: number, b: number): void {
  sessions.set(a, { partnerId: b, money: 0, items: [], ready: false });
  sessions.set(b, { partnerId: a, money: 0, items: [], ready: false });
}

export function buildTradeInvite(inviterCharId: number): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x0092, 16);
  b.writeInt32LE(inviterCharId | 0, 12);
  return b;
}

export function buildTradeInviteResponses(response: number): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x0093, 16);
  b.writeInt32LE(response | 0, 12);
  return b;
}

export function buildTradeReady(): Buffer {
  const b = Buffer.alloc(12, 0);
  writeHeader(b, 0x0094, 12);
  return b;
}

export function buildTradeConfirm(): Buffer {
  const b = Buffer.alloc(12, 0);
  writeHeader(b, 0x0095, 12);
  return b;
}

export function buildTradeCancel(): Buffer {
  const b = Buffer.alloc(12, 0);
  writeHeader(b, 0x0096, 12);
  return b;
}

export function buildTradeFail(): Buffer {
  const b = Buffer.alloc(12, 0);
  writeHeader(b, 0x0097, 12);
  return b;
}

export function buildTradeSuccess(): Buffer {
  const b = Buffer.alloc(12, 0);
  writeHeader(b, 0x0098, 12);
  return b;
}

function writeTradeSlot(buf: Buffer, off: number, it: TradeItem | undefined): void {
  if (!it) return;
  buf.writeUInt32LE(it.itemId >>> 0, off);
  buf.writeUInt16LE(it.spirit & 0xffff, off + 4);
  buf.writeUInt16LE(it.quantity & 0xffff, off + 6);
  for (let i = 0; i < 10; i++) buf.writeUInt8((it.levels[i] ?? 0) & 0xff, off + 8 + i);
  buf.writeUInt16LE(it.fusion & 0xffff, off + 18);
  // remaining padding already 0
}

/** TRADE_PUT 0x9A — 12 header + 16 ids/money + 12×48×2 item blocks = 1180 */
export function buildTradePut(selfId: number, partnerId: number, self: TradeSession, partner: TradeSession): Buffer {
  const b = Buffer.alloc(1180, 0);
  writeHeader(b, 0x009a, 1180);
  b.writeInt32LE(selfId | 0, 12);
  b.writeInt32LE(partnerId | 0, 16);
  b.writeInt32LE(self.money | 0, 20);
  b.writeInt32LE(partner.money | 0, 24);
  for (let i = 0; i < 12; i++) writeTradeSlot(b, 28 + i * 48, self.items[i]);
  for (let i = 0; i < 12; i++) writeTradeSlot(b, 28 + 12 * 48 + i * 48, partner.items[i]);
  return b;
}

export function isTradeOpcode(op: number): boolean {
  return op === 0x0092 || op === 0x0093 || op === 0x0094 || op === 0x0095 || op === 0x0096 || op === 0x0099;
}

async function loadInvItem(
  charId: number,
  type: number,
  slot: number,
): Promise<{ itemId: number; amount: number; spirit: number; levels: number[]; fusion: number; isCash: number; term: number } | null> {
  if (type < 3) {
    const rows = await query<RowDataPacket[]>(
      SELECT_EQUIP_BY_CHARID_11,
      [charId, type, slot],
    );
    if (!rows.length) return null;
    const r = rows[0]!;
    const levels = [r.p_1, r.p_2, r.p_3, r.p_4, r.p_5, r.p_6, r.p_7, r.p_8, r.p_9, r.p_10].map((x) => Number(x ?? 0));
    return {
      itemId: Number(r.type),
      amount: 1,
      spirit: Number(r.soulperc ?? 0),
      levels,
      fusion: 0,
      isCash: Number(r.iscash ?? 0),
      term: Number(r.timeuse ?? -1),
    };
  }
  if (type === 3) {
    const rows = await query<RowDataPacket[]>(
      SELECT_SPEND_BY_CHARID_6,
      [charId, slot],
    );
    if (!rows.length) return null;
    const r = rows[0]!;
    return {
      itemId: Number(r.itemid),
      amount: Number(r.amount ?? 1),
      spirit: 0,
      levels: Array(10).fill(0),
      fusion: 0,
      isCash: Number(r.iscash ?? 0),
      term: Number(r.timeuse ?? -1),
    };
  }
  if (type === 4) {
    const rows = await query<RowDataPacket[]>(
      SELECT_OTHER_BY_CHARID_5,
      [charId, slot],
    );
    if (!rows.length) return null;
    const r = rows[0]!;
    return {
      itemId: Number(r.type),
      amount: Number(r.amount ?? 1),
      spirit: 0,
      levels: Array(10).fill(0),
      fusion: 0,
      isCash: Number(r.iscash ?? 0),
      term: Number(r.timeuse ?? -1),
    };
  }
  return null;
}

/** Escrow an inventory item into the trade window. Returns bag to refresh, or -1 on fail. */
export async function tradePutItem(
  charId: number,
  type: number,
  slot: number,
  quantity: number,
): Promise<{ ok: true; bag: number } | { ok: false; reason: string }> {
  const trade = sessions.get(charId);
  if (!trade) return { ok: false, reason: "no trade" };
  if (trade.items.length >= 12) return { ok: false, reason: "full" };
  if (quantity < 1) return { ok: false, reason: "bad qty" };

  const src = await loadInvItem(charId, type, slot);
  if (!src) return { ok: false, reason: "missing item" };
  const take = Math.min(quantity, src.amount);
  if (take < 1) return { ok: false, reason: "empty" };

  const removed = await removeInvQty(charId, type, slot, take);
  if (!removed) return { ok: false, reason: "remove failed" };

  trade.items.push({
    itemId: src.itemId,
    type,
    slot,
    quantity: take,
    sourceQuantity: src.amount,
    spirit: src.spirit,
    levels: src.levels,
    fusion: src.fusion,
    isCash: src.isCash,
    term: src.term,
  });
  trade.ready = false;
  const partner = sessions.get(trade.partnerId);
  if (partner) partner.ready = false;
  return { ok: true, bag: type };
}

/** Put gold into trade (SourceType/Slot = 0x64). Returns false if not enough. */
export async function tradePutMoney(
  charId: number,
  amount: number,
  currentMoney: number,
): Promise<{ ok: true; newMoney: number; delta: number } | { ok: false; reason: string }> {
  const trade = sessions.get(charId);
  if (!trade) return { ok: false, reason: "no trade" };
  if (amount < 0 || amount > currentMoney) return { ok: false, reason: "funds" };
  // Replace offered money (C# overwrites Trade.Money)
  const prev = trade.money;
  const delta = amount - prev;
  if (delta > currentMoney) return { ok: false, reason: "funds" };
  trade.money = amount;
  trade.ready = false;
  const partner = sessions.get(trade.partnerId);
  if (partner) partner.ready = false;
  return { ok: true, newMoney: currentMoney - delta, delta: -delta };
}

/** Return escrowed items/money to owner (cancel / fail). */
export async function restoreTradeOffer(
  charId: number,
  trade: TradeSession,
): Promise<{ money: number; bags: number[] }> {
  const bags = new Set<number>();
  for (const it of trade.items) {
    const bag = await addItemToInventory(charId, it.itemId, it.quantity, it.isCash, it.term);
    if (bag >= 0) bags.add(bag);
    // Best-effort restore of equip forge levels when re-inserted as plain equip
    if ((it.type === 1 || it.type === 2) && it.levels.some((l) => l > 0)) {
      const rows = await query<RowDataPacket[]>(
        SELECT_EQUIP_BY_CHARID_AND_TYPE_2,
        [charId, bag > 0 ? bag : it.type, it.itemId],
      );
      if (rows.length) {
        await execute(
          UPDATE_EQUIP_BY_CHARID_7,
          [...it.levels, it.spirit, charId, bag > 0 ? bag : it.type, Number(rows[0]!.pos2)],
        );
      }
    }
  }
  const moneyBack = trade.money;
  trade.items = [];
  trade.money = 0;
  trade.ready = false;
  return { money: moneyBack, bags: [...bags] };
}

/** Complete trade: give each side the partner's offer. */
export async function completeTrade(
  a: number,
  b: number,
): Promise<{ ok: true; bagsA: number[]; bagsB: number[]; moneyA: number; moneyB: number } | { ok: false }> {
  const ta = sessions.get(a);
  const tb = sessions.get(b);
  if (!ta || !tb) return { ok: false };

  const bagsA = new Set<number>();
  const bagsB = new Set<number>();
  try {
    for (const it of tb.items) {
      const bag = await addItemToInventory(a, it.itemId, it.quantity, it.isCash, it.term);
      if (bag < 0) throw new Error("full A");
      bagsA.add(bag);
    }
    for (const it of ta.items) {
      const bag = await addItemToInventory(b, it.itemId, it.quantity, it.isCash, it.term);
      if (bag < 0) throw new Error("full B");
      bagsB.add(bag);
    }
  } catch {
    // Caller should restore — we don't auto-rollback DB mid-way here beyond best effort
    return { ok: false };
  }

  const moneyA = tb.money;
  const moneyB = ta.money;
  clearTrade(a);
  clearTrade(b);
  return { ok: true, bagsA: [...bagsA], bagsB: [...bagsB], moneyA, moneyB };
}

export async function refreshBags(charId: number, bags: number[], magic: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  const seen = new Set<number>();
  for (const bag of bags) {
    if (bag < 0 || seen.has(bag)) continue;
    seen.add(bag);
    out.push(...(await refreshBagPackets(charId, bag, magic)));
  }
  return out;
}
