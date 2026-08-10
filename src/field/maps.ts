import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { monstersOnMap } from "./monsters.js";

export function deadTownMap(map: number): number {
  switch (map) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 22:
    case 23:
      return 1;
    case 7:
    case 8:
    case 9:
      return 16;
    case 10:
    case 11:
    case 20:
      return 10;
    case 12:
    case 13:
      return 12;
    case 14:
    case 15:
    case 17:
    case 18:
    case 19:
    case 21:
      return 15;
    case 16:
      return 16;
    case 24:
    case 25:
    case 26:
    case 31:
    case 32:
    case 33:
      return 25;
    case 27:
    case 28:
      return 27;
    default:
      return 1;
  }
}

/** Safe town spawn so death-respawn doesn't load invalid field coords */
export function deadTownSpawn(map: number): { x: number; y: number } {
  switch (map) {
    case 1:
      return { x: 125, y: 1010 };
    case 10:
      return { x: 200, y: 800 };
    case 12:
      return { x: 200, y: 800 };
    case 15:
      return { x: 200, y: 800 };
    case 16:
      return { x: 200, y: 800 };
    case 25:
      return { x: 200, y: 800 };
    case 27:
      return { x: 200, y: 800 };
    default:
      return { x: 125, y: 1010 };
  }
}

/**
 * the client crashes when ENTERPLAYER / CHANGEMAP lands at 0,0 (or void).
 * Client portals sometimes auth-warp with X=Y=0 — never accept that.
 */
export function defaultFieldSpawn(map: number, region: number): { x: number; y: number } {
  if (map === 2 && region === 6) return { x: 600, y: 1000 };
  if (map === 1 && region === 1) return { x: 125, y: 1010 };
  if (map === 16 && region === 1) return { x: 200, y: 1100 };
  if (map === 7 && region === 3) return { x: 500, y: 700 };
  const mobs = monstersOnMap(map, region);
  if (mobs.length) {
    const m = mobs[0]!;
    return { x: Math.max(80, m.spawnX - 120), y: Math.max(64, m.spawnY) };
  }
  return deadTownSpawn(deadTownMap(map));
}

export function sanitizePlayerPos(
  map: number,
  region: number,
  x: number,
  y: number,
): { x: number; y: number; fixed: boolean } {
  const bad =
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x <= 0 ||
    y <= 0 ||
    x > 20000 ||
    y > 20000;
  if (!bad) return { x, y, fixed: false };
  const s = defaultFieldSpawn(map, region);
  return { x: s.x, y: s.y, fixed: true };
}

/** True when data/client has `data/Project/t{map}_s{region}.prj` (loadable field). */
export function mapExists(map: number, region: number): boolean {
  if (!Number.isFinite(map) || !Number.isFinite(region)) return false;
  if (map < 0 || region < 0) return false;
  const name = `t${Math.floor(map)}_s${Math.floor(region)}.prj`;
  const dirs = [
    path.join(config.dataDir, "client", "data", "Project"),
    path.join(config.rootDir, "data", "client", "data", "Project"),
    path.join(config.dataDir, "Project"),
  ];
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}
