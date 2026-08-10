import type { RowDataPacket } from 'mysql2';
import { rates, config } from '../../config.js';
import { query, execute } from '../../db.js';
import {
  opcodeOf,
  readCString,
  writeHeader,
  logPkt,
} from '../../net/packet.js';
import { packetMagicOrDefault } from '../../protocol/magic.js';
import {
  ensureBeginnerSkills,
  syncJobSkills,
  buildSkillAll,
  buildSkillLevelUpAck,
  skillPointUp,
  getSkillByTypeSlot,
  clearAdvancedSkills,
  maxAllSkills,
  maxSkillLevel,
  JOB_UNSET,
  job2ClassId,
  job2ClassName,
  job2PathFromId,
  job3ToWireGuild,
} from '../skills.js';
import {
  loadMonsters,
  monstersOnMap,
  getMonster,
  sendCombatMonAll,
  buildMonAllCreate,
  buildMonInfo,
  applyDamage,
  buildDropPackets,
  monsterExp,
  tickRespawns,
  tickWander,
  buildMonRegen,
  resetMonstersOnMap,
  hibernateMonstersOnMap,
  isFlyer,
  moveTypeFor,
  setMonsterAggro,
  displayPos,
  LIVE_INTERVAL_MS,
  type Monster,
} from '../monsters.js';
import {
  loadDropRules,
  getDrop,
  clearDrop,
  dropsOnMap,
  buildDropSpawn,
  buildDropClear,
  spawnDrop,
  isSoulOrb,
  tickGroundDrops,
} from '../drops.js';
import {
  loadCashShopFromDb,
  buildCashLists,
  cashSlotCount,
  buildBalance,
  buildWarehouse,
  cashBuy,
  deliverCashGifts,
} from '../cashshop.js';
import {
  buildAllBags,
  buildEquip,
  buildEquip1,
  buildEquip2,
  buildSetAvatar,
  addItemToInventory,
  addPetToBag,
  isPetItem,
  removeInvQty,
  changeItem,
  dismantle,
  refreshBagPackets,
  buyPrice,
  sellPrice,
  getPetUseSlot,
  setPetUseSlot,
  getSpendUseSlot,
  setSpendUseSlot,
  buildSpend3,
  buildPetWorldState,
} from '../inventory.js';
import { applySpendRecover, spendRecoverEffect } from '../spend_effects.js';
import {
  activeBuffOrNull,
  applyEventBuff,
  isSpecialSpendItem,
  rollGachaBox,
  type BoxBuff,
} from '../spend_boxes.js';
import { handleQuestPacket, onMonsterKill, buildQuestAll } from '../quests.js';
import { buildQuickSlotAll, saveQuickSlot } from '../hotkeys.js';
import {
  dispatchPShop,
  handlePShopBuy,
  isPShopOpcode,
  isPShopOutOpcode,
  listActivePShops,
  buildPShopStartPkt,
  endPShopIfActive,
} from '../pshop.js';
import {
  isPartyOpcode,
  getParty,
  clearParty,
  setSharedParty,
  removeFromParty,
  buildPartyInvite,
  buildPartyInviteResponses,
  buildPartyUpdate,
  buildPartyHpUpdate,
  buildPartyDismiss,
  type PartyMemberSnap,
} from '../party.js';
import {
  isTradeOpcode,
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
} from '../trade.js';
import {
  type Player,
  players,
  send,
  broadcastMap,
  broadcastMapUdp,
  broadcastAll,
  enterTrace,
  beginEnterTrace,
  endEnterTrace,
  mapHasPlayers,
  fieldUdp,
  setFieldUdp,
} from '../player.js';
import {
  deadTownMap,
  deadTownSpawn,
  defaultFieldSpawn,
  sanitizePlayerPos,
  mapExists,
} from '../maps.js';
import { charAll, enterPlayer, loadCharRow, u8, u16, u32 } from '../packets/char.js';
import {
  writeChangeMapPacket,
  mapInfo,
  leavePacket,
  notice,
  moneyPacket,
  hpMpPacket,
  sendVital,
  lvExpPacket,
  levelUpPacket,
  playerDeadAck,
} from '../packets/ui.js';
import { handleGm, runGmCommand } from '../gm.js';
import { fishAck, startFishing, fishCatchTick } from '../fishing.js';
import { CHAT_TYPE_MAP, CHAT_TYPE_WHISPER, isCashMall } from '../constants.js';
import { getPrices } from '../prices.js';
import { initPacket } from '../packets/hello.js';
import {
  clearMonCombat,
  scheduleEnterMonsters,
  maybeHibernateMap,
  ensureMonCombatReady,
} from '../monster-runtime.js';
import { MOVE_OPS, relayPeerAction } from './movement.js';
import { resolveCharId } from './auth.js';
import { chatPacket, findPlayerByName, readWhisperTarget } from './chat.js';
import { handlePartyPacket, leaveParty, sendPartyUpdateTo } from './party.js';
import { handleTradePacket } from './trade.js';
import { handleUseSkill, buildStatUpAck } from './skills.js';
import { handleUseSpendShout, isEffectSpendItem, useSpendStartPkt, tryHandleSpecialSpend, tryApplySpendRecover } from './spend.js';
import {
  hurtPlayer,
  grantMonsterExp,
  partyShareRecipients,
} from './combat.js';
import {
  sendBags,
  sendCashMall,
  sendCashCatalog,
  sendCashBalanceAndWarehouse,
} from '../enter-helpers.js';
import { countOnline } from '../online-count.js';

import { DELETE_CASH_INVEN_BY_ID, DELETE_EQUIP_BY_CHARID_4, DELETE_EQUIP_BY_CHARID_5, INSERT_EQUIP_3, INSERT_EQUIP_4, INSERT_GIFTS, SELECT_CASH_INVEN_BY_CHARID_AND_SLOT, SELECT_CHARACTERS_BY_NAME_2, SELECT_EQUIP, SELECT_EQUIP_BY_CHARID_10, SELECT_PETS_BY_CID_AND_TYPE_9, SELECT_SPEND_BY_CHARID, SELECT_USERS_BY_ACCOUNTID_3, UPDATE_CHARACTERS_BY_ID, UPDATE_CHARACTERS_BY_ID_10, UPDATE_CHARACTERS_BY_ID_14, UPDATE_CHARACTERS_BY_ID_19, UPDATE_CHARACTERS_BY_ID_20, UPDATE_CHARACTERS_BY_ID_21, UPDATE_CHARACTERS_BY_ID_22, UPDATE_CHARACTERS_BY_ID_23, UPDATE_CHARACTERS_BY_ID_24, UPDATE_CHARACTERS_BY_ID_9, UPDATE_EQUIP_BY_CHARID_6 } from "../../db/queries/index.js";
export async function handlePacket(p: Player, pkt: Buffer): Promise<void> {
  const op = opcodeOf(pkt);
  console.log(
    `[field] pkt op=0x${op.toString(16)} len=${pkt.length} loggedIn=${p.loggedIn} char=${p.charId}`,
  );
  logPkt("IN", `field#${p.charId || "?"} op=${op.toString(16)}`, pkt);

  if (op === 0x0018) {
    // legacy: first 0x18 binds char + INIT; subsequent 0x18 sends CHAR_ALL/skills/map
    if (!p.loggedIn) {
      const info = await resolveCharId(pkt);
      if (!info) {
        console.log("[field] closing — auth failed");
        p.sock.destroy();
        return;
      }
      const old = players.get(info.charId);
      if (old && old.sock !== p.sock) {
        try {
          old.sock.destroy();
        } catch {
          /* */
        }
      }
      const row = await loadCharRow(info.charId);
      if (!row) {
        console.log("[field] no character row", info.charId);
        return;
      }
      p.charId = info.charId;
      p.accountId = info.accountId;
      p.name = info.name;
      p.map = Number(row.map ?? 1);
      p.region = Number(row.region ?? 1);
      // Rescue characters stuck on deleted / never-shipped maps (e.g. //gogo to missing prj).
      if (!mapExists(p.map, p.region)) {
        console.log(
          `[field] rescue invalid map char=${info.charId} ${p.map}/${p.region} -> 1/1`,
        );
        p.map = 1;
        p.region = 1;
        const safe = defaultFieldSpawn(1, 1);
        p.x = safe.x;
        p.y = safe.y;
        await execute(UPDATE_CHARACTERS_BY_ID_19, [
          p.x,
          p.y,
          info.charId,
        ]);
      } else {
        const pos = sanitizePlayerPos(p.map, p.region, Number(row.charX ?? 0), Number(row.charY ?? 0));
        p.x = pos.x;
        p.y = pos.y;
        if (pos.fixed) {
          await execute(UPDATE_CHARACTERS_BY_ID_20, [p.x, p.y, info.charId]);
          console.log(`[field] fixed void spawn char=${info.charId} -> ${p.map}/${p.region} @${p.x},${p.y}`);
        }
      }
      p.level = Number(row.level ?? 1);
      p.exp = Number(row.exp ?? 0);
      p.mexp = Number(row.mexp ?? 30);
      p.job = Number(row.job ?? 0);
      // 0 was wrongly written by old //job2 — treat as unset
      let j2 = Number(row.job2 ?? -1);
      let j3 = Number(row.job3 ?? -1);
      if (j2 === 0) j2 = -1;
      if (j3 === 0) j3 = -1;
      p.job2 = j2;
      p.job3 = j3;
      p.hp = Number(row.chp ?? 50);
      p.maxHp = Number(row.cmhp ?? 50);
      p.mp = Number(row.cmp ?? 50);
      p.maxMp = Number(row.cmmp ?? 50);
      p.minAtk = Number(row.mindamphy ?? 10);
      p.maxAtk = Math.max(p.minAtk, Number(row.maxdamphy ?? 10));
      p.minMag = Number(row.mindamw ?? 0);
      p.maxMag = Math.max(p.minMag, Number(row.maxdamw ?? 0));
      p.def = Number(row.def ?? 0);
      p.money = Number(row.money ?? 0);
      p.soul = Number(row.soul ?? 0);
      p.maxSoul = Math.max(1, Number(row.maxsoul ?? 100));
      const u = await query<RowDataPacket[]>(SELECT_USERS_BY_ACCOUNTID_3, [p.accountId]);
      p.gm = Number(u[0]?.gm ?? 0);
      p.alive = p.hp > 1;
      // Logged out while dead — respawn at town so reconnect doesn't reload monster map at 1 HP
      if (!p.alive) {
        const town = deadTownMap(p.map);
        const spawn = deadTownSpawn(town);
        p.map = town;
        p.region = 1;
        p.x = spawn.x;
        p.y = spawn.y;
        p.hp = Math.max(1, p.maxHp);
        p.alive = true;
        await execute(UPDATE_CHARACTERS_BY_ID_21, [
          p.map,
          p.region,
          p.x,
          p.y,
          p.hp,
          p.charId,
        ]);
        console.log(`[field] dead-login respawn char=${p.charId} -> ${p.map}/1 @${p.x},${p.y}`);
      }
      p.spendUseSlot = 0xff;
      setSpendUseSlot(info.charId, 0xff);
      p.petUseSlot = getPetUseSlot(info.charId);
      p.touchGraceUntil = Date.now() + rates.touchGraceAuthMs;
      p.lastTouchAt = Date.now();
      if (p.petUseSlot === 0xff) {
        const worn = await query<RowDataPacket[]>(
          SELECT_PETS_BY_CID_AND_TYPE_9,
          [info.charId],
        );
        if (worn.length) {
          setPetUseSlot(info.charId, 0);
          p.petUseSlot = 0;
        }
      }
      // Register only after loadout is built — avoids mid-await broadcasts.
      await ensureBeginnerSkills(p.charId);
      // Do not syncJobSkills here — original unlocks job skills via master quests.
      // Client needs INIT with real charId (connect hello only has a placeholder id).
      send(p, initPacket(p.charId, packetMagicOrDefault(p.magic)));
      console.log(`[field] bound char=${p.charId} name=${p.name} map=${p.map}/${p.region}`);
    }
    // Send loadout (legacy: CHAR_ALL → skills → quickslot → quests → MAP_INFO).
    // client: keep MAP_INFO early (before quests) — MAP last left some clients stuck loading.
    send(p, await charAll(p.charId));
    send(p, await buildSkillAll(p.charId));
    send(p, mapInfo(p));
    send(p, await buildQuestAll(p.charId));
    try {
      send(p, await buildQuickSlotAll(p.charId));
    } catch (e) {
      console.error("[field] quickslot send failed", e);
    }
    if (!p.loggedIn && p.charId) {
      p.loggedIn = true;
      players.set(p.charId, p);
      countOnline();
    }
    console.log(`[field] sent CHAR_ALL/SKILLS/MAP for ${p.name}`);
    return;
  }

  if (!p.loggedIn || !p.charId) return;

  if (MOVE_OPS.has(op)) {
    relayPeerAction(p, pkt, op);
    return;
  }

  if (op === 0x00db) {
    // legacy 0xDB: bags + ENTERPLAYER(self) + peers + drops. MON_ALL is prepared but NEVER sent.
    // Client often re-sends 0xDB ~1s later — second ENTERPLAYER causes a loading flash.
    if (p.fieldEntered && !p.pendingWarp) {
      console.log(`[field] ignore duplicate 0xDB char=${p.charId}`);
      return;
    }
    beginEnterTrace(p.charId, `0xDB map=${p.map}/${p.region} @${p.x},${p.y}`);
    p.touchGraceUntil = Date.now() + rates.touchGraceEnterMs;
    p.lastTouchAt = Date.now();
    await sendBags(p);
    // Mall: push catalog BEFORE ENTERPLAYER so UI sync (map=77) sees filled lists — no 2nd 0x1E.
    if (isCashMall(p.map, p.region)) await sendCashCatalog(p);
    const ep = await enterPlayer(p.charId, {
      x: p.x,
      y: p.y,
      petUseSlot: p.petUseSlot,
      map: p.map,
      region: p.region,
    });
    send(p, ep);
    // client often stays invisible without an explicit SETAVATAR after ENTERPLAYER
    send(p, await buildSetAvatar(p.charId));
    for (const o of players.values()) {
      if (o.loggedIn && o.fieldEntered && o.charId !== p.charId && o.map === p.map && o.region === p.region) {
        send(p, await enterPlayer(o.charId, { x: o.x, y: o.y, petUseSlot: o.petUseSlot, map: o.map, region: o.region }));
        send(p, await buildSetAvatar(o.charId));
        send(o, ep);
        send(o, await buildSetAvatar(p.charId));
      }
    }
    p.fieldEntered = true;
    for (const d of dropsOnMap(p.map, p.region)) send(p, buildDropSpawn(d, { settled: true }));
    for (const shop of listActivePShops(p.map, p.region)) {
      send(p, buildPShopStartPkt(shop.charId, shop.name, shop.kind));
    }
    const petLife = await buildPetWorldState(p.charId);
    if (petLife.readUInt16LE(2) === 0x0107) send(p, petLife);
    if (isCashMall(p.map, p.region)) await sendCashBalanceAndWarehouse(p);
    const monCount = scheduleEnterMonsters(p, p.map, p.region, "db");
    console.log(
      `[field] enter-0xDB map=${p.map}/${p.region} (no MON packets; ${monCount} pending until move)`,
    );
    p.touchGraceUntil = Date.now() + rates.touchGraceEnterMs;
    p.lastTouchAt = Date.now();
    endEnterTrace(p.charId);
    return;
  }

  if (op === 0x001d || op === 0x011d) {
    // Initial enter: client sends 0x1D before 0xDB. Self ENTERPLAYER before bags crashes the client.
    // After warp (0x85): legacy sends ENTERPLAYER + peers + MON + drops — NOT bags/PET_LIFE.
    if (pkt.length >= 24) {
      const nx = pkt.readUInt16LE(20);
      const ny = pkt.readUInt16LE(22);
      if (nx < 20000 && ny < 20000) {
        p.x = nx;
        p.y = ny;
        await execute(UPDATE_CHARACTERS_BY_ID_20, [p.x, p.y, p.charId]);
      }
    }
    if (p.pendingWarp) {
      p.pendingWarp = false;
      const warpMap = p.map;
      const warpRegion = p.region;
      beginEnterTrace(p.charId, `warp-0x1D map=${warpMap}/${warpRegion} @${p.x},${p.y}`);
      p.touchGraceUntil = Date.now() + rates.touchGraceEnterMs;
      p.lastTouchAt = Date.now();
      // Mall: catalog before ENTERPLAYER (avoids extra 0x1E that flashes "loading").
      if (isCashMall(p.map, p.region)) await sendCashCatalog(p);
      const ep = await enterPlayer(p.charId, {
        x: p.x,
        y: p.y,
        petUseSlot: p.petUseSlot,
        map: p.map,
        region: p.region,
      });
      send(p, ep);
      send(p, await buildSetAvatar(p.charId));
      for (const o of players.values()) {
        if (o.loggedIn && o.fieldEntered && o.charId !== p.charId && o.map === p.map && o.region === p.region) {
          send(p, await enterPlayer(o.charId, { x: o.x, y: o.y, petUseSlot: o.petUseSlot, map: o.map, region: o.region }));
          send(p, await buildSetAvatar(o.charId));
          send(o, ep);
          send(o, await buildSetAvatar(p.charId));
        }
      }
      p.fieldEntered = true;
      for (const d of dropsOnMap(warpMap, warpRegion)) send(p, buildDropSpawn(d, { settled: true }));
      for (const shop of listActivePShops(warpMap, warpRegion)) {
        send(p, buildPShopStartPkt(shop.charId, shop.name, shop.kind));
      }
      if (isCashMall(p.map, p.region)) await sendCashBalanceAndWarehouse(p);
      resetMonstersOnMap(warpMap, warpRegion);
      const monCount = scheduleEnterMonsters(p, warpMap, warpRegion, "warp");
      console.log(`[field] MON_ALL(warp) map=${warpMap}/${warpRegion} count=${monCount}`);
      p.touchGraceUntil = Date.now() + rates.touchGraceEnterMs;
      p.lastTouchAt = Date.now();
      endEnterTrace(p.charId);
      console.log(`[field] enter-warp char=${p.charId} map=${warpMap}/${warpRegion}`);
      return;
    }
    // First join: peers only — bags/self/MON_ALL/cash come from 0xDB (avoid double mall + loading).
    beginEnterTrace(p.charId, `join-0x1D map=${p.map}/${p.region} @${p.x},${p.y}`);
    for (const o of players.values()) {
      if (o.loggedIn && o.fieldEntered && o.charId !== p.charId && o.map === p.map && o.region === p.region) {
        send(p, await enterPlayer(o.charId, { x: o.x, y: o.y, petUseSlot: o.petUseSlot, map: o.map, region: o.region }));
        send(p, await buildSetAvatar(o.charId));
      }
    }
    endEnterTrace(p.charId);
    return;
  }

  if (op === 0x0017) {
    const chatType = pkt.length >= 20 ? pkt.readInt32LE(16) : CHAT_TYPE_MAP;
    let msg = readCString(pkt, pkt.length >= 120 ? 0x14 : 12, 80);
    msg = msg.replace(/^[^:]+:\s*/, "").trim();
    // En-client often ships //commands over CHAT instead of COMMAND 0x10.
    // Never rebroadcast // lines as map chat.
    if (/^\/\//.test(msg)) {
      await runGmCommand(p, msg);
      return;
    }
    if (!msg) return;

    // Whisper (type 3): 1:1 only — never map-broadcast (overhead text for everyone).
    if (chatType === CHAT_TYPE_WHISPER) {
      let targetName = readWhisperTarget(pkt);
      if (!targetName) {
        const m = msg.match(/^\/?\s*(\S+)\s+(.+)$/);
        if (m) {
          targetName = m[1]!;
          msg = m[2]!.trim();
        }
      }
      console.log(
        `[field] whisper from=${p.name}(${p.charId}) target=${JSON.stringify(targetName)} msg=${JSON.stringify(msg)} tail=${pkt.length >= 0x78 ? pkt.subarray(0x64, 0x78).toString("hex") : "?"}`,
      );
      if (!targetName) {
        send(p, notice("Whisper: no target", 3));
        return;
      }
      if (targetName.toLowerCase() === p.name.toLowerCase()) {
        send(p, notice("Cannot whisper yourself", 3));
        return;
      }
      const dest = findPlayerByName(targetName);
      if (!dest) {
        send(p, notice(`${targetName} is not online`, 3));
        return;
      }
      // Type 3 = whisper color; suppressBubble clears overhead binding (not guild type 1).
      const out = chatPacket(p.charId, p.name, msg, CHAT_TYPE_WHISPER, dest.name, {
        suppressBubble: true,
      });
      send(dest, out);
      send(p, out);
      return;
    }

    const out = chatPacket(p.charId, p.name, msg, chatType === CHAT_TYPE_MAP ? CHAT_TYPE_MAP : chatType);
    // Client local-echoes typed map chat; echoing back to self doubles every line.
    broadcastMap(p.map, p.region, out, p.charId);
    return;
  }

  if (op === 0x0010) {
    await handleGm(p, pkt);
    return;
  }

  if (op === 0x0045) {
    // AttackMonster_Req: charId@12, slot@14, dmg@18, hitX@20, hitY@22
    ensureMonCombatReady(p);
    const slot = pkt.length >= 16 ? pkt.readUInt16LE(14) & 0xff : pkt.readUInt8(14);
    const clientDmg = pkt.length >= 20 ? pkt.readInt16LE(18) : 0;
    const hitSparkX = pkt.length >= 24 ? pkt.readUInt16LE(20) : 0;
    const hitSparkY = pkt.length >= 24 ? pkt.readUInt16LE(22) : 0;
    const m = getMonster(p.map, p.region, slot);
    if (!m || m.dead) return;

    // Hit sparks are VFX only — never warp authoritative Position (blink/teleport).
    // legacy: status 7 then immediate status 1 at same MON_X/Y (no Y snap on hit).
    p.touchGraceUntil = Date.now() + rates.touchGraceAttackMs;
    p.lastTouchAt = Date.now();
    m.side = p.x < m.x ? -1 : 1;
    // Prefer server Position for sparks when client spark is wild; else use spark for FX only.
    const hitX = hitSparkX > 10 ? hitSparkX : m.x;
    const hitY = hitSparkY > 50 ? hitSparkY : m.y;

    // Trust client Damage (rolled from mindamphy/maxdamphy + gear on client).
    let dmg = clientDmg;
    if (!Number.isFinite(dmg) || dmg <= 0 || dmg > 9999) {
      const lo = Math.max(1, p.minAtk);
      const hi = Math.max(lo, p.maxAtk);
      dmg = lo + Math.floor(Math.random() * (hi - lo + 1));
      dmg = Math.max(1, dmg - Math.floor((m.def || 0) / 2));
    }
    dmg = Math.max(1, Math.min(9999, Math.floor(dmg)));

    // On lethal hit, soft-align corpse X to hit spark only. Never take spark Y —
    // it is often airborne/underground and made loot rise from below the floor.
    if (dmg >= m.hp && hitSparkX > 10 && hitSparkX < 20000 && Math.abs(hitSparkX - m.x) < 320) {
      m.x = hitSparkX;
    }

    const { dead, drops } = applyDamage(m, dmg, (() => {
      const buff = activeBuffOrNull(p.eventBuff);
      return buff ? { dropMul: buff.dropMul, goldMul: buff.goldMul } : undefined;
    })());
    if (dead) {
      m.state = 9;
      broadcastMap(p.map, p.region, buildMonInfo(m, 9, p.charId, dmg, hitX, hitY));
      const killExp = monsterExp(m);
      // Official Bonus Share: each same-map member gets full EXP (not divided).
      const recipients = partyShareRecipients(p);
      let anyPartyLevel = false;
      for (const pl of recipients) {
        if (await grantMonsterExp(pl, killExp)) anyPartyLevel = true;
      }
      if (anyPartyLevel) {
        const party = getParty(p.charId);
        if (party && party.length >= 2) sendPartyUpdateTo(party);
      }
      for (const d of buildDropPackets(drops)) broadcastMap(p.map, p.region, d);
      // Official: party shares quest/QQ kill counts on the same map
      // (namuwiki 무리 / SSO tips — main reason PT levels faster).
      for (const pl of recipients) {
        for (const q of await onMonsterKill(pl.charId, m.template)) send(pl, q);
      }
    } else {
      // legacy: status 7 then immediate status 1 at same coords (keeps walk clip alive).
      // Do NOT hold state=7 for hundreds of ms — that freezes then snap-resumes (blink).
      m.state = 7;
      broadcastMap(p.map, p.region, buildMonInfo(m, 7, p.charId, dmg, hitX, hitY));
      setMonsterAggro(m, p.charId);
      m.nextAttackAt = Date.now() + 500;
      m.state = 1;
      m.walkArmed = true;
      m.attackUntil = 0;
      if (isFlyer(m)) {
        const lead = Math.max(48, Math.round(40 * (m.speed || 1) * 1.5));
        const destX = m.x + (m.side < 0 ? -1 : 1) * lead;
        broadcastMap(p.map, p.region, buildMonInfo(m, 2, 0, 0, 0, 0, destX, m.y));
        m.flyDestX = destX;
        m.flyDestY = m.y;
      } else {
        broadcastMap(p.map, p.region, buildMonInfo(m, 1, 0, 0, 0, 0));
      }
      m.lastSyncX = m.x;
      m.lastSyncY = m.y;
      m.lastSyncSide = m.side;
      m.lastSyncAt = Date.now();
    }
    return;
  }

  if (op === 0x0046) {
    // Client flinch report after monster State 3. Skip if we already applied
    // server-side aggro/touch damage (avoids double-hit).
    if (Date.now() - p.lastTouchAt < 800) return;
    let dmg = pkt.readUInt16LE(12);
    if (!Number.isFinite(dmg) || dmg <= 0 || dmg >= 0xff00 || dmg > 500) dmg = 15;
    await hurtPlayer(p, dmg, "client-0x46");
    return;
  }
  if (op === 0x0047) {
    console.log(`[field] CHAR_DEAD_REQ char=${p.charId} alive=${p.alive}`);
    return;
  }

  if (op === 0x004c) {
    const oid = pkt.readUInt32LE(12);
    const d = getDrop(oid);
    if (!d) return;
    if (d.map !== p.map || d.region !== p.region) return;
    if (Date.now() >= d.expireAt) {
      clearDrop(oid);
      broadcastMap(p.map, p.region, buildDropClear(0, d));
      return;
    }
    // money / soul don't need invent space
    if (d.itemId >= 9800001 && d.itemId <= 9800005) {
      clearDrop(oid);
      broadcastMap(p.map, p.region, buildDropClear(p.charId, d));
      p.money += d.qty;
      await execute(UPDATE_CHARACTERS_BY_ID_9, [p.money, p.charId]);
      send(p, moneyPacket(p.money, d.qty));
      return;
    }
    // Bahamut 鬼魂系統:
    // 9900001 blue → +20% 鬼力(SP/MP), 9900002 green → +40% SP,
    // 9900003 red → fury/DP (characters.soul), 9900004 purple → worn Seal soulperc.
    if (isSoulOrb(d.itemId)) {
      if (d.itemId === 9900004) {
        // Purple → fill worn Seal (type group 85). Leave on ground if none worn.
        const seals = await query<RowDataPacket[]>(
          SELECT_EQUIP_BY_CHARID_10,
          [p.charId],
        );
        if (!seals.length) return;
        const add = Math.max(1, d.qty);
        for (const s of seals) {
          const cur = Number(s.soulperc ?? 0);
          const next = Math.min(100, Math.max(0, cur + add));
          await execute(
            UPDATE_EQUIP_BY_CHARID_6,
            [next, p.charId, Number(s.pos2)],
          );
        }
        clearDrop(oid);
        broadcastMap(p.map, p.region, buildDropClear(p.charId, d));
        send(p, await buildEquip(p.charId));
        return;
      }

      clearDrop(oid);
      broadcastMap(p.map, p.region, buildDropClear(p.charId, d));
      if (d.itemId === 9900001 || d.itemId === 9900002) {
        const pct = d.itemId === 9900001 ? 0.2 : 0.4;
        const gain = Math.max(1, Math.floor(p.maxMp * pct));
        p.mp = Math.min(p.maxMp, p.mp + gain);
        await execute(UPDATE_CHARACTERS_BY_ID_22, [p.mp, p.charId]);
      } else {
        // 9900003 red → fury / DP
        if (p.maxSoul < 1) p.maxSoul = 100;
        p.soul = Math.min(p.maxSoul, p.soul + Math.max(1, d.qty));
        await execute(UPDATE_CHARACTERS_BY_ID_23, [p.soul, p.charId]);
      }
      sendVital(p);
      return;
    }
    const bag = isPetItem(d.itemId)
      ? await addPetToBag(p.charId, d.itemId, "Pet", 0, packetMagicOrDefault(p.magic))
      : await addItemToInventory(p.charId, d.itemId, d.qty, 0, -1, packetMagicOrDefault(p.magic));
    if (bag < 0) return; // full — leave drop on ground
    clearDrop(oid);
    broadcastMap(p.map, p.region, buildDropClear(p.charId, d));
    for (const out of await refreshBagPackets(p.charId, bag, packetMagicOrDefault(p.magic))) send(p, out);
    return;
  }

  if (op === 0x0085) {
    // WarpToMapAuth_Req → leave peers on old map, then CHANGEMAP (0x86) to self only.
    // Client finishes load via 0x1D (ENTERPLAYER + monsters) — do not LEAVE self.
    let map = pkt.readUInt16LE(12);
    let region = pkt.readUInt16LE(14);
    let x = pkt.readUInt16LE(16);
    let y = pkt.readUInt16LE(18);
    if (!p.alive) {
      map = deadTownMap(p.map);
      region = 1;
      const spawn = deadTownSpawn(map);
      x = spawn.x;
      y = spawn.y;
      p.alive = true;
      if (p.hp < 1) p.hp = 1;
      if (p.mp < 1) p.mp = 1;
      if (p.maxSoul < 1) p.maxSoul = 100;
      await execute(UPDATE_CHARACTERS_BY_ID_14, [p.hp, p.mp, p.charId]);
      sendVital(p);
      console.log(`[field] PLAYER_RESPAWN char=${p.charId} -> ${map}/1 @${x},${y}`);
    } else {
      const pos = sanitizePlayerPos(map, region, x, y);
      if (pos.fixed) {
        console.log(`[field] warp void @0,0 -> ${map}/${region} @${pos.x},${pos.y}`);
      }
      x = pos.x;
      y = pos.y;
    }
    broadcastMap(p.map, p.region, leavePacket(p.charId), p.charId);
    const leftMap = p.map;
    const leftRegion = p.region;
    const shopEnd = endPShopIfActive(p.charId);
    if (shopEnd) broadcastMap(leftMap, leftRegion, shopEnd);
    clearMonCombat(p);
    if (p.fishing) {
      p.fishing = false;
      if (p.fishTimer) clearTimeout(p.fishTimer);
      broadcastMap(leftMap, leftRegion, fishAck(p.charId, 0, 0));
    }
    p.map = map;
    p.region = region;
    p.x = x;
    p.y = y;
    p.fieldEntered = false;
    maybeHibernateMap(leftMap, leftRegion, p.charId);
    p.touchGraceUntil = Date.now() + rates.touchGraceRespawnMs;
    p.lastTouchAt = Date.now();
    await execute(UPDATE_CHARACTERS_BY_ID, [map, region, x, y, p.charId]);
    send(p, writeChangeMapPacket(p, map, region, x, y));
    p.pendingWarp = true;
    console.log(`[field] warp char=${p.charId} -> ${map}/${region} @${x},${y}`);
    return;
  }

  // cash shop
  if (op === 0x00e4) {
    await sendCashMall(p);
    return;
  }
  if (op === 0x00e5) {
    for (const b of await buildBalance(p.accountId)) send(p, b);
    send(p, await buildWarehouse(p.charId));
    return;
  }
  if (op === 0x00e7) {
    const itemId = pkt.readUInt32LE(12);
    const ok = await cashBuy(p.accountId, p.charId, itemId);
    const ack = Buffer.alloc(16, 0);
    writeHeader(ack, 0x00e8, 16);
    ack.writeUInt32LE(ok ? 1 : 0, 12);
    send(p, ack);
    for (const b of await buildBalance(p.accountId)) send(p, b);
    send(p, await buildWarehouse(p.charId));
    return;
  }
  if (op === 0x00e9) {
    // gift: itemId@12, itemName@16, target@78
    const itemId = pkt.readUInt32LE(12);
    const target = readCString(pkt, 78, 20);
    try {
      await execute(
        INSERT_GIFTS,
        [target, itemId, String(itemId), p.name],
      );
    } catch {
      /* */
    }
    const ack = Buffer.alloc(16, 0);
    writeHeader(ack, 0x00ea, 16);
    ack.writeUInt32LE(1, 12);
    send(p, ack);
    return;
  }
  if (op === 0x00ef) {
    // cash warehouse -> invent: slot at +12
    const slot = pkt.readUInt32LE(12);
    if (slot > 19) return;
    const rows = await query<RowDataPacket[]>(SELECT_CASH_INVEN_BY_CHARID_AND_SLOT, [p.charId, slot]);
    if (!rows.length) return;
    const r = rows[0];
    const itemId = Number(r.itemid);
    const amount = Number(r.amount ?? 1);
    const locked = Number(r.islocked ?? 1);
    const term = Number(r.term ?? -1);
    const group = Math.floor(itemId / 100000);
    let bag = -1;
    if (group === 90) {
      // hair → worn 7
      await execute(DELETE_EQUIP_BY_CHARID_4, [p.charId]);
      const m = await query<RowDataPacket[]>(SELECT_EQUIP);
      await execute(
        INSERT_EQUIP_3,
        [Number(m[0]?.m ?? 0) + 1, itemId, p.charId, locked, term],
      );
      bag = 0;
    } else if (group === 91) {
      await execute(DELETE_EQUIP_BY_CHARID_5, [p.charId]);
      const m = await query<RowDataPacket[]>(SELECT_EQUIP);
      await execute(
        INSERT_EQUIP_4,
        [Number(m[0]?.m ?? 0) + 1, itemId, p.charId, locked, term],
      );
      bag = 0;
    } else if (isPetItem(itemId)) {
      bag = await addPetToBag(p.charId, itemId, "Pet", locked, packetMagicOrDefault(p.magic));
    } else {
      bag = await addItemToInventory(p.charId, itemId, amount, locked, term, packetMagicOrDefault(p.magic));
    }
    if (bag < 0) return;
    await execute(DELETE_CASH_INVEN_BY_ID, [r.id]);
    const ack = Buffer.alloc(16, 0);
    writeHeader(ack, 0x00f0, 16);
    ack.writeUInt32LE(1, 12);
    send(p, ack);
    send(p, await buildWarehouse(p.charId));
    for (const out of await refreshBagPackets(p.charId, bag, packetMagicOrDefault(p.magic))) send(p, out);
    if (bag === 0) {
      const av = await buildSetAvatar(p.charId);
      send(p, av);
      broadcastMap(p.map, p.region, av, p.charId);
    }
    return;
  }
  if (op === 0x00fc) {
    const name = readCString(pkt, 12, 20);
    const rows = await query<RowDataPacket[]>(SELECT_CHARACTERS_BY_NAME_2, [name]);
    const ack = Buffer.alloc(16, 0);
    writeHeader(ack, 0x00fd, 16);
    ack.writeUInt32LE(rows.length ? 1 : 0, 12);
    send(p, ack);
    return;
  }
  if (op === 0x0140) {
    // DISMANTLE / unseal: type@+12, slot@+16 — clears IsLocked (iscash/islocked)
    const type = pkt.readUInt32LE(12);
    const slot = pkt.readUInt32LE(16);
    console.log(`[cashshop] 0x140 unseal char=${p.charId} type=${type} slot=${slot}`);
    const res = await dismantle(p.charId, type, slot, packetMagicOrDefault(p.magic));
    for (const out of res.packets) send(p, out);
    if (res.warehouse) send(p, await buildWarehouse(p.charId));
    return;
  }

  // Free market personal shop / auction
  if (isPShopOpcode(op)) {
    if (op === 0x00d5 || op === 0x01a4) {
      const res = await handlePShopBuy({ charId: p.charId, money: p.money }, pkt, op >= 0x19c ? 1 : 0);
      if (res.buyerMoney !== undefined) {
        const delta = res.buyerMoney - p.money;
        p.money = res.buyerMoney;
        await execute(UPDATE_CHARACTERS_BY_ID_9, [p.money, p.charId]);
        send(p, moneyPacket(p.money, delta));
      }
      if (res.sellerId !== undefined) {
        const seller = players.get(res.sellerId);
        if (res.sellerGain !== undefined && res.sellerGain > 0) {
          if (seller) {
            seller.money += res.sellerGain;
            await execute(UPDATE_CHARACTERS_BY_ID_9, [seller.money, seller.charId]);
            send(seller, moneyPacket(seller.money, res.sellerGain));
          } else {
            await execute(UPDATE_CHARACTERS_BY_ID_10, [res.sellerGain, res.sellerId]);
          }
        }
        if (seller && res.toSeller) {
          for (const out of res.toSeller) send(seller, out);
        }
      }
      for (const out of res.packets) send(p, out);
      if (res.toMap) {
        for (const out of res.toMap) broadcastMap(p.map, p.region, out);
      }
    } else {
      // START/END must go to the whole map (shop name/visual over the seller).
      const res = await dispatchPShop(p.charId, op, pkt, p.map, p.region);
      for (const out of res.toSelf) send(p, out);
      if (res.toMap) {
        for (const out of res.toMap) broadcastMap(p.map, p.region, out);
      }
    }
    return;
  }

  // fishing
  if (op === 0x00e0) {
    if (p.fishing) {
      p.fishing = false;
      if (p.fishTimer) clearTimeout(p.fishTimer);
      broadcastMap(p.map, p.region, fishAck(p.charId, 0, 0));
    } else {
      startFishing(p);
    }
    return;
  }

  // NPC buy (0x22) — client opens shop UI locally; server only settles purchase
  if (op === 0x0022) {
    const itemId = pkt.readUInt32LE(16);
    let qty = Math.max(1, pkt.readUInt32LE(20) || 1);
    if (qty > 100) qty = 100;
    let give = qty;
    if (itemId >= 8880011 && itemId <= 8880101) give = qty * 100;
    const unit = buyPrice(itemId, getPrices());
    const cost = unit * qty;
    if (p.money < cost) return;
    const bag = await addItemToInventory(p.charId, itemId, give, 0, -1, packetMagicOrDefault(p.magic));
    if (bag < 0) return;
    p.money -= cost;
    await execute(UPDATE_CHARACTERS_BY_ID_9, [p.money, p.charId]);
    send(p, moneyPacket(p.money, -cost));
    for (const pkt of await refreshBagPackets(p.charId, bag, packetMagicOrDefault(p.magic))) send(p, pkt);
    return;
  }
  // NPC sell (0x23)
  if (op === 0x0023) {
    const itemId = pkt.readUInt32LE(12);
    const type = pkt.readUInt8(16);
    const slot = pkt.readUInt8(17);
    let qty = pkt.readUInt16LE(18);
    if (qty < 1 || qty > 100) return;
    if (type < 3) qty = 1;
    const removed = await removeInvQty(p.charId, type, slot, qty);
    if (!removed || removed !== itemId) return;
    const gain = sellPrice(itemId, getPrices()) * qty;
    p.money += gain;
    await execute(UPDATE_CHARACTERS_BY_ID_9, [p.money, p.charId]);
    send(p, moneyPacket(p.money, gain));
    for (const pkt of await refreshBagPackets(p.charId, type, packetMagicOrDefault(p.magic))) send(p, pkt);
    return;
  }

  // inventory move / unequip / drop
  if (op === 0x006c) {
    const srcBag = pkt.length > 12 ? pkt.readUInt8(12) : -1;
    const srcSlot = pkt.length > 13 ? pkt.readUInt8(13) : -1;
    const dstBag = pkt.length > 14 ? pkt.readUInt8(14) : -1;
    const dstSlot = pkt.length > 15 ? pkt.readUInt8(15) : -1;
    console.log(
      `[field] CHANGEITEM char=${p.charId} ${srcBag}:${srcSlot} -> ${dstBag}:${dstSlot}`,
    );
    const res = await changeItem(p.charId, pkt, packetMagicOrDefault(p.magic));
    // Pet moves: bag rearrange = PET5 only; equip/unequip = PET5 + EQUIP + SETAVATAR + PET_LIFE
    if (res.petRefresh && res.packets.length) {
      for (const out of res.packets) send(p, out);
      if (res.broadcastAvatar) broadcastMap(p.map, p.region, res.broadcastAvatar, p.charId);
      if (res.petWorld) {
        for (const w of res.petWorld) {
          send(p, w);
          broadcastMap(p.map, p.region, w, p.charId);
        }
      }
    } else {
      for (const out of res.packets) send(p, out);
    }
    if (res.broadcastAvatar) broadcastMap(p.map, p.region, res.broadcastAvatar, p.charId);
    if (typeof res.petUseSlot === "number") {
      p.petUseSlot = res.petUseSlot;
      setPetUseSlot(p.charId, res.petUseSlot);
    }
    if (res.drop) {
      const dy = Math.max(0, p.y - 50);
      console.log(`[field] drop char=${p.charId} item=${res.drop.itemId} @${p.x},${dy}`);
      const d = spawnDrop({
        itemId: res.drop.itemId,
        qty: res.drop.qty,
        x: p.x,
        y: dy,
        map: p.map,
        region: p.region,
      });
      broadcastMap(p.map, p.region, buildDropSpawn(d));
    }
    return;
  }

  // quests
  if (op >= 0x007a && op <= 0x007f) {
    const qres = await handleQuestPacket(p.charId, p.level, op, pkt);
    for (const b of qres.packets) send(p, b);
    if (qres.refreshChar) {
      const row = await loadCharRow(p.charId);
      if (row) {
        p.level = Number(row.level ?? p.level);
        p.exp = Number(row.exp ?? p.exp);
        p.mexp = Number(row.mexp ?? p.mexp);
        p.money = Number(row.money ?? p.money);
        p.job = Number(row.job ?? p.job);
        p.hp = Number(row.chp ?? p.hp);
        p.mp = Number(row.cmp ?? p.mp);
        p.maxHp = Number(row.cmhp ?? p.maxHp);
        p.maxMp = Number(row.cmmp ?? p.maxMp);
      }
      send(p, await charAll(p.charId));
      send(p, await buildSkillAll(p.charId));
      send(p, await buildSetAvatar(p.charId));
    }
    return;
  }

  // select spend slot — ack 0x6E; refresh SPEND3 so UseSlot is visible to client
  if (op === 0x006d) {
    let slot = pkt.length >= 16 ? pkt.readUInt32LE(12) : 0xff;
    if (slot < 0 || slot > 63) slot = 0xff;
    p.spendUseSlot = slot;
    setSpendUseSlot(p.charId, slot);
    const ack = Buffer.alloc(16, 0);
    writeHeader(ack, 0x006e, 16);
    ack.writeUInt32LE(slot, 12);
    send(p, ack);
    send(p, await buildSpend3(p.charId, packetMagicOrDefault(p.magic)));
    return;
  }

  // USE_SPEND (0x6F) — consume spend; apply HP/SP recover; VFX for fireworks/etc
  if (op === 0x006f) {
    const b0 = pkt.length >= 13 ? pkt.readUInt8(12) : 0;
    const b1 = pkt.length >= 14 ? pkt.readUInt8(13) : 0;
    let slot = b0;
    if (b0 <= 5 && b1 <= 23) slot = b1;
    if (slot < 0 || slot > 63) return;
    const rows = await query<RowDataPacket[]>(
      SELECT_SPEND_BY_CHARID,
      [p.charId, slot],
    );
    if (!rows.length) return;
    const itemId = Number(rows[0]!.itemid);
    if (itemId < 1) return;
    if (isEffectSpendItem(itemId)) {
      broadcastMap(p.map, p.region, useSpendStartPkt(p.charId, p.x, p.y, itemId, 3, slot));
    }
    const removed = await removeInvQty(p.charId, 3, slot, 1);
    if (!removed) return;
    await tryHandleSpecialSpend(p, itemId);
    await tryApplySpendRecover(p, itemId);
    for (const out of await refreshBagPackets(p.charId, 3, packetMagicOrDefault(p.magic))) send(p, out);
    return;
  }

  // INVEN_USESPEND (0x70) — x,y,slot; always broadcast 0x71; apply recover if potion
  if (op === 0x0070) {
    const posX = pkt.length >= 14 ? pkt.readUInt16LE(12) : p.x;
    const posY = pkt.length >= 16 ? pkt.readUInt16LE(14) : p.y;
    let slot = pkt.length >= 17 ? pkt.readUInt8(16) : 0;
    if (slot > 63 && pkt.length >= 20) slot = pkt.readUInt32LE(16) & 0xff;
    if (slot > 63) return;
    const rows = await query<RowDataPacket[]>(
      SELECT_SPEND_BY_CHARID,
      [p.charId, slot],
    );
    if (!rows.length) return;
    const itemId = Number(rows[0]!.itemid);
    if (itemId < 1) return;
    broadcastMap(p.map, p.region, useSpendStartPkt(p.charId, posX, posY, itemId, 3, slot));
    const removed = await removeInvQty(p.charId, 3, slot, 1);
    if (!removed) return;
    await tryHandleSpecialSpend(p, itemId);
    await tryApplySpendRecover(p, itemId);
    for (const out of await refreshBagPackets(p.charId, 3, packetMagicOrDefault(p.magic))) send(p, out);
    return;
  }

  // INVEN_USESPEND_SHOUT_REQ (0xFA) / Server Scroll ALL (0x15B) — broadcast shout to all players
  if (op === 0x00fa || op === 0x015b) {
    await handleUseSpendShout(p, pkt, op);
    return;
  }

  // hotkeys
  if (op === 0x00a8) {
    try {
      await saveQuickSlot(p.charId, pkt);
      send(p, await buildQuickSlotAll(p.charId));
    } catch (e) {
      console.error("[field] quickslot save failed", e);
    }
    return;
  }

  // skill point up 0x74 — C#: byte Type, byte Slot (not skillId)
  if (op === 0x0074) {
    const type = pkt.length >= 13 ? pkt.readUInt8(12) : 0xff;
    const slot = pkt.length >= 14 ? pkt.readUInt8(13) : 0xff;
    const res = await skillPointUp(p.charId, type, slot);
    if (res.ok) {
      send(p, buildSkillLevelUpAck(res.skPoint, type, slot, res.level));
      send(p, await buildSkillAll(p.charId));
      send(p, await charAll(p.charId));
      console.log(
        `[field] skill-up char=${p.charId} type=${type} slot=${slot} skill=${res.skillId} lv=${res.level} sk=${res.skPoint}`,
      );
    } else {
      console.log(`[field] skill-up FAIL char=${p.charId} type=${type} slot=${slot}: ${res.reason}`);
    }
    return;
  }

  // USE_SKILL_REQ 0x76 — Meditate / buffs / HP↔MP (C# SkillHandler.UseSkill_Req)
  if (op === 0x0076) {
    await handleUseSkill(p, pkt);
    return;
  }

  // stat up 0x5F — bump base stat + derived combat values (C# Char_Statup_Req)
  if (op === 0x005f) {
    const which = pkt.readUInt8(12);
    const row = await loadCharRow(p.charId);
    if (!row) return;
    const pts = Number(row.st_point ?? 0);
    if (pts < 1) return;

    let str = Number(row.str ?? 3);
    let dex = Number(row.dex ?? 3);
    let vit = Number(row.vit ?? 3);
    let intel = Number(row.intel ?? 3);
    let cmhp = Number(row.cmhp ?? 50);
    let cmmp = Number(row.cmmp ?? 50);
    let maxdamphy = Number(row.maxdamphy ?? 10);
    let mindamphy = Number(row.mindamphy ?? 10);
    let maxdamw = Number(row.maxdamw ?? 0);
    let mindamw = Number(row.mindamw ?? 0);
    let def = Number(row.def ?? 0);

    if (which === 1) {
      // STR: +3 MaxHp; MaxAttack +2 (+3 every 5th)
      str += 1;
      cmhp += 3;
      maxdamphy += str % 5 !== 0 ? 2 : 3;
    } else if (which === 2) {
      // DEX: Attack/MaxAttack bump
      dex += 1;
      if (dex % 5 !== 0) {
        mindamphy += 1;
        maxdamphy += 2;
      } else {
        mindamphy += 2;
        maxdamphy += 3;
      }
    } else if (which === 3) {
      // VIT: +5 Def, +20 MaxHp
      vit += 1;
      def += 5;
      cmhp += 20;
    } else if (which === 4) {
      // INT: +3 MaxMp; Magic bumps
      intel += 1;
      cmmp += 3;
      if (intel % 5 !== 0) {
        mindamw += 2;
        maxdamw += 2;
      } else {
        mindamw += 3;
        maxdamw += 3;
      }
    } else {
      return;
    }

    if (mindamphy > maxdamphy) mindamphy = maxdamphy;
    if (mindamw > maxdamw) mindamw = maxdamw;

    const chp = Math.min(Math.max(Number(row.chp ?? cmhp), 1), cmhp);
    const cmp = Math.min(Math.max(Number(row.cmp ?? cmmp), 0), cmmp);

    await execute(
      UPDATE_CHARACTERS_BY_ID_24,
      [str, dex, vit, intel, cmhp, cmmp, chp, cmp, maxdamphy, mindamphy, maxdamw, mindamw, def, p.charId],
    );

    p.maxHp = cmhp;
    p.maxMp = cmmp;
    p.hp = Math.min(p.hp, cmhp);
    p.mp = Math.min(p.mp, cmmp);
    p.minAtk = mindamphy;
    p.maxAtk = maxdamphy;
    p.minMag = mindamw;
    p.maxMag = maxdamw;
    p.def = def;

    send(p, await buildStatUpAck(p.charId));
    sendVital(p);
    console.log(
      `[field] stat-up char=${p.charId} which=${which} str=${str} dex=${dex} vit=${vit} int=${intel} hp=${cmhp} atk=${mindamphy}-${maxdamphy} def=${def}`,
    );
    return;
  }

  if (isPartyOpcode(op)) {
    await handlePartyPacket(p, op, pkt);
    return;
  }

  if (isTradeOpcode(op)) {
    await handleTradePacket(p, op, pkt);
    return;
  }
}
