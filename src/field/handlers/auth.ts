import type { RowDataPacket } from "mysql2";
import { query, execute } from "../../db.js";
import { readCString } from "../../net/packet.js";
import { decodePassword, encodePassword } from "../../login/passwordCodec.js";
import { parseFieldInetCredentials } from "../../net/inetAuth.js";
import { SELECT_CHARACTERS_BY_USERID_3, SELECT_USERS_BY_USERNAME_2 } from "../../db/queries/index.js";

export async function resolveCharId(
  pkt: Buffer,
): Promise<{ accountId: number; charId: number; name: string } | null> {
  const { username, password, key } = parseFieldInetCredentials(pkt);

  // client field login (0x65dfaa): writes selected index to [esp+0xa60] AFTER three
  // pushes for sprintf — effective packet offset is +0x10C (268), same as legacy.
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

  const u = await query<RowDataPacket[]>(SELECT_USERS_BY_USERNAME_2, [
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
    SELECT_CHARACTERS_BY_USERID_3,
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
