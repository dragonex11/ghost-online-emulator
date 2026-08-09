import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

type PexGrid = {
  h: number;
  wcols: number;
  mapW: number;
  /** York/thpspx expanded grid (Width*33); index X via X+X/32+1 */
  expanded: boolean;
  data: Buffer;
};

const cache = new Map<string, PexGrid>();

function key(map: number, region: number): string {
  return `${map}/${region}`;
}

function loadPex(map: number, region: number): PexGrid | undefined {
  const k = key(map, region);
  if (cache.has(k)) return cache.get(k);
  const p = path.join(config.dataDir, "map_pexels", `t${map}_s${region}.pex`);
  if (!fs.existsSync(p)) return undefined;
  const raw = fs.readFileSync(p);
  if (raw.length < 12) return undefined;
  const h = raw.readInt32LE(0);
  const wcols = raw.readInt32LE(4);
  const mapW = raw.readInt32LE(8);
  const grid = raw.subarray(12);
  if (h <= 0 || wcols <= 0 || mapW <= 0 || grid.length < h * wcols) return undefined;
  // York: wcols = Width*33, mapW = Width*32  →  wcols ≈ mapW + mapW/32
  const expectExp = mapW + Math.floor(mapW / 32);
  const expanded = Math.abs(wcols - expectExp) <= 2 || Math.abs(wcols - (expectExp + 1)) <= 2;
  const g: PexGrid = { h, wcols, mapW, expanded, data: grid };
  cache.set(k, g);
  console.log(
    `[pex] loaded t${map}_s${region} h=${h} wcols=${wcols} mapW=${mapW} mode=${expanded ? "expanded" : "scaled"}`,
  );
  return g;
}

/** Clear cache after regenerating .pex files (tests / hot reload). */
export function clearPexCache(): void {
  cache.clear();
}

function sByte(v: number): number {
  return v > 127 ? v - 256 : v;
}

/** York Map.GetMapPexel column (expanded) or legacy scaled fallback. */
function colForX(g: PexGrid, x: number): number {
  if (g.expanded) return x + Math.floor(x / 32) + 1;
  if (g.mapW <= 1) return 0;
  return Math.floor((x * g.wcols) / g.mapW);
}

function pexGet(g: PexGrid, x: number, y: number): number {
  const y2 = Math.floor(y / 32);
  const x2 = colForX(g, x);
  if (y2 < 0 || y2 >= g.h || x2 < 0 || x2 >= g.wcols) return -1;
  return sByte(g.data[y2 * g.wcols + x2]!);
}

/** York Map.GetPexInfo — coarser X for wall flag (value 4). */
function pexInfo(g: PexGrid, x: number, y: number): number {
  const y2 = Math.floor(y / 32);
  let x2: number;
  if (g.expanded) x2 = 32 * Math.floor(x / 32) + Math.floor(x / 32);
  else x2 = colForX(g, x);
  if (y2 < 0 || y2 >= g.h || x2 < 0 || x2 >= g.wcols) return -1;
  return sByte(g.data[y2 * g.wcols + x2]!);
}

export function hasPex(map: number, region: number): boolean {
  return loadPex(map, region) !== undefined;
}

export function mapWidthPx(map: number, region: number): number {
  const g = loadPex(map, region);
  return g?.mapW ?? 6400;
}

/** York spawn Y fix — walk down from void until solid cell. */
export function snapMonsterY(map: number, region: number, x: number, y: number): number {
  const g = loadPex(map, region);
  if (!g) return y;
  let yy = y;
  for (let i = 0; i < 80 && pexGet(g, x, yy) === -1; i++) {
    yy = (Math.floor(yy / 32) + 1) * 32;
  }
  if (pexGet(g, x, yy) === -1) {
    for (const dx of [1, -1, 2, -2, 4, -4, 8, -8, 16, -16]) {
      let y2 = y;
      for (let i = 0; i < 80 && pexGet(g, x + dx, y2) === -1; i++) {
        y2 = (Math.floor(y2 / 32) + 1) * 32;
      }
      if (pexGet(g, x + dx, y2) !== -1) return y2;
    }
  }
  return yy;
}

/**
 * York/thpspx Map.UpdatePosition — step `dest` px on X, fix Y via pexels, flip on edge/wall.
 * Mutates pos; returns new facing side (-1|1).
 */
export function updateMonsterPosition(
  map: number,
  region: number,
  pos: { x: number; y: number; side: number },
  dest: number,
): number {
  const g = loadPex(map, region);
  let dir = pos.side < 0 ? -1 : 1;
  let mx = pos.x;
  let my = pos.y;
  const mapW = g?.mapW ?? 6400;

  for (let step = dest; step >= 1; step--) {
    if (mx <= 25 || mx >= mapW - 25) {
      dir = -dir;
      mx = mx + dir;
      break;
    }
    if (!g) {
      mx = mx + dir;
      continue;
    }
    const curr = pexGet(g, mx, my);
    mx = mx + dir;
    let next = pexGet(g, mx, my);
    if (next === -1) {
      const inf = pexInfo(g, mx, my);
      if (inf === 4) {
        dir = -dir;
        mx = mx + dir;
        continue;
      }
      my = Math.floor(my / 32) * 32;
      const c = curr === -1 ? 0 : curr;
      my += c;
      my = Math.floor((my / 32.0 - 0.01) * 32);
      next = pexGet(g, mx, my);
      if (next === -1 && curr === 0x1f) {
        my = (Math.floor(my / 32) + 1) * 32;
        next = pexGet(g, mx, my);
        if (next !== -1) continue;
      }
      if (next === -1) {
        dir = -dir;
        mx = mx + dir;
        break;
      }
      continue;
    }
  }

  if (g) {
    const current = pexGet(g, mx, my);
    if (current !== 0 && current !== -1) {
      my = Math.floor(my / 32) * 32;
      my += current;
      my = Math.floor((my / 32.0 - 0.01) * 32);
    }
  }

  pos.x = mx;
  pos.y = my;
  pos.side = dir >= 0 ? 1 : -1;
  return pos.side;
}

/**
 * Flyer (MoveType 3) patrol — horizontal only, Y unchanged.
 */
export function updateFlyerPosition(
  map: number,
  region: number,
  pos: { x: number; y: number; side: number },
  dest: number,
): number {
  const mapW = mapWidthPx(map, region);
  let dir = pos.side < 0 ? -1 : 1;
  let mx = pos.x;
  for (let step = dest; step >= 1; step--) {
    if (mx <= 25 || mx >= mapW - 25) {
      dir = -dir;
      mx = mx + dir;
      break;
    }
    mx = mx + dir;
  }
  pos.x = mx;
  pos.side = dir >= 0 ? 1 : -1;
  return pos.side;
}

/**
 * Flyer chase — free 2D step toward (tx,ty). Used when aggroed so they rise/dive at the player.
 */
export function updateFlyerToward(
  map: number,
  region: number,
  pos: { x: number; y: number; side: number },
  tx: number,
  ty: number,
  dest: number,
): number {
  const mapW = mapWidthPx(map, region);
  const dx = tx - pos.x;
  const dy = ty - pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1 || dest <= 0) {
    if (Math.abs(dx) > 12) pos.side = dx < 0 ? -1 : 1;
    return pos.side;
  }
  if (dist <= dest) {
    pos.x = tx;
    pos.y = ty;
  } else {
    pos.x = Math.round(pos.x + (dx / dist) * dest);
    pos.y = Math.round(pos.y + (dy / dist) * dest);
  }
  pos.x = Math.max(25, Math.min(mapW - 25, pos.x));
  pos.y = Math.max(48, Math.min(4500, pos.y));
  if (Math.abs(dx) > 12) pos.side = dx < 0 ? -1 : 1;
  return pos.side;
}
