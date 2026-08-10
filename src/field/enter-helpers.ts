import {
  buildCashLists,
  cashSlotCount,
  buildBalance,
  buildWarehouse,
  deliverCashGifts,
} from './features/cashshop/index.js';
import {
  buildAllBags,
  buildEquip,
  buildEquip1,
  buildEquip2,
  buildSetAvatar,
} from './features/inventory/index.js';
import { packetMagicOrDefault } from '../protocol/magic.js';
import { type Player, send } from './player.js';

export async function sendBags(p: Player): Promise<void> {
  for (const bag of await buildAllBags(p.charId, packetMagicOrDefault(p.magic))) send(p, bag);
}

export async function sendCashMall(p: Player): Promise<void> {
  const magic = packetMagicOrDefault(p.magic);
  send(p, await buildEquip(p.charId));
  send(p, await buildEquip1(p.charId, magic));
  send(p, await buildEquip2(p.charId, magic));
  send(p, await buildSetAvatar(p.charId));
  const slots = cashSlotCount(packetMagicOrDefault(p.magic));
  const lists = buildCashLists(slots);
  for (const c of lists) send(p, c);
  console.log(
    `[cashshop] sent lists char=${p.charId} slotsPer=${slots} magic=0x${(p.magic || 0).toString(16)} sizes=${lists.map((b: Buffer) => b.length).join(",")}`,
  );
  for (const b of await buildBalance(p.accountId)) send(p, b);
  await deliverCashGifts(p.charId, p.name);
  send(p, await buildWarehouse(p.charId));
}

/** Catalog only — must be sent BEFORE ENTERPLAYER on map 77 so UI sync sees filled lists. */
export async function sendCashCatalog(p: Player): Promise<void> {
  const magic = packetMagicOrDefault(p.magic);
  send(p, await buildEquip(p.charId));
  send(p, await buildEquip1(p.charId, magic));
  send(p, await buildEquip2(p.charId, magic));
  send(p, await buildSetAvatar(p.charId));
  const slots = cashSlotCount(packetMagicOrDefault(p.magic));
  const lists = buildCashLists(slots);
  for (const c of lists) send(p, c);
  console.log(
    `[cashshop] catalog char=${p.charId} slotsPer=${slots} magic=0x${(p.magic || 0).toString(16)} sizes=${lists.map((b: Buffer) => b.length).join(",")}`,
  );
}

export async function sendCashBalanceAndWarehouse(p: Player): Promise<void> {
  for (const b of await buildBalance(p.accountId)) send(p, b);
  await deliverCashGifts(p.charId, p.name);
  send(p, await buildWarehouse(p.charId));
}

function isCashMall(map: number, region: number): boolean {
  return (map === 77 && region === 1) || (map === 1 && region === 77);
}
