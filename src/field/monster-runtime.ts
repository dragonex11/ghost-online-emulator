import fs from "node:fs";
import path from "node:path";
import {
  monstersOnMap,
  sendCombatMonAll,
  buildMonAllCreate,
  resetMonstersOnMap,
  hibernateMonstersOnMap,
} from "./monsters.js";
import { type Player, players, send, mapHasPlayers } from "./player.js";

/** client drops raw frames with totalLen > 0x7FFF; Look list is 39212. */

export function clearMonCombat(p: Player): void {
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
  // Walk flags. the client.exe patched at 0x686227: null-guard after anim
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
 * Delayed monster packets on 0xDB crash the client at whatever delay we pick.
 * Direct login: wait until the client is in-world (first move), then send MON_ALL.
 */
export function scheduleEnterMonsters(
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
export function trySpawnMonstersAfterReady(p: Player): void {
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

export function broadcastMonRegen(map: number, region: number, buf: Buffer): void {
  for (const pl of players.values()) {
    if (!pl.loggedIn || !pl.fieldEntered || !pl.monCombatReady) continue;
    if (pl.map !== map || pl.region !== region) continue;
    send(pl, buf);
  }
}

export function ensureMonCombatReady(p: Player): void {
  if (p.monCombatReady) return;
  if (p.monCombatTimer) {
    clearTimeout(p.monCombatTimer);
    p.monCombatTimer = undefined;
  }
  sendCombatMonAll((pkt) => send(p, pkt), p.map, p.region, false);
  p.monCombatReady = true;
}

export function maybeHibernateMap(map: number, region: number, exceptCharId?: number): void {
  if (mapHasPlayers(map, region, exceptCharId)) return;
  hibernateMonstersOnMap(map, region);
}
