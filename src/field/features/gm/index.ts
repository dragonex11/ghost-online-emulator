import { rates } from "../../../config.js";
import { execute } from "../../../db/index.js";
import { readCString } from "../../../net/packet.js";
import { PACKET_MAGIC } from "../../../protocol/magic.js";
import {
  ensureBeginnerSkills,
  syncJobSkills,
  buildSkillAll,
  clearAdvancedSkills,
  maxAllSkills,
  JOB_UNSET,
  job2ClassId,
  job2ClassName,
  job2PathFromId,
} from "../skills/index.js";
import { addItemToInventory, refreshBagPackets, buildSetAvatar } from "../inventory/index.js";
import { endPShopIfActive } from "../pshop/index.js";
import { mapExists, sanitizePlayerPos } from "../../maps.js";
import { type Player, players, send, broadcastMap, broadcastAll } from "../../player.js";
import { charAll, enterPlayer } from "../../packets/char.js";
import {
  UPDATE_CHARACTERS_BY_ID,
  UPDATE_CHARACTERS_BY_ID_2,
  UPDATE_CHARACTERS_BY_ID_3,
  UPDATE_CHARACTERS_BY_ID_4,
  UPDATE_CHARACTERS_BY_ID_5,
  UPDATE_CHARACTERS_BY_ID_6,
  UPDATE_CHARACTERS_BY_ID_7,
  UPDATE_CHARACTERS_BY_ID_8,
} from "../../../db/queries/index.js";
import {
  leavePacket,
  notice,
  moneyPacket,
  writeChangeMapPacket,
  sendVital,
  levelUpPacket,
  lvExpPacket,
} from "../../packets/ui.js";

export async function handleGm(p: Player, pkt: Buffer): Promise<void> {
  const cmd = readCString(pkt, 12, 60).trim();
  await runGmCommand(p, cmd);
}

/** Shared GM/chat-command runner. En-client often sends // via CHAT 0x17, not COMMAND 0x10. */
export async function runGmCommand(p: Player, cmdRaw: string): Promise<void> {
  const cmd = cmdRaw.trim();
  // Require //word — bare "//" or "// hi" are not commands (legacy is silent on unknowns).
  if (!/^\/\/[a-zA-Z]/.test(cmd)) return;
  if (p.gm <= 0) {
    console.log(`[field] GM denied char=${p.charId} gm=${p.gm} cmd=${JSON.stringify(cmd)}`);
    return;
  }
  console.log(`[field] GM char=${p.charId} gm=${p.gm} cmd=${JSON.stringify(cmd)}`);
  const parts = cmd.split(/\s+/);
  const c0 = parts[0]!.toLowerCase();

  const doWarp = async (map: number, region: number, x: number, y: number) => {
    if (!mapExists(map, region)) {
      console.log(`[field] GM warp rejected missing map ${map}/${region} char=${p.charId}`);
      return;
    }
    const pos = sanitizePlayerPos(map, region, x, y);
    const leftMap = p.map;
    const leftRegion = p.region;
    broadcastMap(leftMap, leftRegion, leavePacket(p.charId), p.charId);
    const shopEnd = endPShopIfActive(p.charId);
    if (shopEnd) broadcastMap(leftMap, leftRegion, shopEnd);
    p.map = map;
    p.region = region;
    p.x = pos.x;
    p.y = pos.y;
    await execute(UPDATE_CHARACTERS_BY_ID, [
      map,
      region,
      pos.x,
      pos.y,
      p.charId,
    ]);
    send(p, writeChangeMapPacket(p, map, region, pos.x, pos.y));
    p.pendingWarp = true;
  };

  /** Refresh char sheet + avatar after job/level changes (legacy _GmSetJob parity). */
  const refreshCharView = async () => {
    send(p, await charAll(p.charId));
    send(p, await buildSkillAll(p.charId));
    // Re-push ENTERPLAYER so Class/Title strings rebind from job/job2/job3.
    send(
      p,
      await enterPlayer(p.charId, {
        x: p.x,
        y: p.y,
        map: p.map,
        region: p.region,
        petUseSlot: p.petUseSlot,
      }),
    );
    const av = await buildSetAvatar(p.charId);
    send(p, av);
    broadcastMap(p.map, p.region, av, p.charId);
  };

  if (c0 === "//notice" || c0 === "//1") {
    broadcastAll(notice(parts.slice(1).join(" ") || "Hello", 3));
  } else if (c0 === "//heal") {
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    sendVital(p);
  } else if (c0 === "//hp") {
    if (parts[1] !== undefined && parts[1] !== "") {
      let v = Number(parts[1]);
      if (!Number.isFinite(v) || v < 1) v = 1;
      if (v > 32767) v = 32767;
      p.hp = v;
      p.maxHp = v;
      await execute(UPDATE_CHARACTERS_BY_ID_2, [v, v, p.charId]);
      sendVital(p);
      send(p, await charAll(p.charId));
    } else {
      p.hp = p.maxHp;
      sendVital(p);
    }
  } else if (c0 === "//mp") {
    if (parts[1] !== undefined && parts[1] !== "") {
      let v = Number(parts[1]);
      if (!Number.isFinite(v) || v < 1) v = 1;
      if (v > 32767) v = 32767;
      p.mp = v;
      p.maxMp = v;
      await execute(UPDATE_CHARACTERS_BY_ID_3, [v, v, p.charId]);
      sendVital(p);
      send(p, await charAll(p.charId));
    } else {
      p.mp = p.maxMp;
      sendVital(p);
    }
  } else if (c0 === "//money") {
    const amt = Number(parts[1] ?? 10000);
    p.money += amt;
    await execute(UPDATE_CHARACTERS_BY_ID_4, [p.money, p.charId]);
    send(p, moneyPacket(p.money, amt));
  } else if (c0 === "//level") {
    let target = Number(parts[1] ?? NaN);
    if (!Number.isFinite(target)) return;
    target = Math.floor(target);
    if (target < 1) target = 1;
    if (target > 99) target = 99;
    const old = p.level;
    let mexp = 30;
    for (let lv = 1; lv < target; lv++) mexp = Math.floor(mexp * rates.levelExpCurve);
    if (mexp < 1) mexp = 30;
    const gained = Math.max(0, target - old);
    p.level = target;
    p.mexp = mexp;
    p.exp = 0;
    await execute(
      UPDATE_CHARACTERS_BY_ID_5,
      [target, mexp, gained * 5, gained * 2, p.charId],
    );
    send(p, levelUpPacket(p.charId));
    send(p, lvExpPacket(p.level, p.exp));
    send(p, await charAll(p.charId));
    send(p, await buildSkillAll(p.charId));
    broadcastMap(p.map, p.region, levelUpPacket(p.charId), p.charId);
  } else if (c0 === "//levelup") {
    p.level++;
    p.mexp = Math.floor(p.mexp * rates.levelExpCurve);
    await execute(
      UPDATE_CHARACTERS_BY_ID_6,
      [p.level, p.mexp, p.charId],
    );
    send(p, levelUpPacket(p.charId));
    send(p, lvExpPacket(p.level, p.exp));
    send(p, await charAll(p.charId));
    send(p, await buildSkillAll(p.charId));
    broadcastMap(p.map, p.region, levelUpPacket(p.charId), p.charId);
  } else if (c0 === "//warp" || c0 === "//gogo") {
    const arg1 = parts[1];
    if (arg1 !== undefined && arg1 !== "" && !/^-?\d+$/.test(arg1)) {
      const targetName = arg1;
      let target: Player | undefined;
      for (const o of players.values()) {
        if (o.loggedIn && o.name.toLowerCase() === targetName.toLowerCase()) {
          target = o;
          break;
        }
      }
      if (!target) {
        console.log(`[field] GM warp target offline: ${targetName}`);
        return;
      }
      await doWarp(target.map, target.region, target.x, target.y);
    } else if (c0 === "//gogo" && parts.length >= 3 && parts.length < 5) {
      // legacy //gogo map region — keep current X/Y
      const map = Number(parts[1] ?? p.map);
      const region = Number(parts[2] ?? p.region);
      await doWarp(map, region, p.x, p.y);
    } else {
      const map = Number(parts[1] ?? 1);
      const region = Number(parts[2] ?? 1);
      const x = Number(parts[3] ?? 100);
      const y = Number(parts[4] ?? 100);
      await doWarp(map, region, x, y);
    }
  } else if (c0 === "//job") {
    // //job 0|1|2|3 — set 1st job; clears job2/faction + all advanced skills (empty job skill tab)
    let job = Number(parts[1] ?? 0);
    if (!Number.isFinite(job)) return;
    job = Math.floor(job);
    if (job < 0) job = 0;
    if (job > 3) job = 3;
    p.job = job;
    p.job2 = JOB_UNSET;
    p.job3 = JOB_UNSET;
    await execute(UPDATE_CHARACTERS_BY_ID_7, [
      p.job,
      p.job2,
      p.job3,
      p.charId,
    ]);
    await clearAdvancedSkills(p.charId);
    await ensureBeginnerSkills(p.charId);
    await refreshCharView();
    console.log(`[field] GM //job char=${p.charId} -> job=${p.job} (cleared job2/faction/skills)`);
  } else if (c0 === "//job2") {
    // //job2 1|2 — Order|Chaos for CURRENT 1st job → correct title id
    //   Warrior: Knight / Dark Knight
    //   Assassin: Ninja / Killer
    //   Mage: White Mage / Black Mage
    // //job2 0 — clear 2nd job + faction
    if (p.job < 1 || p.job > 3) {
      console.log(`[field] GM //job2 denied char=${p.charId}: need 1st job first (job=${p.job})`);
      return;
    }
    let path = Number(parts[1] ?? 0);
    if (!Number.isFinite(path)) return;
    path = Math.floor(path);
    if (path <= 0) {
      p.job2 = JOB_UNSET;
      p.job3 = JOB_UNSET;
      await execute(UPDATE_CHARACTERS_BY_ID_8, [p.job2, p.job3, p.charId]);
      // Drop job2/faction skills; keep 1st-job book (legacy _GmSetJob + _SkillsEnsureForChar)
      await syncJobSkills(p.charId, p.job, p.job2, p.job3);
      await refreshCharView();
      console.log(`[field] GM //job2 char=${p.charId} cleared`);
      return;
    }
    if (path > 2) path = 2;
    const classId = job2ClassId(p.job, path);
    if (classId < 1) {
      console.log(`[field] GM //job2 failed char=${p.charId} job=${p.job} path=${path}`);
      return;
    }
    p.job2 = classId;
    // Keep faction aligned with Order/Chaos path (skills + consistency)
    p.job3 = path;
    await execute(UPDATE_CHARACTERS_BY_ID_8, [p.job2, p.job3, p.charId]);
    // Grant 1st + 2nd + faction skills for this path (legacy _SkillsEnsureForChar)
    await syncJobSkills(p.charId, p.job, p.job2, p.job3);
    await refreshCharView();
    console.log(
      `[field] GM //job2 char=${p.charId} job=${p.job} path=${path} -> ${job2ClassName(classId)} (id=${classId})`,
    );
  } else if (c0 === "//faction") {
    // //faction 1|2 — Order|Chaos; also sets matching 2nd-job title for current 1st job
    // //faction 0 clears faction + 2nd job title
    // Args are numeric only (1=Order / Forces of Order, 2=Chaos) — not the display name.
    if (p.job < 1 || p.job > 3) {
      console.log(`[field] GM //faction denied char=${p.charId}: need 1st job first`);
      return;
    }
    let path = Number(parts[1] ?? 0);
    if (!Number.isFinite(path)) return;
    path = Math.floor(path);
    if (path <= 0) {
      p.job2 = JOB_UNSET;
      p.job3 = JOB_UNSET;
      await execute(UPDATE_CHARACTERS_BY_ID_8, [p.job2, p.job3, p.charId]);
      await syncJobSkills(p.charId, p.job, p.job2, p.job3);
      await refreshCharView();
      return;
    }
    if (path > 2) path = 2;
    p.job3 = path;
    p.job2 = job2ClassId(p.job, path);
    await execute(UPDATE_CHARACTERS_BY_ID_8, [p.job2, p.job3, p.charId]);
    // legacy //faction → _GmSetJob → _SkillsEnsureForChar (grants Guild/faction book)
    await syncJobSkills(p.charId, p.job, p.job2, p.job3);
    await refreshCharView();
    console.log(
      `[field] GM //faction char=${p.charId} job=${p.job} -> ${job2ClassName(p.job2)} faction=${path}`,
    );
  } else if (c0 === "//skills") {
    // Unlock all skills for current progression (1st + job2 path + Guild/faction)
    await syncJobSkills(p.charId, p.job, p.job2, p.job3);
    await refreshCharView();
    console.log(
      `[field] GM //skills char=${p.charId} job=${p.job}/${p.job2}(${job2ClassName(p.job2)})/${p.job3} path=${job2PathFromId(p.job2)}`,
    );
  } else if (c0 === "//maxskills") {
    const n = await maxAllSkills(p.charId);
    send(p, await buildSkillAll(p.charId));
    send(p, await charAll(p.charId));
    console.log(`[field] GM //maxskills char=${p.charId} updated=${n}`);
  } else if (c0 === "//item") {
    const itemId = Number(parts[1] ?? 8810011);
    const qty = Number(parts[2] ?? 1);
    const bag = await addItemToInventory(p.charId, itemId, qty, 0, -1, p.magic || PACKET_MAGIC);
    if (bag < 0) {
      console.log(`[field] GM //item inventory full char=${p.charId}`);
    } else {
      for (const out of await refreshBagPackets(p.charId, bag, p.magic || PACKET_MAGIC)) send(p, out);
    }
  } else if (c0 === "//ban") {
    const targetName = parts[1];
    if (!targetName) return;
    let target: Player | undefined;
    for (const o of players.values()) {
      if (o.loggedIn && o.name.toLowerCase() === targetName.toLowerCase()) {
        target = o;
        break;
      }
    }
    if (!target) {
      console.log(`[field] GM //ban not online: ${targetName}`);
      return;
    }
    try {
      target.sock.destroy();
    } catch {
      /* */
    }
    console.log(`[field] GM //ban kicked ${targetName}`);
  } else {
    // legacy: log only — never NOTICE (looks like //notice spam in-game).
    console.log(`[field] Unknown GM cmd: ${cmd}`);
  }
}
