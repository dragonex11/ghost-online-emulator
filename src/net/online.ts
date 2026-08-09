import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** Shared online count (Login reads; Field writes). Also mirrored to channel_online.txt for legacy compat. */
let online = 0;

export function getOnlineCount(): number {
  return Math.max(0, Math.min(800, online));
}

export function setOnlineCount(n: number): void {
  online = Math.max(0, Math.min(800, Math.floor(n)));
  try {
    fs.writeFileSync(path.join(config.dataDir, "channel_online.txt"), String(online), "utf8");
  } catch {
    /* ignore */
  }
}

export function bumpOnline(delta: number): number {
  setOnlineCount(getOnlineCount() + delta);
  return getOnlineCount();
}
