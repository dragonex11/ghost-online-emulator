import type { RowDataPacket } from 'mysql2';
import { execute, query } from '../../db.js';
import { readCString, writeCString, writeHeader } from '../../net/packet.js';
import { packetMagicOrDefault } from '../../protocol/magic.js';
import { applySpendRecover, spendRecoverEffect } from '../spend_effects.js';
import {
  activeBuffOrNull,
  applyEventBuff,
  isSpecialSpendItem,
  rollGachaBox,
} from '../spend_boxes.js';
import {
  addItemToInventory,
  addPetToBag,
  removeInvQty,
  refreshBagPackets,
} from '../inventory.js';
import { type Player, broadcastAll, send } from '../player.js';
import { notice, sendVital } from '../packets/ui.js';

import { SELECT_SPEND_BY_CHARID, UPDATE_CHARACTERS_BY_ID_14 } from "../../db/queries/index.js";
export function isEffectSpendItem(itemId: number): boolean {
  if (itemId === 8890031 || itemId === 8890037) return true;
  if (itemId === 8890011 || itemId === 8890021) return true;
  if (itemId >= 8843021 && itemId <= 8843025) return true;
  return false;
}

/** Apply HP/SP recover from a spent potion/food; persists + syncs 0x51. */
export async function tryApplySpendRecover(p: Player, itemId: number): Promise<void> {
  const effect = spendRecoverEffect(itemId);
  if (!effect) return;
  if (!p.alive) return;
  const next = applySpendRecover(p.hp, p.mp, p.maxHp, p.maxMp, effect);
  if (!next.changed) return;
  p.hp = next.hp;
  p.mp = next.mp;
  await execute(UPDATE_CHARACTERS_BY_ID_14, [p.hp, p.mp, p.charId]);
  sendVital(p);
}

/** Gift/Treasure/Christmas boxes + Lucky Spring / Golden Xmas sox. Returns true if handled. */
export async function tryHandleSpecialSpend(p: Player, itemId: number): Promise<boolean> {
  if (!isSpecialSpendItem(itemId)) return false;

  const buffed = applyEventBuff(itemId);
  if (buffed) {
    p.eventBuff = buffed.buff;
    send(p, notice(buffed.notice, 3));
    console.log(`[spend] buff char=${p.charId} item=${itemId} until=${buffed.buff.until}`);
    return true;
  }

  const rolled = rollGachaBox(itemId);
  if (!rolled) return false;

  let bag = -1;
  if (Math.floor(rolled.itemId / 100000) === 92 || rolled.itemId === 7820501) {
    bag = await addPetToBag(p.charId, rolled.itemId, "Pet", 0, packetMagicOrDefault(p.magic));
  } else {
    bag = await addItemToInventory(p.charId, rolled.itemId, rolled.qty, 0, -1, packetMagicOrDefault(p.magic));
  }
  if (bag < 0) {
    send(p, notice(`${rolled.label}: inventory full — reward lost`, 3));
    console.log(`[spend] gacha FULL char=${p.charId} box=${itemId} reward=${rolled.itemId}`);
    return true;
  }
  for (const out of await refreshBagPackets(p.charId, bag, packetMagicOrDefault(p.magic))) send(p, out);
  send(p, notice(`${rolled.label}: obtained item ${rolled.itemId} x${rolled.qty}`, 3));
  console.log(
    `[spend] gacha char=${p.charId} box=${itemId} -> ${rolled.itemId}x${rolled.qty} (${rolled.label})`,
  );
  return true;
}

export function useSpendStartPkt(
  charId: number,
  x: number,
  y: number,
  itemId: number,
  type: number,
  slot: number,
): Buffer {
  const b = Buffer.alloc(28, 0);
  writeHeader(b, 0x0071, 28);
  b.writeUInt32LE(charId, 12);
  b.writeUInt16LE(x & 0xffff, 16);
  b.writeUInt16LE(y & 0xffff, 18);
  b.writeUInt32LE(itemId, 20);
  b.writeUInt8(type & 0xff, 24);
  b.writeUInt8(slot & 0xff, 25);
  return b;
}

/** S2C INVEN_USESPEND_SHOUT_ACK (0xFB) — client template len 0x124. */
function useSpendShoutAckPkt(channel: number, name: string, message: string, type = 1): Buffer {
  const b = Buffer.alloc(0x124, 0);
  writeHeader(b, 0x00fb, 0x124);
  b.writeUInt8(channel & 0xff, 12);
  writeCString(b, 13, name.slice(0, 19), 20);
  writeCString(b, 0x21, message.slice(0, 255), 256);
  b.writeUInt16LE(type & 0xffff, 0x121);
  return b;
}

/**
 * Cash shout scrolls: 8842001 → C2S 0xFA (channel), 8842002 Server Scroll → C2S 0x15B (all).
 * Body: u8 slot @+12, null-terminated message @+13 (client zeros 256 bytes).
 */
export async function handleUseSpendShout(p: Player, pkt: Buffer, op: number): Promise<void> {
  const expectId = op === 0x015b ? 8842002 : 8842001;
  const slot = pkt.length >= 13 ? pkt.readUInt8(12) : 0xff;
  const message = pkt.length > 13 ? readCString(pkt, 13, Math.min(256, pkt.length - 13)).trim() : "";
  if (slot > 63 || !message || message.length > 255) {
    console.log(`[field] shout reject char=${p.charId} op=0x${op.toString(16)} slot=${slot} msgLen=${message.length}`);
    return;
  }
  const rows = await query<RowDataPacket[]>(
    SELECT_SPEND_BY_CHARID,
    [p.charId, slot],
  );
  if (!rows.length) {
    console.log(`[field] shout empty slot char=${p.charId} slot=${slot}`);
    return;
  }
  const itemId = Number(rows[0]!.itemid);
  if (itemId !== expectId) {
    console.log(`[field] shout wrong item char=${p.charId} slot=${slot} got=${itemId} want=${expectId}`);
    return;
  }
  const removed = await removeInvQty(p.charId, 3, slot, 1);
  if (!removed) return;
  const ack = useSpendShoutAckPkt(1, p.name, message, op === 0x015b ? 1 : 0);
  broadcastAll(ack);
  for (const out of await refreshBagPackets(p.charId, 3, packetMagicOrDefault(p.magic))) send(p, out);
  console.log(
    `[field] shout ok char=${p.charId} name=${p.name} op=0x${op.toString(16)} item=${itemId} msg="${message.slice(0, 40)}"`,
  );
}
