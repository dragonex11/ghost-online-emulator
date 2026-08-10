import net from "node:net";
import type { RowDataPacket } from "mysql2";
import { config } from "../config.js";
import { query, execute, withConnection } from "../db/index.js";
import { peelGame, opcodeOf, readCString, writeCString, writeHeader, logPkt, bufToHex } from "../net/packet.js";
import { decodePassword, encodePassword } from "../login/passwordCodec.js";
import { parseInetCredentials } from "../net/inetAuth.js";
import { PACKET_MAGIC } from "../protocol/magic.js";
import {
  CHAR_SLOTS,
  CHAR_SLOT_BYTES,
  NEW_CHAR_SOUL_ITEM_ID,
  OP_CHARSTATUS_REQ,
  OP_CHARSTATUS,
  OP_CREATE_ACK,
  OP_CREATE_CHAR,
  OP_CHECK_NAME,
  OP_DELETE_ACK,
  OP_DELETE_CHAR,
  OP_NAME_ACK,
  EQUIP_SLOT_WEAPON,
  EQUIP_SLOT_ARMOR,
  EQUIP_SLOT_CAPE,
  EQUIP_SLOT_HAT,
  EQUIP_SLOT_EYE,
  EQUIP_SLOT_FACE_UPPER,
  EQUIP_SLOT_CLOTHES,
  EQUIP_SLOT_FACE_LOWER,
  EQUIP_SLOT_HAIR,
} from "./constants.js";
import { CREATE_CHAR_MULTI_STATEMENT, DELETE_CHARACTERS_BY_ID, DELETE_EQUIP_BY_CHARID, DELETE_OTHER_BY_CHARID, DELETE_SKILLS_BY_CHARID, DELETE_SPEND_BY_CHARID, SELECT_CHARACTERS_BY_NAME, SELECT_CHARACTERS_BY_NAME_AND_USERID, SELECT_CHARACTERS_BY_USERID, SELECT_CHARACTERS_BY_USERID_2, selectEquipByCharIdsIn, SELECT_USERS_BY_USERNAME } from "../db/queries/index.js";

type Client = {
  sock: net.Socket;
  buf: Buffer;
  accountId: number;
  magic: number;
  /** Session token from request header +8; echoed in replies. */
  unk: number;
};

/** Match legacy _GETACCOUNTID — see parseInetCredentials. */
function parseCredentials(pkt: Buffer) {
  return parseInetCredentials(pkt);
}

async function getAccountId(pkt: Buffer): Promise<number> {
  const { username, password, key } = parseCredentials(pkt);
  if (!username) return 0;
  const rows = await query<RowDataPacket[]>(SELECT_USERS_BY_USERNAME, [username]);
  if (!rows.length) {
    console.log("[channel] auth fail: unknown user");
    return 0;
  }
  const dbPass = String(rows[0].password);
  const plain = key != null ? decodePassword(password, key) : null;
  const ok =
    dbPass === password ||
    (key != null && encodePassword(dbPass, key) === password) ||
    (plain != null && dbPass === plain) ||
    (plain != null && dbPass.toLowerCase() === plain.toLowerCase());
  if (!ok) {
    console.log(`[channel] auth fail: bad password for user=${username}`);
    return 0;
  }
  return Number(rows[0].accountid);
}

/** Load equipped items for many chars in one round-trip. */
async function getEquippedBatch(charIds: number[]): Promise<Map<number, Record<number, number>>> {
  const out = new Map<number, Record<number, number>>();
  for (const id of charIds) out.set(id, {});
  if (!charIds.length) return out;
  const ph = charIds.map(() => "?").join(",");
  const rows = await query<RowDataPacket[]>(
    selectEquipByCharIdsIn(ph),
    charIds,
  );
  for (const r of rows) {
    const cid = Number(r.charid);
    const map = out.get(cid) ?? {};
    map[Number(r.pos2)] = Number(r.type);
    out.set(cid, map);
  }
  return out;
}

async function charStatus(accountId: number, magic = PACKET_MAGIC, unk = 0): Promise<Buffer> {
  const chars = await query<RowDataPacket[]>(
    SELECT_CHARACTERS_BY_USERID,
    [accountId],
  );
  const slots = CHAR_SLOTS;
  const total = 16 + slots * CHAR_SLOT_BYTES;
  const buf = Buffer.alloc(total, 0);
  writeHeader(buf, OP_CHARSTATUS, total, magic, unk);
  buf.writeUInt32LE(Math.min(chars.length, slots), 12);

  const n = Math.min(chars.length, slots);
  const ids = chars.slice(0, n).map((c) => Number(c.ID));
  const equips = await getEquippedBatch(ids);

  for (let i = 0; i < n; i++) {
    const c = chars[i]!;
    const base = 16 + i * CHAR_SLOT_BYTES;
    writeCString(buf, base, String(c.name ?? ""), 40);
    // sex@+40, level@+41, job@+42 relative to slot base
    buf.writeUInt8(Number(c.sex ?? 0), base + 40);
    buf.writeUInt8(Number(c.level ?? 1), base + 41);
    buf.writeUInt8(Number(c.job ?? 0), base + 42);

    // +43 is a signed gate used for BOTH the select-screen bubble and class-name path:
    //   0xFF (-1) → no bubble; parchment uses basic job→Peasant/Warrior/Assassin/Magician
    //   else      → bubble on; parchment takes advanced 2nd-job names (Knight/Ninja/…)
    // +44 is NOT the DB job2 class id (1–8). Client compares it to 0/1 only:
    //   0 = Order (Knight/Ninja/White Mage/…), 1 = Chaos (Dark Knight/Killer/…)
    // Sending class id 3 here fails the name lookup and Class stays as Level's "%d".
    const job2Raw = Number(c.job2);
    const job3Raw = Number(c.job3);
    const hasJob2 = Number.isFinite(job2Raw) && job2Raw >= 1 && job2Raw <= 8;
    const hasFaction = Number.isFinite(job3Raw) && job3Raw > 0;
    if (hasJob2) {
      buf.writeUInt8(1, base + 43); // bubble + advanced class names
      // Odd class ids = Order → 0; even = Chaos → 1 (same as job3 wire guild)
      buf.writeUInt8(job2Raw % 2 === 1 ? 0 : 1, base + 44);
    } else {
      buf.writeUInt8(0xff, base + 43); // no bubble + basic class names
      buf.writeUInt8(0xff, base + 44);
    }
    // Faction aura flag (ec1); CHARSTATUS may not read +45 on all builds.
    buf.writeUInt8(hasFaction ? 1 : 0, base + 45);

    const eq = equips.get(Number(c.ID)) ?? {};
    buf.writeUInt32LE(eq[EQUIP_SLOT_WEAPON] ?? 0, base + 52);
    buf.writeUInt32LE(eq[EQUIP_SLOT_ARMOR] ?? 0, base + 56);
    buf.writeUInt32LE(eq[EQUIP_SLOT_FACE_UPPER] ?? 0, base + 60);
    buf.writeUInt32LE(eq[EQUIP_SLOT_FACE_LOWER] ?? 0, base + 64);
    buf.writeUInt32LE(eq[EQUIP_SLOT_HAT] ?? 0, base + 68);
    buf.writeUInt32LE(eq[EQUIP_SLOT_EYE] ?? 0, base + 72);
    buf.writeUInt32LE(eq[EQUIP_SLOT_CLOTHES] ?? 0, base + 76);
    buf.writeUInt32LE(eq[EQUIP_SLOT_CAPE] ?? 0, base + 80);
    buf.writeUInt32LE(eq[EQUIP_SLOT_HAIR] ?? 0, base + 84);
  }
  return buf;
}

async function checkName(pkt: Buffer): Promise<boolean> {
  const name = readCString(pkt, 12, 20);
  const rows = await query<RowDataPacket[]>(SELECT_CHARACTERS_BY_NAME, [name]);
  return rows.length === 0;
}

async function createChar(accountId: number, pkt: Buffer): Promise<number> {
  const t0 = Date.now();
  const name = readCString(pkt, 12, 20);
  const sex = pkt.readUInt8(32);
  const eye = pkt.readUInt32LE(36);
  const hair = pkt.readUInt32LE(40);
  const weapon = pkt.readUInt32LE(44);
  const armor = pkt.readUInt32LE(48);
  const soul = NEW_CHAR_SOUL_ITEM_ID;

  // Two remote DB round-trips total (was ~18): meta SELECT, then multi-statement inserts.
  const numChars = await withConnection(async (conn) => {
    const [metaRows] = await conn.query<RowDataPacket[]>(
      SELECT_CHARACTERS_BY_NAME_AND_USERID,
      [name, accountId],
    );
    const meta = metaRows[0]!;
    if (Number(meta.name_taken) > 0) return 0;

    const charId = Number(meta.max_id) + 1;
    const eid0 = Number(meta.max_eid);
    const prevCount = Number(meta.char_count);

    await conn.query(
      CREATE_CHAR_MULTI_STATEMENT,
      [
        charId, name, accountId, sex,
        eid0 + 1, weapon, charId,
        eid0 + 2, armor, charId,
        eid0 + 3, soul, charId,
        eid0 + 4, hair, charId,
        eid0 + 5, eye, charId,
        charId, 1, charId, 2, charId, 3, charId, 4,
      ],
    );
    return prevCount + 1;
  });

  console.log(`[channel] createChar name=${name} chars=${numChars} ${Date.now() - t0}ms`);
  return numChars;
}

async function deleteChar(accountId: number, pkt: Buffer): Promise<number> {
  const slot = pkt.readUInt8(12) & 0x0f;
  const chars = await query<RowDataPacket[]>(SELECT_CHARACTERS_BY_USERID_2, [accountId]);
  if (slot >= chars.length) return 0;
  const charId = Number(chars[slot]!.ID);
  await execute(DELETE_CHARACTERS_BY_ID, [charId]);
  await execute(DELETE_EQUIP_BY_CHARID, [charId]);
  await execute(DELETE_OTHER_BY_CHARID, [charId]);
  await execute(DELETE_SPEND_BY_CHARID, [charId]);
  await execute(DELETE_SKILLS_BY_CHARID, [charId]);
  return Math.max(0, chars.length - 1);
}

function createAck(numChars: number, magic = PACKET_MAGIC, unk = 0): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, OP_CREATE_ACK, 16, magic, unk);
  b.writeUInt8(1, 12);
  b.writeUInt8(numChars & 0xff, 13);
  return b;
}

function deleteAck(numChars: number, magic = PACKET_MAGIC, unk = 0): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, OP_DELETE_ACK, 16, magic, unk);
  b.writeUInt32LE(numChars, 12);
  return b;
}

function nameAck(ok: boolean, magic = PACKET_MAGIC, unk = 0): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, OP_NAME_ACK, 16, magic, unk);
  b.writeUInt32LE(ok ? 1 : 0, 12);
  return b;
}

async function handlePacket(client: Client, pkt: Buffer): Promise<void> {
  client.magic = pkt.readUInt16LE(0) || PACKET_MAGIC;
  client.unk = pkt.readUInt32LE(8);
  const op = opcodeOf(pkt);
  console.log(
    `[channel] pkt op=0x${op.toString(16)} magic=0x${client.magic.toString(16)} unk=${client.unk} len=${pkt.length} hex=${bufToHex(pkt.subarray(0, Math.min(64, pkt.length)))}`,
  );
  logPkt("IN", `channel op=${op.toString(16)}`, pkt);

  if (op === OP_CHARSTATUS_REQ) {
    // Future: age-verified channels reject via GAME_ACK status 0x1C.
    // PVP / Guild War (ch 10) are field/channel rules, not SERVERLIST flags — see login/server.ts.
    const aid = await getAccountId(pkt);
    client.accountId = aid;
    if (!aid) {
      console.log("[channel] login rejected — no CHARSTATUS sent");
      return;
    }
    const list = await charStatus(aid, client.magic, client.unk);
    client.sock.write(list);
    console.log(
      `[channel] CHARSTATUS sent account=${aid} magic=0x${client.magic.toString(16)} bytes=${list.length} head=${bufToHex(list.subarray(0, 16))}`,
    );
    logPkt("OUT", "channel CHARSTATUS", list);
  } else if (op === OP_CREATE_CHAR) {
    if (!client.accountId) return;
    const t0 = Date.now();
    const n = await createChar(client.accountId, pkt);
    // legacy: only 0x000b on success — no CHARSTATUS. Client enters UI mode 0x1B
    // (create→select jump cinematic); an immediate 0x0009 forces mode 0x0B and skips it.
    if (n > 0) {
      client.sock.write(createAck(n, client.magic, client.unk));
      console.log(`[channel] createAck account=${client.accountId} chars=${n} ${Date.now() - t0}ms`);
    } else {
      console.log(`[channel] create failed account=${client.accountId} ${Date.now() - t0}ms`);
    }
  } else if (op === OP_DELETE_CHAR) {
    if (!client.accountId) return;
    const n = await deleteChar(client.accountId, pkt);
    // legacy: deleteAck only (no CHARSTATUS)
    client.sock.write(deleteAck(n, client.magic, client.unk));
  } else if (op === OP_CHECK_NAME) {
    const ok = await checkName(pkt);
    client.sock.write(nameAck(ok, client.magic, client.unk));
  }
}

export function startChannelServer(): net.Server {
  const server = net.createServer((sock) => {
    const client: Client = { sock, buf: Buffer.alloc(0), accountId: 0, magic: PACKET_MAGIC, unk: 0 };
    console.log("[channel] connect from", sock.remoteAddress, sock.remotePort);

    sock.on("data", async (chunk) => {
      console.log(`[channel] raw +${chunk.length}B ${bufToHex(chunk.subarray(0, Math.min(48, chunk.length)))}`);
      client.buf = Buffer.concat([client.buf, chunk]);
      const { frames, rest } = peelGame(client.buf);
      client.buf = rest;
      if (!frames.length && client.buf.length >= 12) {
        console.log(
          `[channel] buffered ${client.buf.length}B waiting (lenField=${client.buf.readUInt16LE(4)})`,
        );
      }
      for (const pkt of frames) {
        try {
          await handlePacket(client, pkt);
        } catch (e) {
          console.error("[channel] error", e);
        }
      }
    });

    sock.on("close", () => console.log("[channel] disconnect"));
    sock.on("error", (e) => console.log("[channel] sock err", e.message));
  });

  server.listen(config.channelPort, config.channelHost, () => {
    console.log(`[channel] listening ${config.channelHost}:${config.channelPort}`);
  });
  return server;
}
