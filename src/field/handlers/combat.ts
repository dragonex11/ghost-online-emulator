import type { RowDataPacket } from 'mysql2';
import { config, rates } from '../../config.js';
import { execute } from '../../db/index.js';
import { activeBuffOrNull } from '../features/spend/boxes.js';
import { getParty } from '../features/party/index.js';
import {
  monstersOnMap,
  displayPos,
} from '../features/monsters/index.js';
import { deadTownMap, deadTownSpawn } from '../maps.js';
import { charAll } from '../packets/char.js';
import { lvExpPacket, levelUpPacket, playerDeadAck, sendVital } from '../packets/ui.js';
import { type Player, players, send, broadcastMap } from '../player.js';

import { UPDATE_CHARACTERS_BY_ID_15, UPDATE_CHARACTERS_BY_ID_16, UPDATE_CHARACTERS_BY_ID_17, UPDATE_CHARACTERS_BY_ID_18 } from "../../db/queries/index.js";
export async function hurtPlayer(p: Player, dmg: number, reason = "hit"): Promise<void> {
  if (!p.alive) return;
  if (dmg <= 0) return;
  if (Date.now() < p.touchGraceUntil) return;
  // VIT/def reduces incoming damage (soft floor of 1)
  const mitigated = Math.max(1, dmg - Math.floor((p.def | 0) / 5));
  dmg = mitigated;
  if (dmg > 500) dmg = 500; // legacy _MonHurtPlayer cap
  p.hp -= dmg;
  p.lastTouchAt = Date.now();
  if (p.hp <= 0) {
    p.alive = false;
    p.hp = 1;
    if (p.mp < 1) p.mp = 1;
    if (p.maxSoul < 1) p.maxSoul = 100;
    // Sanitize death coords — 0,0 / tiny values crash the client death UI
    if (p.x < 10 || p.y < 10 || p.x > 20000 || p.y > 20000) {
      const safe = deadTownSpawn(deadTownMap(p.map));
      p.x = safe.x;
      p.y = safe.y;
    }
    await execute(UPDATE_CHARACTERS_BY_ID_15, [
      p.hp,
      p.mp,
      p.x,
      p.y,
      p.charId,
    ]);
    send(p, playerDeadAck(p));
    sendVital(p);
    console.log(
      `[field] PLAYER_DEAD char=${p.charId} reason=${reason} map=${p.map}/${p.region} @${p.x},${p.y}`,
    );
  } else {
    await execute(UPDATE_CHARACTERS_BY_ID_16, [p.hp, p.charId]);
    sendVital(p);
  }
}

export function tickMonsterTouch(): void {
  const now = Date.now();
  for (const p of players.values()) {
    if (!p.loggedIn || !p.alive || !p.fieldEntered) continue;
    if (now < p.touchGraceUntil) continue;
    if (now - p.lastTouchAt < rates.touchCooldownMs) continue;
    for (const m of monstersOnMap(p.map, p.region)) {
      if (m.dead) continue;
      // Require contact with BOTH server feet and client-visible estimate.
      // Server-only contact was phantom HP loss when the sprite lagged behind.
      const vis = displayPos(m, now);
      const nearServer = Math.abs(p.x - m.x) <= 100 && Math.abs(p.y - m.y) <= 90;
      const nearVis = Math.abs(p.x - vis.x) <= 100 && Math.abs(p.y - vis.y) <= 90;
      if (nearServer && nearVis) {
        void hurtPlayer(p, m.crash, `touch slot=${m.slot}`);
        break;
      }
    }
  }
}

export async function grantMonsterExp(p: Player, amount: number): Promise<boolean> {
  if (amount <= 0 || !p.loggedIn) return false;
  const buff = activeBuffOrNull(p.eventBuff);
  const mul = buff?.expMul ?? 1;
  p.exp += Math.max(1, Math.floor(amount * mul));
  send(p, lvExpPacket(p.level, p.exp));
  let leveled = false;
  while (p.exp >= p.mexp && p.mexp > 0) {
    p.exp -= p.mexp;
    p.level++;
    p.mexp = Math.floor(p.mexp * rates.levelExpCurve);
    if (p.mexp < 1) p.mexp = 30;
    await execute(
      UPDATE_CHARACTERS_BY_ID_17,
      [p.charId],
    );
    leveled = true;
    send(p, levelUpPacket(p.charId));
    broadcastMap(p.map, p.region, levelUpPacket(p.charId), p.charId);
  }
  await execute(UPDATE_CHARACTERS_BY_ID_18, [
    p.exp,
    p.level,
    p.mexp,
    p.charId,
  ]);
  if (leveled) send(p, await charAll(p.charId));
  return leveled;
}

/**
 * Same-map/region logged-in party members (incl. killer), else just the killer.
 * Official: different map/region → no EXP (or quest-kill) share.
 */
export function partyShareRecipients(killer: Player): Player[] {
  const list = getParty(killer.charId);
  if (!list || list.length < 2) return [killer];
  const out: Player[] = [];
  for (const id of list) {
    const pl = players.get(id);
    if (!pl?.loggedIn) continue;
    if (pl.map !== killer.map || pl.region !== killer.region) continue;
    out.push(pl);
  }
  return out.length > 0 ? out : [killer];
}
