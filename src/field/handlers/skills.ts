import type { RowDataPacket } from 'mysql2';
import { execute } from '../../db/index.js';
import { writeHeader } from '../../net/packet.js';
import { getSkillByTypeSlot, maxSkillLevel } from '../features/skills/index.js';
import { loadCharRow, u16 } from '../packets/char.js';
import { type Player, players, send, broadcastMap } from '../player.js';
import { sendVital } from '../packets/ui.js';

import { UPDATE_CHARACTERS_BY_ID_14, UPDATE_CHARACTERS_BY_ID_15, UPDATE_CHARACTERS_BY_ID_16 } from "../../db/queries/index.js";
function hidePacket(charId: number, active: number): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x0061, 16);
  b.writeUInt16LE(charId & 0xffff, 12);
  b.writeUInt16LE(active & 0xffff, 14);
  return b;
}

export function clearSkillTimer(p: Player, skillId: number): void {
  const t = p.skillTimers.get(skillId);
  if (t) {
    clearInterval(t);
    clearTimeout(t);
    p.skillTimers.delete(skillId);
  }
}

export function clearAllSkillEffects(p: Player): void {
  for (const id of [...p.skillTimers.keys()]) clearSkillTimer(p, id);
  p.skillMods.clear();
}

async function persistHpMp(p: Player): Promise<void> {
  await execute(UPDATE_CHARACTERS_BY_ID_14, [p.hp, p.mp, p.charId]);
  sendVital(p);
}

/**
 * USE_SKILL_REQ 0x76 — C# SkillHandler.UseSkill_Req.
 * Beginner: 1=basic (MP), 2=noop, 3=Meditate (HP/MP tick), 4=MP spend.
 * Includes 1st-job effect skills (heal, meditate, etc.).
 */
export async function handleUseSkill(p: Player, pkt: Buffer): Promise<void> {
  if (pkt.length < 20) return;
  const type = pkt.readUInt8(12);
  const slot = pkt.readUInt8(13);
  const levelPkt = pkt.readUInt8(14);
  const active = pkt.readInt32LE(16);
  const sk = await getSkillByTypeSlot(p.charId, type, slot);
  if (!sk) {
    console.log(`[field] use-skill miss char=${p.charId} type=${type} slot=${slot}`);
    return;
  }
  const level = Math.max(1, sk.level || levelPkt || 1);
  const sid = sk.skillId;
  console.log(
    `[field] use-skill char=${p.charId} skill=${sid} lv=${level} type=${type}/${slot} active=${active}`,
  );

  switch (sid) {
    case 1: {
      // Basic attack skill — MP cost only (anim is client 0x2E/0x31)
      const cost = level < 5 ? 2 : 4;
      p.mp = Math.max(0, p.mp - cost);
      await persistHpMp(p);
      break;
    }
    case 2:
      break;
    case 3: {
      // Meditate — toggle. No heal on click; first tick after interval.
      // Retail max 20. No client interval table — linear lv1=8s → lv20=5s.
      // Heal +8 HP / +2 MP × level.
      if (active === 1) {
        clearSkillTimer(p, 3);
        const lv = Math.min(maxSkillLevel(3), Math.max(1, level));
        const intervalMs = Math.round(8000 - ((lv - 1) / 19) * 3000);
        console.log(
          `[field] meditate ON char=${p.charId} lv=${lv} tick=${intervalMs}ms heal=${8 * lv}/${2 * lv}`,
        );
        const tick = async () => {
          if (!p.loggedIn || !p.alive || !players.has(p.charId)) {
            clearSkillTimer(p, 3);
            return;
          }
          if (!p.skillTimers.has(3)) return;
          const addHp = Math.min(8 * lv, Math.max(0, p.maxHp - p.hp));
          const addMp = Math.min(2 * lv, Math.max(0, p.maxMp - p.mp));
          if (addHp === 0 && addMp === 0) {
            console.log(`[field] meditate tick char=${p.charId} skipped (full)`);
            return;
          }
          p.hp += addHp;
          p.mp += addMp;
          console.log(
            `[field] meditate tick char=${p.charId} +${addHp}/+${addMp} -> ${p.hp}/${p.maxHp} ${p.mp}/${p.maxMp}`,
          );
          await persistHpMp(p);
        };
        const schedule = () => {
          const to = setTimeout(() => {
            void (async () => {
              await tick();
              if (p.skillTimers.get(3) === to) schedule();
            })();
          }, intervalMs);
          p.skillTimers.set(3, to);
        };
        schedule();
      } else {
        console.log(`[field] meditate OFF char=${p.charId}`);
        clearSkillTimer(p, 3);
      }
      break;
    }
    case 4: {
      p.mp = Math.max(0, p.mp - 5);
      await persistHpMp(p);
      break;
    }
    case 10104: {
      // 氣力轉換 — HP → MP
      p.hp = Math.max(0, p.hp - 5 * level);
      p.mp = Math.min(p.maxMp, p.mp + 16 * level);
      await persistHpMp(p);
      break;
    }
    case 10107: {
      // 狂暴怒氣 — atk up / def down for a duration
      clearSkillTimer(p, 10107);
      p.skillMods.delete(10107);
      const lv = Math.min(20, Math.max(1, level));
      const mpCost = lv <= 5 ? 26 : lv <= 10 ? 52 : lv <= 15 ? 78 : 104;
      const defPct = 0.03 * lv;
      const atkPct = 0.01 * lv;
      const timeSec = 30 + 3 * lv;
      p.mp = Math.max(0, p.mp - mpCost);
      await persistHpMp(p);
      const row = await loadCharRow(p.charId);
      if (!row) break;
      const defense = Math.floor(Number(row.def ?? 0) * defPct);
      const attack = Math.max(1, Math.floor(Number(row.mindamphy ?? 10) * atkPct));
      p.skillMods.set(10107, { atk: attack, def: -defense });
      send(p, await buildStatUpAck(p.charId));
      const to = setTimeout(() => {
        p.skillMods.delete(10107);
        p.skillTimers.delete(10107);
        void buildStatUpAck(p.charId).then((pkt) => send(p, pkt));
      }, timeSec * 1000);
      p.skillTimers.set(10107, to);
      break;
    }
    case 10207: {
      // 霧影術 — hide
      broadcastMap(p.map, p.region, hidePacket(p.charId, 1));
      break;
    }
    case 10309: {
      // 防護加持 — defense buff
      clearSkillTimer(p, 10309);
      p.skillMods.delete(10309);
      const lv = Math.min(20, Math.max(1, level));
      const mpCost = lv <= 5 ? 34 : lv <= 10 ? 68 : lv <= 15 ? 102 : 136;
      const defPct = 0.03 * lv;
      const timeSec = 30 + 5 * lv;
      p.mp = Math.max(0, p.mp - mpCost);
      await persistHpMp(p);
      const row = await loadCharRow(p.charId);
      if (!row) break;
      const defense = Math.max(1, Math.floor(Number(row.def ?? 0) * defPct));
      p.skillMods.set(10309, { atk: 0, def: defense });
      send(p, await buildStatUpAck(p.charId));
      const to = setTimeout(() => {
        p.skillMods.delete(10309);
        p.skillTimers.delete(10309);
        void buildStatUpAck(p.charId).then((pkt) => send(p, pkt));
      }, timeSec * 1000);
      p.skillTimers.set(10309, to);
      break;
    }
    case 10310: {
      // 陰陽幻移 — heal HP for MP
      p.hp = Math.min(p.maxHp, p.hp + 16 * level);
      p.mp = Math.max(0, p.mp - 5 * level);
      await persistHpMp(p);
      break;
    }
    default:
      // Most combat skills only need peer anim (0x2E/0x31 already relayed). No server HP effect.
      break;
  }
}

export async function buildStatUpAck(charId: number): Promise<Buffer> {
  const c = await loadCharRow(charId);
  const b = Buffer.alloc(78, 0);
  writeHeader(b, 0x0060, 78);
  if (!c) return b;
  const pl = players.get(charId);
  let atkMod = 0;
  let defMod = 0;
  if (pl) {
    for (const m of pl.skillMods.values()) {
      atkMod += m.atk;
      defMod += m.def;
    }
  }
  b.writeUInt16LE(u16(c.cmhp, 50), 12);
  b.writeUInt16LE(u16(c.cmmp, 50), 14);
  b.writeUInt16LE(u16(c.str, 3), 16);
  b.writeUInt16LE(u16(c.dex, 3), 18);
  b.writeUInt16LE(u16(c.vit, 3), 20);
  b.writeUInt16LE(u16(c.intel, 3), 22);
  b.writeUInt16LE(u16(Number(c.maxdamphy ?? 10) + atkMod, 10), 24);
  b.writeUInt16LE(u16(Number(c.mindamphy ?? 10) + atkMod, 10), 26);
  b.writeUInt16LE(u16(c.maxdamw, 0), 28);
  b.writeUInt16LE(u16(c.mindamw, 0), 30);
  b.writeUInt16LE(u16(Math.max(0, Number(c.def ?? 0) + defMod), 0), 32);
  b.writeUInt16LE(258, 34);
  b.writeUInt16LE(u16(c.st_point, 0), 38);
  b.writeUInt16LE(u16(c.sk_point, 0), 40);
  b.writeUInt16LE(u16(c.p_str, 0), 42);
  b.writeUInt16LE(u16(c.p_dex, 0), 44);
  b.writeUInt16LE(u16(c.p_vit, 0), 46);
  b.writeUInt16LE(u16(c.p_int, 0), 48);
  b.writeUInt16LE(u16(c.p_damphy, 0), 50);
  b.writeUInt16LE(u16(c.p_damw, 0), 52);
  b.writeUInt16LE(u16(c.p_def, 0), 54);
  return b;
}
