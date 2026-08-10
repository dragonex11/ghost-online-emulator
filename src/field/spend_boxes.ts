/**
 * Cash spend boxes / event buffs (client item.itm):
 *   8890044 Gift Box — mystery reward
 *   8890101 Old Treasure Box — mystery reward
 *   8890050 Christmas sock — mystery reward
 *   8890112 Lucky Spring — 1h luck (drop rate)
 *   8890200 Golden Xmas sox — 1h gold/exp/drop buffs
 */

export type BoxBuff = {
  expMul: number;
  dropMul: number;
  goldMul: number;
  until: number;
};

const GACHA_BOXES = new Set([8890044, 8890101, 8890050]);

/** Weighted reward pools — itemId, weight, qty */
const GIFT_BOX_POOL: { itemId: number; weight: number; qty: number }[] = [
  { itemId: 8890031, weight: 25, qty: 20 }, // Firecracker
  { itemId: 8890037, weight: 25, qty: 20 }, // Passionate Love
  { itemId: 8890011, weight: 15, qty: 10 }, // Candle
  { itemId: 8890021, weight: 15, qty: 10 }, // Torch
  { itemId: 8820061, weight: 10, qty: 5 }, // HP 20%
  { itemId: 8810041, weight: 10, qty: 5 }, // SP 20%
  { itemId: 8841005, weight: 5, qty: 1 }, // Free Reset Scroll
  { itemId: 8950101, weight: 3, qty: 1 }, // Floral Flight trail
  { itemId: 8842002, weight: 2, qty: 5 }, // Server Scroll
];

const TREASURE_BOX_POOL: { itemId: number; weight: number; qty: number }[] = [
  { itemId: 8890031, weight: 20, qty: 50 },
  { itemId: 8890037, weight: 20, qty: 50 },
  { itemId: 8841005, weight: 12, qty: 3 },
  { itemId: 8841006, weight: 8, qty: 1 }, // All Reset
  { itemId: 8950103, weight: 8, qty: 1 }, // Flame Rush
  { itemId: 8950105, weight: 8, qty: 1 }, // Star Dust
  { itemId: 8950501, weight: 6, qty: 1 }, // name frame
  { itemId: 8950508, weight: 6, qty: 1 },
  { itemId: 8842002, weight: 5, qty: 10 },
  { itemId: 9210011, weight: 3, qty: 1 }, // pet
  { itemId: 9220011, weight: 4, qty: 1 }, // Red Muffler
];

const SOCK_POOL: { itemId: number; weight: number; qty: number }[] = [
  { itemId: 8890031, weight: 30, qty: 30 },
  { itemId: 8890037, weight: 30, qty: 30 },
  { itemId: 8820071, weight: 15, qty: 3 },
  { itemId: 8810051, weight: 15, qty: 3 },
  { itemId: 8950510, weight: 5, qty: 1 },
  { itemId: 8842002, weight: 5, qty: 5 },
];

function pickWeighted(pool: { itemId: number; weight: number; qty: number }[]): {
  itemId: number;
  qty: number;
} {
  const valid = pool.filter((e) => e.weight > 0 && e.itemId > 0);
  const total = valid.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of valid) {
    r -= e.weight;
    if (r <= 0) return { itemId: e.itemId, qty: e.qty };
  }
  return { itemId: valid[0]!.itemId, qty: valid[0]!.qty };
}

export function isGachaBox(itemId: number): boolean {
  return GACHA_BOXES.has(itemId);
}

export function isEventBuffItem(itemId: number): boolean {
  return itemId === 8890112 || itemId === 8890200;
}

export function isSpecialSpendItem(itemId: number): boolean {
  return isGachaBox(itemId) || isEventBuffItem(itemId);
}

export function rollGachaBox(itemId: number): { itemId: number; qty: number; label: string } | null {
  if (itemId === 8890044) {
    const r = pickWeighted(GIFT_BOX_POOL);
    return { ...r, label: "Gift Box" };
  }
  if (itemId === 8890101) {
    const r = pickWeighted(TREASURE_BOX_POOL);
    return { ...r, label: "Old Treasure Box" };
  }
  if (itemId === 8890050) {
    const r = pickWeighted(SOCK_POOL);
    return { ...r, label: "Christmas sock" };
  }
  return null;
}

/** Apply buff from Lucky Spring / Golden Xmas sox. Returns notice text. */
export function applyEventBuff(itemId: number, now = Date.now()): { buff: BoxBuff; notice: string } | null {
  const hour = 60 * 60 * 1000;
  if (itemId === 8890112) {
    return {
      buff: { expMul: 1, dropMul: 1.5, goldMul: 1, until: now + hour },
      notice: "Lucky Spring: item drop rate +50% for 1 hour",
    };
  }
  if (itemId === 8890200) {
    // item.itm: gold +50%, exp +25%, item drop +50%
    return {
      buff: { expMul: 1.25, dropMul: 1.5, goldMul: 1.5, until: now + hour },
      notice: "Golden Xmas sox: gold +50%, EXP +25%, drops +50% for 1 hour",
    };
  }
  return null;
}

export function activeBuffOrNull(buff: BoxBuff | undefined, now = Date.now()): BoxBuff | null {
  if (!buff || buff.until <= now) return null;
  return buff;
}
