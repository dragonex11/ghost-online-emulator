import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import { logPkt } from "../net/packet.js";
import { encodeFieldFrame, type FieldKeys } from "../net/fieldCodec.js";
import { isPShopOutOpcode } from "./pshop.js";
import { PACKET_MAGIC } from "../protocol/magic.js";
import type { BoxBuff } from "./spend_boxes.js";

export type Player = {
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
  spendUseSlot: number;
  petUseSlot: number;
  pendingWarp: boolean;
  fieldEntered: boolean;
  touchGraceUntil: number;
  lastTouchAt: number;
  fishTimer?: ReturnType<typeof setTimeout>;
  pktChain: Promise<void>;
  monCombatReady: boolean;
  monCombatTimer?: ReturnType<typeof setTimeout>;
  magic: number;
  unk: number;
  helloSent: boolean;
  fieldKeys: FieldKeys;
  udpPort: number;
  udpHost: string;
  skillTimers: Map<number, ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>;
  skillMods: Map<number, { atk: number; def: number }>;
  eventBuff?: BoxBuff;
};

export const players = new Map<number, Player>();

/** client drops raw frames with totalLen > 0x7FFF; Look list is 39212. */
const FIELD_RAW_MAX = 0x7fff;

/** Capture outbound packets around map enter for crash debugging */
export const enterTrace = new Map<number, string[]>();

export function beginEnterTrace(charId: number, tag: string): void {
  enterTrace.set(charId, [`=== ${tag} ${new Date().toISOString()} ===`]);
}

export function endEnterTrace(charId: number): void {
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

export function send(p: Player, buf: Buffer): void {
  if (p.sock.destroyed) return;
  let out = Buffer.from(buf);
  let op = 0;
  if (out.length >= 12 && p.magic) {
    op = out.readUInt16LE(2);
    const len = out.readUInt16LE(4);
    out.writeUInt16LE(p.magic & 0xffff, 0);
    out.writeUInt16LE((op + len + p.magic) & 0xffff, 6);
    if ((op >= 0x11f && op <= 0x127) || isPShopOutOpcode(op)) {
      out.writeUInt32LE(0, 8);
    } else {
      out.writeUInt32LE(p.unk >>> 0, 8);
    }
  }
  const isCashList = op >= 0x11f && op <= 0x127;
  if ((isCashList || out.length > FIELD_RAW_MAX) && p.fieldKeys) {
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

export function broadcastMap(map: number, region: number, buf: Buffer, except?: number): void {
  for (const p of players.values()) {
    if (!p.loggedIn || !p.fieldEntered) continue;
    if (p.map !== map || p.region !== region) continue;
    if (except !== undefined && p.charId === except) continue;
    send(p, buf);
  }
}

export let fieldUdp: dgram.Socket | null = null;

export function setFieldUdp(sock: dgram.Socket | null): void {
  fieldUdp = sock;
}

export function broadcastMapUdp(map: number, region: number, buf: Buffer, except?: number): void {
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

export function broadcastAll(buf: Buffer): void {
  for (const p of players.values()) {
    if (p.loggedIn && p.fieldEntered) send(p, buf);
  }
}

export function mapHasPlayers(map: number, region: number, exceptCharId?: number): boolean {
  for (const pl of players.values()) {
    if (!pl.loggedIn || !pl.fieldEntered) continue;
    if (exceptCharId && pl.charId === exceptCharId) continue;
    if (pl.map === map && pl.region === region) return true;
  }
  return false;
}
