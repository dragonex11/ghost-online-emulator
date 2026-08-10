import { hexToBuf } from "../net/packet.js";

export const VALIDPAS = hexToBuf("AA550500310000E80355AA");
export const INVALIDPAS = hexToBuf("AA550500310D00000055AA");

/** Redirect client to field 127.0.0.1:15023 */
export const LPACKET = hexToBuf(
  "AA551800350009003132372E302E302E31AF3A000000005F003B000055AA",
);

export const LOGIN_OPCODE_SERVERLIST = 0x0033;
export const LOGIN_OPCODE_LOGIN_ACK = 0x0031;

/** Private-server defaults for custom channel list builder */
export const DEFAULT_CHANNEL_IP = "127.0.0.1";
export const DEFAULT_MAX_PLAYERS = 800;
export const DEFAULT_CHANNEL_FLAG = 1;
export const STOCK_CHANNEL_B_VALUE = 12;

/** Server list refresh interval (ms) */
export const SERVER_LIST_REFRESH_MS = 8000;

/** Stock template path segment */
export const STOCK_LIST_REL_PATH = ["src", "data", "str1_base.hex"] as const;

export function hexLE32(n: number): string {
  const v = n >>> 0;
  return (
    (v & 0xff).toString(16).padStart(2, "0") +
    ((v >> 8) & 0xff).toString(16).padStart(2, "0") +
    ((v >> 16) & 0xff).toString(16).padStart(2, "0") +
    ((v >> 24) & 0xff).toString(16).padStart(2, "0")
  ).toUpperCase();
}
