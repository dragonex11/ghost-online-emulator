import { setOnlineCount } from "../net/online.js";
import { players } from "./player.js";

export function countOnline(): number {
  let n = 0;
  for (const p of players.values()) if (p.loggedIn) n++;
  setOnlineCount(n);
  return n;
}
