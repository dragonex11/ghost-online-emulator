import { execute, query } from "../db.js";
import type { RowDataPacket } from "mysql2";
import { writeHeader, writeCString } from "../net/packet.js";
import { addItemToInventory, removeInvQty, refreshBagPackets } from "./inventory.js";
import { SELECT_EQUIP_BY_CHARID_9, SELECT_OTHER_BY_CHARID_4, SELECT_SPEND_BY_CHARID_5 } from "../db/queries/index.js";

type ShopSlot = {
  itemId: number;
  qty: number;
  price: number;
  srcType: number;
  srcSlot: number;
  spirit: number;
  fusion: number;
  locked: number;
  /** L1..L10 (legacy order = p_1..p_10) */
  levels: number[];
};

type Shop = {
  active: boolean;
  kind: number; // 0 personal, 1 commit
  name: string;
  money: number;
  map: number;
  region: number;
  slots: ShopSlot[];
};

const shops = new Map<number, Shop>();

/** legacy _PShopOpcodes */
function opcodes(kind: number) {
  if (kind === 1) {
    return { open: 0x19d, start: 0x19f, end: 0x1a0, sellInfo: 0x1a1, info: 0x1a3, buy: 0x1a5 };
  }
  return { open: 0x00ce, start: 0x00d0, end: 0x00d1, sellInfo: 0x00d2, info: 0x00d4, buy: 0x00d6 };
}

function ensure(charId: number): Shop {
  let s = shops.get(charId);
  if (!s) {
    s = { active: false, kind: 0, name: "", money: 0, map: 0, region: 0, slots: [] };
    shops.set(charId, s);
  }
  return s;
}

export function pshopClear(charId: number): void {
  shops.delete(charId);
}

/** End active shop and return map END packet (leave/warp/disconnect). */
export function endPShopIfActive(charId: number): Buffer | null {
  const s = shops.get(charId);
  if (!s?.active) {
    pshopClear(charId);
    return null;
  }
  // Money is credited to characters.money on each buy (legacy parity) — do not re-add.
  const pkt = buildPShopEndPkt(charId, s.kind);
  pshopClear(charId);
  return pkt;
}

export function buildPShopStartPkt(charId: number, name: string, kind: number): Buffer {
  const o = opcodes(kind);
  const start = Buffer.alloc(60, 0);
  writeHeader(start, o.start, 60);
  start.writeUInt32LE(charId, 12);
  // client: +16 feeds shop-flag via 0x49eeb0; 0 yields a non-positive flag and
  // blocks click→0xD3. legacy wrote 0 (TW); Client needs a positive type (≥1).
  start.writeUInt32LE(1, 16);
  writeCString(start, 20, name.slice(0, 39), 40);
  return start;
}

export function buildPShopEndPkt(charId: number, kind: number): Buffer {
  const o = opcodes(kind);
  const end = Buffer.alloc(16, 0);
  writeHeader(end, o.end, 16);
  end.writeUInt32LE(charId, 12);
  return end;
}

function buildPShopSellInfoPkt(sellerId: number, s: Shop): Buffer {
  const o = opcodes(s.kind);
  const sellInfo = Buffer.alloc(168, 0);
  writeHeader(sellInfo, o.sellInfo, 168);
  sellInfo.writeUInt32LE(sellerId, 12);
  sellInfo.writeUInt32LE(s.money, 16);
  sellInfo.writeUInt32LE(0, 20);
  for (let i = 0; i < 12; i++) {
    const off = 24 + i * 12;
    const sl = s.slots[i];
    if (sl && sl.itemId && sl.qty > 0) {
      sellInfo.writeUInt16LE(sl.srcType & 0xffff, off);
      sellInfo.writeUInt16LE(sl.srcSlot & 0xffff, off + 2);
      sellInfo.writeUInt32LE(sl.qty, off + 4);
      sellInfo.writeUInt32LE(sl.price, off + 8);
    } else {
      sellInfo.writeUInt16LE(0xffff, off);
      sellInfo.writeUInt16LE(0xffff, off + 2);
    }
  }
  return sellInfo;
}

function buildPShopInfoAckPkt(sellerId: number, s: Shop | undefined, kind: number): Buffer {
  const o = opcodes(kind);
  const b = Buffer.alloc(584, 0);
  writeHeader(b, o.info, 584);
  // legacy: INFO ack +12 = seller id (REQID)
  b.writeUInt32LE(sellerId, 12);
  writeCString(b, 16, s?.name || "Shop", 40);
  if (!s?.active) return b;
  for (let i = 0; i < 12; i++) {
    const off = 56 + i * 44;
    const slot = s.slots[i];
    if (slot && slot.itemId && slot.qty > 0) {
      b.writeUInt32LE(slot.itemId, off);
      b.writeUInt16LE(slot.spirit & 0xffff, off + 4);
      b.writeUInt16LE(slot.qty & 0xffff, off + 6);
      for (let k = 0; k < 10; k++) b.writeUInt8((slot.levels[k] ?? 0) & 0xff, off + 8 + k);
      b.writeUInt8(slot.fusion & 0xff, off + 18);
      b.writeUInt8(slot.locked & 0xff, off + 19);
      b.writeUInt32LE(slot.price >>> 0, off + 20);
    }
  }
  return b;
}

function shopHasStock(s: Shop): boolean {
  return s.slots.some((sl) => sl && sl.itemId && sl.qty > 0);
}

/** Active shops on a map — for enter/warp sync (legacy map-all START). */
export function listActivePShops(
  map: number,
  region: number,
): { charId: number; name: string; kind: number }[] {
  const out: { charId: number; name: string; kind: number }[] = [];
  for (const [charId, s] of shops) {
    if (!s.active) continue;
    if (s.map !== map || s.region !== region) continue;
    out.push({ charId, name: s.name || "Shop", kind: s.kind });
  }
  return out;
}

export function handlePShopOpen(charId: number, kind: number): Buffer {
  const s = ensure(charId);
  s.kind = kind;
  const o = opcodes(kind);
  const b = Buffer.alloc(16, 0);
  writeHeader(b, o.open, 16);
  b.writeUInt32LE(6, 12);
  return b;
}

/** legacy _PShopSnapshotItem — resolve bag/equip row into a listing. */
async function snapshotItem(
  charId: number,
  srcType: number,
  srcSlot: number,
  qty: number,
  price: number,
): Promise<ShopSlot | null> {
  if (srcType < 3) {
    const rows = await query<RowDataPacket[]>(
      SELECT_EQUIP_BY_CHARID_9,
      [charId, srcType, srcSlot],
    );
    if (!rows.length) return null;
    const r = rows[0]!;
    // legacy INFO writes L1..L10 = p_1..p_10
    const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => Number(r[`p_${n}`] ?? 0) & 0xff);
    return {
      itemId: Number(r.type),
      qty: 1,
      price: Math.max(0, price),
      srcType,
      srcSlot,
      spirit: Number(r.soulperc ?? 0),
      fusion: Number(r.slot ?? 0),
      locked: Number(r.iscash ?? 0),
      levels,
    };
  }
  if (srcType === 3) {
    const rows = await query<RowDataPacket[]>(
      SELECT_SPEND_BY_CHARID_5,
      [charId, srcSlot],
    );
    if (!rows.length) return null;
    const r = rows[0]!;
    const have = Number(r.amount ?? 0);
    const use = Math.max(1, Math.min(qty > 0 ? qty : have, have));
    return {
      itemId: Number(r.itemid),
      qty: use,
      price: Math.max(0, price),
      srcType,
      srcSlot,
      spirit: 0,
      fusion: 0,
      locked: Number(r.iscash ?? 0),
      levels: Array(10).fill(0),
    };
  }
  if (srcType === 4) {
    const rows = await query<RowDataPacket[]>(
      SELECT_OTHER_BY_CHARID_4,
      [charId, srcSlot],
    );
    if (!rows.length) return null;
    const r = rows[0]!;
    const have = Number(r.amount ?? 0);
    const use = Math.max(1, Math.min(qty > 0 ? qty : have, have));
    return {
      itemId: Number(r.type),
      qty: use,
      price: Math.max(0, price),
      srcType,
      srcSlot,
      spirit: 0,
      fusion: 0,
      locked: Number(r.iscash ?? 0),
      levels: Array(10).fill(0),
    };
  }
  return null;
}

/**
 * Client 0xCF / 0x19E → map-broadcast START 0xD0 / 0x19F (legacy _SendPacketToMapAll).
 * Listing block: +52 + i*12 = srcType(u16), srcSlot(u16), qty(u32), price(u32).
 */
export async function handlePShopSellStart(
  charId: number,
  pkt: Buffer,
  kind: number,
  map: number,
  region: number,
): Promise<{ packets: Buffer[]; broadcast: boolean }> {
  const name =
    pkt.length >= 52 ? pkt.toString("utf8", 12, 52).replace(/\0.*$/, "").trim() || "Shop" : "Shop";
  const slots: ShopSlot[] = [];
  for (let i = 0; i < 12; i++) {
    const off = 52 + i * 12;
    if (pkt.length < off + 12) break;
    const srcType = pkt.readUInt16LE(off);
    const srcSlot = pkt.readUInt16LE(off + 2);
    const qty = pkt.readUInt32LE(off + 4);
    const price = pkt.readInt32LE(off + 8);
    if (srcType === 0xffff || srcSlot === 0xffff) continue;
    if (srcType > 5 || srcSlot > 63) continue;
    if (price < 0) continue;
    const snap = await snapshotItem(charId, srcType, srcSlot, qty, price);
    if (snap && snap.itemId) slots.push(snap);
  }
  if (!slots.length) {
    console.log(`[pshop] start fail: no items char=${charId}`);
    return { packets: [], broadcast: false };
  }
  const s = ensure(charId);
  s.kind = kind;
  s.name = name;
  s.active = true;
  s.money = 0;
  s.map = map;
  s.region = region;
  s.slots = slots;
  console.log(`[pshop] start char=${charId} name=${name} items=${slots.length} kind=${kind} map=${map}/${region}`);
  return { packets: [buildPShopStartPkt(charId, name, kind)], broadcast: true };
}

export function handlePShopSellEnd(charId: number, kind: number): { packets: Buffer[]; broadcast: boolean } {
  const s = shops.get(charId);
  if (!s?.active) {
    pshopClear(charId);
    return { packets: [], broadcast: false };
  }
  const end = buildPShopEndPkt(charId, kind);
  // Shop money was already credited to characters.money on each buy.
  pshopClear(charId);
  console.log(`[pshop] end char=${charId}`);
  return { packets: [end], broadcast: true };
}

export async function handlePShopInfo(buyerId: number, pkt: Buffer, kind: number): Promise<Buffer | null> {
  const sellerId = pkt.readUInt32LE(12);
  const s = shops.get(sellerId);
  if (!s?.active) {
    console.log(`[pshop] info miss buyer=${buyerId} seller=${sellerId}`);
    return null;
  }
  console.log(`[pshop] info buyer=${buyerId} seller=${sellerId} items=${s.slots.filter((x) => x.qty > 0).length}`);
  return buildPShopInfoAckPkt(sellerId, s, kind);
}

export type PShopBuyResult = {
  packets: Buffer[];
  buyerMoney?: number;
  sellerId?: number;
  sellerGain?: number;
  sellerSrcType?: number;
  toSeller?: Buffer[];
  toMap?: Buffer[];
};

export async function handlePShopBuy(
  buyer: { charId: number; money: number },
  pkt: Buffer,
  kind: number,
): Promise<PShopBuyResult> {
  const sellerId = pkt.readUInt32LE(12);
  // legacy: +16 itemId, +20 slot u16, +22 qty u16
  const itemId = pkt.length >= 20 ? pkt.readUInt32LE(16) : 0;
  const idx = pkt.length >= 22 ? pkt.readUInt16LE(20) : pkt.readUInt32LE(16);
  const qty = pkt.length >= 24 ? Math.max(1, pkt.readUInt16LE(22)) : 1;
  const s = shops.get(sellerId);
  const o = opcodes(kind);
  const fail = (): PShopBuyResult => {
    const ack = Buffer.alloc(16, 0);
    writeHeader(ack, o.buy, 16);
    ack.writeUInt32LE(0, 12);
    return { packets: [ack] };
  };
  if (!s?.active || idx < 0 || idx > 11 || !s.slots[idx] || s.slots[idx]!.qty < qty) {
    console.log(`[pshop] buy fail state buyer=${buyer.charId} seller=${sellerId} idx=${idx}`);
    return fail();
  }
  const slot = s.slots[idx]!;
  if (itemId && slot.itemId !== itemId) {
    console.log(`[pshop] buy fail item buyer=${buyer.charId} want=${itemId} have=${slot.itemId}`);
    return fail();
  }
  const cost = slot.price * qty;
  if (buyer.money < cost) {
    console.log(`[pshop] buy fail money buyer=${buyer.charId} need=${cost} have=${buyer.money}`);
    return fail();
  }
  // Remove from seller first (legacy order); rollback if buyer bag full.
  const removed = await removeInvQty(sellerId, slot.srcType, slot.srcSlot, qty).catch(() => 0);
  if (!removed) {
    console.log(`[pshop] buy fail remove seller=${sellerId} type=${slot.srcType} slot=${slot.srcSlot}`);
    return fail();
  }
  const bag = await addItemToInventory(buyer.charId, slot.itemId, qty);
  if (bag < 0) {
    await addItemToInventory(sellerId, slot.itemId, qty).catch(() => -1);
    console.log(`[pshop] buy fail bag buyer=${buyer.charId}`);
    return fail();
  }
  slot.qty -= qty;
  s.money += cost;

  const ack = Buffer.alloc(16, 0);
  writeHeader(ack, o.buy, 16);
  ack.writeUInt32LE(1, 12);

  const buyerRefresh = await refreshBagPackets(buyer.charId, bag);
  // legacy: re-send INFO then BUY ack to buyer
  const infoAgain = buildPShopInfoAckPkt(sellerId, s, kind);
  const toSeller: Buffer[] = [buildPShopSellInfoPkt(sellerId, s)];
  try {
    const sellerRefresh = await refreshBagPackets(sellerId, slot.srcType);
    toSeller.unshift(...sellerRefresh);
  } catch {
    /* seller offline bags still OK in DB */
  }

  let toMap: Buffer[] | undefined;
  if (!shopHasStock(s)) {
    // No stock left — close shop for everyone (map END).
    toMap = [buildPShopEndPkt(sellerId, s.kind)];
    pshopClear(sellerId);
    console.log(`[pshop] buy emptied shop seller=${sellerId} — closed`);
  }

  console.log(
    `[pshop] buy buyer=${buyer.charId} seller=${sellerId} item=${slot.itemId} qty=${qty} price=${cost}`,
  );
  return {
    packets: [...buyerRefresh, infoAgain, ack],
    buyerMoney: buyer.money - cost,
    sellerId,
    sellerGain: cost,
    sellerSrcType: slot.srcType,
    toSeller,
    toMap,
  };
}

export function isPShopOpcode(op: number): boolean {
  return (op >= 0x00cd && op <= 0x00d5) || (op >= 0x019c && op <= 0x01a4);
}

/** Opcodes whose header unk must stay 0 (legacy _CashShopWriteHeader). */
export function isPShopOutOpcode(op: number): boolean {
  return (
    (op >= 0x00ce && op <= 0x00d6) ||
    (op >= 0x019d && op <= 0x01a5)
  );
}

export type PShopDispatchResult = {
  toSelf: Buffer[];
  /** When set, fan-out to entire map (start/end shop visuals). */
  toMap?: Buffer[];
};

export async function dispatchPShop(
  charId: number,
  op: number,
  pkt: Buffer,
  map: number,
  region: number,
): Promise<PShopDispatchResult> {
  const commit = op >= 0x019c;
  const kind = commit ? 1 : 0;
  const base = commit ? 0x019c : 0x00cd;
  const rel = op - base;
  if (rel === 0) return { toSelf: [handlePShopOpen(charId, kind)] };
  if (rel === 2) {
    const r = await handlePShopSellStart(charId, pkt, kind, map, region);
    return r.broadcast ? { toSelf: [], toMap: r.packets } : { toSelf: r.packets };
  }
  if (rel === 4) {
    const r = handlePShopSellEnd(charId, kind);
    return r.broadcast ? { toSelf: [], toMap: r.packets } : { toSelf: r.packets };
  }
  if (rel === 6) {
    const info = await handlePShopInfo(charId, pkt, kind);
    return { toSelf: info ? [info] : [] };
  }
  if (rel === 8) {
    const o = opcodes(kind);
    const ack = Buffer.alloc(16, 0);
    writeHeader(ack, o.buy, 16);
    ack.writeUInt32LE(0, 12);
    return { toSelf: [ack] };
  }
  const ack = Buffer.alloc(16, 0);
  writeHeader(ack, op + 1, 16);
  ack.writeUInt32LE(1, 12);
  return { toSelf: [ack] };
}
