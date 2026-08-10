import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { rates } from "../config.js";
import { writeHeader } from "../net/packet.js";
import { addItemToInventory, removeInvQty, refreshBagPackets } from "./inventory.js";
import { ensureBeginnerSkills, buildSkillAll } from "./skills.js";
import { DELETE_QUESTS_BY_CHARID_AND_QUESTID, INSERT_QUESTS, INSERT_SKILLS, SELECT_CHARACTERS_BY_ID_2, SELECT_EQUIP_BY_CHARID_AND_TYPE, SELECT_QUESTS_BY_CHARID, SELECT_QUESTS_BY_CHARID_AND_QUESTID, SELECT_QUESTS_BY_CHARID_AND_STATE, selectRowDynamicTableCol, SELECT_SKILLS_BY_CHARID_AND_SKILLID, UPDATE_CHARACTERS_BY_ID_10, UPDATE_CHARACTERS_BY_ID_11, UPDATE_CHARACTERS_BY_ID_12, UPDATE_CHARACTERS_BY_ID_13, UPDATE_QUESTS_BY_CHARID_AND_QUESTID, UPDATE_QUESTS_BY_CHARID_AND_QUESTID_2, UPDATE_QUESTS_BY_ID, UPDATE_QUESTS_BY_ID_2 } from "../db/queries/index.js";

/** remote DB: quests(charid, questid, state, progress). Packets match legacy legacy quests. */

const KILL_GOALS: Record<number, { template: number; count: number }> = {
  8: { template: 1001201, count: 10 },
  28: { template: 1002201, count: 20 },
  38: { template: 1002201, count: 20 },
  29: { template: 1002801, count: 20 },
  39: { template: 1002801, count: 20 },
  49: { template: 1002801, count: 20 },
  30: { template: 1003401, count: 20 },
  40: { template: 1003401, count: 20 },
  50: { template: 1003401, count: 20 },
  31: { template: 1003801, count: 20 },
  41: { template: 1003801, count: 20 },
  44: { template: 1001201, count: 20 },
  45: { template: 1001201, count: 20 },
  46: { template: 1001601, count: 20 },
  47: { template: 1002101, count: 20 },
  48: { template: 1002401, count: 20 },
  51: { template: 1003701, count: 20 },
};

const NEED_LEVEL: Record<number, number> = {
  2: 2, 3: 2, 4: 3, 5: 5, 6: 8,
  7: 10, 15: 10, 16: 10, 17: 10, 18: 10, 19: 10, 20: 10, 21: 10, 22: 10, 23: 10,
  32: 10, 33: 10, 42: 10, 43: 10,
  8: 12, 44: 12, 45: 12,
  9: 13, 24: 13, 25: 13, 34: 13, 35: 13,
  10: 15, 11: 18, 12: 18, 26: 18, 27: 18, 36: 18, 37: 18,
  13: 20, 46: 17, 47: 21, 28: 23, 38: 23, 48: 25, 29: 28, 39: 28, 49: 29,
  14: 30, 30: 33, 40: 33, 50: 33, 51: 37, 31: 38, 41: 38,
};

const NEED_QUEST: Record<number, number> = { 4: 3, 9: 8, 12: 11, 13: 12 };

/** Turn-in consume list from quest.lua goal.getItem + deleteItem (quests 2–51). */
const TURN_IN_ITEMS: Record<number, Array<[number, number]>> = {
  2: [[8910031, 10]],
  3: [[8990002, 1]],
  4: [[8990003, 1]],
  5: [[8910051, 10]],
  6: [[8110011, 1]],
  7: [[8910101, 10]],
  9: [[8910121, 20]],
  10: [[8910161, 20]],
  11: [[8810041, 1]],
  12: [[8810041, 1]],
  13: [[8990004, 1], [8910201, 10]],
  14: [[8910301, 10]],
  15: [[8910061, 20], [8910071, 10]],
  17: [[8910081, 10]],
  18: [[8910061, 20], [8910071, 10]],
  20: [[8910061, 20], [8910071, 10]],
  22: [[8990006, 1]],
  23: [[8990009, 1]],
  24: [[8910141, 10]],
  25: [[8910141, 10]],
  26: [[8910181, 10]],
  27: [[8910181, 10]],
  32: [[8990007, 1]],
  33: [[8990010, 1]],
  34: [[8910141, 10]],
  35: [[8910141, 10]],
  36: [[8910181, 10]],
  37: [[8910181, 10]],
  42: [[8990008, 1]],
  43: [[8990011, 1]],
};

const ACCEPT_ITEMS: Record<number, number> = {
  3: 8990002, 4: 8990003, 22: 8990006, 23: 8990009,
  32: 8990007, 33: 8990010, 42: 8990008, 43: 8990011,
};

const SKILL_REWARDS: Record<number, number> = {
  22: 10101, 23: 10102, 24: 10105, 25: 10103, 26: 10106, 27: 10108, 28: 10107, 29: 10104, 30: 10109, 31: 10110,
  32: 10201, 33: 10202, 34: 10203, 35: 10206, 36: 10209, 37: 10208, 38: 10204, 39: 10205, 40: 10207, 41: 10210,
  42: 10301, 43: 10302, 44: 10304, 45: 10303, 46: 10305, 47: 10306, 48: 10307, 49: 10308, 50: 10309, 51: 10310,
};

function supported(qid: number): boolean {
  return qid >= 2 && qid <= 51;
}

export async function buildQuestAll(cid: number): Promise<Buffer> {
  const rows = await query<RowDataPacket[]>(
    SELECT_QUESTS_BY_CHARID,
    [cid],
  );
  const b = Buffer.alloc(1252, 0);
  writeHeader(b, 0x0079, 1252);
  let slot = 0;
  for (const r of rows) {
    if (slot >= 15) break;
    const st = Number(r.questState ?? 0x20);
    if (st === 0x20) continue;
    b.writeUInt32LE(Number(r.completeMonster ?? 0), 12 + slot * 16);
    b.writeUInt16LE(Number(r.questId) & 0xffff, 24 + slot * 16);
    b.writeUInt8(1, 26 + slot * 16);
    b.writeUInt8(0, 27 + slot * 16);
    slot++;
  }
  const base = 12 + 15 * 16;
  for (let i = 0; i < 999; i++) b.writeUInt8(0x20, base + i);
  for (const r of rows) {
    const qid = Number(r.questId);
    const st = Number(r.questState ?? 0x20);
    if (qid < 1 || qid > 999 || st === 0x20) continue;
    b.writeUInt8(st & 0xff, base + (qid - 1));
  }
  return b;
}

function questUpdate(complete: number, questId: number, stateA: number, stateB: number): Buffer {
  const b = Buffer.alloc(28, 0);
  writeHeader(b, 0x0080, 28);
  b.writeUInt32LE(complete, 12);
  b.writeUInt16LE(questId & 0xffff, 24);
  b.writeUInt8(stateA & 0xff, 26);
  b.writeUInt8(stateB & 0xff, 27);
  return b;
}

async function getRow(cid: number, qid: number): Promise<RowDataPacket | null> {
  const rows = await query<RowDataPacket[]>(
    SELECT_QUESTS_BY_CHARID_AND_QUESTID,
    [cid, qid],
  );
  return rows[0] ?? null;
}

async function removeItemById(cid: number, itemId: number, qty: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let left = qty;
  const bags: Array<{ bag: number; col: string; table: string }> = [
    { bag: 3, col: "itemid", table: "spend" },
    { bag: 4, col: "type", table: "other" },
  ];
  for (const t of bags) {
    if (left <= 0) break;
    const rows = await query<RowDataPacket[]>(
      selectRowDynamicTableCol(t.table, t.col),
      [cid, itemId],
    );
    for (const r of rows) {
      if (left <= 0) break;
      const take = Math.min(left, Number(r.amount));
      await removeInvQty(cid, t.bag, Number(r.pos2), take);
      left -= take;
      out.push(...(await refreshBagPackets(cid, t.bag)));
    }
  }
  // Equip (bags 0–2): one row per piece — legacy parity
  if (left > 0) {
    const rows = await query<RowDataPacket[]>(
      SELECT_EQUIP_BY_CHARID_AND_TYPE,
      [cid, itemId, left],
    );
    const refreshed = new Set<number>();
    for (const r of rows) {
      const bag = Number(r.pos1);
      await removeInvQty(cid, bag, Number(r.pos2), 1);
      left -= 1;
      if (!refreshed.has(bag)) {
        refreshed.add(bag);
        out.push(...(await refreshBagPackets(cid, bag)));
      }
    }
  }
  return out;
}

async function grantSkill(cid: number, skillId: number): Promise<void> {
  const rows = await query<RowDataPacket[]>(SELECT_SKILLS_BY_CHARID_AND_SKILLID, [cid, skillId]);
  if (!rows.length) await execute(INSERT_SKILLS, [cid, skillId]);
}

async function addMoney(cid: number, amount: number): Promise<void> {
  await execute(UPDATE_CHARACTERS_BY_ID_10, [amount, cid]);
}

async function addFame(cid: number, amount: number): Promise<void> {
  await execute(UPDATE_CHARACTERS_BY_ID_11, [amount, cid]);
}

async function addExp(cid: number, amount: number): Promise<void> {
  const rows = await query<RowDataPacket[]>(SELECT_CHARACTERS_BY_ID_2, [cid]);
  if (!rows.length) return;
  let exp = Number(rows[0]!.exp ?? 0) + amount;
  let mexp = Number(rows[0]!.mexp ?? 30);
  let level = Number(rows[0]!.level ?? 1);
  let st = Number(rows[0]!.st_point ?? 0);
  let sk = Number(rows[0]!.sk_point ?? 0);
  while (exp >= mexp && level < 99) {
    exp -= mexp;
    level += 1;
    st += 5;
    sk += 1;
    mexp = Math.floor(mexp * rates.questExpRate) + rates.questExpFlat;
  }
  await execute(UPDATE_CHARACTERS_BY_ID_12, [
    exp, mexp, level, st, sk, cid,
  ]);
}

async function jobChange(cid: number, job: number): Promise<Buffer[]> {
  await execute(UPDATE_CHARACTERS_BY_ID_13, [job, cid]);
  // Original: job change does not unlock skills — those come from job-master quests (22–51).
  await ensureBeginnerSkills(cid);
  return [await buildSkillAll(cid)];
}

async function applyRewards(cid: number, questId: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const [iid, q] of TURN_IN_ITEMS[questId] ?? []) {
    out.push(...(await removeItemById(cid, iid, q)));
  }

  const money: Record<number, number> = {
    2: 200, 3: 300, 4: 400, 5: 600, 6: 1200, 7: 1500, 8: 1800, 9: 2000, 10: 3000, 13: 9000, 14: 54000,
  };
  const exp: Record<number, number> = {
    3: 30, 4: 30, 5: 50, 6: 200, 7: 300, 8: 500, 9: 500, 11: 100, 12: 100, 13: 2000, 14: 5000,
  };
  const fame: Record<number, number> = {
    3: 1, 4: 1, 5: 1, 6: 5, 8: 1, 9: 1, 11: 2, 12: 2,
  };
  if (money[questId]) await addMoney(cid, money[questId]!);
  if (exp[questId]) await addExp(cid, exp[questId]!);
  if (fame[questId]) await addFame(cid, fame[questId]!);

  if (questId === 7) {
    const b1 = await addItemToInventory(cid, 8810011, 20);
    const b2 = await addItemToInventory(cid, 8820011, 40);
    if (b1 >= 0) out.push(...(await refreshBagPackets(cid, b1)));
    if (b2 >= 0) out.push(...(await refreshBagPackets(cid, b2)));
  }
  if (questId === 12) {
    const b = await addItemToInventory(cid, 8990004, 1);
    if (b >= 0) out.push(...(await refreshBagPackets(cid, b)));
  }

  if (questId === 16) out.push(...(await jobChange(cid, 1)));
  if (questId === 19) out.push(...(await jobChange(cid, 2)));
  if (questId === 21) out.push(...(await jobChange(cid, 3)));

  const sid = SKILL_REWARDS[questId];
  if (sid) {
    await grantSkill(cid, sid);
    out.push(await buildSkillAll(cid));
  }
  return out;
}

export async function acceptQuest(cid: number, level: number, questId: number): Promise<Buffer[]> {
  if (!supported(questId)) return [await buildQuestAll(cid)];
  const needLv = NEED_LEVEL[questId] ?? 1;
  if (level < needLv) return [await buildQuestAll(cid)];
  const needQ = NEED_QUEST[questId];
  if (needQ) {
    const prereq = await getRow(cid, needQ);
    if (!prereq || Number(prereq.questState) !== 0x32) return [await buildQuestAll(cid)];
  }
  const existing = await getRow(cid, questId);
  if (existing) {
    const st = Number(existing.questState);
    if (st === 0x31 || st === 0x32) return [await buildQuestAll(cid)];
    await execute(UPDATE_QUESTS_BY_ID, [existing.id]);
  } else {
    await execute(INSERT_QUESTS, [cid, questId]);
  }
  const out: Buffer[] = [];
  const acceptItem = ACCEPT_ITEMS[questId];
  if (acceptItem) {
    const bag = await addItemToInventory(cid, acceptItem, 1);
    if (bag >= 0) out.push(...(await refreshBagPackets(cid, bag)));
  }
  out.push(await buildQuestAll(cid));
  return out;
}

export async function giveUpQuest(cid: number, questId: number): Promise<Buffer[]> {
  await execute(DELETE_QUESTS_BY_CHARID_AND_QUESTID, [cid, questId]);
  return [await buildQuestAll(cid)];
}

export type QuestCompleteResult = { packets: Buffer[]; refreshChar: boolean };

export async function completeQuest(cid: number, questId: number): Promise<QuestCompleteResult> {
  const row = await getRow(cid, questId);
  if (!row || Number(row.questState) !== 0x31) {
    return { packets: [await buildQuestAll(cid)], refreshChar: false };
  }
  await execute(UPDATE_QUESTS_BY_CHARID_AND_QUESTID, [cid, questId]);
  const rewardPkts = await applyRewards(cid, questId);
  return {
    packets: [...rewardPkts, await buildQuestAll(cid), questUpdate(Number(row.completeMonster), questId, 1, 0)],
    refreshChar: true,
  };
}

export async function onMonsterKill(cid: number, template: number): Promise<Buffer[]> {
  const rows = await query<RowDataPacket[]>(
    SELECT_QUESTS_BY_CHARID_AND_STATE,
    [cid],
  );
  const out: Buffer[] = [];
  for (const r of rows) {
    const qid = Number(r.questId);
    const def = KILL_GOALS[qid];
    if (!def || def.template !== template) continue;
    let done = Number(r.completeMonster ?? 0);
    if (done >= def.count) continue;
    done += 1;
    // Keep state=49 (0x31) until turn-in — legacy parity
    await execute(UPDATE_QUESTS_BY_ID_2, [done, r.id]);
    out.push(questUpdate(done, qid, 1, 0));
  }
  return out;
}

/** legacy: 0x7A accept, 0x7B giveup, 0x7C done, 0x7D return, 0x7E done2, 0x7F update */
export async function handleQuestPacket(
  cid: number,
  level: number,
  opcode: number,
  pkt: Buffer,
): Promise<QuestCompleteResult> {
  const qid = pkt.length >= 14 ? pkt.readUInt16LE(12) : 0;
  if (opcode === 0x007a) return { packets: await acceptQuest(cid, level, qid), refreshChar: false };
  if (opcode === 0x007b) return { packets: await giveUpQuest(cid, qid), refreshChar: false };
  if (opcode === 0x007c) return completeQuest(cid, qid);
  if (opcode === 0x007e) {
    const questId = pkt.length >= 22 ? pkt.readUInt16LE(20) : qid;
    return completeQuest(cid, questId);
  }
  if (opcode === 0x007d) {
    const questId = pkt.length >= 18 ? pkt.readUInt16LE(16) : qid;
    const stage = pkt.length >= 20 ? pkt.readUInt16LE(18) : 0;
    await execute(UPDATE_QUESTS_BY_CHARID_AND_QUESTID_2, [stage, cid, questId]);
    const row = await getRow(cid, questId);
    if (!row) return { packets: [], refreshChar: false };
    return { packets: [questUpdate(Number(row.completeMonster), questId, 1, stage & 0xff)], refreshChar: false };
  }
  if (opcode === 0x007f) {
    const row = await getRow(cid, qid);
    if (!row || Number(row.questState) !== 0x31) return { packets: [], refreshChar: false };
    return { packets: [questUpdate(Number(row.completeMonster), qid, 1, 0)], refreshChar: false };
  }
  return { packets: [await buildQuestAll(cid)], refreshChar: false };
}

/** @deprecated alias */
export async function buildQuestList(cid: number): Promise<Buffer[]> {
  return [await buildQuestAll(cid)];
}
