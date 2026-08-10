import type { RowDataPacket } from "mysql2";
import { query } from "../../../db/index.js";
import { SELECT_ITEM_PRICES } from "../../../db/queries/index.js";

let prices = new Map<number, number>();

/** Load NPC prices from MySQL `item_prices` (seeded by database/schema.sql). */
export async function loadPrices(): Promise<void> {
  prices = new Map();
  try {
    const rows = await query<RowDataPacket[]>(SELECT_ITEM_PRICES);
    for (const r of rows) {
      prices.set(Number(r.item_id), Number(r.price));
    }
  } catch (e) {
    console.warn("[prices] failed to load item_prices from DB:", e);
  }
  if (!prices.size) prices.set(8810011, 100);
  console.log(`[prices] loaded ${prices.size} rows from DB`);
}

export function getPrices(): Map<number, number> {
  return prices;
}
