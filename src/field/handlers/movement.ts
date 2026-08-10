import { MOVE_OPS } from "../constants.js";
import { type Player, players, broadcastMap, broadcastMapUdp } from "../player.js";
import { trySpawnMonstersAfterReady } from "../monster-runtime.js";

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
export function relayPeerAction(p: Player, pkt: Buffer, op: number): void {
  updatePosFromMove(p, pkt, op);
  trySpawnMonstersAfterReady(p);
  const out = Buffer.from(pkt);
  broadcastMap(p.map, p.region, out, p.charId);
  if (op >= 0x10b && op <= 0x118) {
    broadcastMapUdp(p.map, p.region, out, p.charId);
  }
}

export { MOVE_OPS };
