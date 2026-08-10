import { readCString } from "./packet.js";

export type InetCredentials = {
  username: string;
  password: string;
  key: number | null;
  raw: string;
};

/**
 * Match legacy _GETACCOUNTID: C-string at +17 skips leading "INET ", then
 * StringSplit 1-based [2]=username [4]=password → 0-based [1] and [3].
 * Full string from +12 is "INET 1000 ADMIN 0 admin ..." (C# uses [2]/[4] on that).
 * client sends encoded password; key is the numeric field after INET.
 */
export function parseInetCredentials(pkt: Buffer): InetCredentials {
  const rawFrom12 = readCString(pkt, 12, 240);
  const raw = readCString(pkt, 17, 240);

  const full = rawFrom12.split(" ");
  if (full[0] === "INET" && full.length > 4) {
    const key = /^\d+$/.test(full[1] ?? "") ? Number(full[1]) : null;
    return { username: full[2] ?? "", password: full[4] ?? "", key, raw: rawFrom12 };
  }

  const parts = raw.split(" ");
  if (parts.length > 3) {
    const key = /^\d+$/.test(parts[0] ?? "") ? Number(parts[0]) : null;
    return { username: parts[1] ?? "", password: parts[3] ?? "", key, raw };
  }

  const tok = raw.split(/\s+/).filter(Boolean);
  if (tok.length >= 4 && /^\d+$/.test(tok[0]!)) {
    return { username: tok[1] ?? "", password: tok[3] ?? "", key: Number(tok[0]), raw };
  }
  if (tok.length >= 2) {
    return { username: tok[0] ?? "", password: tok[1] ?? "", key: null, raw };
  }
  return { username: "", password: "", key: null, raw };
}

/**
 * Field login variants: try INET at +12 / +16 / +17 (alternate layouts).
 */
export function parseFieldInetCredentials(pkt: Buffer): InetCredentials {
  const raw12 = readCString(pkt, 12, 240);
  const raw16 = readCString(pkt, 16, 240);
  const raw17 = readCString(pkt, 17, 240);
  const candidates = [raw12, raw16, raw17].filter(Boolean);

  for (const s of candidates) {
    const full = s.split(" ");
    if (full[0] === "INET" && full.length > 4) {
      return {
        username: full[2] ?? "",
        password: full[4] ?? "",
        key: /^\d+$/.test(full[1] ?? "") ? Number(full[1]) : null,
        raw: s,
      };
    }
    const parts = s.split(" ");
    if (parts.length > 3 && /^\d+$/.test(parts[0] ?? "")) {
      return {
        key: Number(parts[0]),
        username: parts[1] ?? "",
        password: parts[3] ?? "",
        raw: s,
      };
    }
  }
  return { username: "", password: "", key: null, raw: "" };
}
