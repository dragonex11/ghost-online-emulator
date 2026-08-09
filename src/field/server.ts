import fs from "node:fs";
import path from "node:path";
import dgram from "node:dgram";
import net from "node:net";
import type { RowDataPacket } from "mysql2";
import { config, rates } from "../config.js";
import { query, execute } from "../db.js";
import {
  peelGame,
  opcodeOf,
  readCString,
  writeCString,
  writeHeader,
  logPkt,
  bufToHex,
} from "../net/packet.js";
import { decodeFieldFrame, encodeFieldFrame, type FieldKeys } from "../net/fieldCodec.js";
import { bumpOnline, setOnlineCount } from "../net/online.js";
import { decodePassword, encodePassword } from "../login/passwordCodec.js";
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
} from "./skills.js";
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
} from "./monsters.js";
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
} from "./drops.js";
import {
  loadCashShopFromDb,
  buildCashLists,
  cashSlotsForMagic,
  buildBalance,
  buildWarehouse,
  cashBuy,
  deliverCashGifts,
} from "./cashshop.js";
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
} from "./inventory.js";
import { applySpendRecover, spendRecoverEffect } from "./spend_effects.js";
import {
  activeBuffOrNull,
  applyEventBuff,
  isSpecialSpendItem,
  rollGachaBox,
  type BoxBuff,
} from "./spend_boxes.js";
import { handleQuestPacket, onMonsterKill, buildQuestAll } from "./quests.js";
import { buildQuickSlotAll, saveQuickSlot } from "./hotkeys.js";
import {
  dispatchPShop,
  handlePShopBuy,
  isPShopOpcode,
  isPShopOutOpcode,
  listActivePShops,
  buildPShopStartPkt,
  endPShopIfActive,
} from "./pshop.js";
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
} from "./party.js";
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
} from "./trade.js";

type Player = {
  sock: net.Socket;
  buf: Buffer;
  charId: number;
  accountId: number;
  name: string;
  map: number;
  region: number;
  x: number;
  y: number;
  level: number;
  exp: number;
  mexp: number;
  job: number;
  job2: number;
  job3: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  /** Physical / magic attack used for monster hits (from mindamphy/maxdamphy/…). */
  minAtk: number;
  maxAtk: number;
  minMag: number;
  maxMag: number;
  def: number;
  money: number;
  soul: number;
  maxSoul: number;
  gm: number;
  loggedIn: boolean;
  fishing: boolean;
  alive: boolean;
  spendUseSlot: number; // 0xFF = none
  petUseSlot: number; // 0xFF = none; bag slot used when equipping pet
  /** Set on 0x85; 0x1D then sends ENTERPLAYER (bags first). Initial login leaves this false. */
  pendingWarp: boolean;
  /** True after first ENTERPLAYER this map — blocks duplicate 0xDB enter. */
  fieldEntered: boolean;
  /** Skip monster touch damage until this time (ms) — avoids HP packet during map load. */
  touchGraceUntil: number;
  /** legacy $CHAR_LAST_TOUCH — touch damage cooldown */
  lastTouchAt: number;
  fishTimer?: ReturnType<typeof setTimeout>;
  /** Serialize async packet handlers — overlapping data events race ENTERPLAYER/bags. */
  pktChain: Promise<void>;
  /** Full MON_ALL sent for combat slot table on current map */
  monCombatReady: boolean;
  monCombatTimer?: ReturnType<typeof setTimeout>;
  /** Game4=0x0105, en-client=0x0037 — echoed on every outbound header. */
  magic: number;
  /** Session token from client header +8. */
  unk: number;
  /** True after connect hello (0x14) was sent with the client's magic. */
  helloSent: boolean;
  /** en-client field stream cipher keys (from hello 0x14). */
  fieldKeys: FieldKeys;
  /** Client's local UDP bind port (8000/8001) learned from move-relay datagrams. */
  udpPort: number;
  udpHost: string;
  /** Active skill effect timers (Meditate tick, buff expiry). */
  skillTimers: Map<number, ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>;
  /** Per-skill temporary atk/def mods (summed into STATUP). */
  skillMods: Map<number, { atk: number; def: number }>;
  /** Lucky Spring / Golden Xmas sox style timed rate buffs. */
  eventBuff?: BoxBuff;
};

const players = new Map<number, Player>(); // charId -> player
/** Peer-visible action packets relayed UDP→TCP (and TCP→TCP). Position-bearing: 0x27/DD/29/2A. */
const MOVE_OPS = new Set([
  0x27, 0xdd, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x24, // move / jump / speed / basic attack
  0x2e, 0x31, // P_SPELL_C / P_SKILL_C — skill cast anims
  0x10b, 0x10c, 0x10d, 0x10e, // PET_MOVE / MOVETO / BIRD / BIRDTO
  0x110, 0x111, 0x116, // PET_JUMP / ATTACK / related pet action
]);

/** Keep live coords in sync — movement is mostly UDP, drops/touch use p.x/p.y */
function updatePosFromMove(p: Player, pkt: Buffer, op: number): void {
  try {
    let nx = p.x;
    let ny = p.y;
    if ((op === 0x27 || op === 0xdd) && pkt.length >= 24) {
      nx = Math.floor(pkt.readFloatLE(16));
      ny = Math.floor(pkt.readFloatLE(20));
    } else if ((op === 0x2a || op === 0x29) && pkt.length >= 28) {
      nx = Math.floor(pkt.readFloatLE(20));
      ny = Math.floor(pkt.readFloatLE(24));
    } else {
      // Skill/pet/attack anims are peer-visual only — do not parse as char position
      return;
    }
    if (Number.isFinite(nx) && Number.isFinite(ny) && nx >= 50 && ny >= 50 && nx < 20000 && ny < 20000) {
      p.x = nx;
      p.y = ny;
    }
  } catch {
    /* */
  }
}

/**
 * Authentic peer-action relay (legacy / official PS shape):
 * client sends move/skill/pet on UDP → server → fan-out unchanged to same map.
 * Do NOT invent PET_MOVE from player coords (that snaps the pet and looks like teleporting).
 * Pet ops also go to each peer's local UDP socket (retail was UDP P2P; TCP alone doesn't apply 0x10B).
 */
function relayPeerAction(p: Player, pkt: Buffer, op: number): void {
  updatePosFromMove(p, pkt, op);
  trySpawnMonstersAfterReady(p);
  const out = Buffer.from(pkt);
  broadcastMap(p.map, p.region, out, p.charId);
  if (op >= 0x10b && op <= 0x118) {
    broadcastMapUdp(p.map, p.region, out, p.charId);
  }
}

let prices = new Map<number, number>();

/** Load NPC prices from MySQL `item_prices` (seeded by database/schema.sql). */
async function loadPrices(): Promise<void> {
  prices = new Map();
  try {
    const rows = await query<RowDataPacket[]>("SELECT item_id, price FROM item_prices");
    for (const r of rows) {
      prices.set(Number(r.item_id), Number(r.price));
    }
  } catch (e) {
    console.warn("[prices] failed to load item_prices from DB:", e);
  }
  if (!prices.size) prices.set(8810011, 100);
  console.log(`[prices] loaded ${prices.size} rows from DB`);
}

function countOnline(): number {
  let n = 0;
  for (const p of players.values()) if (p.loggedIn) n++;
  setOnlineCount(n);
  return n;
}

/** en-client drops raw frames with totalLen > 0x7FFF; Look list is 39212. */
const FIELD_RAW_MAX = 0x7fff;

function send(p: Player, buf: Buffer): void {
  if (p.sock.destroyed) return;
  // Copy before header rewrite — sock.write is async and may still hold `buf`.
  // Mutating in place corrupts in-flight packets when multiple clients share
  // broadcast buffers (UDP moves, mon info, etc.).
  let out = Buffer.from(buf);
  let op = 0;
  if (out.length >= 12 && p.magic) {
    op = out.readUInt16LE(2);
    const len = out.readUInt16LE(4);
    out.writeUInt16LE(p.magic & 0xffff, 0);
    out.writeUInt16LE((op + len + p.magic) & 0xffff, 6);
    // Cash list templates + personal shop (legacy _CashShopWriteHeader) need unk=0.
    if ((op >= 0x11f && op <= 0x127) || isPShopOutOpcode(op)) {
      out.writeUInt32LE(0, 8);
    } else {
      out.writeUInt32LE(p.unk >>> 0, 8);
    }
  }
  // en-client: compress cash lists (and any frame > 0x7FFF) as 0x81.
  // Equip/Ability/Pet are < 0x7FFF raw but ~100KB burst still overflows the client's
  // recv window; compressed lists are ~0.3–4KB each and apply reliably.
  const isCashList = op >= 0x11f && op <= 0x127;
  if ((isCashList || out.length > FIELD_RAW_MAX) && p.magic === 0x0037 && p.fieldKeys) {
    try {
      const wrapped = encodeFieldFrame(out, p.fieldKeys);
      logPkt("OUT", `field#${p.charId}/0x81`, wrapped);
      p.sock.write(wrapped);
      if (enterTrace.has(p.charId)) {
        const lines = enterTrace.get(p.charId)!;
        lines.push(`OUT 0x81 wrap op=0x${op.toString(16)} raw=${out.length} wire=${wrapped.length}`);
      }
      return;
    } catch (e) {
      console.warn(`[field] 0x81 wrap failed len=${out.length}:`, e);
    }
  }
  p.sock.write(out);
  logPkt("OUT", `field#${p.charId}`, out);
  if (enterTrace.has(p.charId)) {
    const lines = enterTrace.get(p.charId)!;
    lines.push(
      `OUT op=0x${op.toString(16)} len=${out.length} hex=${out.subarray(0, Math.min(out.length, 48)).toString("hex")}`,
    );
  }
}

/** Capture outbound packets around map enter for crash debugging */
const enterTrace = new Map<number, string[]>();

function beginEnterTrace(charId: number, tag: string): void {
  enterTrace.set(charId, [`=== ${tag} ${new Date().toISOString()} ===`]);
}

function endEnterTrace(charId: number): void {
  const lines = enterTrace.get(charId);
  enterTrace.delete(charId);
  if (!lines?.length) return;
  try {
    const logPath = path.join(process.cwd(), "enter_trace.log");
    fs.appendFileSync(logPath, lines.join("\n") + "\n\n", "utf8");
    console.log(`[field] enter-trace wrote ${lines.length} lines → enter_trace.log`);
  } catch (e) {
    console.warn("[field] enter-trace write failed", e);
  }
}

function clearMonCombat(p: Player): void {
  if (p.monCombatTimer) {
    clearTimeout(p.monCombatTimer);
    p.monCombatTimer = undefined;
  }
  p.monCombatReady = false;
}

function traceMonsterSend(p: Player, tag: string, buf: Buffer): void {
  send(p, buf);
  try {
    const op = buf.length >= 4 ? buf.readUInt16LE(2) : 0;
    const line = `[${tag}] OUT op=0x${op.toString(16)} len=${buf.length} count=${buf.length >= 16 && op === 0x42 ? buf.readUInt32LE(12) : "-"}`;
    fs.appendFileSync(path.join(process.cwd(), "enter_trace.log"), line + "\n", "utf8");
    console.log(`[field] ${line}`);
  } catch {
    /* */
  }
}

function sendMonAllNow(p: Player, map: number, region: number, tag: string): number {
  // York walk flags. Game4.exe patched at 0x686227: null-guard after anim
  // lookup (LJUMP_*/ATTACK_* missing sprite tables no longer AV).
  const pkt = buildMonAllCreate(map, region, false);
  const count = pkt.readUInt32LE(12);
  const walkTag = tag.includes("walk") ? tag : `${tag}-walk`;
  traceMonsterSend(p, walkTag, pkt);
  console.log(
    `[field] ${walkTag} map=${map}/${region} count=${count} state0=${pkt[16]} move0=${pkt[216]} spd0=${pkt.readFloatLE(1616)}`,
  );
  p.monCombatReady = true;
  return count;
}

/**
 * legacy parity (critical):
 * - 0xDB: builds MON_ALL into $PACKET_SEND but NEVER TCPSends it
 * - 0x1D (warp/enter-field): TCPSends MON_ALL immediately after ENTERPLAYER
 *
 * Delayed monster packets on 0xDB crash Game4 at whatever delay we pick.
 * Direct login: wait until the client is in-world (first move), then send MON_ALL.
 */
function scheduleEnterMonsters(
  p: Player,
  map: number,
  region: number,
  mode: "db" | "warp",
): number {
  clearMonCombat(p);
  const count = monstersOnMap(map, region).length;
  if (mode === "warp") {
    return sendMonAllNow(p, map, region, "MON_ALL-warp");
  }
  // 0xDB: legacy sends zero monster packets here.
  p.monCombatReady = count === 0;
  return count;
}

/** After direct login, spawn monsters once the client is walking (map load finished). */
function trySpawnMonstersAfterReady(p: Player): void {
  if (!p.fieldEntered || p.monCombatReady || p.pendingWarp) return;
  if (p.sock.destroyed) return;
  const count = monstersOnMap(p.map, p.region).length;
  if (count === 0) {
    p.monCombatReady = true;
    return;
  }
  resetMonstersOnMap(p.map, p.region);
  sendMonAllNow(p, p.map, p.region, "MON_ALL-after-ready");
}

function broadcastMonRegen(map: number, region: number, buf: Buffer): void {
  for (const pl of players.values()) {
    if (!pl.loggedIn || !pl.fieldEntered || !pl.monCombatReady) continue;
    if (pl.map !== map || pl.region !== region) continue;
    send(pl, buf);
  }
}

function ensureMonCombatReady(p: Player): void {
  if (p.monCombatReady) return;
  if (p.monCombatTimer) {
    clearTimeout(p.monCombatTimer);
    p.monCombatTimer = undefined;
  }
  sendCombatMonAll((pkt) => send(p, pkt), p.map, p.region, false);
  p.monCombatReady = true;
}

function mapHasPlayers(map: number, region: number, exceptCharId?: number): boolean {
  for (const pl of players.values()) {
    if (!pl.loggedIn || !pl.fieldEntered) continue;
    if (exceptCharId && pl.charId === exceptCharId) continue;
    if (pl.map === map && pl.region === region) return true;
  }
  return false;
}

/** When the last player leaves a map, freeze+reset mobs (no AI until next enter). */
function maybeHibernateMap(map: number, region: number, exceptCharId?: number): void {
  if (mapHasPlayers(map, region, exceptCharId)) return;
  hibernateMonstersOnMap(map, region);
}

function broadcastMap(map: number, region: number, buf: Buffer, except?: number): void {
  for (const p of players.values()) {
    // Skip clients still loading (after 0x18 bind, before 0xDB). Sending peer
    // moves/avatars early makes en-client error when a 2nd client joins an occupied map.
    if (!p.loggedIn || !p.fieldEntered) continue;
    if (p.map !== map || p.region !== region) continue;
    if (except !== undefined && p.charId === except) continue;
    send(p, buf);
  }
}

/** Peer-action UDP fan-out — en-client applies pet (0x10B+) on its local UDP socket, not TCP. */
let fieldUdp: dgram.Socket | null = null;
function broadcastMapUdp(map: number, region: number, buf: Buffer, except?: number): void {
  if (!fieldUdp) return;
  for (const p of players.values()) {
    if (!p.loggedIn || !p.fieldEntered || !p.udpPort) continue;
    if (p.map !== map || p.region !== region) continue;
    if (except !== undefined && p.charId === except) continue;
    try {
      fieldUdp.send(buf, p.udpPort, p.udpHost || "127.0.0.1");
    } catch {
      /* */
    }
  }
}

function broadcastAll(buf: Buffer): void {
  // Notices only — still skip clients mid map-load.
  for (const p of players.values()) {
    if (p.loggedIn && p.fieldEntered) send(p, buf);
  }
}

/** Default hello key material (en-client layout +0x2C / +0x30). */
const FIELD_HELLO_KEY1 = 0xa1085ba0;
const FIELD_HELLO_KEY2 = 0x80be7de5;
/** en-client 0x443168 / 0x44316d — permanent halves of the field stream cipher. */
const FIELD_CRYPTO_SEED_LO = 0xebd66b29;
const FIELD_CRYPTO_SEED_HI = 0x2103a92c;
/** en-client refuses field enter unless hello[+0x10] equals this build token. */
const EN_CLIENT_HELLO_TOKEN = 0x1e488bf5;

let nextHelloId = 200;

function makeFieldKeys(key1: number, key2: number): FieldKeys {
  return {
    key1: (FIELD_CRYPTO_SEED_LO ^ key1) >>> 0,
    key2: (FIELD_CRYPTO_SEED_HI ^ key2) >>> 0,
  };
}

function initPacket(
  id: number,
  magic = 0x0037,
  keys?: { key1: number; key2: number },
): Buffer {
  const b = Buffer.alloc(40, 0);
  writeHeader(b, 0x0014, 40, magic);
  b.writeUInt32LE(id, 12);
  const k1 = keys?.key1 ?? FIELD_HELLO_KEY1;
  const k2 = keys?.key2 ?? FIELD_HELLO_KEY2;
  if (magic === 0x0037) {
    // en-client: token@+0x10, udp@+0x14, prefix@+0x18, keys@+0x20/+0x24 (40B total)
    b.writeUInt32LE(EN_CLIENT_HELLO_TOKEN, 16);
    b.writeUInt16LE(config.udpPort & 0xffff, 20);
    b.writeUInt16LE(0, 22);
    Buffer.from("E2D315013ABB5D52", "hex").copy(b, 24);
    b.writeUInt32LE(k1 >>> 0, 0x20);
    b.writeUInt32LE(k2 >>> 0, 0x24);
  } else {
    // Game4 / legacy: seed@+0x10, udp@+0x14, prefix@+0x18, keys@+0x20/+0x24
    b.writeUInt32LE(0x0c848761, 16);
    b.writeUInt16LE(config.udpPort & 0xffff, 20);
    b.writeUInt16LE(0, 22);
    Buffer.from("E2D315013ABB5D52", "hex").copy(b, 24);
    b.writeUInt32LE(k1 >>> 0, 0x20);
    b.writeUInt32LE(k2 >>> 0, 0x24);
  }
  return b;
}

function writeChangeMapPacket(p: Player, map: number, region: number, x: number, y: number): Buffer {
  // Both Game4 and en-client read map/region on 0x86 as u16 @+16/+18 (unlike mapInfo 0x1c).
  // Byte-packing here made map=1,region=1 → client map 0x0101 (257) and crash on missing t257_*.prj.
  const chg = Buffer.alloc(46, 0);
  writeHeader(chg, 0x0086, 46);
  chg.writeUInt32LE(1, 12);
  chg.writeUInt16LE(map & 0xffff, 16);
  chg.writeUInt16LE(region & 0xffff, 18);
  chg.writeUInt16LE(x & 0xffff, 20);
  chg.writeUInt16LE(y & 0xffff, 22);
  chg.writeUInt16LE(map & 0xffff, 24);
  chg.writeUInt16LE(region & 0xffff, 26);
  chg.writeUInt16LE(x & 0xffff, 28);
  chg.writeUInt16LE(y & 0xffff, 30);
  return chg;
}

function mapInfo(p: Player): Buffer {
  const b = Buffer.alloc(42, 0);
  writeHeader(b, 0x001c, 42);
  // Game4: map/region as u16 @+12/+14.
  // en-client (0x37): map/region as adjacent u8 @+12/+13 — u16 packing makes
  // map=1,region=1 become bytes 01 00 01 00 → client loads t1_s0.prj (missing).
  if (p.magic === 0x0037) {
    b.writeUInt8(p.map & 0xff, 12);
    b.writeUInt8(p.region & 0xff, 13);
    b.writeUInt16LE(p.x & 0xffff, 14);
    b.writeUInt16LE(p.y & 0xffff, 16);
    b.writeUInt8(p.map & 0xff, 18);
    b.writeUInt8(p.region & 0xff, 19);
    b.writeUInt16LE(p.x & 0xffff, 20);
    b.writeUInt16LE(p.y & 0xffff, 22);
  } else {
    b.writeUInt16LE(p.map, 12);
    b.writeUInt16LE(p.region, 14);
    b.writeUInt16LE(p.x, 16);
    b.writeUInt16LE(p.y, 18);
    b.writeUInt16LE(p.map, 20);
    b.writeUInt16LE(p.region, 22);
    b.writeUInt16LE(p.x, 24);
    b.writeUInt16LE(p.y, 26);
  }
  return b;
}

async function loadCharRow(charId: number): Promise<RowDataPacket | null> {
  const rows = await query<RowDataPacket[]>("SELECT * FROM characters WHERE ID = ?", [charId]);
  return rows[0] ?? null;
}

function u8(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback & 0xff;
  if (v < 0) return 0xff; // legacy: job2/job3 -1 → 0xFF
  return v & 0xff;
}

function u16(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback & 0xffff;
  return v & 0xffff;
}

function u32(n: unknown, fallback = 0): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback >>> 0;
  return v >>> 0;
}

async function charAll(charId: number): Promise<Buffer> {
  const c = await loadCharRow(charId);
  const b = Buffer.alloc(132, 0);
  writeHeader(b, 0x0050, 132);
  if (!c) return b;
  writeCString(b, 12, String(c.name ?? ""), 40);
  b.writeUInt8(u8(c.sex, 0), 52);
  b.writeUInt8(u8(c.level, 1), 53);
  b.writeUInt8(u8(c.job, 0), 54);
  b.writeUInt8(u8(c.job2, 255), 55);
  // Guild: wire 0=Order / 1=Chaos (DB job3 is 1/2)
  b.writeUInt8(job3ToWireGuild(Number(c.job3 ?? -1)), 56);
  b.writeUInt16LE(u16(c.cmhp, 50), 58);
  b.writeUInt16LE(u16(c.chp, 50), 60);
  b.writeUInt16LE(u16(c.cmmp, 50), 62);
  b.writeUInt16LE(u16(c.cmp, 50), 64);
  b.writeUInt32LE(u32(c.mexp, 30), 68);
  b.writeUInt32LE(u32(c.exp, 0), 76);
  b.writeUInt16LE(u16(c.honor, 0), 84);
  b.writeUInt16LE(u16(c.maxsoul, 20), 86);
  b.writeUInt16LE(u16(c.soul, 0), 88);
  b.writeUInt16LE(771, 90);
  b.writeUInt16LE(u16(c.str, 3), 92);
  b.writeUInt16LE(u16(c.dex, 3), 94);
  b.writeUInt16LE(u16(c.vit, 3), 96);
  b.writeUInt16LE(u16(c.intel, 3), 98);
  b.writeUInt16LE(u16(c.maxdamphy, 10), 100);
  b.writeUInt16LE(u16(c.mindamphy, 10), 102);
  b.writeUInt16LE(u16(c.maxdamw, 0), 104);
  b.writeUInt16LE(u16(c.mindamw, 0), 106);
  b.writeUInt16LE(u16(c.def, 0), 108);
  b.writeUInt16LE(258, 110);
  b.writeUInt16LE(u16(c.st_point, 0), 114);
  b.writeUInt16LE(u16(c.sk_point, 0), 116);
  b.writeUInt16LE(u16(c.p_str, 0), 118);
  b.writeUInt16LE(u16(c.p_dex, 0), 120);
  b.writeUInt16LE(u16(c.p_vit, 0), 122);
  b.writeUInt16LE(u16(c.p_int, 0), 124);
  b.writeUInt16LE(u16(c.p_damphy, 0), 126);
  b.writeUInt16LE(u16(c.p_damw, 0), 128);
  b.writeUInt16LE(u16(c.p_def, 0), 130);
  return b;
}

async function getEquipMap(charId: number): Promise<Record<number, number>> {
  const rows = await query<RowDataPacket[]>("SELECT type, pos2 FROM equip WHERE charid = ? AND pos1 = 0", [charId]);
  const m: Record<number, number> = {};
  for (const r of rows) m[Number(r.pos2)] = Number(r.type);
  return m;
}

async function enterPlayer(
  charId: number,
  opts?: { x?: number; y?: number; petUseSlot?: number; map?: number; region?: number },
): Promise<Buffer> {
  const c = await loadCharRow(charId);
  const b = Buffer.alloc(274, 0);
  writeHeader(b, 0x001e, 274);
  if (!c) return b;
  const eq = await getEquipMap(charId);
  const x = opts?.x ?? Number(c.charX ?? 0);
  const y = opts?.y ?? Number(c.charY ?? 0);
  // Prefer live field map — cash UI sync (0x45bc20) only runs when map==77 in this packet.
  const map = opts?.map ?? Number(c.map ?? 1);
  const region = opts?.region ?? Number(c.region ?? 1);
  b.writeUInt32LE(charId, 12);
  writeCString(b, 16, String(c.name ?? ""), 40);
  b.writeUInt16LE(u16(map, 1), 56);
  b.writeUInt16LE(u16(region, 1), 58);
  b.writeUInt16LE(u16(x, 0), 60);
  b.writeUInt16LE(u16(y, 0), 62);
  b.writeUInt8(u8(c.sex, 0), 64);
  b.writeUInt8(u8(c.level, 1), 65);
  b.writeUInt8(u8(c.job, 0), 66);
  b.writeUInt8(u8(c.job2, 255), 67);
  // Guild: wire 0=Order / 1=Chaos (DB job3 is 1/2)
  b.writeUInt8(job3ToWireGuild(Number(c.job3 ?? -1)), 68);
  b.writeUInt32LE(0, 72);
  b.writeUInt32LE(eq[7] ?? 0, 76); // hair
  b.writeUInt32LE(eq[9] ?? 0, 80);
  b.writeUInt32LE(eq[12] ?? 0, 84);
  b.writeUInt32LE(eq[6] ?? 0, 88);
  b.writeUInt32LE(eq[8] ?? 0, 92);
  b.writeUInt32LE(eq[1] ?? 0, 96);
  b.writeUInt32LE(eq[11] ?? 0, 100);
  b.writeUInt32LE(eq[0] ?? 0, 104);
  b.writeUInt32LE(eq[4] ?? 0, 108);
  const petRows = await query<RowDataPacket[]>(
    "SELECT * FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1",
    [charId],
  );
  let weaponGlow = 0;
  const wrows = await query<RowDataPacket[]>(
    "SELECT p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1 FROM equip WHERE charid=? AND pos1=0 AND pos2=0 LIMIT 1",
    [charId],
  );
  if (wrows.length) {
    const w = [20, 15, 12, 9, 7, 5, 4, 3, 2, 1];
    const lv = [
      wrows[0]!.p_10, wrows[0]!.p_9, wrows[0]!.p_8, wrows[0]!.p_7, wrows[0]!.p_6,
      wrows[0]!.p_5, wrows[0]!.p_4, wrows[0]!.p_3, wrows[0]!.p_2, wrows[0]!.p_1,
    ].map((x) => Number(x ?? 0));
    weaponGlow = lv.reduce((a, v, i) => a + v * w[i]!, 0);
  }
  if (petRows.length) {
    const pr = petRows[0]!;
    b.writeUInt32LE(Number(pr.itemId), 112);
    b.writeUInt32LE(eq[15] ?? 0, 116); // toy
    writeCString(b, 120, String(pr.name || "Pet"), 20);
    b.writeUInt32LE(Number(pr.level ?? 1), 140);
    b.writeUInt32LE(Number(pr.hp ?? 100), 144);
    b.writeUInt32LE(Number(pr.mp ?? 100), 148);
    b.writeUInt32LE(Number(pr.exp ?? 0), 152);
    b.writeUInt32LE(Number(pr.decorateId ?? 0), 156);
    let use = opts?.petUseSlot ?? 0;
    if (use === 0xff) use = 0;
    b.writeUInt32LE(use, 160);
  } else {
    b.writeUInt32LE(0, 112);
    b.writeUInt32LE(eq[15] ?? 0, 116);
  }
  b.writeUInt16LE(0, 200);
  b.writeUInt16LE(weaponGlow & 0xffff, 202);
  b.writeUInt16LE(0, 204);
  b.writeUInt8(127, 206);
  b.writeUInt8(0, 207);
  b.writeUInt8(0, 208);
  b.writeUInt8(1, 209);
  b.writeUInt8(127, 210);
  b.writeUInt8(0, 211);
  b.writeUInt8(0, 212);
  b.writeUInt8(1, 213);
  b.writeUInt16LE(config.udpPort, 214);
  return b;
}

function leavePacket(charId: number): Buffer {
  const b = Buffer.alloc(38, 0);
  writeHeader(b, 0x001f, 38);
  b.writeUInt32LE(charId, 12);
  return b;
}

function notice(msg: string, type = 3): Buffer {
  const b = Buffer.alloc(80, 0);
  writeHeader(b, 0x0012, 80);
  b.writeUInt8(type, 12);
  writeCString(b, 13, msg.slice(0, 59), 60);
  return b;
}

async function sendBags(p: Player): Promise<void> {
  for (const bag of await buildAllBags(p.charId, p.magic || 0x0037)) send(p, bag);
}

async function sendCashMall(p: Player): Promise<void> {
  const magic = p.magic || 0x0037;
  send(p, await buildEquip(p.charId));
  send(p, await buildEquip1(p.charId, magic));
  send(p, await buildEquip2(p.charId, magic));
  send(p, await buildSetAvatar(p.charId));
  const slots = cashSlotsForMagic(p.magic || 0x0037);
  const lists = buildCashLists(slots);
  for (const c of lists) send(p, c);
  console.log(
    `[cashshop] sent lists char=${p.charId} slotsPer=${slots} magic=0x${(p.magic || 0).toString(16)} sizes=${lists.map((b) => b.length).join(",")}`,
  );
  for (const b of await buildBalance(p.accountId)) send(p, b);
  await deliverCashGifts(p.charId, p.name);
  send(p, await buildWarehouse(p.charId));
}

/** Catalog only — must be sent BEFORE ENTERPLAYER on map 77 so UI sync sees filled lists. */
async function sendCashCatalog(p: Player): Promise<void> {
  const magic = p.magic || 0x0037;
  send(p, await buildEquip(p.charId));
  send(p, await buildEquip1(p.charId, magic));
  send(p, await buildEquip2(p.charId, magic));
  if (p.magic === 0x0037) send(p, await buildSetAvatar(p.charId));
  const slots = cashSlotsForMagic(p.magic || 0x0037);
  const lists = buildCashLists(slots);
  for (const c of lists) send(p, c);
  console.log(
    `[cashshop] catalog char=${p.charId} slotsPer=${slots} magic=0x${(p.magic || 0).toString(16)} sizes=${lists.map((b) => b.length).join(",")}`,
  );
}

async function sendCashBalanceAndWarehouse(p: Player): Promise<void> {
  for (const b of await buildBalance(p.accountId)) send(p, b);
  await deliverCashGifts(p.charId, p.name);
  send(p, await buildWarehouse(p.charId));
}

function isCashMall(map: number, region: number): boolean {
  return (map === 77 && region === 1) || (map === 1 && region === 77);
}

/** EN chat types at pkt+0x10: 0=map (bubble), 1=guild (cyan), 3=whisper. */
const CHAT_TYPE_MAP = 0;
const CHAT_TYPE_WHISPER = 3;

function chatPacket(
  charId: number,
  name: string,
  msg: string,
  type = CHAT_TYPE_MAP,
  targetName = "",
  opts?: { suppressBubble?: boolean },
): Buffer {
  const b = Buffer.alloc(120, 0);
  writeHeader(b, 0x0017, 120);
  // EN draws overhead for type 0/3 only when it can bind pkt+0xC to a field avatar.
  // Whispers keep type 3 (correct color) but use charId 0 so the bubble path is skipped.
  b.writeUInt32LE(opts?.suppressBubble ? 0 : charId >>> 0, 12);
  b.writeUInt32LE(type | 0, 16);
  const line =
    type === CHAT_TYPE_WHISPER
      ? `${name} >> ${msg}`.slice(0, 80)
      : `${name}: ${msg}`.slice(0, 80);
  writeCString(b, 20, line, 80);
  if (targetName) writeCString(b, 0x64, targetName, 20);
  return b;
}

function findPlayerByName(name: string): Player | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  let exact: Player | undefined;
  const prefixHits: Player[] = [];
  for (const o of players.values()) {
    if (!o.loggedIn) continue;
    const n = o.name.toLowerCase();
    if (n === key) {
      exact = o;
      break;
    }
    // EN whisper target field often truncates the last character of long names.
    // Only allow real-name-starts-with-key (not the reverse — that false-matches
    // e.g. "asdasdddddd" against shorter "asdasddas").
    if (key.length >= 4 && n.length > key.length && n.startsWith(key)) {
      prefixHits.push(o);
    }
  }
  if (exact) return exact;
  return prefixHits.length === 1 ? prefixHits[0] : undefined;
}

function readWhisperTarget(pkt: Buffer): string {
  if (pkt.length >= 0x78) {
    const at64 = readCString(pkt, 0x64, 20).trim();
    if (at64) return at64;
    const at68 = readCString(pkt, 0x68, 16).trim();
    if (at68) return at68;
  }
  return "";
}

function moneyPacket(money: number, delta: number): Buffer {
  const b = Buffer.alloc(28, 0);
  writeHeader(b, 0x006b, 28);
  b.writeInt32LE(money, 12);
  b.writeInt32LE(delta, 20);
  return b;
}

function hpMpPacket(p: Player): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x0051, 20);
  b.writeUInt16LE(p.hp & 0xffff, 12);
  b.writeUInt16LE(p.mp & 0xffff, 14);
  // legacy fury fields — client divides by max; 0/0 crashes Game4 on death UI
  const maxSoul = Math.max(1, p.maxSoul | 0);
  b.writeUInt16LE((p.soul | 0) & 0xffff, 16);
  b.writeUInt16LE(maxSoul & 0xffff, 18);
  return b;
}

function peerIpBytes(p: Player): [number, number, number, number] {
  const host = (p.sock.remoteAddress || "127.0.0.1").replace(/^::ffff:/, "");
  const parts = host.split(".").map((x) => Number(x));
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
    return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  }
  return [127, 0, 0, 1];
}

function partySnap(p: Player): PartyMemberSnap {
  return {
    charId: p.charId,
    name: p.name,
    level: p.level,
    maxHp: p.maxHp,
    hp: p.hp,
    maxMp: p.maxMp,
    mp: p.mp,
    ip: peerIpBytes(p),
  };
}

function sendPartyUpdateTo(memberIds: number[]): void {
  const snaps: PartyMemberSnap[] = [];
  for (const id of memberIds) {
    const pl = players.get(id);
    if (pl?.loggedIn) snaps.push(partySnap(pl));
  }
  const pkt = buildPartyUpdate(snaps);
  for (const id of memberIds) {
    const pl = players.get(id);
    if (pl?.loggedIn) send(pl, pkt);
  }
}

function broadcastPartyHp(p: Player): void {
  const list = getParty(p.charId);
  if (!list || list.length < 2) return;
  const pkt = buildPartyHpUpdate(p.charId, p.maxHp, p.hp, p.maxMp, p.mp);
  for (const id of list) {
    if (id === p.charId) continue;
    const pl = players.get(id);
    if (pl?.loggedIn) send(pl, pkt);
  }
}

function sendVital(p: Player): void {
  send(p, hpMpPacket(p));
  broadcastPartyHp(p);
}

async function cancelTradeFor(p: Player, notifyPartner: boolean): Promise<void> {
  const trade = getTrade(p.charId);
  if (!trade) return;
  const partnerId = trade.partnerId;
  const partner = players.get(partnerId);
  const partnerTrade = getTrade(partnerId);

  const restored = await restoreTradeOffer(p.charId, trade);
  if (restored.money > 0) {
    p.money += restored.money;
    await execute("UPDATE characters SET money=? WHERE ID=?", [p.money, p.charId]);
    send(p, moneyPacket(p.money, restored.money));
  }
  for (const pkt of await refreshBags(p.charId, restored.bags, p.magic || 0x0037)) send(p, pkt);

  if (partnerTrade && partner) {
    const r2 = await restoreTradeOffer(partnerId, partnerTrade);
    if (r2.money > 0) {
      partner.money += r2.money;
      await execute("UPDATE characters SET money=? WHERE ID=?", [partner.money, partnerId]);
      send(partner, moneyPacket(partner.money, r2.money));
    }
    for (const pkt of await refreshBags(partnerId, r2.bags, partner.magic || 0x0037)) send(partner, pkt);
    if (notifyPartner) send(partner, buildTradeCancel());
  }
  clearTrade(p.charId);
  clearTrade(partnerId);
}

function leaveParty(p: Player): void {
  const remaining = removeFromParty(p.charId);
  send(p, buildPartyUpdate([]));
  send(p, buildPartyDismiss());
  if (remaining.length >= 2) sendPartyUpdateTo(remaining);
  else {
    for (const id of remaining) {
      const pl = players.get(id);
      if (pl?.loggedIn) {
        clearParty(id);
        send(pl, buildPartyUpdate([]));
        send(pl, buildPartyDismiss());
      }
    }
  }
}

async function handlePartyPacket(p: Player, op: number, pkt: Buffer): Promise<void> {
  if (op === 0x009b) {
    // Party invite — target charId @+12
    const targetId = pkt.length >= 16 ? pkt.readInt32LE(12) : 0;
    const target = players.get(targetId);
    if (!target?.loggedIn || target.map !== p.map || target.region !== p.region) {
      console.log(`[field] party-invite fail char=${p.charId} target=${targetId} (offline/other map)`);
      return;
    }
    if (getParty(targetId)?.length) {
      console.log(`[field] party-invite fail char=${p.charId} target=${targetId} already in party`);
      return;
    }
    const mine = getParty(p.charId);
    if (mine && mine.length >= 6) return;
    if (mine && mine[0] !== p.charId) {
      console.log(`[field] party-invite fail char=${p.charId} not leader`);
      return;
    }
    const members = mine ? [...mine, targetId] : [p.charId, targetId];
    setSharedParty(members);
    send(target, buildPartyInvite(p.charId));
    console.log(`[field] party-invite char=${p.charId} -> ${targetId}`);
    return;
  }

  if (op === 0x009c) {
    const response = pkt.length >= 16 ? pkt.readInt32LE(12) : 0;
    const list = getParty(p.charId);
    if (!list?.length) return;
    const leaderId = list[0]!;
    const leader = players.get(leaderId);

    if (response === 0) {
      // Decline — remove self; notify leader
      removeFromParty(p.charId);
      if (leader?.loggedIn && leaderId !== p.charId) {
        send(leader, buildPartyInviteResponses(0));
        const left = getParty(leaderId);
        if (left && left.length >= 2) sendPartyUpdateTo(left);
        else if (left) {
          clearParty(leaderId);
          send(leader, buildPartyUpdate([]));
        }
      }
      clearParty(p.charId);
      console.log(`[field] party-decline char=${p.charId}`);
      return;
    }

    // Accept
    send(p, buildPartyInviteResponses(1));
    sendPartyUpdateTo(list);
    console.log(`[field] party-accept char=${p.charId} members=${list.join(",")}`);
    return;
  }

  if (op === 0x009f || op === 0x00a0) {
    leaveParty(p);
    console.log(`[field] party-leave char=${p.charId}`);
  }
}

async function handleTradePacket(p: Player, op: number, pkt: Buffer): Promise<void> {
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
      await execute("UPDATE characters SET money=? WHERE ID=?", [p.money, p.charId]);
      send(p, moneyPacket(p.money, result.moneyA));
    }
    if (result.moneyB > 0) {
      partner.money += result.moneyB;
      await execute("UPDATE characters SET money=? WHERE ID=?", [partner.money, partnerId]);
      send(partner, moneyPacket(partner.money, result.moneyB));
    }
    for (const pktOut of await refreshBags(p.charId, result.bagsA, p.magic || 0x0037)) send(p, pktOut);
    for (const pktOut of await refreshBags(partnerId, result.bagsB, partner.magic || 0x0037)) send(partner, pktOut);
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
      await execute("UPDATE characters SET money=? WHERE ID=?", [p.money, p.charId]);
      send(p, moneyPacket(p.money, res.delta));
    } else {
      const res = await tradePutItem(p.charId, sourceType, sourceSlot, quantity);
      if (!res.ok) {
        console.log(`[field] trade-put fail char=${p.charId}: ${res.reason}`);
        return;
      }
      for (const pktOut of await refreshBags(p.charId, [res.bag], p.magic || 0x0037)) send(p, pktOut);
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

function hidePacket(charId: number, active: number): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x0061, 16);
  b.writeUInt16LE(charId & 0xffff, 12);
  b.writeUInt16LE(active & 0xffff, 14);
  return b;
}

function clearSkillTimer(p: Player, skillId: number): void {
  const t = p.skillTimers.get(skillId);
  if (t) {
    clearInterval(t);
    clearTimeout(t);
    p.skillTimers.delete(skillId);
  }
}

function clearAllSkillEffects(p: Player): void {
  for (const id of [...p.skillTimers.keys()]) clearSkillTimer(p, id);
  p.skillMods.clear();
}

async function persistHpMp(p: Player): Promise<void> {
  await execute("UPDATE characters SET chp=?, cmp=? WHERE ID=?", [p.hp, p.mp, p.charId]);
  sendVital(p);
}

/**
 * USE_SKILL_REQ 0x76 — C# SkillHandler.UseSkill_Req.
 * Beginner: 1=basic (MP), 2=noop, 3=Meditate (HP/MP tick), 4=MP spend.
 * Also ports the few 1st-job effect skills from the Thai reference.
 */
async function handleUseSkill(p: Player, pkt: Buffer): Promise<void> {
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
      // Heal +8 HP / +2 MP × level (Thai hardcoded 8/2 with unused level).
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

function playerDeadAck(p: Player): Buffer {
  // opcode 0x48 len 32 — header 0501480020006D01
  const b = Buffer.alloc(32, 0);
  writeHeader(b, 0x0048, 32);
  b.writeUInt32LE(p.charId, 12);
  b.writeUInt16LE(p.map, 16);
  b.writeUInt16LE(p.region, 18);
  b.writeUInt16LE(p.x, 20);
  b.writeUInt16LE(p.y, 22);
  b.writeUInt16LE(p.map, 24);
  b.writeUInt16LE(p.region, 26);
  b.writeUInt16LE(p.x, 28);
  b.writeUInt16LE(p.y, 30);
  return b;
}

function deadTownMap(map: number): number {
  switch (map) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 22:
    case 23:
      return 1;
    case 7:
    case 8:
    case 9:
      return 16;
    case 10:
    case 11:
    case 20:
      return 10;
    case 12:
    case 13:
      return 12;
    case 14:
    case 15:
    case 17:
    case 18:
    case 19:
    case 21:
      return 15;
    case 16:
      return 16;
    case 24:
    case 25:
    case 26:
    case 31:
    case 32:
    case 33:
      return 25;
    case 27:
    case 28:
      return 27;
    default:
      return 1;
  }
}

/** Safe town spawn so death-respawn doesn't load invalid field coords */
function deadTownSpawn(map: number): { x: number; y: number } {
  switch (map) {
    case 1:
      return { x: 125, y: 1010 };
    case 10:
      return { x: 200, y: 800 };
    case 12:
      return { x: 200, y: 800 };
    case 15:
      return { x: 200, y: 800 };
    case 16:
      return { x: 200, y: 800 };
    case 25:
      return { x: 200, y: 800 };
    case 27:
      return { x: 200, y: 800 };
    default:
      return { x: 125, y: 1010 };
  }
}

/**
 * Game4 crashes when ENTERPLAYER / CHANGEMAP lands at 0,0 (or void).
 * Client portals sometimes auth-warp with X=Y=0 — never accept that.
 */
function defaultFieldSpawn(map: number, region: number): { x: number; y: number } {
  // Known field entrances (left/near ground). Fall back: first mob spawn or mid-map.
  if (map === 2 && region === 6) return { x: 600, y: 1000 };
  if (map === 1 && region === 1) return { x: 125, y: 1010 };
  if (map === 16 && region === 1) return { x: 200, y: 1100 };
  if (map === 7 && region === 3) return { x: 500, y: 700 };
  const mobs = monstersOnMap(map, region);
  if (mobs.length) {
    const m = mobs[0]!;
    return { x: Math.max(80, m.spawnX - 120), y: Math.max(64, m.spawnY) };
  }
  return deadTownSpawn(deadTownMap(map));
}

function sanitizePlayerPos(
  map: number,
  region: number,
  x: number,
  y: number,
): { x: number; y: number; fixed: boolean } {
  const bad =
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x <= 0 ||
    y <= 0 ||
    x > 20000 ||
    y > 20000;
  if (!bad) return { x, y, fixed: false };
  const s = defaultFieldSpawn(map, region);
  return { x: s.x, y: s.y, fixed: true };
}

/** True when data/client has `data/Project/t{map}_s{region}.prj` (loadable field). */
function mapExists(map: number, region: number): boolean {
  if (!Number.isFinite(map) || !Number.isFinite(region)) return false;
  if (map < 0 || region < 0) return false;
  const name = `t${Math.floor(map)}_s${Math.floor(region)}.prj`;
  const dirs = [
    path.join(config.dataDir, "client", "data", "Project"),
    path.join(config.rootDir, "data", "client", "data", "Project"),
    path.join(config.dataDir, "Project"),
  ];
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}

async function hurtPlayer(p: Player, dmg: number, reason = "hit"): Promise<void> {
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
    // Sanitize death coords — 0,0 / tiny values crash Game4 death UI
    if (p.x < 10 || p.y < 10 || p.x > 20000 || p.y > 20000) {
      const safe = deadTownSpawn(deadTownMap(p.map));
      p.x = safe.x;
      p.y = safe.y;
    }
    await execute("UPDATE characters SET chp=?, cmp=?, charX=?, charY=? WHERE ID=?", [
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
    await execute("UPDATE characters SET chp=? WHERE ID=?", [p.hp, p.charId]);
    sendVital(p);
  }
}

function tickMonsterTouch(): void {
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

async function buildStatUpAck(charId: number): Promise<Buffer> {
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

function isEffectSpendItem(itemId: number): boolean {
  if (itemId === 8890031 || itemId === 8890037) return true;
  if (itemId === 8890011 || itemId === 8890021) return true;
  if (itemId >= 8843021 && itemId <= 8843025) return true;
  return false;
}

/** Apply HP/SP recover from a spent potion/food; persists + syncs 0x51. */
async function tryApplySpendRecover(p: Player, itemId: number): Promise<void> {
  const effect = spendRecoverEffect(itemId);
  if (!effect) return;
  if (!p.alive) return;
  const next = applySpendRecover(p.hp, p.mp, p.maxHp, p.maxMp, effect);
  if (!next.changed) return;
  p.hp = next.hp;
  p.mp = next.mp;
  await execute("UPDATE characters SET chp=?, cmp=? WHERE ID=?", [p.hp, p.mp, p.charId]);
  sendVital(p);
}

/** Gift/Treasure/Christmas boxes + Lucky Spring / Golden Xmas sox. Returns true if handled. */
async function tryHandleSpecialSpend(p: Player, itemId: number): Promise<boolean> {
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
    bag = await addPetToBag(p.charId, rolled.itemId, "Pet", 0, p.magic || 0x0037);
  } else {
    bag = await addItemToInventory(p.charId, rolled.itemId, rolled.qty, 0, -1, p.magic || 0x0037);
  }
  if (bag < 0) {
    send(p, notice(`${rolled.label}: inventory full — reward lost`, 3));
    console.log(`[spend] gacha FULL char=${p.charId} box=${itemId} reward=${rolled.itemId}`);
    return true;
  }
  for (const out of await refreshBagPackets(p.charId, bag, p.magic || 0x0037)) send(p, out);
  send(p, notice(`${rolled.label}: obtained item ${rolled.itemId} x${rolled.qty}`, 3));
  console.log(
    `[spend] gacha char=${p.charId} box=${itemId} -> ${rolled.itemId}x${rolled.qty} (${rolled.label})`,
  );
  return true;
}

function useSpendStartPkt(
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

/** S2C INVEN_USESPEND_SHOUT_ACK (0xFB) — en-client template len 0x124. */
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
async function handleUseSpendShout(p: Player, pkt: Buffer, op: number): Promise<void> {
  const expectId = op === 0x015b ? 8842002 : 8842001;
  const slot = pkt.length >= 13 ? pkt.readUInt8(12) : 0xff;
  const message = pkt.length > 13 ? readCString(pkt, 13, Math.min(256, pkt.length - 13)).trim() : "";
  if (slot > 63 || !message || message.length > 255) {
    console.log(`[field] shout reject char=${p.charId} op=0x${op.toString(16)} slot=${slot} msgLen=${message.length}`);
    return;
  }
  const rows = await query<RowDataPacket[]>(
    "SELECT itemid, amount FROM spend WHERE charid=? AND pos1=3 AND pos2=?",
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
  for (const out of await refreshBagPackets(p.charId, 3, p.magic || 0x0037)) send(p, out);
  console.log(
    `[field] shout ok char=${p.charId} name=${p.name} op=0x${op.toString(16)} item=${itemId} msg="${message.slice(0, 40)}"`,
  );
}

function lvExpPacket(level: number, exp: number): Buffer {
  const b = Buffer.alloc(54, 0);
  writeHeader(b, 0x005b, 54);
  b.writeUInt32LE(level, 12);
  b.writeUInt32LE(exp, 16);
  return b;
}

function levelUpPacket(charId: number): Buffer {
  const b = Buffer.alloc(42, 0);
  writeHeader(b, 0x005d, 42);
  b.writeUInt32LE(charId, 12);
  return b;
}

/**
 * Grant kill EXP to one player (bar + level-ups + DB).
 * Returns true if the player leveled.
 *
 * Official TW Ghost Online FAQ (巴哈姆特精華 FAQ):
 *   Q 組隊的經驗值？
 *   A 通常都是均分或個人，不過搞鬼是不均分但是會增加？％，有利無害。
 *   P 現在在不同區域不得分享經驗值
 * → Same map/region share; NOT equal-split; each gets full kill EXP
 *   (bonus % was never published — FAQ literally wrote "？％").
 * FatPudding (KGO): "Bonus Share — full EXP … (and a little extra)".
 * C#/legacy/GOR never implemented share (TODO / killer-only).
 */
async function grantMonsterExp(p: Player, amount: number): Promise<boolean> {
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
      "UPDATE characters SET st_point=st_point+5, sk_point=sk_point+2 WHERE ID=?",
      [p.charId],
    );
    leveled = true;
    send(p, levelUpPacket(p.charId));
    broadcastMap(p.map, p.region, levelUpPacket(p.charId), p.charId);
  }
  await execute("UPDATE characters SET exp=?, level=?, mexp=? WHERE ID=?", [
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
function partyShareRecipients(killer: Player): Player[] {
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

async function resolveCharId(
  pkt: Buffer,
): Promise<{ accountId: number; charId: number; name: string } | null> {
  // Game4: INET at +12, slot @268. en-client field login (len 0x554): INET at +16, slot @280.
  const raw12 = readCString(pkt, 12, 240);
  const raw16 = readCString(pkt, 16, 240);
  const raw17 = readCString(pkt, 17, 240);
  const candidates = [raw12, raw16, raw17].filter(Boolean);

  let username = "";
  let password = "";
  let key: number | null = null;
  let raw = "";
  for (const s of candidates) {
    const full = s.split(" ");
    if (full[0] === "INET" && full.length > 4) {
      username = full[2] ?? "";
      password = full[4] ?? "";
      key = /^\d+$/.test(full[1] ?? "") ? Number(full[1]) : null;
      raw = s;
      break;
    }
    const parts = s.split(" ");
    if (parts.length > 3 && /^\d+$/.test(parts[0] ?? "")) {
      key = Number(parts[0]);
      username = parts[1] ?? "";
      password = parts[3] ?? "";
      raw = s;
      break;
    }
  }

  // en-client field login (0x65dfaa): writes selected index to [esp+0xa60] AFTER three
  // pushes for sprintf — effective packet offset is +0x10C (268), same as Game4/legacy.
  // (Earlier +280 guess ignored the stack adjustment; +280 stays 0 from the template clear.)
  // Packet template sets +0x10C = 0xFF before overwrite; 0xFF means “no slot”.
  let charSlot = 0;
  if (pkt.length > 268) {
    const rawSlot = pkt.readUInt8(268);
    charSlot = rawSlot === 0xff ? 0 : rawSlot;
  }

  console.log(`[field] auth user=${username} slot=${charSlot} pktLen=${pkt.length}`);

  if (!username) {
    console.log("[field] auth fail: no username parsed");
    return null;
  }

  const u = await query<RowDataPacket[]>("SELECT accountid, password, gm FROM users WHERE username = ?", [
    username,
  ]);
  if (!u.length) {
    console.log("[field] auth fail: unknown user");
    return null;
  }
  const dbPass = String(u[0]!.password);
  const plain = key != null ? decodePassword(password, key) : null;
  const ok =
    dbPass === password ||
    (key != null && encodePassword(dbPass, key) === password) ||
    (plain != null && dbPass === plain) ||
    (plain != null && dbPass.toLowerCase() === plain.toLowerCase());
  if (!ok) {
    console.log(`[field] auth fail: bad credentials for user=${username}`);
    return null;
  }
  const accountId = Number(u[0]!.accountid);
  const chars = await query<RowDataPacket[]>(
    "SELECT ID, name FROM characters WHERE userid = ? ORDER BY ID",
    [accountId],
  );
  if (charSlot >= chars.length) {
    console.log(`[field] auth fail: slot ${charSlot} >= ${chars.length} chars`);
    return null;
  }
  return {
    accountId,
    charId: Number(chars[charSlot]!.ID),
    name: String(chars[charSlot]!.name),
  };
}

async function handleGm(p: Player, pkt: Buffer): Promise<void> {
  const cmd = readCString(pkt, 12, 60).trim();
  await runGmCommand(p, cmd);
}

/** Shared GM/chat-command runner. En-client often sends // via CHAT 0x17, not COMMAND 0x10. */
async function runGmCommand(p: Player, cmdRaw: string): Promise<void> {
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
    await execute("UPDATE characters SET map=?, region=?, charX=?, charY=? WHERE ID=?", [
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
    // Re-push ENTERPLAYER so EN client Class/Title strings rebind from job/job2/job3.
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
      await execute("UPDATE characters SET chp=?, cmhp=? WHERE ID=?", [v, v, p.charId]);
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
      await execute("UPDATE characters SET cmp=?, cmmp=? WHERE ID=?", [v, v, p.charId]);
      sendVital(p);
      send(p, await charAll(p.charId));
    } else {
      p.mp = p.maxMp;
      sendVital(p);
    }
  } else if (c0 === "//money") {
    const amt = Number(parts[1] ?? 10000);
    p.money += amt;
    await execute("UPDATE characters SET money = ? WHERE ID = ?", [p.money, p.charId]);
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
      "UPDATE characters SET level=?, mexp=?, exp=0, st_point=st_point+?, sk_point=sk_point+? WHERE ID=?",
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
      "UPDATE characters SET level = ?, mexp = ?, st_point = st_point + 5, sk_point = sk_point + 2 WHERE ID = ?",
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
    await execute("UPDATE characters SET job=?, job2=?, job3=? WHERE ID=?", [
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
    // //job2 1|2 — Order|Chaos for CURRENT 1st job → correct EN title id
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
      await execute("UPDATE characters SET job2=?, job3=? WHERE ID=?", [p.job2, p.job3, p.charId]);
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
    await execute("UPDATE characters SET job2=?, job3=? WHERE ID=?", [p.job2, p.job3, p.charId]);
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
      await execute("UPDATE characters SET job2=?, job3=? WHERE ID=?", [p.job2, p.job3, p.charId]);
      await syncJobSkills(p.charId, p.job, p.job2, p.job3);
      await refreshCharView();
      return;
    }
    if (path > 2) path = 2;
    p.job3 = path;
    p.job2 = job2ClassId(p.job, path);
    await execute("UPDATE characters SET job2=?, job3=? WHERE ID=?", [p.job2, p.job3, p.charId]);
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
    const bag = await addItemToInventory(p.charId, itemId, qty, 0, -1, p.magic || 0x0037);
    if (bag < 0) {
      console.log(`[field] GM //item inventory full char=${p.charId}`);
    } else {
      for (const out of await refreshBagPackets(p.charId, bag, p.magic || 0x0037)) send(p, out);
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

function fishAck(charId: number, state: number, isFishing: number): Buffer {
  const b = Buffer.alloc(24, 0);
  writeHeader(b, 0x00e1, 24);
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
      "SELECT itemid, amount FROM spend WHERE charid=? AND pos1=3 AND pos2=?",
      [p.charId, slot],
    );
    if (rows.length && Number(rows[0]!.amount) >= 1) return slot;
  }
  const all = await query<RowDataPacket[]>(
    "SELECT pos2, itemid, amount FROM spend WHERE charid=? AND pos1=3 AND amount>=1 ORDER BY pos2",
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
    "SELECT itemid, amount FROM spend WHERE charid=? AND pos1=3 AND pos2=?",
    [p.charId, slot],
  );
  if (!rows.length) return -2;
  if (Number(rows[0]!.amount) < 1) return -2;
  return 0;
}

function startFishing(p: Player): void {
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

async function fishCatchTick(p: Player): Promise<void> {
  if (!p.fishing) return;
  const state = await fishCheckBait(p);
  if (state !== 0) {
    p.fishing = false;
    broadcastMap(p.map, p.region, fishAck(p.charId, state, 0));
    return;
  }
  const itemId = FISH_REWARDS[Math.floor(Math.random() * FISH_REWARDS.length)]!;
  const bag = await addItemToInventory(p.charId, itemId, 1, 0, -1, p.magic || 0x0037);
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
    "SELECT slot FROM equip WHERE charid=? AND pos1=0 AND pos2=0",
    [p.charId],
  );
  if (w.length) {
    const fus = Number(w[0]!.slot ?? 0) + 1;
    await execute("UPDATE equip SET slot=? WHERE charid=? AND pos1=0 AND pos2=0", [fus, p.charId]);
    if (fus >= 30) rodBroken = true;
  }
  for (const out of await refreshBagPackets(p.charId, bag, p.magic || 0x0037)) send(p, out);
  for (const out of await refreshBagPackets(p.charId, 3, p.magic || 0x0037)) send(p, out);
  for (const out of await refreshBagPackets(p.charId, 0, p.magic || 0x0037)) send(p, out);
  if (rodBroken) {
    p.fishing = false;
    broadcastMap(p.map, p.region, fishAck(p.charId, -1, 0));
  } else {
    const again = await fishCheckBait(p);
    if (again !== 0) {
      p.fishing = false;
      broadcastMap(p.map, p.region, fishAck(p.charId, again, 0));
    } else {
      // keep fishing — schedule next catch
      p.fishTimer = setTimeout(() => {
        void fishCatchTick(p);
      }, 50000);
    }
  }
}

async function handlePacket(p: Player, pkt: Buffer): Promise<void> {
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
        await execute("UPDATE characters SET map=1, region=1, charX=?, charY=? WHERE ID=?", [
          p.x,
          p.y,
          info.charId,
        ]);
      } else {
        const pos = sanitizePlayerPos(p.map, p.region, Number(row.charX ?? 0), Number(row.charY ?? 0));
        p.x = pos.x;
        p.y = pos.y;
        if (pos.fixed) {
          await execute("UPDATE characters SET charX=?, charY=? WHERE ID=?", [p.x, p.y, info.charId]);
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
      const u = await query<RowDataPacket[]>("SELECT gm FROM users WHERE accountid = ?", [p.accountId]);
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
        await execute("UPDATE characters SET map=?, region=?, charX=?, charY=?, chp=? WHERE ID=?", [
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
          "SELECT id FROM pets WHERE cid=? AND type=0 AND slot=10 LIMIT 1",
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
      send(p, initPacket(p.charId, p.magic || 0x0037));
      console.log(`[field] bound char=${p.charId} name=${p.name} map=${p.map}/${p.region}`);
    }
    // Send loadout (legacy: CHAR_ALL → skills → quickslot → quests → MAP_INFO).
    // en-client: keep MAP_INFO early (before quests) — MAP last left some clients stuck loading.
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
    // en-client often stays invisible without an explicit SETAVATAR after ENTERPLAYER
    if (p.magic === 0x0037) send(p, await buildSetAvatar(p.charId));
    for (const o of players.values()) {
      if (o.loggedIn && o.fieldEntered && o.charId !== p.charId && o.map === p.map && o.region === p.region) {
        send(p, await enterPlayer(o.charId, { x: o.x, y: o.y, petUseSlot: o.petUseSlot, map: o.map, region: o.region }));
        if (p.magic === 0x0037) send(p, await buildSetAvatar(o.charId));
        send(o, ep);
        if (o.magic === 0x0037) send(o, await buildSetAvatar(p.charId));
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
    // Initial enter: client sends 0x1D before 0xDB. Self ENTERPLAYER before bags crashes Game4.
    // After warp (0x85): legacy sends ENTERPLAYER + peers + MON + drops — NOT bags/PET_LIFE.
    if (pkt.length >= 24) {
      const nx = pkt.readUInt16LE(20);
      const ny = pkt.readUInt16LE(22);
      if (nx < 20000 && ny < 20000) {
        p.x = nx;
        p.y = ny;
        await execute("UPDATE characters SET charX=?, charY=? WHERE ID=?", [p.x, p.y, p.charId]);
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
      if (p.magic === 0x0037) send(p, await buildSetAvatar(p.charId));
      for (const o of players.values()) {
        if (o.loggedIn && o.fieldEntered && o.charId !== p.charId && o.map === p.map && o.region === p.region) {
          send(p, await enterPlayer(o.charId, { x: o.x, y: o.y, petUseSlot: o.petUseSlot, map: o.map, region: o.region }));
          if (p.magic === 0x0037) send(p, await buildSetAvatar(o.charId));
          send(o, ep);
          if (o.magic === 0x0037) send(o, await buildSetAvatar(p.charId));
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
        if (p.magic === 0x0037) send(p, await buildSetAvatar(o.charId));
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
    // EN local-echoes typed map chat; echoing back to self doubles every line.
    // Game4 / legacy rely on Map+self (no local echo).
    const exceptSelf = p.magic === 0x0037 ? p.charId : undefined;
    broadcastMap(p.map, p.region, out, exceptSelf);
    return;
  }

  if (op === 0x0010) {
    await handleGm(p, pkt);
    return;
  }

  if (op === 0x0045) {
    // York AttackMonster_Req: charId@12, slot@14, dmg@18, hitX@20, hitY@22
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

    // York: trust client Damage (rolled from mindamphy/maxdamphy + gear on client).
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
      await execute("UPDATE characters SET money=? WHERE ID=?", [p.money, p.charId]);
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
          "SELECT pos2, soulperc FROM equip WHERE charid=? AND pos1=0 AND FLOOR(type/100000)=85",
          [p.charId],
        );
        if (!seals.length) return;
        const add = Math.max(1, d.qty);
        for (const s of seals) {
          const cur = Number(s.soulperc ?? 0);
          const next = Math.min(100, Math.max(0, cur + add));
          await execute(
            "UPDATE equip SET soulperc=? WHERE charid=? AND pos1=0 AND pos2=?",
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
        await execute("UPDATE characters SET cmp=? WHERE ID=?", [p.mp, p.charId]);
      } else {
        // 9900003 red → fury / DP
        if (p.maxSoul < 1) p.maxSoul = 100;
        p.soul = Math.min(p.maxSoul, p.soul + Math.max(1, d.qty));
        await execute("UPDATE characters SET soul=? WHERE ID=?", [p.soul, p.charId]);
      }
      sendVital(p);
      return;
    }
    const bag = isPetItem(d.itemId)
      ? await addPetToBag(p.charId, d.itemId, "Pet", 0, p.magic || 0x0037)
      : await addItemToInventory(p.charId, d.itemId, d.qty, 0, -1, p.magic || 0x0037);
    if (bag < 0) return; // full — leave drop on ground
    clearDrop(oid);
    broadcastMap(p.map, p.region, buildDropClear(p.charId, d));
    for (const out of await refreshBagPackets(p.charId, bag, p.magic || 0x0037)) send(p, out);
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
      await execute("UPDATE characters SET chp=?, cmp=? WHERE ID=?", [p.hp, p.mp, p.charId]);
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
    await execute("UPDATE characters SET map=?, region=?, charX=?, charY=? WHERE ID=?", [map, region, x, y, p.charId]);
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
        "INSERT INTO gifts (name, itemid, itemname, amount, islocked, term, receive, sender) VALUES (?,?,?,1,1,-1,0,?)",
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
    const rows = await query<RowDataPacket[]>("SELECT * FROM cash_inven WHERE charid=? AND slot=?", [p.charId, slot]);
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
      await execute("DELETE FROM equip WHERE charid=? AND pos1=0 AND pos2=7", [p.charId]);
      const m = await query<RowDataPacket[]>("SELECT COALESCE(MAX(equipid),0) AS m FROM equip");
      await execute(
        "INSERT INTO equip (equipid,type,charid,pos1,pos2,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse,isspecial) VALUES (?,?,?,0,7,0,0,0,0,0,0,0,0,0,0,0,0,?,?,0)",
        [Number(m[0]?.m ?? 0) + 1, itemId, p.charId, locked, term],
      );
      bag = 0;
    } else if (group === 91) {
      await execute("DELETE FROM equip WHERE charid=? AND pos1=0 AND pos2=8", [p.charId]);
      const m = await query<RowDataPacket[]>("SELECT COALESCE(MAX(equipid),0) AS m FROM equip");
      await execute(
        "INSERT INTO equip (equipid,type,charid,pos1,pos2,slot,p_10,p_9,p_8,p_7,p_6,p_5,p_4,p_3,p_2,p_1,soulperc,iscash,timeuse,isspecial) VALUES (?,?,?,0,8,0,0,0,0,0,0,0,0,0,0,0,0,?,?,0)",
        [Number(m[0]?.m ?? 0) + 1, itemId, p.charId, locked, term],
      );
      bag = 0;
    } else if (isPetItem(itemId)) {
      bag = await addPetToBag(p.charId, itemId, "Pet", locked, p.magic || 0x0037);
    } else {
      bag = await addItemToInventory(p.charId, itemId, amount, locked, term, p.magic || 0x0037);
    }
    if (bag < 0) return;
    await execute("DELETE FROM cash_inven WHERE id=?", [r.id]);
    const ack = Buffer.alloc(16, 0);
    writeHeader(ack, 0x00f0, 16);
    ack.writeUInt32LE(1, 12);
    send(p, ack);
    send(p, await buildWarehouse(p.charId));
    for (const out of await refreshBagPackets(p.charId, bag, p.magic || 0x0037)) send(p, out);
    if (bag === 0) {
      const av = await buildSetAvatar(p.charId);
      send(p, av);
      broadcastMap(p.map, p.region, av, p.charId);
    }
    return;
  }
  if (op === 0x00fc) {
    const name = readCString(pkt, 12, 20);
    const rows = await query<RowDataPacket[]>("SELECT ID FROM characters WHERE name=?", [name]);
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
    const res = await dismantle(p.charId, type, slot, p.magic || 0x0037);
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
        await execute("UPDATE characters SET money=? WHERE ID=?", [p.money, p.charId]);
        send(p, moneyPacket(p.money, delta));
      }
      if (res.sellerId !== undefined) {
        const seller = players.get(res.sellerId);
        if (res.sellerGain !== undefined && res.sellerGain > 0) {
          if (seller) {
            seller.money += res.sellerGain;
            await execute("UPDATE characters SET money=? WHERE ID=?", [seller.money, seller.charId]);
            send(seller, moneyPacket(seller.money, res.sellerGain));
          } else {
            await execute("UPDATE characters SET money=money+? WHERE ID=?", [res.sellerGain, res.sellerId]);
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
    const unit = buyPrice(itemId, prices);
    const cost = unit * qty;
    if (p.money < cost) return;
    const bag = await addItemToInventory(p.charId, itemId, give, 0, -1, p.magic || 0x0037);
    if (bag < 0) return;
    p.money -= cost;
    await execute("UPDATE characters SET money=? WHERE ID=?", [p.money, p.charId]);
    send(p, moneyPacket(p.money, -cost));
    for (const pkt of await refreshBagPackets(p.charId, bag, p.magic || 0x0037)) send(p, pkt);
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
    const gain = sellPrice(itemId, prices) * qty;
    p.money += gain;
    await execute("UPDATE characters SET money=? WHERE ID=?", [p.money, p.charId]);
    send(p, moneyPacket(p.money, gain));
    for (const pkt of await refreshBagPackets(p.charId, type, p.magic || 0x0037)) send(p, pkt);
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
    const res = await changeItem(p.charId, pkt, p.magic || 0x0037);
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
    send(p, await buildSpend3(p.charId, p.magic || 0x0037));
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
      "SELECT itemid, amount FROM spend WHERE charid=? AND pos1=3 AND pos2=?",
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
    for (const out of await refreshBagPackets(p.charId, 3, p.magic || 0x0037)) send(p, out);
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
      "SELECT itemid, amount FROM spend WHERE charid=? AND pos1=3 AND pos2=?",
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
    for (const out of await refreshBagPackets(p.charId, 3, p.magic || 0x0037)) send(p, out);
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
      `UPDATE characters SET st_point=st_point-1,
        str=?, dex=?, vit=?, intel=?,
        cmhp=?, cmmp=?, chp=?, cmp=?,
        maxdamphy=?, mindamphy=?, maxdamw=?, mindamw=?, def=?
       WHERE ID=? AND st_point>0`,
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

export async function startFieldServer(): Promise<{ tcp: net.Server; udp: dgram.Socket }> {
  await loadDropRules();
  await loadCashShopFromDb();
  await loadPrices();
  await loadMonsters();

  setInterval(() => {
    const now = Date.now();
    const activeMaps = new Set<string>();
    const wanderTargets: { map: number; region: number; x: number; y: number; charId: number }[] =
      [];
    for (const pl of players.values()) {
      if (!pl.loggedIn || !pl.fieldEntered || !pl.monCombatReady) continue;
      activeMaps.add(`${pl.map}/${pl.region}`);
      if (pl.alive) {
        wanderTargets.push({
          map: pl.map,
          region: pl.region,
          x: pl.x,
          y: pl.y,
          charId: pl.charId,
        });
      }
    }

    // Ground drops (items/money/souls) expire after TTL — clear so they don't linger for hours.
    for (const ev of tickGroundDrops(now)) {
      broadcastMap(ev.drop.map, ev.drop.region, buildDropClear(0, ev.drop));
    }

    if (activeMaps.size > 0) {
      tickMonsterTouch();
      const revived = tickRespawns(now, activeMaps);
      for (const m of revived) {
        broadcastMonRegen(m.map, m.region, buildMonRegen(m));
      }
      const { moves, attacks } = tickWander(now, activeMaps, wanderTargets);
      for (const w of moves) {
        broadcastMonRegen(w.map, w.region, w.pkt);
      }
      for (const a of attacks) {
        // State 3 first — Hit spark on victim so Game4 plays flinch + may send 0x46.
        // Delay HP apply so the hit anim is not skipped by an immediate 0x51.
        broadcastMonRegen(a.map, a.region, a.pkt);
        const charId = a.charId;
        const dmg = a.dmg;
        const map = a.map;
        const region = a.region;
        setTimeout(() => {
          const victim = players.get(charId);
          if (
            !victim ||
            !victim.loggedIn ||
            !victim.alive ||
            victim.map !== map ||
            victim.region !== region
          ) {
            return;
          }
          // Already applied via client CHAR_DAMAGE 0x46
          if (Date.now() - victim.lastTouchAt < 700) return;
          void hurtPlayer(victim, dmg, "mon-aggro-atk");
        }, 280);
      }
    }
  }, LIVE_INTERVAL_MS);

  const udp = dgram.createSocket("udp4");
  fieldUdp = udp;
  udp.on("message", (msg, rinfo) => {
    if (msg.length < 12) return;
    const magic = msg.readUInt16LE(0);
    // Game4=0x0105 (byte0=0x05), en-client=0x0037
    if (magic !== 0x0105 && magic !== 0x0037) return;
    const op = msg.readUInt16LE(2);
    if (!MOVE_OPS.has(op)) return;
    const charId = msg.length >= 16 ? msg.readUInt32LE(12) : 0;
    let p = players.get(charId);
    if (!p) {
      for (const pl of players.values()) {
        if (pl.udpPort === rinfo.port && pl.udpHost === rinfo.address) {
          p = pl;
          break;
        }
      }
    }
    if (!p || !p.fieldEntered) return;
    p.udpPort = rinfo.port;
    p.udpHost = rinfo.address;
    relayPeerAction(p, msg, op);
  });
  udp.bind(config.udpPort, config.fieldHost, () => {
    console.log(`[field-udp] ${config.fieldHost}:${config.udpPort}`);
  });

  const tcp = net.createServer((sock) => {
    const p: Player = {
      sock,
      buf: Buffer.alloc(0),
      charId: 0,
      accountId: 0,
      name: "",
      map: 1,
      region: 1,
      x: 0,
      y: 0,
      level: 1,
      exp: 0,
      mexp: 30,
      job: 0,
      job2: -1,
      job3: -1,
      hp: 50,
      maxHp: 50,
      mp: 50,
      maxMp: 50,
      minAtk: 10,
      maxAtk: 10,
      minMag: 0,
      maxMag: 0,
      def: 0,
      money: 0,
      soul: 0,
      maxSoul: 100,
      gm: 0,
      loggedIn: false,
      fishing: false,
      alive: true,
      spendUseSlot: 0xff,
      petUseSlot: 0xff,
      pendingWarp: false,
      fieldEntered: false,
      touchGraceUntil: 0,
      lastTouchAt: 0,
      pktChain: Promise.resolve(),
      monCombatReady: false,
      magic: 0x0037,
      unk: 0,
      helloSent: false,
      fieldKeys: makeFieldKeys(FIELD_HELLO_KEY1, FIELD_HELLO_KEY2),
      udpPort: 0,
      udpHost: "",
      skillTimers: new Map(),
      skillMods: new Map(),
      eventBuff: undefined,
    };
    // en-client waits for hello 0x14 before sending field login; Game4 can send first
    // but also accepts an immediate hello. Magic/token must match en-client (0x37 / 0x1E488BF5).
    // Unique hello id per connection (avoid always-122 when two local clients connect).
    const helloId = nextHelloId++;
    if (nextHelloId > 0x7fffffff) nextHelloId = 200;
    console.log("[field] connect from", sock.remoteAddress, sock.remotePort);
    p.helloSent = true;
    send(p, initPacket(helloId, p.magic));
    console.log(
      `[field] hello 0x14 sent magic=0x${p.magic.toString(16)} id=${helloId} token=0x${EN_CLIENT_HELLO_TOKEN.toString(16)}`,
    );

    sock.on("data", (chunk) => {
      console.log(`[field] raw +${chunk.length}B ${bufToHex(chunk.subarray(0, Math.min(chunk.length, 256)))}`);
      p.buf = Buffer.concat([p.buf, chunk]);
      const { frames, rest } = peelGame(p.buf);
      p.buf = rest;
      if (!frames.length && p.buf.length >= 12) {
        console.log(
          `[field] buffered ${p.buf.length}B waiting (op=0x${p.buf.readUInt16LE(2).toString(16)} lenField=${p.buf.readUInt16LE(4)})`,
        );
      }
      p.pktChain = p.pktChain.then(async () => {
        for (const frame of frames) {
          try {
            let pkt = frame;
            const outerOp = frame.length >= 4 ? frame.readUInt16LE(2) : 0;
            if (outerOp === 0x81) {
              const decoded = decodeFieldFrame(frame, p.fieldKeys);
              if (!decoded) {
                console.warn(`[field] failed to decode 0x81 frame len=${frame.length}`);
                continue;
              }
              pkt = decoded;
              console.log(
                `[field] decoded 0x81 -> op=0x${opcodeOf(pkt).toString(16)} len=${pkt.length}`,
              );
            }
            if (pkt.length >= 12) {
              const innerMagic = pkt.readUInt16LE(0);
              // Outer 0x81 stores uncomp size in the magic field — ignore that.
              if (innerMagic === 0x0037 || innerMagic === 0x0105) {
                p.magic = innerMagic;
              }
              p.unk = pkt.readUInt32LE(8);
            }
            await handlePacket(p, pkt);
          } catch (e) {
            console.error("[field] err", e);
          }
        }
      });
    });

    sock.on("close", () => {
      if (p.loggedIn && p.charId) {
        const leftMap = p.map;
        const leftRegion = p.region;
        const shopEnd = endPShopIfActive(p.charId);
        if (shopEnd) broadcastMap(leftMap, leftRegion, shopEnd);
        void cancelTradeFor(p, true).catch((e) => console.error("[field] trade cleanup", e));
        if (getParty(p.charId)) leaveParty(p);
        broadcastMap(leftMap, leftRegion, leavePacket(p.charId), p.charId);
        players.delete(p.charId);
        countOnline();
        maybeHibernateMap(leftMap, leftRegion);
      }
      if (p.fishTimer) clearTimeout(p.fishTimer);
      if (p.monCombatTimer) clearTimeout(p.monCombatTimer);
      clearAllSkillEffects(p);
    });
    sock.on("error", () => undefined);
  });

  tcp.listen(config.fieldPort, config.fieldHost, () => {
    console.log(`[field] listening ${config.fieldHost}:${config.fieldPort}`);
  });

  return { tcp, udp };
}
