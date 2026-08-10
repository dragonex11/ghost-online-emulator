import type { RowDataPacket } from "mysql2";
import { rates } from "../../../config.js";
import { query } from "../../../db/index.js";
import { SELECT_MONSTER_DROPS } from "../../../db/queries/index.js";

export type DropRule = {
  monsterId: number;
  kind: "money" | "soul" | "item";
  itemId: number;
  minQty: number;
  maxQty: number;
  chanceBps: number;
  minLv: number;
  maxLv: number;
};

let rules: DropRule[] = [];

/**
 * Ground-drop lifetime. Client also caps at 0x578 frames (~23s) on 0x4E spawn;
 * server must clear too or litter survives forever and floods login with 0x4E.
 */
export const DROP_TTL_MS = 60_000;
export const SOUL_TTL_MS = DROP_TTL_MS;
/** Server-side Y lift interval for souls (pickup authority). */
export const SOUL_RISE_INTERVAL_MS = 200;
/** Pixels upward per rise tick (screen Y decreases). */
const SOUL_RISE_PX = 8;

/** Load drop rules from MySQL `monster_drops` (seeded by database/schema.sql). */
export async function loadDropRules(): Promise<void> {
  rules = [];
  try {
    const rows = await query<RowDataPacket[]>(
      SELECT_MONSTER_DROPS,
    );
    for (const r of rows) {
      const kind = String(r.kind);
      if (kind !== "money" && kind !== "soul" && kind !== "item") continue;
      rules.push({
        monsterId: Number(r.monster_id),
        kind,
        itemId: Number(r.item_id),
        minQty: Number(r.min_qty),
        maxQty: Number(r.max_qty),
        chanceBps: Number(r.chance_bps),
        minLv: Number(r.min_lv ?? 1),
        maxLv: Number(r.max_lv ?? 100),
      });
    }
  } catch (e) {
    console.warn("[drops] failed to load monster_drops from DB:", e);
    rules = [];
  }
  console.log(`[drops] loaded ${rules.length} rules from DB`);
}

/** Pick soul color — all colors at every level (old table gated green/red/purple by lv). */
function rollSoulColor(level: number): { itemId: number; qty: number } {
  // Weights: blue, green, red, purple — early maps used to be blue-only via drop table.
  let w = [28, 32, 24, 16];
  if (level >= 25) w = [22, 30, 28, 20];
  if (level >= 50) w = [15, 25, 32, 28];
  if (level >= 75) w = [10, 20, 30, 40];
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let idx = 0;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r <= 0) {
      idx = i;
      break;
    }
  }
  const itemId = 9900001 + idx;
  const qty =
    idx === 0 ? 1 : idx === 1 ? 1 + Math.floor(Math.random() * 2) : idx === 2 ? 2 + Math.floor(Math.random() * 2) : 3 + Math.floor(Math.random() * 3);
  return { itemId, qty };
}

export function rollDrops(
  monsterId: number,
  level: number,
  extras?: { dropMul?: number; goldMul?: number },
): { itemId: number; qty: number }[] {
  const out: { itemId: number; qty: number }[] = [];
  const applicable = rules.filter(
    (r) => (r.monsterId === 0 || r.monsterId === monsterId) && level >= r.minLv && level <= r.maxLv,
  );
  const dropMul = Math.max(0, rates.dropRate * (extras?.dropMul ?? 1));
  const goldMul = Math.max(0, rates.goldRate * (extras?.goldMul ?? 1));
  let rolledSoul = false;
  for (const r of applicable) {
    if (out.length >= rates.maxDropSlots) break;
    const chance = Math.min(10000, r.chanceBps * dropMul);
    if (Math.random() * 10000 >= chance) continue;
    if (r.kind === "soul") {
      // One soul orb per kill; color chosen by level weights (not hard level gates).
      if (rolledSoul) continue;
      rolledSoul = true;
      out.push(rollSoulColor(level));
      continue;
    }
    let qty = r.minQty;
    if (r.maxQty > r.minQty) qty = r.minQty + Math.floor(Math.random() * (r.maxQty - r.minQty + 1));
    if (r.kind === "money" && r.minQty === 0 && r.maxQty === 0) {
      const base =
        level * rates.goldMinPerLevel +
        Math.floor(Math.random() * (level * rates.goldRangePerLevel + 1));
      qty = Math.max(1, Math.floor(base * goldMul));
    } else if (r.kind === "money" && goldMul !== 1) {
      qty = Math.max(1, Math.floor(qty * goldMul));
    }
    out.push({ itemId: r.itemId, qty: Math.max(1, qty) });
  }
  return out;
}

export type GroundDrop = {
  oid: number;
  itemId: number;
  qty: number;
  x: number;
  y: number;
  map: number;
  region: number;
  spawnedAt: number;
  /** Absolute time when drop is removed (all kinds). */
  expireAt: number;
  lastRiseAt?: number;
};

let nextOid = 1;
const ground = new Map<number, GroundDrop>();

/** legacy `_NextDropID` — reuse oid only after pickup clears the slot */
function nextDropOid(): number {
  for (let tries = 0; tries < 500; tries++) {
    if (nextOid > 500) nextOid = 1;
    const oid = nextOid++;
    if (!ground.has(oid)) return oid;
  }
  for (let oid = 1; oid <= 500; oid++) {
    if (!ground.has(oid)) return oid;
  }
  return 1;
}

export function spawnDrop(d: Omit<GroundDrop, "oid" | "spawnedAt" | "expireAt" | "lastRiseAt">): GroundDrop {
  const oid = nextDropOid();
  const now = Date.now();
  const full: GroundDrop = {
    ...d,
    oid,
    spawnedAt: now,
    expireAt: now + (isSoulOrb(d.itemId) ? SOUL_TTL_MS : DROP_TTL_MS),
    lastRiseAt: isSoulOrb(d.itemId) ? now : undefined,
  };
  ground.set(oid, full);
  return full;
}

export function getDrop(oid: number): GroundDrop | undefined {
  return ground.get(oid);
}

export function clearDrop(oid: number): void {
  ground.delete(oid);
}

export function dropsOnMap(map: number, region: number): GroundDrop[] {
  const now = Date.now();
  return [...ground.values()].filter(
    (d) => d.map === map && d.region === region && d.expireAt > now,
  );
}

export type DropTickEvent = { type: "expire"; drop: GroundDrop };

/** @deprecated use tickGroundDrops */
export type SoulTickEvent = DropTickEvent;

/**
 * Expire all ground drops past TTL; souls also drift Y for pickup range.
 * Do NOT re-broadcast 0x4E on rise (duplicate orbs on client).
 */
export function tickGroundDrops(now = Date.now()): DropTickEvent[] {
  const evts: DropTickEvent[] = [];
  for (const d of [...ground.values()]) {
    if (now >= d.expireAt) {
      ground.delete(d.oid);
      evts.push({ type: "expire", drop: d });
      continue;
    }
    if (!isSoulOrb(d.itemId)) continue;
    const last = d.lastRiseAt ?? d.spawnedAt;
    if (now - last < SOUL_RISE_INTERVAL_MS) continue;
    d.lastRiseAt = now;
    d.y = Math.max(4, d.y - SOUL_RISE_PX);
  }
  return evts;
}

/** @deprecated use tickGroundDrops */
export function tickSouls(now = Date.now()): DropTickEvent[] {
  return tickGroundDrops(now);
}

/**
 * 0x4E drop spawn.
 * @param settled when true, packet+24=1 — client patch skips fall velocity (map sync).
 */
export function buildDropSpawn(d: GroundDrop, opts?: { settled?: boolean }): Buffer {
  const b = Buffer.alloc(32, 0);
  b[0] = 0x05;
  b[1] = 0x01;
  b.writeUInt16LE(0x004e, 2);
  b.writeUInt16LE(0x0020, 4);
  b.writeUInt16LE((0x004e + 0x0020 + 0x105) & 0xffff, 6);
  b.writeUInt32LE(d.oid, 12);
  b.writeUInt32LE(d.itemId, 16);
  b.writeUInt16LE(d.x, 20);
  b.writeUInt16LE(d.y, 22);
  // +24: non-zero = already on ground (no drop/fall anim) — see game.exe cave
  if (opts?.settled) b[24] = 1;
  b.writeUInt32LE(d.qty, 28);
  return b;
}

export function buildDropClear(pickerId: number, d: GroundDrop): Buffer {
  const b = Buffer.alloc(28, 0);
  b[0] = 0x05;
  b[1] = 0x01;
  b.writeUInt16LE(0x004d, 2);
  b.writeUInt16LE(0x001c, 4);
  b.writeUInt16LE((0x004d + 0x001c + 0x105) & 0xffff, 6);
  b.writeUInt32LE(pickerId, 12);
  b.writeUInt32LE(d.oid, 16);
  b.writeUInt32LE(d.itemId, 20);
  // legacy CLEAR_DROP_ITEM_PKT: +24=00, +25=01, +26=FF, +27=FF (fly-to-picker anim)
  b[24] = 0x00;
  b[25] = 0x01;
  b[26] = 0xff;
  b[27] = 0xff;
  return b;
}

/** Ground soul orbs — Bahamut: blue/green/red/purple (9900001..4). */
export function isSoulOrb(itemId: number): boolean {
  return itemId >= 9900001 && itemId <= 9900004;
}
