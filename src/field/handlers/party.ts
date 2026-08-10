import { execute } from '../../db.js';
import { packetMagicOrDefault } from '../../protocol/magic.js';
import {
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
} from '../party.js';
import { type Player, players, send } from '../player.js';
import { moneyPacket } from '../packets/ui.js';

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

export function sendPartyUpdateTo(memberIds: number[]): void {
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
export function leaveParty(p: Player): void {
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

export async function handlePartyPacket(p: Player, op: number, pkt: Buffer): Promise<void> {
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
