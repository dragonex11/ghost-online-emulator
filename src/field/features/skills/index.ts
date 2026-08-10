import type { RowDataPacket } from "mysql2";
import { query, execute } from "../../../db/index.js";
import { writeHeader } from "../../../net/packet.js";
import { DELETE_SKILLS_BY_CHARID_2, DELETE_SKILLS_BY_CHARID_3, DELETE_SKILLS_BY_CHARID_4, DELETE_SKILLS_BY_ID, INSERT_SKILLS, INSERT_SKILLS_BY_CHARID_AND_SKILLID, SELECT_CHARACTERS_BY_ID_3, SELECT_SKILLS_BY_CHARID, SELECT_SKILLS_BY_CHARID_2, SELECT_SKILLS_BY_CHARID_3, SELECT_SKILLS_BY_CHARID_AND_SKILLID, UPDATE_CHARACTERS_BY_ID_25, UPDATE_SKILLS_BY_ID } from "../../../db/queries/index.js";

/** Unset job2/job3 in DB — packet byte becomes 0xFF via u8(). */
export const JOB_UNSET = -1;

/**
 * client `job2` is a **2nd-job class id**, not a light/dark flag:
 *   1 Knight, 2 Dark Knight, 3 Ninja, 4 Killer, 5 White Mage, 6 Black Mage,
 *   7 Royal Gladiator, 8 Demonic Gladiator
 * Order = odd, Chaos = even. 1st job selects the pair.
 */
export function job2ClassId(job1: number, path: number): number {
  // path: 1=Order, 2=Chaos
  if (path !== 1 && path !== 2) return JOB_UNSET;
  if (job1 === 1) return path === 1 ? 1 : 2;
  if (job1 === 2) return path === 1 ? 3 : 4;
  if (job1 === 3) return path === 1 ? 5 : 6;
  return JOB_UNSET;
}

/**
 * Wire Guild byte for CHAR_ALL / ENTERPLAYER:
 *   0 = Force of Order, 1 = Force of Chaos, 0xFF = unset
 * DB / GM `//faction` keep 1=Order, 2=Chaos (legacy convention) — convert here only.
 */
export function job3ToWireGuild(job3: number): number {
  const v = Number(job3);
  if (!Number.isFinite(v) || v < 0) return 0xff;
  if (v === 1) return 0; // Order
  if (v === 2) return 1; // Chaos
  // Already wire-form (0/1) or unknown — pass through clipped
  return v & 0xff;
}

/** Order(1)/Chaos(2) from a job2 class id; 0 if unset. */
export function job2PathFromId(job2Id: number): number {
  if (job2Id < 1 || job2Id > 8) return 0;
  return job2Id % 2 === 1 ? 1 : 2;
}

export function job2ClassName(job2Id: number): string {
  const names = [
    "",
    "Knight",
    "Dark Knight",
    "Ninja",
    "Killer",
    "White Mage",
    "Black Mage",
    "Royal Gladiator",
    "Demonic Gladiator",
  ];
  return names[job2Id] ?? `job2=${job2Id}`;
}

export async function ensureBeginnerSkills(charId: number): Promise<void> {
  await execute(
    INSERT_SKILLS_BY_CHARID_AND_SKILLID,
    [charId, charId],
  );
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** 1st-job skill book (sword / claw / mage). */
export function job1SkillIds(job: number): number[] {
  if (job === 1) return range(10101, 10110);
  if (job === 2) return range(10201, 10210);
  if (job === 3) return range(10301, 10310);
  return [];
}

/**
 * 2nd-job skill base for (1st job, path).
 * path 1=light/正 → 21x00, path 2=dark/邪 → 22x00
 * Warrior→211/221, Assassin→212/222, Mage→213/223
 */
export function job2SkillBase(job: number, path: number): number {
  if (job < 1 || job > 3 || (path !== 1 && path !== 2)) return 0;
  const light = [0, 21100, 21200, 21300][job]!;
  const dark = [0, 22100, 22200, 22300][job]!;
  return path === 2 ? dark : light;
}

/** Full 2nd-job line for GM unlock (quest skills use +1..+4; pad through +10). */
export function job2SkillIds(job: number, path: number): number[] {
  const base = job2SkillBase(job, path);
  if (!base) return [];
  return range(base + 1, base + 10);
}

/** Faction skills for (1st job, faction path) — legacy `_SkillsFactionList` parity. */
export function factionSkillIds(job: number, path: number): number[] {
  if (job < 1 || job > 3 || (path !== 1 && path !== 2)) return [];
  if (path === 2) {
    const shared = [32001, 32002];
    if (job === 1) return [...shared, 32101, 32102, 32103, 32104, 32107, 32108, 32105, 32106];
    if (job === 2) return [...shared, 32201, 32202, 32203, 32204, 32207, 32208, 32205, 32206];
    return [...shared, 32301, 32302, 32303, 32304, 32305, 32308, 32309, 32306];
  }
  const shared = [31001, 31002];
  if (job === 1) return [...shared, 31101, 31102, 31103, 31104, 31107, 31108, 31105, 31106];
  if (job === 2) return [...shared, 31201, 31202, 31203, 31204, 31207, 31208, 31205, 31206];
  return [...shared, 31301, 31302, 31303, 31304, 31305, 31308, 31309, 31306];
}

/** All skills that belong to the character's current job progression (and below). */
export function skillsForProgression(job: number, job2: number, job3: number): number[] {
  const out: number[] = [1, 2, 3, 4];
  if (job >= 1 && job <= 3) out.push(...job1SkillIds(job));
  // job2 is class id 1–8; derive Order/Chaos path for skill bases
  const path = job2PathFromId(job2);
  if (job >= 1 && path) out.push(...job2SkillIds(job, path));
  const factionPath = job3 === 1 || job3 === 2 ? job3 : path;
  if (job >= 1 && (factionPath === 1 || factionPath === 2)) {
    out.push(...factionSkillIds(job, factionPath));
  }
  return out;
}

async function grantSkillIds(charId: number, ids: number[]): Promise<void> {
  for (const sid of ids) {
    if (sid <= 0) continue;
    const rows = await query<RowDataPacket[]>(SELECT_SKILLS_BY_CHARID_AND_SKILLID, [charId, sid]);
    if (!rows.length) await execute(INSERT_SKILLS, [charId, sid, 1]);
  }
}

/**
 * GM `//skills`: unlock every skill for current job tree (1st + job2 + faction as set).
 * Drops leftover skills outside the progression (wrong job / old faction IDs).
 * Does not max levels — use `//maxskills` for that.
 */
export async function syncJobSkills(charId: number, job: number, job2: number, job3: number): Promise<void> {
  await ensureBeginnerSkills(charId);
  const keep = new Set(skillsForProgression(job, job2, job3));
  const rows = await query<RowDataPacket[]>(SELECT_SKILLS_BY_CHARID, [charId]);
  for (const r of rows) {
    const sid = Number(r.skillid);
    if (!keep.has(sid)) await execute(DELETE_SKILLS_BY_ID, [r.id]);
  }
  await grantSkillIds(charId, [...keep]);
}

/** Remove non-beginner skills (1st / 2nd / faction). */
export async function clearAdvancedSkills(charId: number): Promise<void> {
  await execute(DELETE_SKILLS_BY_CHARID_2, [charId]);
}

/** Remove 2nd-job + faction skills only (keep matching 1st-job skills). */
export async function clearJob2AndAboveSkills(charId: number): Promise<void> {
  await execute(DELETE_SKILLS_BY_CHARID_3, [charId]);
}

/** Remove faction skills only. */
export async function clearFactionSkills(charId: number): Promise<void> {
  await execute(DELETE_SKILLS_BY_CHARID_4, [charId]);
}

/**
 * Drop 1st-job skills that are not for `job` (e.g. assassin skills after //job 1).
 * Leaves beginner + matching 1st-job + higher tiers untouched (caller clears higher).
 */
export async function clearMismatchedJob1Skills(charId: number, job: number): Promise<void> {
  const keep = new Set(job1SkillIds(job));
  const rows = await query<RowDataPacket[]>(
    SELECT_SKILLS_BY_CHARID_2,
    [charId],
  );
  for (const r of rows) {
    const sid = Number(r.skillid);
    if (!keep.has(sid)) await execute(DELETE_SKILLS_BY_ID, [r.id]);
  }
}

export function maxSkillLevel(skillId: number): number {
  if (skillId === 1) return 5;
  if (skillId === 2) return 10;
  if (skillId === 3) return 20; // Meditate — retail max 20
  if (skillId === 4) return 20; // Palm Force
  return 20;
}

/** GM `//maxskills`: set every owned skill to its cap. */
export async function maxAllSkills(charId: number): Promise<number> {
  const rows = await query<RowDataPacket[]>(SELECT_SKILLS_BY_CHARID, [charId]);
  let n = 0;
  for (const r of rows) {
    const cap = maxSkillLevel(Number(r.skillid));
    await execute(UPDATE_SKILLS_BY_ID, [cap, r.id]);
    n++;
  }
  return n;
}

/**
 * SkillPacket layout (C# shape) — not the older 3-tab packing.
 * Type 0 beginner (10), 1 = 1st job (10), 2 = 2nd job (10), 3 = Guild/faction (20), 4 = 4th (10×i32).
 */
export type SkillBuckets = {
  t0: RowDataPacket[];
  t1: RowDataPacket[];
  t2: RowDataPacket[];
  t3: RowDataPacket[];
  t4: RowDataPacket[];
};

async function skillsByType(charId: number): Promise<SkillBuckets> {
  const rows = await query<RowDataPacket[]>(
    SELECT_SKILLS_BY_CHARID_3,
    [charId],
  );
  const t0: RowDataPacket[] = [];
  const t1: RowDataPacket[] = [];
  const t2: RowDataPacket[] = [];
  const t3: RowDataPacket[] = [];
  const t4: RowDataPacket[] = [];
  for (const r of rows) {
    const sid = Number(r.skillid);
    if (sid < 10000) {
      if (t0.length < 10) t0.push(r);
    } else if (sid < 20000) {
      if (t1.length < 10) t1.push(r);
    } else if (sid < 30000) {
      if (t2.length < 10) t2.push(r);
    } else if (sid < 40000) {
      if (t3.length < 20) t3.push(r);
    } else if (t4.length < 10) {
      t4.push(r);
    }
  }
  return { t0, t1, t2, t3, t4 };
}

function writeTypeShort(buf: Buffer, idsOff: number, lvOff: number, rows: RowDataPacket[], slots: number): void {
  for (let i = 0; i < slots; i++) {
    const r = rows[i];
    if (!r) continue;
    buf.writeUInt16LE(Number(r.skillid) & 0xffff, idsOff + i * 2);
    buf.writeUInt8(Math.max(1, Number(r.points ?? 1)) & 0xff, lvOff + i);
  }
}

export async function buildSkillAll(charId: number): Promise<Buffer> {
  const { t0, t1, t2, t3, t4 } = await skillsByType(charId);
  // C# SkillPacket.getSkillInfo body ends ~+216; keep legacy-proven total len 244.
  const buf = Buffer.alloc(244, 0);
  writeHeader(buf, 0x0073, 244);

  // type0 beginner: ids +12, lv +32
  writeTypeShort(buf, 12, 32, t0, 10);
  // type1 1st job: ids +42, lv +62
  writeTypeShort(buf, 42, 62, t1, 10);
  // type2 2nd job: ids +72, lv +92
  writeTypeShort(buf, 72, 92, t2, 10);
  // type3 Guild/faction: ids +102 (20), lv +142
  writeTypeShort(buf, 102, 142, t3, 20);
  // type4: skillId as int32 +162, lv +202
  for (let i = 0; i < 10; i++) {
    const r = t4[i];
    if (!r) continue;
    buf.writeUInt32LE(Number(r.skillid) >>> 0, 162 + i * 4);
    buf.writeUInt8(Math.max(1, Number(r.points ?? 1)) & 0xff, 202 + i);
  }
  buf.writeUInt32LE(0, 212);
  return buf;
}

/** SKILL_LEVELUP_ACK 0x75 — remaining sk points + type/slot/level (C# SkillPacket.updateSkillLevel). */
export function buildSkillLevelUpAck(skPoint: number, type: number, slot: number, level: number): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x0075, 20);
  b.writeUInt16LE(skPoint & 0xffff, 12);
  b.writeUInt8(type & 0xff, 14);
  b.writeUInt8(slot & 0xff, 15);
  b.writeUInt8(level & 0xff, 16);
  return b;
}

export type SkillUpResult = { ok: true; skillId: number; level: number; skPoint: number } | { ok: false; reason: string };

/** Resolve skill at book type/slot (same packing as SKILL_ALL / 0x74). */
export async function getSkillByTypeSlot(
  charId: number,
  type: number,
  slot: number,
): Promise<{ skillId: number; level: number } | null> {
  if (type < 0 || type > 4) return null;
  const maxSlot = type === 3 ? 19 : 9;
  if (slot < 0 || slot > maxSlot) return null;
  const buckets = await skillsByType(charId);
  const list = [buckets.t0, buckets.t1, buckets.t2, buckets.t3, buckets.t4][type]!;
  const row = list[slot];
  if (!row) return null;
  return {
    skillId: Number(row.skillid),
    level: Math.max(1, Number(row.points ?? 1)),
  };
}

/**
 * Client 0x74 — C# SkillLevelUp_Req: byte Type, byte Slot (not skillId).
 * Type: 0 beginner, 1 1st-job, 2 2nd-job, 3 Guild/faction, 4 4th-job.
 */
export async function skillPointUp(charId: number, type: number, slot: number): Promise<SkillUpResult> {
  const maxSlot = type === 3 ? 19 : 9;
  if (type < 0 || type > 4 || slot < 0 || slot > maxSlot) {
    return { ok: false, reason: `bad type/slot ${type}/${slot}` };
  }
  const chars = await query<RowDataPacket[]>(SELECT_CHARACTERS_BY_ID_3, [charId]);
  if (!chars.length) return { ok: false, reason: "no char" };
  const sk = Number(chars[0]!.sk_point ?? 0);
  if (sk < 1) return { ok: false, reason: "no sk_point" };

  const buckets = await skillsByType(charId);
  const list = [buckets.t0, buckets.t1, buckets.t2, buckets.t3, buckets.t4][type]!;
  const row = list[slot];
  if (!row) return { ok: false, reason: `empty slot type=${type} slot=${slot}` };

  const skillId = Number(row.skillid);
  const pts = Number(row.points ?? 0);
  const cap = maxSkillLevel(skillId);
  if (pts >= cap) return { ok: false, reason: `capped skill=${skillId} pts=${pts}` };

  const newPts = pts + 1;
  await execute(UPDATE_SKILLS_BY_ID, [newPts, row.id]);
  await execute(UPDATE_CHARACTERS_BY_ID_25, [charId]);
  return { ok: true, skillId, level: newPts, skPoint: sk - 1 };
}
