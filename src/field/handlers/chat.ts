import { readCString, writeCString, writeHeader } from "../../net/packet.js";
import { CHAT_TYPE_MAP, CHAT_TYPE_WHISPER } from "../constants.js";
import { type Player, players } from "../player.js";

export function chatPacket(
  charId: number,
  name: string,
  msg: string,
  type = CHAT_TYPE_MAP,
  targetName = "",
  opts?: { suppressBubble?: boolean },
): Buffer {
  const b = Buffer.alloc(120, 0);
  writeHeader(b, 0x0017, 120);
  // Client draws overhead for type 0/3 only when it can bind pkt+0xC to a field avatar.
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

export function findPlayerByName(name: string): Player | undefined {
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
    // Client whisper target field often truncates the last character of long names.
    // Only allow real-name-starts-with-key (not the reverse — that false-matches
    // e.g. "asdasdddddd" against shorter "asdasddas").
    if (key.length >= 4 && n.length > key.length && n.startsWith(key)) {
      prefixHits.push(o);
    }
  }
  if (exact) return exact;
  return prefixHits.length === 1 ? prefixHits[0] : undefined;
}

export function readWhisperTarget(pkt: Buffer): string {
  if (pkt.length >= 0x78) {
    const at64 = readCString(pkt, 0x64, 20).trim();
    if (at64) return at64;
    const at68 = readCString(pkt, 0x68, 16).trim();
    if (at68) return at68;
  }
  return "";
}
