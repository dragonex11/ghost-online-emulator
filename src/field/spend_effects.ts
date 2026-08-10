/**
 * Spend-bag recover effects (client item.itm descriptions).
 * HP = red bar (chp), SP = blue bar stored as mp/cmp on this server.
 */

export type SpendRecover =
  | { hpFlat: number }
  | { mpFlat: number }
  | { hpPct: number }
  | { mpPct: number };

/** itemid → recover amount from data/client/table/item.itm */
const SPEND_RECOVER: Record<number, SpendRecover> = {
  // Blue / SP potions
  8810011: { mpFlat: 50 },
  8810021: { mpFlat: 150 },
  8810031: { mpFlat: 400 },
  8810041: { mpPct: 20 },
  8810051: { mpPct: 40 },
  8810061: { mpPct: 60 },
  // Red / HP potions
  8820011: { hpFlat: 50 },
  8820021: { hpFlat: 120 },
  8820031: { hpFlat: 250 },
  8820041: { hpFlat: 500 },
  8820051: { hpFlat: 800 },
  8820061: { hpPct: 20 },
  8820071: { hpPct: 40 },
  8820081: { hpPct: 60 },
  // Fish recoveries
  8810012: { mpFlat: 1500 },
  8810022: { mpFlat: 1050 },
  8810032: { mpFlat: 750 },
  8810042: { mpFlat: 400 },
  8810052: { mpFlat: 200 },
  8810062: { mpFlat: 200 },
  8820012: { hpFlat: 1200 },
  8820022: { hpFlat: 900 },
  8820032: { hpFlat: 600 },
  8820042: { hpFlat: 300 },
  8820052: { hpFlat: 150 },
  8820062: { hpFlat: 150 },
  // Cash / special
  8821001: { hpFlat: 7000 },
  8821002: { mpFlat: 7000 },
  8843001: { hpFlat: 220_000 },
  8843002: { hpFlat: 450_000 },
  8843003: { hpFlat: 675_000 },
  8843006: { mpFlat: 160_000 },
  8843007: { mpFlat: 330_000 },
  8843008: { mpFlat: 495_000 },
  8843102: { hpFlat: 20_000 },
  8843103: { mpFlat: 20_000 },
  8890051: { mpFlat: 100 },
};

export function spendRecoverEffect(itemId: number): SpendRecover | null {
  return SPEND_RECOVER[itemId] ?? null;
}

export function applySpendRecover(
  hp: number,
  mp: number,
  maxHp: number,
  maxMp: number,
  effect: SpendRecover,
): { hp: number; mp: number; changed: boolean } {
  let nextHp = hp;
  let nextMp = mp;
  if ("hpFlat" in effect) {
    nextHp = Math.min(maxHp, hp + effect.hpFlat);
  } else if ("hpPct" in effect) {
    nextHp = Math.min(maxHp, hp + Math.floor((maxHp * effect.hpPct) / 100));
  } else if ("mpFlat" in effect) {
    nextMp = Math.min(maxMp, mp + effect.mpFlat);
  } else if ("mpPct" in effect) {
    nextMp = Math.min(maxMp, mp + Math.floor((maxMp * effect.mpPct) / 100));
  }
  return { hp: nextHp, mp: nextMp, changed: nextHp !== hp || nextMp !== mp };
}
