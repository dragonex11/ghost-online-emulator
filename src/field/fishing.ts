import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";
import { PACKET_MAGIC } from "../protocol/magic.js";
import { OP_FIELD_FISH_ACK } from "../protocol/opcodes.js";
import {
  addItemToInventory,
  refreshBagPackets,
  removeInvQty,
  setSpendUseSlot,
} from "./inventory.js";
import { type Player, send, broadcastMap } from "./player.js";
import { SELECT_EQUIP_BY_CHARID, SELECT_SPEND_BY_CHARID, SELECT_SPEND_BY_CHARID_2, UPDATE_EQUIP_BY_CHARID } from "../db/queries/index.js";

export function fishAck(charId: number, state: number, isFishing: number): Buffer {
  const b = Buffer.alloc(24, 0);
  writeHeader(b, OP_FIELD_FISH_ACK, 24);
  b.writeUInt32LE(charId, 12);
  b.writeInt32LE(state, 16);
  b.writeUInt32LE(isFishing, 20);
  return b;
}

const FISH_REWARDS = [
  8810012, 8820012, 8820022, 8810022, 8820032, 8810032, 8820042, 8810042, 8820052, 8810052,
  8820062, 8810062, 8970001, 8970002, 8970003, 8970004, 8970005, 8970006, 8970007, 8970008,
  8970009, 8970010, 8970011, 8970012,
];

function fishIsBaitItem(itemId: number): boolean {
  if (itemId === 8810011 || itemId === 8820011) return true;
  const g = Math.floor(itemId / 100000);
  if ((g === 881 || g === 882) && itemId % 10 === 1) return true;
  return false;
}

async function fishFindBaitSlot(p: Player): Promise<number> {
  const slot = p.spendUseSlot;
  if (slot !== 0xff && slot >= 0 && slot <= 63) {
    const rows = await query<RowDataPacket[]>(
      SELECT_SPEND_BY_CHARID,
      [p.charId, slot],
    );
    if (rows.length && Number(rows[0]!.amount) >= 1) return slot;
  }
  const all = await query<RowDataPacket[]>(
    SELECT_SPEND_BY_CHARID_2,
    [p.charId],
  );
  let fallback = 0xff;
  for (const r of all) {
    const pslot = Number(r.pos2);
    const iid = Number(r.itemid);
    if (fishIsBaitItem(iid)) {
      p.spendUseSlot = pslot;
      setSpendUseSlot(p.charId, pslot);
      return pslot;
    }
    if (fallback === 0xff) fallback = pslot;
  }
  if (fallback !== 0xff) {
    p.spendUseSlot = fallback;
    setSpendUseSlot(p.charId, fallback);
    return fallback;
  }
  return 0xff;
}

async function fishCheckBait(p: Player): Promise<number> {
  const slot = await fishFindBaitSlot(p);
  if (slot === 0xff) return -2;
  const rows = await query<RowDataPacket[]>(
    SELECT_SPEND_BY_CHARID,
    [p.charId, slot],
  );
  if (!rows.length) return -2;
  if (Number(rows[0]!.amount) < 1) return -2;
  return 0;
}

export function startFishing(p: Player): void {
  void (async () => {
    if (p.fishTimer) clearTimeout(p.fishTimer);
    const state = await fishCheckBait(p);
    if (state !== 0) {
      p.fishing = false;
      broadcastMap(p.map, p.region, fishAck(p.charId, state, 0));
      return;
    }
    p.fishing = true;
    broadcastMap(p.map, p.region, fishAck(p.charId, 0, 1));
    p.fishTimer = setTimeout(() => {
      void fishCatchTick(p);
    }, 50000);
  })();
}

export async function fishCatchTick(p: Player): Promise<void> {
  if (!p.fishing) return;
  const state = await fishCheckBait(p);
  if (state !== 0) {
    p.fishing = false;
    broadcastMap(p.map, p.region, fishAck(p.charId, state, 0));
    return;
  }
  const itemId = FISH_REWARDS[Math.floor(Math.random() * FISH_REWARDS.length)]!;
  const bag = await addItemToInventory(p.charId, itemId, 1, 0, -1, p.magic || PACKET_MAGIC);
  if (bag < 0) {
    p.fishing = false;
    broadcastMap(p.map, p.region, fishAck(p.charId, -3, 0));
    return;
  }
  const bslot = await fishFindBaitSlot(p);
  if (bslot === 0xff) {
    p.fishing = false;
    broadcastMap(p.map, p.region, fishAck(p.charId, -2, 0));
    return;
  }
  await removeInvQty(p.charId, 3, bslot, 1);
  broadcastMap(p.map, p.region, fishAck(p.charId, itemId, 1));
  let rodBroken = false;
  const w = await query<RowDataPacket[]>(
    SELECT_EQUIP_BY_CHARID,
    [p.charId],
  );
  if (w.length) {
    const fus = Number(w[0]!.slot ?? 0) + 1;
    await execute(UPDATE_EQUIP_BY_CHARID, [fus, p.charId]);
    if (fus >= 30) rodBroken = true;
  }
  for (const out of await refreshBagPackets(p.charId, bag, p.magic || PACKET_MAGIC)) send(p, out);
  for (const out of await refreshBagPackets(p.charId, 3, p.magic || PACKET_MAGIC)) send(p, out);
  for (const out of await refreshBagPackets(p.charId, 0, p.magic || PACKET_MAGIC)) send(p, out);
  if (rodBroken) {
    p.fishing = false;
    broadcastMap(p.map, p.region, fishAck(p.charId, -1, 0));
  } else {
    const again = await fishCheckBait(p);
    if (again !== 0) {
      p.fishing = false;
      broadcastMap(p.map, p.region, fishAck(p.charId, again, 0));
    } else {
      p.fishTimer = setTimeout(() => {
        void fishCatchTick(p);
      }, 50000);
    }
  }
}
