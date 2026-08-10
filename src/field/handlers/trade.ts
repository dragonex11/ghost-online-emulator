import { execute } from '../../db/index.js';
import { packetMagicOrDefault } from '../../protocol/magic.js';
import {
  getTrade,
  clearTrade,
  beginTradePair,
  buildTradeInvite,
  buildTradeInviteResponses,
  buildTradeReady,
  buildTradeConfirm,
  buildTradeCancel,
  buildTradeFail,
  buildTradeSuccess,
  buildTradePut,
  tradePutItem,
  tradePutMoney,
  restoreTradeOffer,
  completeTrade,
  refreshBags,
} from '../features/trade/index.js';
import { type Player, players, send } from '../player.js';
import { moneyPacket } from '../packets/ui.js';
import { UPDATE_CHARACTERS_BY_ID_9 } from "../../db/queries/index.js";

export async function cancelTradeFor(p: Player, notifyPartner: boolean): Promise<void> {
  const trade = getTrade(p.charId);
  if (!trade) return;
  const partnerId = trade.partnerId;
  const partner = players.get(partnerId);
  const partnerTrade = getTrade(partnerId);

  const restored = await restoreTradeOffer(p.charId, trade);
  if (restored.money > 0) {
    p.money += restored.money;
    await execute(UPDATE_CHARACTERS_BY_ID_9, [p.money, p.charId]);
    send(p, moneyPacket(p.money, restored.money));
  }
  for (const pkt of await refreshBags(p.charId, restored.bags, packetMagicOrDefault(p.magic))) send(p, pkt);

  if (partnerTrade && partner) {
    const r2 = await restoreTradeOffer(partnerId, partnerTrade);
    if (r2.money > 0) {
      partner.money += r2.money;
      await execute(UPDATE_CHARACTERS_BY_ID_9, [partner.money, partnerId]);
      send(partner, moneyPacket(partner.money, r2.money));
    }
    for (const pkt of await refreshBags(partnerId, r2.bags, packetMagicOrDefault(partner.magic))) send(partner, pkt);
    if (notifyPartner) send(partner, buildTradeCancel());
  }
  clearTrade(p.charId);
  clearTrade(partnerId);
}
export async function handleTradePacket(p: Player, op: number, pkt: Buffer): Promise<void> {
  if (op === 0x0092) {
    const targetId = pkt.length >= 16 ? pkt.readInt32LE(12) : 0;
    const target = players.get(targetId);
    if (!target?.loggedIn || target.map !== p.map || target.region !== p.region) {
      console.log(`[field] trade-invite fail char=${p.charId} target=${targetId}`);
      return;
    }
    if (getTrade(p.charId) || getTrade(targetId)) {
      console.log(`[field] trade-invite fail busy char=${p.charId}/${targetId}`);
      return;
    }
    // Tentative link until accept (C# sets Trader both ways on invite)
    beginTradePair(p.charId, targetId);
    // Don't escrow yet — clear money/items until accept by using empty sessions;
    // beginTradePair already empty. Mark as pending: partnerId set is enough.
    send(target, buildTradeInvite(p.charId));
    console.log(`[field] trade-invite char=${p.charId} -> ${targetId}`);
    return;
  }

  if (op === 0x0093) {
    const response = pkt.length >= 16 ? pkt.readInt32LE(12) : 0;
    const trade = getTrade(p.charId);
    if (!trade) return;
    const partner = players.get(trade.partnerId);
    if (response !== 1) {
      clearTrade(p.charId);
      clearTrade(trade.partnerId);
      if (partner?.loggedIn) send(partner, buildTradeInviteResponses(0));
      send(p, buildTradeInviteResponses(0));
      console.log(`[field] trade-decline char=${p.charId}`);
      return;
    }
    // Accept — ensure both have fresh sessions
    beginTradePair(p.charId, trade.partnerId);
    send(p, buildTradeInviteResponses(1));
    if (partner?.loggedIn) send(partner, buildTradeInviteResponses(1));
    console.log(`[field] trade-accept char=${p.charId} with=${trade.partnerId}`);
    return;
  }

  if (op === 0x0094) {
    const trade = getTrade(p.charId);
    if (!trade) return;
    trade.ready = true;
    const partner = players.get(trade.partnerId);
    if (partner?.loggedIn) {
      send(partner, buildTradeReady());
      send(partner, buildTradeInviteResponses(2));
      send(partner, buildTradeConfirm());
    }
    console.log(`[field] trade-ready char=${p.charId}`);
    return;
  }

  if (op === 0x0095) {
    const trade = getTrade(p.charId);
    if (!trade) return;
    const partnerId = trade.partnerId;
    const partner = players.get(partnerId);
    if (!partner?.loggedIn) {
      await cancelTradeFor(p, false);
      return;
    }
    const result = await completeTrade(p.charId, partnerId);
    if (!result.ok) {
      send(p, buildTradeFail());
      send(partner, buildTradeFail());
      await cancelTradeFor(p, true);
      return;
    }
    if (result.moneyA > 0) {
      p.money += result.moneyA;
      await execute(UPDATE_CHARACTERS_BY_ID_9, [p.money, p.charId]);
      send(p, moneyPacket(p.money, result.moneyA));
    }
    if (result.moneyB > 0) {
      partner.money += result.moneyB;
      await execute(UPDATE_CHARACTERS_BY_ID_9, [partner.money, partnerId]);
      send(partner, moneyPacket(partner.money, result.moneyB));
    }
    for (const pktOut of await refreshBags(p.charId, result.bagsA, packetMagicOrDefault(p.magic))) send(p, pktOut);
    for (const pktOut of await refreshBags(partnerId, result.bagsB, packetMagicOrDefault(partner.magic))) send(partner, pktOut);
    send(p, buildTradeSuccess());
    send(partner, buildTradeSuccess());
    console.log(`[field] trade-confirm char=${p.charId} <-> ${partnerId}`);
    return;
  }

  if (op === 0x0096) {
    await cancelTradeFor(p, true);
    send(p, buildTradeCancel());
    console.log(`[field] trade-cancel char=${p.charId}`);
    return;
  }

  if (op === 0x0099) {
    const trade = getTrade(p.charId);
    if (!trade) return;
    const partner = players.get(trade.partnerId);
    if (!partner?.loggedIn) return;
    const sourceType = pkt.length >= 14 ? pkt.readInt16LE(12) : -1;
    const sourceSlot = pkt.length >= 16 ? pkt.readInt16LE(14) : -1;
    const quantity = pkt.length >= 20 ? pkt.readInt32LE(16) : 0;

    if (sourceType === 0x64 && sourceSlot === 0x64) {
      const res = await tradePutMoney(p.charId, quantity, p.money);
      if (!res.ok) return;
      p.money = res.newMoney;
      await execute(UPDATE_CHARACTERS_BY_ID_9, [p.money, p.charId]);
      send(p, moneyPacket(p.money, res.delta));
    } else {
      const res = await tradePutItem(p.charId, sourceType, sourceSlot, quantity);
      if (!res.ok) {
        console.log(`[field] trade-put fail char=${p.charId}: ${res.reason}`);
        return;
      }
      for (const pktOut of await refreshBags(p.charId, [res.bag], packetMagicOrDefault(p.magic))) send(p, pktOut);
    }

    const selfTrade = getTrade(p.charId)!;
    const partnerTrade = getTrade(partner.charId)!;
    send(p, buildTradePut(p.charId, partner.charId, selfTrade, partnerTrade));
    send(partner, buildTradePut(partner.charId, p.charId, partnerTrade, selfTrade));
    console.log(
      `[field] trade-put char=${p.charId} type=${sourceType} slot=${sourceSlot} qty=${quantity}`,
    );
  }
}
