import type { RowDataPacket } from "mysql2";
import { query } from "../../../db/index.js";
import { rates } from "../../../config.js";
import { rollDrops, spawnDrop, buildDropSpawn, isSoulOrb, type GroundDrop } from "../drops/index.js";
import {
  updateMonsterPosition,
  updateFlyerPosition,
  updateFlyerToward,
  snapMonsterY,
} from "../monsters/pex.js";
import { mobMoveType } from "../monsters/move-types.js";
import { mobAttackType } from "../monsters/attack-types.js";
import { SELECT_MONSTER } from "../../../db/queries/index.js";

export type Monster = {
  slot: number;
  template: number;
  map: number;
  region: number;
  x: number;
  y: number;
  spawnX: number;
  spawnY: number;
  hp: number;
  maxHp: number;
  level: number;
  speed: number;
  side: number;
  atk1: number;
  atk2: number;
  crash: number;
  def: number;
  dead: boolean;
  deadAt: number;
  state: number;
  nextWanderAt: number;
  /** Last position sent via MON_INFO (chase eases from here). */
  lastSyncX: number;
  lastSyncY: number;
  /** Last facing sent via MON_INFO — avoid spam when idle in range. */
  lastSyncSide: number;
  /** Last MON_INFO wall-clock — heartbeat so client doesn't go stale. */
  lastSyncAt: number;
  /** Armed after first status-1 so client has Speed/MoveType for walk/fly clips. */
  walkArmed: boolean;
  /** Fractional px leftover (kept for chase carry). */
  stepCarry: number;
  /** AttackType — non-zero enables post-hit State 3 counter-attack. */
  attackType: number;
  /** Aggro chase after being hit (0 = idle roam). */
  aggroCharId: number;
  aggroUntil: number;
  nextAttackAt: number;
  /** While now < attackUntil, stay in State 3 (attack anim). */
  attackUntil: number;
  /** Last flight destination sent via status-2 (the client flyer path). */
  flyDestX: number;
  flyDestY: number;
};

/** Living players for chase AI (same-map only). */
export type WanderTarget = { map: number; region: number; x: number; y: number; charId: number };

const ENTER_AI_GRACE_MS = 2000;
/**
 * Client (unpatched) protocol:
 * - Client walks/flies from Speed + Direction; dense Absolute SetPosition kills clips.
 * - Ground: 1Hz Dest step + one MON_INFO per tick (keeps loot/touch synced).
 * - Flyers: arm once with status 1, then only status-2 Dest packets.
 * Authored .prj speed is ~1.0 (40 px/s) — that matches official pace; do not floor to 2.6.
 */
export const LIVE_INTERVAL_MS = 16;
export const FLYER_INTERVAL_MS = 16;
const AI_TICK_MS = 16;
/** Legacy `$MON_WALK_MS = 1000` — one Dest step per second. */
const GROUND_AI_MS = 1000;
/** Default / floor when DB speed missing. Authored spawns use ~1.0. */
const DEFAULT_SPEED = 1;
/** Chase slightly faster than roam (official still feels slow at speed 1). */
const CHASE_SPEED_MUL = 1.25;
/** Flyer status-2 lead ≈ 1.5s of travel. */
const FLYER_DEST_LEAD_MS = 1500;
/** Re-issue flyer dest when target drifts (avoid per-frame dest spam). */
const FLYER_DEST_STALE_PX = 96;

/** Soft Absolute correct when silent server lead exceeds this (px). ~2s at speed 1. */
const GROUND_DRIFT_SYNC_PX = 80;

const FACE_DEADZONE = 20;

function mapKey(map: number, region: number): string {
  return `${map}/${region}`;
}

/** Walk step distance = 40×Speed px per tick. */
function stepSize(m: Monster, dtMs: number, chase = false): number {
  const sp = Math.max(0.5, Math.min(9, effectiveSpeed(m.template, m.speed) || DEFAULT_SPEED));
  const mul = chase ? CHASE_SPEED_MUL : 1;
  const step = Math.round((40 * sp * mul * dtMs) / 1000);
  return Math.max(1, Math.min(360, step));
}

function flyerLeadPx(m: Monster): number {
  const sp = Math.max(0.5, Math.min(9, effectiveSpeed(m.template, m.speed) || DEFAULT_SPEED));
  return Math.max(48, Math.round(40 * sp * (FLYER_DEST_LEAD_MS / 1000)));
}

/**
 * Where the client likely shows the mob (last Absolute + Speed prediction).
 * Server `m.x` can walk silently ahead between facing syncs — touch/AI range
 * must use this or players take damage from "invisible" contact.
 */
export function displayPos(m: Monster, now = Date.now()): { x: number; y: number } {
  const syncX = m.lastSyncAt > 0 ? m.lastSyncX : m.x;
  const syncY = m.lastSyncAt > 0 ? m.lastSyncY : m.y;
  if (m.state === 3 || m.state === 7 || m.state === 9 || !m.walkArmed) {
    return { x: syncX, y: syncY };
  }
  if (isFlyer(m)) {
    // Status-2 dest path — server track is what we last steered toward.
    return { x: m.x, y: m.y };
  }
  if (m.lastSyncAt <= 0) return { x: m.x, y: m.y };
  // Facing flipped on server but not yet broadcast — sprite still on old path.
  if (m.side !== m.lastSyncSide) return { x: syncX, y: syncY };

  const dt = Math.max(0, Math.min(1.5, (now - m.lastSyncAt) / 1000));
  const pxPerSec = 40 * effectiveSpeed(m.template, m.speed);
  const dir = m.lastSyncSide < 0 ? -1 : 1;
  let predX = Math.round(syncX + dir * pxPerSec * dt);
  // Never predict past the authoritative server foot (walls / flips).
  if (dir > 0) predX = Math.min(predX, m.x);
  else predX = Math.max(predX, m.x);
  // Server rewound past sync (edge flip) — snap estimate to server.
  if ((m.x - syncX) * dir < 0) predX = m.x;
  return { x: predX, y: syncY };
}

/** Idle flyers ease back to spawn altitude. */
function flyerIdleY(m: Monster): number {
  if (Math.abs(m.y - m.spawnY) <= 2) return m.spawnY;
  return m.y + Math.sign(m.spawnY - m.y) * Math.min(8, Math.abs(m.spawnY - m.y));
}

/** MoveType 3 = flyer. Client may animate flight; server still patrols X. */
export function isFlyer(m: Monster): boolean {
  return moveTypeFor(m.template) === 3;
}

const monsters: Monster[] = [];

function normalizeSide(raw: number): number {
  const s = Number(raw);
  if (s === 0 || s === -1 || s === 255) return -1;
  return 1;
}

/** Mob AttackType */
export function attackTypeFor(template: number): number {
  return mobAttackType(template);
}

/** Mob MoveType: 0=stationary, 1=ground walk, 3=fly. */
export function moveTypeFor(template: number): number {
  return mobMoveType(template);
}

/**
 * MoveType written to the client. Must match reference tables for flyers (3): sending 1 made
 * the client ground-snap Y every frame while we pushed air Y → vertical twitching.
 */
function clientMoveType(template: number): number {
  return moveTypeFor(template);
}

function effectiveSpeed(template: number, rawSpeed: number): number {
  const mt = moveTypeFor(template);
  if (mt === 0) return 0;
  // Honor authored .prj/DB speed (~1.0). legacy floored to 2.6 — too fast vs stock client.
  let sp = Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : DEFAULT_SPEED;
  if (sp < 0.5) sp = DEFAULT_SPEED;
  if (sp > 9) sp = 9;
  if (mt === 3 && sp > 6) sp = 6;
  return sp;
}

/** Wire Speed for clips. Keep non-zero on hit (status 7) — legacy always writes Speed. */
function packetSpeed(m: Monster, status: number): number {
  const mt = moveTypeFor(m.template);
  if (mt === 0) return 0;
  if (status === 9) return 0;
  return effectiveSpeed(m.template, m.speed);
}

function sideByte(side: number): number {
  return side < 0 ? 255 : side & 0xff;
}

/** legacy `_MonLevelFromId`: digits 2..5 of template (1000101 → 1, 1000601 → 6) */
export function levelFromTemplate(id: number): number {
  const s = String(id);
  if (s.length < 5) return 1;
  const lv = Number(s.slice(1, 5));
  return lv > 0 ? lv : 1;
}

function maxHpForLevel(level: number, boss = false): number {
  const table: Record<number, number> = {
    1: 50,
    2: 70,
    3: 100,
    4: 120,
    5: 150,
    6: 180,
    7: 220,
    8: 260,
    9: 300,
    10: 350,
  };
  let hp = table[level] ?? 50 + level * 30;
  if (boss) hp = Math.floor(hp * 3);
  return hp;
}

function statsForTemplate(template: number): { atk1: number; atk2: number; crash: number; def: number } {
  const lv = levelFromTemplate(template);
  let atk1 = 8 + lv * 2;
  let atk2 = 20 + lv * 3;
  let crash = 8 + lv;
  let def = 2 + Math.floor(lv / 2);
  if (template === 1000101) {
    atk1 = 5;
    atk2 = 10;
    crash = 5;
    def = 1;
  } else if (template === 1000201) {
    atk1 = 6;
    atk2 = 12;
    crash = 6;
    def = 1;
  } else if (template === 1000501) {
    atk1 = 14;
    atk2 = 24;
    crash = 10;
    def = 3;
  } else if (template === 1000601) {
    atk1 = 14;
    atk2 = 40;
    crash = 14;
    def = 4;
  } else if (template === 1000701) {
    atk1 = 18;
    atk2 = 39;
    crash = 12;
    def = 4;
  }
  return { atk1, atk2, crash, def };
}

/** @deprecated — .prj extract owns starter map templates/coords now */
export async function ensureStarterMonsters(): Promise<void> {
  /* no-op: spawns come from client/data/Project/*.prj via import-prj-spawns */
}

export async function loadMonsters(): Promise<void> {
  monsters.length = 0;
  const rows = await query<RowDataPacket[]>(
    SELECT_MONSTER,
  );
  for (const r of rows) {
    const slot = Number(r.m_monsterid ?? 0);
    if (slot < 0 || slot > 49) continue;
    const template = Number(r.monsterid);
    const level = levelFromTemplate(template);
    let hp = Number(r.health ?? 0);
    if (hp <= 0) hp = maxHpForLevel(level);
    const wiki = maxHpForLevel(level);
    if (hp < wiki / 2) hp = wiki;
    const st = statsForTemplate(template);
    const map = Number(r.map);
    const region = Number(r.region);
    const x = Number(r.monsterX ?? 0);
    let y = Number(r.monsterY ?? 0);
    if (!Number.isFinite(template) || template <= 0) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Defer .pex Y snap until map enter / walk (avoid loading every map at boot)
    const rawSp = Number(r.speed);
    const speed = Number.isFinite(rawSp) && rawSp > 0 && rawSp < 50 ? rawSp : 1;
    monsters.push({
      slot,
      template,
      map,
      region,
      x,
      y,
      spawnX: x,
      spawnY: y,
      hp,
      maxHp: hp,
      level,
      speed: effectiveSpeed(template, speed),
      side: normalizeSide(Number(r.side ?? 1)),
      ...st,
      dead: false,
      deadAt: 0,
      state: moveTypeFor(template) === 0 ? 0 : 1,
      nextWanderAt: Date.now() + Math.random() * 2000,
      lastSyncX: x,
      lastSyncY: y,
      lastSyncSide: normalizeSide(Number(r.side ?? 1)),
      lastSyncAt: 0,
      walkArmed: false,
      stepCarry: 0,
      attackType: attackTypeFor(template),
      aggroCharId: 0,
      aggroUntil: 0,
      nextAttackAt: 0,
      attackUntil: 0,
      flyDestX: Number.NaN,
      flyDestY: Number.NaN,
    });
  }
  const byMap = new Map<string, number>();
  for (const m of monsters) {
    const k = `${m.map}/${m.region}`;
    byMap.set(k, (byMap.get(k) ?? 0) + 1);
  }
  const sample26 = monsters.filter((m) => m.map === 2 && m.region === 6);
  const tids26 = [...new Set(sample26.map((m) => m.template))].join(",");
  console.log(
    `[monsters] loaded ${monsters.length} spawns from DB (${byMap.size} maps; 2/6 x${sample26.length} ids=${tids26 || "-"})`,
  );
}

export function monstersOnMap(map: number, region: number): Monster[] {
  return monsters.filter((m) => m.map === map && m.region === region && !m.dead);
}

export function getMonster(map: number, region: number, slot: number): Monster | undefined {
  return monsters.find((m) => m.map === map && m.region === region && m.slot === slot);
}

function writeMonSlot(buf: Buffer, s: number, m: Monster, enterSafe = false): void {
  // Server AI uses MoveType; client MoveType may differ for the client anim (see clientMoveType).
  const mt = enterSafe ? 0 : moveTypeFor(m.template);
  const moveType = enterSafe ? 0 : clientMoveType(m.template);
  const state = enterSafe ? 0 : mt === 0 ? 0 : 1;
  const spd = enterSafe || mt === 0 ? 0 : packetSpeed(m, 1);
  const atkType = enterSafe ? 0 : m.attackType & 0xff;
  buf.writeUInt8(state & 0xff, 16 + s);
  buf.writeUInt8(m.level & 0xff, 66 + s);
  buf.writeUInt8(0, 116 + s);
  buf.writeUInt8(sideByte(m.side), 166 + s);
  buf.writeUInt8(moveType, 216 + s);
  buf.writeUInt8(atkType, 266 + s);
  buf.writeInt16LE(m.slot, 316 + s * 2);
  buf.writeUInt16LE((enterSafe ? m.spawnX : m.x) & 0xffff, 416 + s * 2);
  buf.writeUInt16LE((enterSafe ? m.spawnY : m.y) & 0xffff, 516 + s * 2);
  buf.writeUInt16LE(m.atk1 & 0xffff, 1016 + s * 2);
  buf.writeUInt16LE(m.atk2 & 0xffff, 1116 + s * 2);
  buf.writeUInt16LE(m.crash & 0xffff, 1216 + s * 2);
  buf.writeUInt16LE(m.def & 0xffff, 1316 + s * 2);
  buf.writeUInt32LE(m.template, 1416 + s * 4);
  buf.writeFloatLE(spd, 1616 + s * 4);
  buf.writeUInt16LE(0x46cb, 1816 + s * 2);
  buf.writeUInt32LE(m.maxHp, 1916 + s * 4);
  buf.writeUInt32LE(m.hp, 2116 + s * 4);
}

/** Pack by slot index 0..49 — matches legacy MON_ALL_CREATE */
export function buildMonAllCreate(map: number, region: number, enterSafe = false): Buffer {
  const buf = Buffer.alloc(2316, 0);
  buf[0] = 0x05;
  buf[1] = 0x01;
  buf.writeUInt16LE(0x0042, 2);
  buf.writeUInt16LE(0x090c, 4);
  buf.writeUInt16LE((0x0042 + 0x090c + 0x105) & 0xffff, 6);
  const slotMap = new Int32Array(50);
  slotMap.fill(-1);
  let count = 0;
  for (let i = 0; i < monsters.length; i++) {
    const m = monsters[i]!;
    if (m.dead || m.map !== map || m.region !== region) continue;
    if (m.slot < 0 || m.slot >= 50) continue;
    slotMap[m.slot] = i;
    count++;
  }
  for (let s = 0; s < 50; s++) {
    const idx = slotMap[s]!;
    if (idx < 0) {
      buf.writeInt16LE(-1, 316 + s * 2);
      continue;
    }
    writeMonSlot(buf, s, monsters[idx]!, enterSafe);
  }
  buf.writeUInt32LE(count, 12);
  return buf;
}

/** Empty MON_ALL — used before staggered MON_REGEN (avoids the client crash on bulk spawn) */
export function buildMonAllEmpty(): Buffer {
  const buf = Buffer.alloc(2316, 0);
  buf[0] = 0x05;
  buf[1] = 0x01;
  buf.writeUInt16LE(0x0042, 2);
  buf.writeUInt16LE(0x090c, 4);
  buf.writeUInt16LE((0x0042 + 0x090c + 0x105) & 0xffff, 6);
  for (let s = 0; s < 50; s++) buf.writeInt16LE(-1, 316 + s * 2);
  buf.writeUInt32LE(0, 12);
  return buf;
}

/** Stagger MON_REGEN per mob — stable on the client vs one large MON_ALL at enter */
export function scheduleMonRegen(
  send: (buf: Buffer) => void,
  map: number,
  region: number,
  delayMs = 45,
): number {
  const list = monstersOnMap(map, region);
  send(buildMonAllEmpty());
  list.forEach((m, i) => {
    setTimeout(() => send(buildMonRegen(m)), i * delayMs);
  });
  return list.length;
}

/**
 * After REGEN visuals finish, send full MON_ALL so MON_INFO slot lookup works on hit.
 * Bulk MON_ALL during enter crashes the client; sending after stagger is stable.
 */
export function scheduleCombatMonAll(
  send: (buf: Buffer) => void,
  map: number,
  region: number,
  regenCount: number,
  regenDelayMs = 45,
  extraDelayMs = 800,
  onReady?: () => void,
): ReturnType<typeof setTimeout> | undefined {
  const pkt = buildMonAllCreate(map, region);
  const count = pkt.readUInt32LE(12);
  if (count === 0) {
    send(pkt);
    onReady?.();
    return undefined;
  }
  const delay = Math.max(extraDelayMs, regenCount * regenDelayMs + extraDelayMs);
  return setTimeout(() => {
    send(pkt);
    onReady?.();
  }, delay);
}

export function sendCombatMonAll(
  send: (buf: Buffer) => void,
  map: number,
  region: number,
  enterSafe = false,
): boolean {
  const pkt = buildMonAllCreate(map, region, enterSafe);
  if (pkt.readUInt32LE(12) === 0) {
    send(pkt);
    return true;
  }
  send(pkt);
  return true;
}

/** MON_REGEN 0x3F — single monster respawn (legacy); do NOT re-send full MON_ALL */
export function buildMonRegen(m: Monster): Buffer {
  const moveType = clientMoveType(m.template);
  const b = Buffer.alloc(70, 0);
  b[0] = 0x05;
  b[1] = 0x01;
  b.writeUInt16LE(0x003f, 2);
  b.writeUInt16LE(0x0046, 4);
  b.writeUInt16LE((0x003f + 0x0046 + 0x105) & 0xffff, 6);
  b.writeUInt32LE(m.template, 12);
  b.writeUInt8(m.level & 0xff, 16);
  b.writeUInt8(0, 17);
  b.writeUInt8(sideByte(m.side), 18);
  b.writeUInt8(moveType, 19);
  b.writeUInt16LE(m.x & 0xffff, 20);
  b.writeUInt16LE(m.y & 0xffff, 22);
  b.writeUInt32LE(m.hp, 28);
  b.writeUInt16LE(m.slot & 0xffff, 32);
  b.writeUInt16LE(m.atk1 & 0xffff, 34);
  b.writeUInt16LE(m.atk2 & 0xffff, 36);
  b.writeUInt16LE(m.crash & 0xffff, 38);
  b.writeUInt16LE(m.def & 0xffff, 40);
  b.writeUInt16LE(m.attackType & 0xffff, 42);
  b.writeUInt16LE(0x0630, 44);
  return b;
}

export function buildMonInfo(
  m: Monster,
  status: number,
  charHit: number,
  dmg: number,
  hitX: number,
  hitY: number,
  destX?: number,
  destY?: number,
): Buffer {
  // PositionX/Y ALWAYS server m.x/m.y. HitX/HitY are spark only (+64/+66).
  // Status 2 (flyers): the client skips SetPosition and uses +20/+22 as flight destination.
  const px = m.x;
  const py = m.y;
  const spd = packetSpeed(m, status);
  const safeDmg = Math.max(0, Math.min(9999, Math.floor(Number(dmg) || 0)));
  let hx = hitX;
  let hy = hitY;
  if (hx === 0 && hy === 0) {
    hx = px;
    hy = py;
  }
  const dx =
    destX !== undefined && Number.isFinite(destX) ? destX : status === 2 ? px : 0;
  const dy =
    destY !== undefined && Number.isFinite(destY) ? destY : status === 2 ? py : 0;
  const b = Buffer.alloc(98, 0);
  b[0] = 0x05;
  b[1] = 0x01;
  b.writeUInt16LE(0x0038, 2);
  b.writeUInt16LE(0x0062, 4);
  b.writeUInt16LE((0x0038 + 0x0062 + 0x105) & 0xffff, 6);
  b.writeUInt32LE(status, 12);
  b.writeUInt32LE(m.slot, 16);
  b.writeUInt16LE(dx & 0xffff, 20);
  b.writeUInt16LE(dy & 0xffff, 22);
  b.writeUInt32LE(sideByte(m.side), 24);
  b.writeFloatLE(spd, 28);
  b.writeUInt16LE(px & 0xffff, 32);
  b.writeUInt16LE(py & 0xffff, 34);
  b.writeUInt16LE(0, 36);
  b.writeUInt16LE(0, 38);
  b.writeUInt32LE(0, 40);
  b.writeUInt32LE(0, 44);
  b.writeUInt32LE(charHit >>> 0, 48);
  b.writeUInt16LE(safeDmg & 0xffff, 52);
  b.writeUInt16LE(status === 7 || status === 9 ? 1 : 0, 54);
  b.writeUInt32LE(0, 56);
  b.writeUInt32LE(m.hp >>> 0, 60);
  b.writeUInt16LE(hx & 0xffff, 64);
  b.writeUInt16LE(hy & 0xffff, 66);
  return b;
}

export type WanderBroadcast = { map: number; region: number; pkt: Buffer };
export type AiAttackEvent = {
  map: number;
  region: number;
  charId: number;
  dmg: number;
  pkt: Buffer;
};

/** Mark monster as aggroed on the attacker (chase + repeated State 3 attacks). */
export function setMonsterAggro(m: Monster, charId: number, now = Date.now()): void {
  m.aggroCharId = charId;
  m.aggroUntil = now + rates.aggroMs;
  m.nextAttackAt = now + 500;
}

function clearAggro(m: Monster): void {
  m.aggroCharId = 0;
  m.aggroUntil = 0;
}

function findTarget(
  targets: WanderTarget[],
  map: number,
  region: number,
  charId: number,
): WanderTarget | undefined {
  return targets.find((t) => t.map === map && t.region === region && t.charId === charId);
}

function markSynced(m: Monster): void {
  m.lastSyncX = m.x;
  m.lastSyncY = m.y;
  m.lastSyncSide = m.side;
  m.lastSyncAt = Date.now();
}

/**
 * Ground MON_INFO: Client Absolute SetPosition restarts walk → idle flash.
 * Sync on facing change, rescue, or large silent drift (keeps touch honest).
 */
function pushGroundSync(
  m: Monster,
  moves: WanderBroadcast[],
  opts: { force?: boolean; sideChanged?: boolean } = {},
): void {
  const sideChanged = opts.sideChanged ?? m.side !== m.lastSyncSide;
  const drifted =
    Math.abs(m.x - m.lastSyncX) >= GROUND_DRIFT_SYNC_PX ||
    Math.abs(m.y - m.lastSyncY) >= GROUND_DRIFT_SYNC_PX;
  if (!opts.force && !sideChanged && !drifted) return;
  markSynced(m);
  moves.push({ map: m.map, region: m.region, pkt: buildMonInfo(m, 1, 0, 0, 0, 0) });
}

/** Keep feet on solid .pex ground; if void, fall back to spawn (stop “falling off map”). */
function settleGroundY(m: Monster): boolean {
  const feet = snapMonsterY(m.map, m.region, m.x, m.y);
  // If snap still looks like free-fall far below spawn, pin to spawn platform.
  if (Math.abs(feet - m.spawnY) > 480) {
    m.x = m.spawnX;
    m.y = snapMonsterY(m.map, m.region, m.spawnX, m.spawnY);
    return true;
  }
  m.y = feet;
  return false;
}

/** Status 2: client skips SetPosition and flies toward +20/+22 (keeps fly clip). */
function pushFlyerDest(
  m: Monster,
  moves: WanderBroadcast[],
  destX: number,
  destY: number,
): void {
  m.flyDestX = destX;
  m.flyDestY = destY;
  markSynced(m);
  moves.push({
    map: m.map,
    region: m.region,
    pkt: buildMonInfo(m, 2, 0, 0, 0, 0, destX, destY),
  });
}

function flyerDestStale(m: Monster, destX: number, destY: number): boolean {
  if (!Number.isFinite(m.flyDestX) || !Number.isFinite(m.flyDestY)) return true;
  return (
    Math.abs(destX - m.flyDestX) >= FLYER_DEST_STALE_PX ||
    Math.abs(destY - m.flyDestY) >= FLYER_DEST_STALE_PX
  );
}

/** Resume / arm flyer without Absolute status-1 (that freezes fly clips on the client). */
function armFlyerResume(m: Monster, moves: WanderBroadcast[]): void {
  const lead = flyerLeadPx(m);
  const destX = m.x + (m.side < 0 ? -1 : 1) * lead;
  pushFlyerDest(m, moves, destX, m.y);
}

/** After hit/attack: re-arm walk/fly clips without teleporting. */
function resumeMovement(m: Monster, moves: WanderBroadcast[]): void {
  m.state = 1;
  m.walkArmed = true;
  if (moveTypeFor(m.template) === 3) {
    armFlyerResume(m, moves);
  } else {
    pushGroundSync(m, moves, { force: true });
  }
}

/**
 * Ground: 1Hz Dest walk; MON_INFO only on facing / rare drift / combat.
 * Flyers: status-1 arm once, then status-2 Dest (never Absolute spam while flying).
 */
export function tickWander(
  now: number,
  activeMaps?: Set<string>,
  targets: WanderTarget[] = [],
): { moves: WanderBroadcast[]; attacks: AiAttackEvent[] } {
  const moves: WanderBroadcast[] = [];
  const attacks: AiAttackEvent[] = [];
  if (activeMaps && activeMaps.size === 0) return { moves, attacks };

  for (const m of monsters) {
    if (m.dead) continue;
    const mt = moveTypeFor(m.template);
    if (mt === 0) continue;
    if (m.state === 9) continue;
    const key = mapKey(m.map, m.region);
    if (activeMaps && !activeMaps.has(key)) continue;

    // Leave attack/hit → resume walk/fly (one packet, no double status-1+2)
    if (m.state === 3 && now >= m.attackUntil) {
      resumeMovement(m, moves);
      m.nextWanderAt = now + (mt === 3 ? AI_TICK_MS : GROUND_AI_MS);
      continue;
    }
    if (m.state === 7 && now >= m.attackUntil) {
      resumeMovement(m, moves);
      m.nextWanderAt = now + (mt === 3 ? AI_TICK_MS : GROUND_AI_MS);
      continue;
    }
    if (m.state === 3 || m.state === 7) continue;
    if (now < m.nextWanderAt) continue;

    const aggroed = m.aggroCharId > 0 && now < m.aggroUntil;
    let target: WanderTarget | undefined;
    if (aggroed) {
      target = findTarget(targets, m.map, m.region, m.aggroCharId);
      if (!target) clearAggro(m);
    }

    // Chase a bit faster than roam so they close in without Dest spam.
    m.nextWanderAt = now + (mt === 3 ? AI_TICK_MS : target ? 500 : GROUND_AI_MS);
    m.state = 1;

    if (!m.walkArmed) {
      m.walkArmed = true;
      // Arm clips: ground status-1 once; flyer status-1 then status-2 Dest.
      pushGroundSync(m, moves, { force: true });
      if (mt === 3) armFlyerResume(m, moves);
      continue;
    }

    // —— Flyers: server track + sparse status-2 Dest (keeps flying anim) ——
    if (mt === 3) {
      const step = stepSize(m, AI_TICK_MS, !!target);
      if (target) {
        const dx = target.x - m.x;
        const dy = target.y - m.y;
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        const wantSide = adx > FACE_DEADZONE ? (dx < 0 ? -1 : 1) : m.side;
        const inRange = adx <= rates.attackRangeX && ady <= rates.attackRangeY + 80;

        if (inRange && m.attackType !== 0 && now >= m.nextAttackAt) {
          m.side = wantSide;
          m.state = 3;
          m.attackUntil = now + rates.attackAnimMs;
          m.nextAttackAt = now + rates.attackCooldownMs;
          m.aggroUntil = now + rates.aggroMs;
          const lo = Math.max(1, m.atk1);
          const hi = Math.max(lo, m.atk2);
          const dmg = lo + Math.floor(Math.random() * (hi - lo + 1));
          attacks.push({
            map: m.map,
            region: m.region,
            charId: target.charId,
            dmg,
            pkt: buildMonInfo(m, 3, target.charId, dmg, target.x, target.y),
          });
          markSynced(m);
          continue;
        }

        const prevSide = m.side;
        const pos = { x: m.x, y: m.y, side: wantSide };
        updateFlyerToward(m.map, m.region, pos, target.x, target.y, step);
        m.x = pos.x;
        m.y = pos.y;
        m.side = pos.side;
        if (prevSide !== m.side || flyerDestStale(m, target.x, target.y)) {
          pushFlyerDest(m, moves, target.x, target.y);
        }
        continue;
      }

      const prevSide = m.side;
      const pos = { x: m.x, y: m.y, side: m.side };
      updateFlyerPosition(m.map, m.region, pos, step);
      m.x = pos.x;
      m.side = pos.side;
      m.y = flyerIdleY(m);
      const patrolDestX = m.x + (m.side < 0 ? -1 : 1) * flyerLeadPx(m);
      if (prevSide !== m.side || flyerDestStale(m, patrolDestX, m.y)) {
        pushFlyerDest(m, moves, patrolDestX, m.y);
      }
      continue;
    }

    // —— Ground: 1Hz Dest (chase 2Hz); packet on facing / drift ——
    const groundDt = target ? 500 : GROUND_AI_MS;
    const groundStep = stepSize(m, groundDt, !!target);
    if (target) {
      const vis = displayPos(m, now);
      const dx = target.x - m.x;
      const dy = target.y - m.y;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      const wantSide = adx > FACE_DEADZONE ? (dx < 0 ? -1 : 1) : m.side;
      // Attack only when the *visible* mob is in range (not silent server-ahead ghost).
      const vdx = Math.abs(target.x - vis.x);
      const vdy = Math.abs(target.y - vis.y);
      const inRange =
        adx <= rates.attackRangeX &&
        ady <= rates.attackRangeY &&
        vdx <= rates.attackRangeX &&
        vdy <= rates.attackRangeY;

      if (inRange && m.attackType !== 0 && now >= m.nextAttackAt) {
        m.side = wantSide;
        m.state = 3;
        m.attackUntil = now + rates.attackAnimMs;
        m.nextAttackAt = now + rates.attackCooldownMs;
        m.aggroUntil = now + rates.aggroMs;
        const lo = Math.max(1, m.atk1);
        const hi = Math.max(lo, m.atk2);
        const dmg = lo + Math.floor(Math.random() * (hi - lo + 1));
        attacks.push({
          map: m.map,
          region: m.region,
          charId: target.charId,
          dmg,
          pkt: buildMonInfo(m, 3, target.charId, dmg, target.x, target.y),
        });
        markSynced(m);
        continue;
      }

      if (inRange) {
        const sideChanged = wantSide !== m.side;
        m.side = wantSide;
        // Facing-only — do not Absolute-snap every idle tick (blinks / kills anim).
        pushGroundSync(m, moves, { sideChanged });
        continue;
      }

      const prevSide = m.side;
      const pos = { x: m.x, y: m.y, side: wantSide };
      updateMonsterPosition(m.map, m.region, pos, groundStep);
      m.x = pos.x;
      m.y = pos.y;
      m.side = pos.side;
      const rescued = settleGroundY(m);
      // Facing-only — forced 1Hz Absolute was walk→idle→walk every Dest tick.
      pushGroundSync(m, moves, {
        force: rescued,
        sideChanged: rescued || m.side !== prevSide,
      });
      continue;
    }

    const prevSide = m.side;
    const pos = { x: m.x, y: m.y, side: m.side };
    updateMonsterPosition(m.map, m.region, pos, groundStep);
    m.x = pos.x;
    m.y = pos.y;
    m.side = pos.side;
    const rescued = settleGroundY(m);
    pushGroundSync(m, moves, {
      force: rescued,
      sideChanged: rescued || m.side !== prevSide,
    });
  }
  return { moves, attacks };
}

/** Pause + reset a map when the last player leaves (no AI / no ghost state). */
export function hibernateMonstersOnMap(map: number, region: number): void {
  for (const m of monsters) {
    if (m.map !== map || m.region !== region) continue;
    m.dead = false;
    m.deadAt = 0;
    m.hp = m.maxHp;
    m.x = m.spawnX;
    m.y = m.spawnY;
    m.lastSyncX = m.spawnX;
    m.lastSyncY = m.spawnY;
    m.lastSyncSide = m.side;
    m.lastSyncAt = 0;
    m.walkArmed = false;
    m.stepCarry = 0;
    m.state = moveTypeFor(m.template) === 0 ? 0 : 1;
    m.nextWanderAt = Number.MAX_SAFE_INTEGER; // frozen until resetMonstersOnMap
    m.aggroCharId = 0;
    m.aggroUntil = 0;
    m.nextAttackAt = 0;
    m.attackUntil = 0;
    m.flyDestX = Number.NaN;
    m.flyDestY = Number.NaN;
  }
}

/** Count living monsters that would simulate on a map (debug / gates). */
export function monsterCountOnMap(map: number, region: number): number {
  let n = 0;
  for (const m of monsters) {
    if (m.map === map && m.region === region) n++;
  }
  return n;
}

/** Full reset on enter: revive + snap to exact .prj spawn (stable the client enter). */
export function resetMonstersOnMap(map: number, region: number): void {
  for (const m of monsters) {
    if (m.map !== map || m.region !== region) continue;
    m.dead = false;
    m.deadAt = 0;
    m.hp = m.maxHp;
    m.x = m.spawnX;
    // Flyers keep authored spawn Y (air); ground snaps via .pex
    m.y = isFlyer(m) ? m.spawnY : snapMonsterY(m.map, m.region, m.spawnX, m.spawnY);
    m.lastSyncX = m.spawnX;
    m.lastSyncY = m.spawnY;
    m.lastSyncSide = m.side;
    m.lastSyncAt = 0;
    m.walkArmed = false;
    m.stepCarry = 0;
    m.state = moveTypeFor(m.template) === 0 ? 0 : 1;
    m.nextWanderAt = Date.now() + ENTER_AI_GRACE_MS + m.slot * 90;
    m.aggroCharId = 0;
    m.aggroUntil = 0;
    m.nextAttackAt = 0;
    m.attackUntil = 0;
    m.flyDestX = Number.NaN;
    m.flyDestY = Number.NaN;
  }
}

export function tickRespawns(now: number, activeMaps?: Set<string>): Monster[] {
  const revived: Monster[] = [];
  for (const m of monsters) {
    if (!m.dead || now - m.deadAt <= rates.monsterRespawnMs) continue;
    const key = mapKey(m.map, m.region);
    // Only respawn on occupied maps — empty maps stay hibernated
    if (activeMaps && !activeMaps.has(key)) continue;
    m.dead = false;
    m.hp = m.maxHp;
    m.x = m.spawnX;
    m.y = isFlyer(m) ? m.spawnY : snapMonsterY(m.map, m.region, m.spawnX, m.spawnY);
    m.lastSyncX = m.spawnX;
    m.lastSyncY = m.spawnY;
    m.lastSyncSide = m.side;
    m.lastSyncAt = 0;
    m.walkArmed = false;
    m.stepCarry = 0;
    m.state = moveTypeFor(m.template) === 0 ? 0 : 1;
    m.nextWanderAt = now + 400;
    m.aggroCharId = 0;
    m.aggroUntil = 0;
    m.nextAttackAt = 0;
    m.attackUntil = 0;
    m.flyDestX = Number.NaN;
    m.flyDestY = Number.NaN;
    revived.push(m);
  }
  return revived;
}

export function applyDamage(
  m: Monster,
  dmg: number,
  dropExtras?: { dropMul?: number; goldMul?: number },
): { dead: boolean; drops: GroundDrop[] } {
  m.hp = Math.max(0, m.hp - dmg);
  if (m.hp > 0) return { dead: false, drops: [] };
  m.dead = true;
  m.deadAt = Date.now();
  m.aggroCharId = 0;
  m.aggroUntil = 0;
  m.attackUntil = 0;
  const rolled = rollDrops(m.template, m.level, dropExtras);
  const drops: GroundDrop[] = [];
  let i = 0;
  // legacy: spread around live corpse X/Y. Snap Y to solid ground first so loot
  // doesn't spawn underground and float up.
  settleGroundY(m);
  const baseX = m.x;
  const baseY = m.y;
  for (const r of rolled) {
    const dx = i === 0 ? 0 : 25 * Math.ceil(i / 2) * (i % 2 === 0 ? 1 : -1);
    const dropX = Math.max(1, baseX + dx);
    const groundY = snapMonsterY(m.map, m.region, dropX, baseY);
    // Souls start near corpse feet then server rises them skyward (tickSouls).
    // Items/money sit just above ground (legacy BY-20).
    const dropY = isSoulOrb(r.itemId)
      ? Math.max(16, groundY - 24)
      : Math.max(32, groundY - 20);
    drops.push(
      spawnDrop({
        itemId: r.itemId,
        qty: r.qty,
        x: dropX,
        y: dropY,
        map: m.map,
        region: m.region,
      }),
    );
    i++;
  }
  return { dead: true, drops };
}

export function buildDropPackets(drops: GroundDrop[]): Buffer[] {
  return drops.map((d) => buildDropSpawn(d));
}

export function monsterExp(m: Monster): number {
  // Laidai/Big-eye early curve; else level * monsterExpPerLevel, then killExpRate
  let base: number;
  if (m.template === 1000101) base = 8 + Math.floor(Math.random() * 5);
  else if (m.template === 1000201) base = 12 + Math.floor(Math.random() * 6);
  else base = Math.max(5, m.level * rates.monsterExpPerLevel);
  return Math.max(1, Math.floor(base * rates.killExpRate));
}
