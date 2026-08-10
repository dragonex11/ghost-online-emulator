export const CAT_NAMES = [
  "boy_eyes",
  "girl_eyes",
  "boy_hair",
  "girl_hair",
  "face1",
  "face2",
  "hat",
  "boy_dress",
  "girl_dress",
  "mantle",
  "luckbag",
  "produce",
  "amulet",
  "pill",
  "talisman",
  "pet",
  "peteq",
  "petcon",
  "guard",
  "treasure",
] as const;

export const CASH_CATEGORY_COUNT = 20;

/** Cash shop slots per category (client loops 200). */
export const CASH_SLOTS_PER_CATEGORY = 200;

/** Buy amount overrides by item ID (unchanged mall behavior). */
export function cashBuyAmount(itemId: number): number {
  if (itemId === 8842002) return 10;
  if (itemId >= 8841001 && itemId <= 8841005) return 20;
  if (itemId === 8890031 || itemId === 8890037) return 100;
  if (itemId === 8890044 || itemId === 8890101 || itemId === 8890050) return 1;
  if (itemId === 8890112 || itemId === 8890200) return 1;
  return 1;
}
