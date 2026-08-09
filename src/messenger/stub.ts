import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import type { RowDataPacket } from "mysql2";
import { peelGame, writeHeader, writeCString, readCString } from "../net/packet.js";
import { query, execute } from "../db.js";

/**
 * Messenger — EN client dials 127.0.0.1:17201.
 *
 * EN wire: magic 0x0037 | op | totalLen | crc | unk | body
 *
 * C2S:
 *   0x0C FriendListReq — login; charId @+12
 *   0x40 LetterListReq — Message Management (dialog 0x36c7)
 *   0x42 LetterSend — deliver; flag@+12, toName@+13 (20), body@+0x21 (512)
 *   0x45 LetterDel — slot index @+12
 *   0x46 LetterDelAll
 *   0x47 LetterRead — slot index @+12
 *   0x48 FriendListRefresh — F / Interact friend tab (dialog 0x3718)
 *   0x4A FriendAddReq — target name @+12
 *   0x4B FriendInviteReply — name @+12, flag @+0x20 (0=accept, -1=reject)
 *   0x5A keepalive
 *
 * S2C:
 *   0x0B GameLog, 0x09 Ready
 *   0x41 LetterList — 30 × 0x21a slots (total 0x3F18); dialog 0x36c7
 *   0x43 LetterRecv — fromName[20]; "You have a message from %s"
 *   0x49 FriendList — dialog 0x3718; 30 × 0x20 name-first slots (total 0x3CC)
 *   0x4A invite notify ("%s has sent a friend invitation")
 *   0x4C result (0=added, 1=fail)
 *   0x4F online notify
 *
 * Note: S2C 0x39 updates dialog 0x3715 (class columns) — NOT the F friends UI.
 */

const EN_MAGIC = 0x0037;
const OP_READY = 0x0009;
const OP_GAMELOG = 0x000b;
const OP_FRIEND_LIST_REQ = 0x000c;
const OP_LETTER_LIST_REQ = 0x0040;
const OP_LETTER_LIST = 0x0041;
const OP_LETTER_SEND = 0x0042;
const OP_LETTER_RECV = 0x0043;
const OP_LETTER_DEL = 0x0045;
const OP_LETTER_DEL_ALL = 0x0046;
const OP_LETTER_READ = 0x0047;
const OP_FRIEND_LIST = 0x0049;
const OP_FRIEND_REFRESH = 0x0048;
const OP_FRIEND_ADD = 0x004a;
const OP_FRIEND_REPLY = 0x004b;
const OP_FRIEND_ADD_ACK = 0x004c;
const OP_FRIEND_ONLINE = 0x004f;
const OP_KEEPALIVE = 0x005a;

/** EN F-list (0x3718): 30 slots × 0x20; empty template @ 0x66e0a0. */
const SLOT_SIZE = 0x20;
const MAX_FRIENDS = 30;
const NAME_LEN = 20;
const FRIEND_LIST_TOTAL = 0x3cc; // 12 + 30*0x20

/** Letter list (0x36c7): 30 slots × 0x21a; empty template @ 0x66dfe0. */
const LETTER_SLOT_SIZE = 0x21a;
const MAX_LETTERS = 30;
const LETTER_BODY_LEN = 512;
const LETTER_LIST_TOTAL = 0x3f18; // 12 + 30*0x21a

const RESULT_OK = 0;
const RESULT_FAIL = 1;
const RESULT_FULL = 2;

const logPath = path.resolve(process.cwd(), "logs", "messenger.log");

interface MsgSession {
  sock: net.Socket;
  tag: string;
  charId: number;
  name: string;
  unk: number;
  listSent: boolean;
  buf: Buffer;
}

interface FriendRow {
  charId: number;
  name: string;
  level: number;
  channel: number;
  online: boolean;
}

interface LetterRow {
  id: number;
  fromName: string;
  body: string;
  sentAt: Date;
  unread: boolean;
}

/** Pending invites: targetCharId → inviter sessions meta */
const pendingByTarget = new Map<number, Map<number, { name: string }>>();

const sessions = new Map<net.Socket, MsgSession>();
const byCharId = new Map<number, MsgSession>();
const byName = new Map<string, MsgSession>();

function mlog(line: string): void {
  const ts = new Date().toISOString();
  console.log(`[messenger] ${line}`);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${ts}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

function makePkt(opcode: number, bodyLen: number, unk: number, fill?: (b: Buffer) => void): Buffer {
  const total = 12 + bodyLen;
  const buf = Buffer.alloc(total, 0);
  writeHeader(buf, opcode, total, EN_MAGIC, unk);
  if (fill) fill(buf);
  return buf;
}

function buildGameLog(unk = 1): Buffer {
  return makePkt(OP_GAMELOG, 12, unk, (b) => {
    b.writeInt32LE(-1, 12);
  });
}

function buildMessengerReady(unk = 1): Buffer {
  return makePkt(OP_READY, 0x24 - 12, unk, (b) => {
    b.writeInt32LE(-1, 12);
    b.writeInt32LE(-1, 16);
  });
}

/**
 * S2C 0x49 FriendList (dialog 0x3718) — 0x20 slot:
 *   name[20] @+0
 *   level   @+0x14  (UI Level; client prints low byte as %d)
 *   mapId   @+0x18  (GuildName via client map-name table; -1 = blank)
 *   channel @+0x1c  (UI Channel = stored+1; 0xFF = offline → client blanks Level/Channel)
 * Empty template @ 0x66e0a0: level=1, mapId=-1, ch=0xFF.
 */
function buildFriendList(unk: number, friends: FriendRow[]): Buffer {
  const bodyLen = MAX_FRIENDS * SLOT_SIZE;
  const pkt = makePkt(OP_FRIEND_LIST, bodyLen, unk, (b) => {
    for (let i = 0; i < MAX_FRIENDS; i++) {
      const off = 12 + i * SLOT_SIZE;
      const f = friends[i];
      if (!f) {
        b.writeInt32LE(1, off + 0x14);
        b.writeInt32LE(-1, off + 0x18);
        b.writeUInt8(0xff, off + 0x1c);
        continue;
      }
      writeCString(b, off, f.name, NAME_LEN);
      // Always write real level; offline path still blanks the Level cell in the client.
      b.writeInt32LE(Math.max(1, Math.min(255, f.level | 0)), off + 0x14);
      b.writeInt32LE(-1, off + 0x18);
      if (f.online) {
        // Client displays Channel as (byte + 1); store channelIndex = channel - 1.
        const channel = Math.max(1, Math.min(255, f.channel || 1));
        b.writeUInt8(channel - 1, off + 0x1c);
      } else {
        b.writeUInt8(0xff, off + 0x1c);
      }
    }
  });
  if (pkt.length !== FRIEND_LIST_TOTAL) {
    mlog(`WARN FriendList size ${pkt.length} != ${FRIEND_LIST_TOTAL}`);
  }
  return pkt;
}

function buildFriendInviteNotify(unk: number, fromName: string): Buffer {
  return makePkt(OP_FRIEND_ADD, 0x20 - 12, unk, (b) => {
    writeCString(b, 12, fromName, NAME_LEN);
  });
}

function buildFriendAddAck(unk: number, result = RESULT_OK): Buffer {
  return makePkt(OP_FRIEND_ADD_ACK, 4, unk, (b) => {
    b.writeInt32LE(result | 0, 12);
  });
}

function buildFriendOnline(unk: number, name: string): Buffer {
  return makePkt(OP_FRIEND_ONLINE, 0x20 - 12, unk, (b) => {
    writeCString(b, 12, name, NAME_LEN);
  });
}

/**
 * S2C 0x41 LetterList — slot 0x21a:
 *   fromName[20] @+0
 *   body[512]    @+0x14
 *   yy,mm,dd,hh,min @+0x214..+0x218  (UI "%02d-%02d-%02d %02d:%02d")
 *   isRead       @+0x219  (0 = unread/new → client sends 0x47 on open; 1 = already read)
 */
function buildLetterList(unk: number, letters: LetterRow[]): Buffer {
  const bodyLen = MAX_LETTERS * LETTER_SLOT_SIZE;
  const pkt = makePkt(OP_LETTER_LIST, bodyLen, unk, (b) => {
    for (let i = 0; i < MAX_LETTERS; i++) {
      const off = 12 + i * LETTER_SLOT_SIZE;
      const letter = letters[i];
      if (!letter) continue;
      writeCString(b, off, letter.fromName, NAME_LEN);
      writeCString(b, off + 0x14, letter.body, LETTER_BODY_LEN);
      const d = letter.sentAt;
      b.writeUInt8(d.getFullYear() % 100, off + 0x214);
      b.writeUInt8(d.getMonth() + 1, off + 0x215);
      b.writeUInt8(d.getDate(), off + 0x216);
      b.writeUInt8(d.getHours(), off + 0x217);
      b.writeUInt8(d.getMinutes(), off + 0x218);
      // Client stores this at letterObj+0x24; 0x47 is only sent when that value is 0.
      b.writeUInt8(letter.unread ? 0 : 1, off + 0x219);
    }
  });
  if (pkt.length !== LETTER_LIST_TOTAL) {
    mlog(`WARN LetterList size ${pkt.length} != ${LETTER_LIST_TOTAL}`);
  }
  return pkt;
}

function buildLetterRecv(unk: number, fromName: string): Buffer {
  return makePkt(OP_LETTER_RECV, 0x20 - 12, unk, (b) => {
    writeCString(b, 12, fromName, NAME_LEN);
  });
}

function send(s: MsgSession, pkt: Buffer): void {
  try {
    s.sock.write(pkt);
  } catch {
    /* ignore */
  }
}

function registerSession(s: MsgSession): void {
  if (s.charId > 0) byCharId.set(s.charId, s);
  if (s.name) byName.set(s.name.toLowerCase(), s);
}

function unregisterSession(s: MsgSession): void {
  if (s.charId > 0 && byCharId.get(s.charId) === s) byCharId.delete(s.charId);
  if (s.name && byName.get(s.name.toLowerCase()) === s) byName.delete(s.name.toLowerCase());
  if (s.charId > 0) pendingByTarget.delete(s.charId);
}

async function loadChar(charId: number): Promise<{ name: string; level: number }> {
  const rows = await query<RowDataPacket[]>(
    "SELECT name, level FROM characters WHERE ID = ? LIMIT 1",
    [charId],
  );
  return {
    name: String(rows[0]?.name ?? "").trim(),
    level: Number(rows[0]?.level ?? 1),
  };
}

async function findCharByName(name: string): Promise<{ id: number; name: string; level: number } | null> {
  const rows = await query<RowDataPacket[]>(
    "SELECT ID, name, level FROM characters WHERE name = ? LIMIT 1",
    [name],
  );
  if (!rows[0]) return null;
  return {
    id: Number(rows[0].ID),
    name: String(rows[0].name),
    level: Number(rows[0].level ?? 1),
  };
}

async function listFriends(charId: number): Promise<FriendRow[]> {
  const rows = await query<RowDataPacket[]>(
    `SELECT c.ID AS id, c.name AS name, c.level AS level
     FROM friends f
     JOIN characters c ON c.ID = f.friendid
     WHERE f.charid = ?
     ORDER BY c.name
     LIMIT ?`,
    [charId, MAX_FRIENDS],
  );
  return rows.map((r) => {
    const id = Number(r.id);
    const online = byCharId.has(id);
    return {
      charId: id,
      name: String(r.name ?? ""),
      level: Number(r.level ?? 1),
      // Single-channel private server for now.
      channel: online ? 1 : 0,
      online,
    };
  });
}

async function areFriends(a: number, b: number): Promise<boolean> {
  const rows = await query<RowDataPacket[]>(
    "SELECT 1 AS ok FROM friends WHERE charid = ? AND friendid = ? LIMIT 1",
    [a, b],
  );
  return rows.length > 0;
}

async function addFriendship(a: number, b: number): Promise<void> {
  await execute("INSERT IGNORE INTO friends (charid, friendid) VALUES (?, ?), (?, ?)", [a, b, b, a]);
}

async function friendCount(charId: number): Promise<number> {
  const rows = await query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM friends WHERE charid = ?",
    [charId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function listLetters(charId: number): Promise<LetterRow[]> {
  const rows = await query<RowDataPacket[]>(
    `SELECT id, from_name, body, sent_at, unread
     FROM letters
     WHERE to_charid = ?
     ORDER BY id DESC
     LIMIT ?`,
    [charId, MAX_LETTERS],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    fromName: String(r.from_name ?? "").trim(),
    body: String(r.body ?? ""),
    sentAt: r.sent_at instanceof Date ? r.sent_at : new Date(String(r.sent_at)),
    unread: Number(r.unread ?? 1) !== 0,
  }));
}

async function letterCount(charId: number): Promise<number> {
  const rows = await query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM letters WHERE to_charid = ?",
    [charId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function pushLetterList(s: MsgSession): Promise<void> {
  if (s.charId <= 0) {
    send(s, buildLetterList(s.unk, []));
    return;
  }
  const letters = await listLetters(s.charId);
  send(s, buildLetterList(s.unk, letters));
  mlog(`  tx LetterList 0x41 char=${s.charId} letters=${letters.length}`);
}

/** On login: play the same letter-recv animation used for live delivery if unread mail exists. */
async function notifyUnreadOnLogin(s: MsgSession): Promise<void> {
  if (s.charId <= 0) return;
  const rows = await query<RowDataPacket[]>(
    `SELECT from_name FROM letters
     WHERE to_charid = ? AND unread <> 0
     ORDER BY id DESC
     LIMIT 1`,
    [s.charId],
  );
  if (!rows.length) return;
  const fromName = String(rows[0]?.from_name ?? "").trim() || "Unknown";
  send(s, buildLetterRecv(s.unk, fromName));
  mlog(`  tx LetterRecv 0x43 (unread on login) char=${s.charId} from="${fromName}"`);
}

async function handleLetterSend(s: MsgSession, toName: string, body: string): Promise<void> {
  if (!s.charId || !s.name) {
    mlog(`  LetterSend ignored — session not logged in`);
    return;
  }
  if (!toName) {
    mlog(`  LetterSend empty recipient from char=${s.charId}`);
    return;
  }
  if (toName.toLowerCase() === s.name.toLowerCase()) {
    mlog(`  LetterSend self ignored char=${s.charId}`);
    return;
  }

  const target = await findCharByName(toName);
  if (!target) {
    mlog(`  LetterSend target not found "${toName}"`);
    return;
  }

  // Keep mailbox at 30 — drop oldest when full.
  while ((await letterCount(target.id)) >= MAX_LETTERS) {
    await execute("DELETE FROM letters WHERE to_charid = ? ORDER BY id ASC LIMIT 1", [target.id]);
  }

  const text = body.slice(0, LETTER_BODY_LEN);
  await execute("INSERT INTO letters (to_charid, from_name, body, unread) VALUES (?, ?, ?, 1)", [
    target.id,
    s.name.slice(0, NAME_LEN),
    text,
  ]);
  mlog(`  LetterSend OK ${s.name}(${s.charId}) -> ${target.name}(${target.id}) len=${text.length}`);

  const other = byCharId.get(target.id) ?? byName.get(target.name.toLowerCase());
  if (other) {
    send(other, buildLetterRecv(other.unk, s.name));
    mlog(`  tx LetterRecv 0x43 to char=${other.charId}`);
  }
}

async function handleLetterDel(s: MsgSession, slot: number): Promise<void> {
  if (!s.charId || slot < 0 || slot >= MAX_LETTERS) {
    mlog(`  LetterDel bad slot=${slot} char=${s.charId}`);
    await pushLetterList(s);
    return;
  }
  const letters = await listLetters(s.charId);
  const letter = letters[slot];
  if (!letter) {
    mlog(`  LetterDel empty slot=${slot} char=${s.charId}`);
    await pushLetterList(s);
    return;
  }
  await execute("DELETE FROM letters WHERE id = ? AND to_charid = ?", [letter.id, s.charId]);
  mlog(`  LetterDel slot=${slot} id=${letter.id} char=${s.charId}`);
  await pushLetterList(s);
}

async function handleLetterDelAll(s: MsgSession): Promise<void> {
  if (!s.charId) return;
  await execute("DELETE FROM letters WHERE to_charid = ?", [s.charId]);
  mlog(`  LetterDelAll char=${s.charId}`);
  await pushLetterList(s);
}

async function handleLetterRead(s: MsgSession, slot: number): Promise<void> {
  if (!s.charId || slot < 0 || slot >= MAX_LETTERS) return;
  const letters = await listLetters(s.charId);
  const letter = letters[slot];
  if (!letter) return;
  if (!letter.unread) {
    mlog(`  LetterRead slot=${slot} id=${letter.id} already read char=${s.charId}`);
    return;
  }
  await execute("UPDATE letters SET unread = 0 WHERE id = ? AND to_charid = ?", [
    letter.id,
    s.charId,
  ]);
  mlog(`  LetterRead slot=${slot} id=${letter.id} char=${s.charId} marked read`);
  // Refresh so client gets isRead=1 and won't keep re-acking.
  await pushLetterList(s);
}

async function pushFriendList(s: MsgSession): Promise<void> {
  if (s.charId <= 0) {
    send(s, buildFriendList(s.unk, []));
    return;
  }
  const friends = await listFriends(s.charId);
  send(s, buildFriendList(s.unk, friends));
  mlog(`  tx FriendList 0x49 char=${s.charId} friends=${friends.length}`);
}

async function notifyOnline(s: MsgSession): Promise<void> {
  if (!s.name || s.charId <= 0) return;
  const friends = await listFriends(s.charId);
  for (const f of friends) {
    const other = byCharId.get(f.charId);
    if (!other) continue;
    send(other, buildFriendOnline(other.unk, s.name));
    send(s, buildFriendOnline(s.unk, other.name || f.name));
  }
}

function addPending(targetId: number, fromId: number, fromName: string): void {
  let m = pendingByTarget.get(targetId);
  if (!m) {
    m = new Map();
    pendingByTarget.set(targetId, m);
  }
  m.set(fromId, { name: fromName });
}

function takePending(targetId: number, fromId: number): boolean {
  const m = pendingByTarget.get(targetId);
  if (!m?.has(fromId)) return false;
  m.delete(fromId);
  if (m.size === 0) pendingByTarget.delete(targetId);
  return true;
}

/** Invite only — do not add friendship or send 0x4C until 0x4B accept. */
async function handleFriendAdd(s: MsgSession, targetName: string): Promise<void> {
  if (!s.charId || !s.name) {
    mlog(`  FriendAdd ignored — session not logged in`);
    return;
  }
  if (!targetName) {
    mlog(`  FriendAdd empty name from char=${s.charId}`);
    return;
  }
  if (targetName.toLowerCase() === s.name.toLowerCase()) {
    mlog(`  FriendAdd self ignored char=${s.charId}`);
    return;
  }

  const target = await findCharByName(targetName);
  if (!target) {
    mlog(`  FriendAdd target not found "${targetName}"`);
    send(s, buildFriendAddAck(s.unk, RESULT_FAIL));
    return;
  }
  if (await areFriends(s.charId, target.id)) {
    mlog(`  FriendAdd already friends ${s.charId}<->${target.id}`);
    send(s, buildFriendAddAck(s.unk, RESULT_OK));
    await pushFriendList(s);
    return;
  }
  if ((await friendCount(s.charId)) >= MAX_FRIENDS || (await friendCount(target.id)) >= MAX_FRIENDS) {
    mlog(`  FriendAdd list full`);
    send(s, buildFriendAddAck(s.unk, RESULT_FULL));
    return;
  }

  addPending(target.id, s.charId, s.name);
  mlog(`  FriendInvite pending ${s.name}(${s.charId}) -> ${target.name}(${target.id})`);

  const other = byCharId.get(target.id) ?? byName.get(target.name.toLowerCase());
  if (other) {
    send(other, buildFriendInviteNotify(other.unk, s.name));
    mlog(`  tx InviteNotify 0x4A to char=${other.charId}`);
  } else {
    mlog(`  target offline — invite queued until login (not persisted)`);
  }
}

async function handleFriendReply(s: MsgSession, fromName: string, flag: number): Promise<void> {
  if (!s.charId || !s.name) return;

  const inviter = await findCharByName(fromName);
  if (!inviter) {
    mlog(`  FriendReply unknown inviter "${fromName}"`);
    return;
  }

  const accept = flag === 0;
  const had = takePending(s.charId, inviter.id);
  mlog(
    `  FriendReply ${accept ? "ACCEPT" : "REJECT"} flag=${flag} from=${fromName}(${inviter.id}) by=${s.name}(${s.charId}) pending=${had}`,
  );

  const other = byCharId.get(inviter.id) ?? byName.get(inviter.name.toLowerCase());

  if (!accept) {
    if (other) send(other, buildFriendAddAck(other.unk, RESULT_FAIL));
    return;
  }

  if (await areFriends(s.charId, inviter.id)) {
    send(s, buildFriendAddAck(s.unk, RESULT_OK));
    await pushFriendList(s);
    return;
  }

  if ((await friendCount(s.charId)) >= MAX_FRIENDS || (await friendCount(inviter.id)) >= MAX_FRIENDS) {
    send(s, buildFriendAddAck(s.unk, RESULT_FULL));
    if (other) send(other, buildFriendAddAck(other.unk, RESULT_FULL));
    return;
  }

  await addFriendship(s.charId, inviter.id);
  mlog(`  FriendAdd OK ${s.name}(${s.charId}) <-> ${inviter.name}(${inviter.id})`);

  send(s, buildFriendAddAck(s.unk, RESULT_OK));
  await pushFriendList(s);
  if (other) {
    send(other, buildFriendAddAck(other.unk, RESULT_OK));
    await pushFriendList(other);
    send(other, buildFriendOnline(other.unk, s.name));
    send(s, buildFriendOnline(s.unk, other.name || inviter.name));
  }
}

function attachClient(sock: net.Socket, tag: string): void {
  const remote = `${sock.remoteAddress}:${sock.remotePort}`;
  mlog(`connect ${tag} from ${remote}`);
  const session: MsgSession = {
    sock,
    tag,
    charId: 0,
    name: "",
    unk: 1,
    listSent: false,
    buf: Buffer.alloc(0),
  };
  sessions.set(sock, session);

  try {
    sock.write(buildGameLog(1));
    mlog(`  tx GameLog 0x0B`);
  } catch {
    /* ignore */
  }

  sock.on("data", (d) => {
    void (async () => {
      mlog(`rx ${tag} ${d.length}b ${d.toString("hex")}`);
      session.buf = Buffer.concat([session.buf, d]);
      const { frames, rest } = peelGame(session.buf);
      session.buf = rest;

      for (const frame of frames) {
        if (frame.length < 12) continue;
        const magic = frame.readUInt16LE(0);
        const op = frame.readUInt16LE(2);
        const totalLen = frame.readUInt16LE(4);
        session.unk = frame.readUInt32LE(8) >>> 0;
        const body = frame.subarray(12);
        let ascii = "";
        try {
          ascii = body.toString("utf8").replace(/[^\x20-\x7e]/g, ".");
        } catch {
          /* ignore */
        }
        mlog(
          `  frame magic=0x${magic.toString(16)} op=0x${op.toString(16)} len=${totalLen} unk=${session.unk} ascii="${ascii.slice(0, 96)}"`,
        );

        try {
          if (op === OP_FRIEND_LIST_REQ && frame.length >= 16) {
            session.charId = frame.readUInt32LE(12);
            const ch = await loadChar(session.charId);
            session.name = ch.name || session.name;
            registerSession(session);
            mlog(`  FriendListReq charId=${session.charId} name="${session.name}"`);
            await pushFriendList(session);
            session.listSent = true;
            send(session, buildMessengerReady(session.unk));
            mlog(`  tx MessengerReady 0x09`);
            await notifyOnline(session);
            await notifyUnreadOnLogin(session);
          } else if (op === OP_FRIEND_REFRESH) {
            mlog(`  FriendListRefresh 0x48 char=${session.charId}`);
            await pushFriendList(session);
            if (!session.listSent) {
              send(session, buildMessengerReady(session.unk));
              session.listSent = true;
            }
          } else if (op === OP_FRIEND_ADD) {
            const name = readCString(body, 0, NAME_LEN);
            mlog(`  FriendAddReq from char=${session.charId} target="${name}"`);
            await handleFriendAdd(session, name);
          } else if (op === OP_FRIEND_REPLY) {
            const name = readCString(body, 0, NAME_LEN);
            const flag = body.length >= 0x14 ? body.readInt32LE(0x14) : 0;
            mlog(`  FriendInviteReply char=${session.charId} from="${name}" flag=${flag}`);
            await handleFriendReply(session, name, flag);
          } else if (op === OP_LETTER_LIST_REQ) {
            mlog(`  LetterListReq 0x40 char=${session.charId}`);
            await pushLetterList(session);
          } else if (op === OP_LETTER_SEND) {
            // body: flag@0, toName@1 (20), text@21 (512)
            const toName = body.length >= 21 ? readCString(body, 1, NAME_LEN) : "";
            const text =
              body.length >= 21 + LETTER_BODY_LEN
                ? readCString(body, 21, LETTER_BODY_LEN)
                : body.length > 21
                  ? readCString(body, 21, body.length - 21)
                  : "";
            mlog(
              `  LetterSend 0x42 from char=${session.charId} to="${toName}" text="${text.slice(0, 48)}"`,
            );
            await handleLetterSend(session, toName, text);
          } else if (op === OP_LETTER_DEL) {
            const slot = body.length >= 4 ? body.readInt32LE(0) : -1;
            mlog(`  LetterDel 0x45 char=${session.charId} slot=${slot}`);
            await handleLetterDel(session, slot);
          } else if (op === OP_LETTER_DEL_ALL) {
            mlog(`  LetterDelAll 0x46 char=${session.charId}`);
            await handleLetterDelAll(session);
          } else if (op === OP_LETTER_READ) {
            const slot = body.length >= 4 ? body.readInt32LE(0) : -1;
            mlog(`  LetterRead 0x47 char=${session.charId} slot=${slot}`);
            await handleLetterRead(session, slot);
          } else if (op === OP_KEEPALIVE) {
            mlog(`  keepalive 0x5A`);
          } else {
            mlog(`  unhandled op=0x${op.toString(16)}`);
          }
        } catch (e) {
          mlog(`  handler error op=0x${op.toString(16)}: ${e}`);
        }
      }
    })();
  });

  sock.on("error", () => undefined);
  sock.on("close", () => {
    mlog(`close ${tag} ${remote} char=${session.charId} name="${session.name}"`);
    unregisterSession(session);
    sessions.delete(sock);
  });
}

export function startMessengerStub(ports: number | number[] = [17201, 13070]): net.Server[] {
  const fl = buildFriendList(1, []);
  if (fl.length !== FRIEND_LIST_TOTAL) {
    console.warn(`[messenger] FriendList size ${fl.length} != 0x3cc — check template`);
  }
  const ll = buildLetterList(1, []);
  if (ll.length !== LETTER_LIST_TOTAL) {
    console.warn(`[messenger] LetterList size ${ll.length} != 0x3f18 — check template`);
  }
  const list = Array.isArray(ports) ? ports : [ports];
  const servers: net.Server[] = [];
  for (const port of list) {
    const srv = net.createServer((sock) => attachClient(sock, `:${port}`));
    srv.on("error", (e) => console.warn(`[messenger] :${port} error`, e.message));
    srv.listen(port, "0.0.0.0", () => mlog(`listening 0.0.0.0:${port}`));
    servers.push(srv);
  }
  return servers;
}
