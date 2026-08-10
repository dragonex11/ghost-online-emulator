import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { config, rates } from "../config.js";
import { query, execute } from "../db.js";
import { frameAA55, peelAA55, hexToBuf, logPkt, bufToHex } from "../net/packet.js";
import { getOnlineCount } from "../net/online.js";
import { decodePassword, encodePassword, readPasswordKey } from "./passwordCodec.js";
import type { RowDataPacket } from "mysql2";
import { INSERT_USERS, SELECT_USERS, SELECT_USERS_BY_USERNAME_3 } from "../db/queries/index.js";

const VALIDPAS = hexToBuf("AA550500310000E80355AA");
const INVALIDPAS = hexToBuf("AA550500310D00000055AA");

/** Redirect client to field 127.0.0.1:15023 */
const LPACKET = hexToBuf(
  "AA551800350009003132372E302E302E31AF3A000000005F003B000055AA",
);

function hexLE32(n: number): string {
  const v = n >>> 0;
  return (
    (v & 0xff).toString(16).padStart(2, "0") +
    ((v >> 8) & 0xff).toString(16).padStart(2, "0") +
    ((v >> 16) & 0xff).toString(16).padStart(2, "0") +
    ((v >> 24) & 0xff).toString(16).padStart(2, "0")
  ).toUpperCase();
}

/**
 * SERVERLIST_ACK (opcode 0x33) — future channel/server feature notes (server-only; client already supports):
 *
 * Per-entry layout after IP: port u16, unk u16, count u32, maxPlayers u32, b u32 (=12 stock),
 * c u32 (=0 stock), **flag u8**, udpPort u32. Client stores flag at channel-object +0x2C.
 *
 * Stock list `u8` flag values (str1_base.hex) — NOT a PVP/18+ bitfield:
 *   1 = normal/live (ch 1–12), 2 = special/test-style (ch 13–16), 0 = hidden/disabled (ch 17–18).
 *
 * Features that are NOT this list byte (client-ready; wire from server when implementing):
 *   - 18+ / age-verified: UI badge `static_server_recommend`; reject with GAME_ACK status **0x1C**
 *     ("This is a age-verified channel. Please select other channels.").
 *   - PVP: gameplay / "PVP channel" rules — not a SERVERLIST flag.
 *   - Guild War: client expects **channel 10**; Forces War is a separate event flow.
 *   - Worlds / TEST tabs: btn_server1..8, btn_tserver1 — client UI grouping of list entries.
 *
 * LOGIN_ACK (0x31) statuses (account, not channel type): 0=ok (+Cyber Cafe if byte2=1),
 * 7–0xC freezes, 0xD bad ID, 0xE bad password, 0x1D hacking 1h ban.
 * GAME_ACK: 0=ok, 4=already logged in, 0x1C=age-verified reject.
 */
/** Build private-server channel list: channel 1 -> 127.0.0.1:15013 */
function buildServerList(): Buffer {
  const ip = "127.0.0.1";
  const ipBuf = Buffer.from(ip, "ascii");
  const count = getOnlineCount();
  // payload after AA55 length field
  // opcode 0x0033 + header junk + one channel entry (and pad zeros for client)
  const entrySize = 2 + 2 + 2 + ipBuf.length + 2 + 2 + 4 + 4 + 4 + 4 + 1 + 4;
  // Keep similar structure to stock: header 28 bytes then entries
  const header = Buffer.alloc(28, 0);
  header.writeUInt16LE(0x0033, 0);
  // stock junk
  Buffer.from("D0CFCFCFCFCFCFCFCFCFCFCF", "hex").copy(header, 2);
  header.writeUInt16LE(1, 14); // something
  header.writeUInt16LE(0, 16);
  header.writeUInt16LE(1, 18);
  header.writeUInt16LE(0, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt16LE(0, 24);
  header.writeUInt16LE(1, 26);

  const entry = Buffer.alloc(entrySize, 0);
  let o = 0;
  entry.writeUInt16LE(1, o); o += 2; // channelIdA
  entry.writeUInt16LE(1, o); o += 2; // channelIdB
  entry.writeUInt16LE(ipBuf.length, o); o += 2;
  ipBuf.copy(entry, o); o += ipBuf.length;
  entry.writeUInt16LE(config.channelPort, o); o += 2; // 15013
  entry.writeUInt16LE(0, o); o += 2;
  entry.writeUInt32LE(count, o); o += 4;
  entry.writeUInt32LE(800, o); o += 4;
  entry.writeUInt32LE(12, o); o += 4;
  entry.writeUInt32LE(0, o); o += 4;
  entry.writeUInt8(1, o); o += 1; // list flag: stock 0/1/2 only (see block comment above)
  entry.writeUInt32LE(config.udpPort, o); o += 4; // 13997

  // Also try loading stock template and patching FEEDFACE if present (compat)
  try {
    const stockPath = path.join(config.rootDir, "src", "data", "str1_base.hex");
    if (fs.existsSync(stockPath)) {
      let hex = fs.readFileSync(stockPath, "utf8").trim();
      hex = hex.replace(/FEEDFACE/gi, hexLE32(count));
      // Prefer custom PS list for channel 1 IP — still send stock for client that expects many channels
      const stock = Buffer.from(hex, "hex");
      // Patch channel-1 current players already done; also patch first IP region if possible
      return frameAA55(stock.subarray(4, stock.length - 2)); // stock file is full AA55 frame without? 
      // str1_base.hex is FULL frame including AA55...55AA from legacy 0x string (no AA55 wrapper in hex - includes AA55)
      // Actually hex starts with AA553803... so it's full frame. Return as-is.
    }
  } catch {
    /* fall through */
  }

  const payload = Buffer.concat([header, entry]);
  return frameAA55(payload);
}

function serverListPacket(): Buffer {
  // Use stock template with online count patched — the client expects full multi-channel layout
  try {
    const stockPath = path.join(config.rootDir, "src", "data", "str1_base.hex");
    let hex = fs.readFileSync(stockPath, "utf8").trim();
    hex = hex.replace(/FEEDFACE/gi, hexLE32(getOnlineCount()));
    const full = Buffer.from(hex, "hex");
    const ip = "127.0.0.1";
    // Patch EVERY channel entry IP -> 127.0.0.1 (padded) and port -> channelPort
    if (full.length > 50 && full[0] === 0xaa) {
      let off = 28; // first entry
      while (off + 8 < full.length - 2) {
        const idA = full.readUInt16LE(off);
        const idB = full.readUInt16LE(off + 2);
        const ipLen = full.readUInt16LE(off + 4);
        if (ipLen < 7 || ipLen > 64 || off + 6 + ipLen + 2 > full.length) break;
        const padded = Buffer.alloc(ipLen, 0);
        Buffer.from(ip, "ascii").copy(padded);
        padded.copy(full, off + 6);
        const portOff = off + 6 + ipLen;
        full.writeUInt16LE(config.channelPort, portOff);
        // Entry: idA u16, idB u16, ipLen u16, ip[ipLen], port u16, unk u16, count u32,
        //        a u32, b u32, c u32, flag u8 (0/1/2), udpPort u32  => ipLen+31
        // (flag left as stock; see buildServerList block comment for 18+/PVP/war notes)
        const stride = ipLen + 31;
        if (idA === 0 && idB === 0) break;
        off += stride;
        if (off + 20 >= full.length - 2) break;
      }
      return full;
    }
    return full;
  } catch {
    return buildServerList();
  }
}

async function checkUser(frame: Buffer): Promise<boolean> {
  // frame includes AA55 header; username at +5 len, +7 name (same as legacy on full packet)
  // Password on the wire is client-encoded; key is u16 LE immediately after password bytes.
  if (frame.length < 10) return false;
  const uLen = frame[5] ?? 0;
  if (frame.length < 7 + uLen + 1) return false;
  const username = frame.subarray(7, 7 + uLen).toString("ascii");
  const pLen = frame[7 + uLen] ?? 0;
  const pOff = 7 + uLen + 2;
  if (frame.length < pOff + pLen) return false;
  const wirePass = frame.subarray(pOff, pOff + pLen).toString("ascii");
  const key = readPasswordKey(frame, pOff, pLen);
  const plainFromWire = key != null ? decodePassword(wirePass, key) : null;

  const rows = await query<RowDataPacket[]>(SELECT_USERS_BY_USERNAME_3, [username]);
  if (!rows.length) {
    // Prefer storing decoded plaintext so later logins (new key each time) still work.
    const toStore = plainFromWire ?? wirePass;
    const maxRows = await query<RowDataPacket[]>(SELECT_USERS);
    const next = Number(maxRows[0]?.m ?? 0) + 1;
    await execute(INSERT_USERS, [
      next,
      username,
      toStore,
      0,
      rates.defaultGamePoints,
    ]);
    console.log(`[login] created user ${username}`);
    return true;
  }
  const dbPass = String(rows[0].password);
  // Accept plaintext DB vs encoded wire, or exact wire match (legacy / already-encoded rows).
  const ok =
    (key != null && encodePassword(dbPass, key) === wirePass) ||
    dbPass === wirePass ||
    (plainFromWire != null && dbPass === plainFromWire) ||
    (plainFromWire != null && dbPass.toLowerCase() === plainFromWire.toLowerCase());
  if (!ok) {
    console.log(`[login] bad password for ${username}`);
  }
  return ok;
}

type Client = { sock: net.Socket; buf: Buffer; authed: boolean; id: number };

export function startLoginServer(): net.Server {
  let nextId = 1;
  const clients = new Map<net.Socket, Client>();

  const server = net.createServer((sock) => {
    const client: Client = { sock, buf: Buffer.alloc(0), authed: false, id: nextId++ };
    clients.set(sock, client);
    console.log(`[login] connect #${client.id}`);

    sock.on("data", async (chunk) => {
      client.buf = Buffer.concat([client.buf, chunk]);
      const { frames, rest } = peelAA55(client.buf);
      client.buf = rest;
      for (const frame of frames) {
        logPkt("IN", `login#${client.id}`, frame);
        try {
          if (!client.authed) {
            const ok = await checkUser(frame);
            const out = ok ? VALIDPAS : INVALIDPAS;
            sock.write(out);
            logPkt("OUT", `login#${client.id}`, out);
            if (ok) {
              client.authed = true;
              // client expects a channel list right after auth; don't wait for AA550100.
              const list = serverListPacket();
              sock.write(list);
              logPkt("OUT", `login#${client.id} list-after-auth`, list);
              console.log(`[login] #${client.id} auth ok → sent channel list`);
            }
          }
          // opcode discriminator from legacy StringLeft 10 of hex "0xAA55...."
          const head = "0x" + bufToHex(frame.subarray(0, 4));
          console.log(`[login] #${client.id} frame head=${head} len=${frame.length} authed=${client.authed}`);
          // legacy matched StringLeft hex "0xAA550100" / "0xAA550500" (bytes AA 55 | len_lo len_hi)
          if (frame[0] === 0xaa && frame[1] === 0x55) {
            if (frame[2] === 0x01 && frame[3] === 0x00) {
              const list = serverListPacket();
              sock.write(list);
              logPkt("OUT", `login#${client.id} list`, list);
              console.log(`[login] #${client.id} list-request → sent channel list`);
            } else if (frame[2] === 0x05 && frame[3] === 0x00 && client.authed) {
              // Only treat as field redirect when already authed (avoid colliding with VALIDPAS-sized frames)
              sock.write(LPACKET);
              logPkt("OUT", `login#${client.id} field`, LPACKET);
            }
          }
        } catch (e) {
          console.error("[login] handler error", e);
        }
      }
    });

    const refresh = setInterval(() => {
      if (!client.authed || sock.destroyed) return;
      try {
        sock.write(serverListPacket());
      } catch {
        /* ignore */
      }
    }, 8000);

    sock.on("close", () => {
      clearInterval(refresh);
      clients.delete(sock);
    });
    sock.on("error", () => {
      clearInterval(refresh);
      clients.delete(sock);
    });
  });

  server.listen(config.loginPort, config.loginHost, () => {
    console.log(`[login] listening ${config.loginHost}:${config.loginPort}`);
  });
  return server;
}
