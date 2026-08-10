/** Catalog item shape (category assigned at insert time). */
export type CashCatalogEntry = {
  itemId: number;
  bargain: number;
  term: number;
  price: number;
  flag: number;
};
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

/** Client pet equipment with icons (item.itm + pet_deco.csp = 3 muffler frames). */
export const PET_EQ_SUPPORTED = new Set([7820501, 9220011, 9220012, 9220013]);

/** Foot-trail cash items (8950101–8950105). */
export const RUN_TRAIL_IDS = new Set([8950101, 8950102, 8950103, 8950104, 8950105]);

export const UNSUPPORTED_PRODUCE_IDS = new Set([8950106, 8950107]);

/** HOT Hot tab (treasure cat 19): gacha boxes, event buffs, Server Scroll. */
export const HOT_TREASURE_ITEMS: Omit<CashCatalogEntry, never>[] = [
  { itemId: 8890044, bargain: 300, term: -1, price: 300, flag: 0 },
  { itemId: 8890101, bargain: 300, term: -1, price: 300, flag: 0 },
  { itemId: 8890050, bargain: 300, term: -1, price: 300, flag: 0 },
  { itemId: 8890112, bargain: 300, term: -1, price: 300, flag: 0 },
  { itemId: 8890200, bargain: 300, term: -1, price: 300, flag: 0 },
  { itemId: 8842002, bargain: 49, term: -1, price: 49, flag: 0 },
];

/** Ensure base pets 001–003 and event pets 201–207. */
export const ENSURE_PETS: Omit<CashCatalogEntry, never>[] = [
  { itemId: 9210011, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210012, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210013, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210021, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210022, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210023, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210031, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210032, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210033, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212011, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212012, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212013, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212014, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212021, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212022, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212023, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212031, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212041, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212043, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212044, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212051, bargain: 149, term: -1, price: 149, flag: 0 },
  { itemId: 9212061, bargain: 149, term: -1, price: 149, flag: 0 },
  { itemId: 9212071, bargain: 149, term: -1, price: 149, flag: 0 },
];

export const PET_EQ_DEFAULTS: Omit<CashCatalogEntry, never>[] = [
  { itemId: 7820501, bargain: 49, term: -1, price: 49, flag: 0 },
  { itemId: 9220011, bargain: 159, term: -1, price: 159, flag: 0 },
  { itemId: 9220012, bargain: 159, term: -1, price: 159, flag: 0 },
  { itemId: 9220013, bargain: 159, term: -1, price: 159, flag: 0 },
];

/** Cash shop slots per category (client loops 200). */
export const CASH_SLOTS_PER_CATEGORY = 200;

/** Fashion category indices for client asset filtering. */
export const FASHION_CATEGORY_INDICES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/** Pet category index in cash shop. */
export const PET_CATEGORY_INDEX = 15;

/** Pet equipment category index. */
export const PET_EQ_CATEGORY_INDEX = 16;

/** Treasure / HOT category index. */
export const TREASURE_CATEGORY_INDEX = 19;

/** Luckbag category index. */
export const LUCKBAG_CATEGORY_INDEX = 10;

/** Produce (mileage frames) category index. */
export const PRODUCE_CATEGORY_INDEX = 11;

/** Pill (run trails) category index. */
export const PILL_CATEGORY_INDEX = 13;

/** Max items per category in catalog builder. */
export const MAX_ITEMS_PER_CATEGORY = 300;

/** Item ID range for companion pets (921xxxx). */
export const COMPANION_PET_ID_MIN = 9_210_000;
export const COMPANION_PET_ID_MAX = 9_220_000;

/** Buy amount overrides by item ID (unchanged mall behavior). */
export function cashBuyAmount(itemId: number): number {
  if (itemId === 8842002) return 10;
  if (itemId >= 8841001 && itemId <= 8841005) return 20;
  if (itemId === 8890031 || itemId === 8890037) return 100;
  if (itemId === 8890044 || itemId === 8890101 || itemId === 8890050) return 1;
  if (itemId === 8890112 || itemId === 8890200) return 1;
  return 1;
}
