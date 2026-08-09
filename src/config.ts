import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(rootDir, ".env") });

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `Missing required env ${name}. Copy .env.example to .env and set DATABASE_URL.`,
    );
  }
  return v;
}

type RatesFile = {
  killExpRate?: number;
  levelExpCurve?: number;
  questExpRate?: number;
  questExpFlat?: number;
  dropRate?: number;
  goldRate?: number;
  monsterExpPerLevel?: number;
  goldMinPerLevel?: number;
  goldRangePerLevel?: number;
  monsterRespawnMs?: number;
  aggroMs?: number;
  attackCooldownMs?: number;
  attackRangeX?: number;
  attackRangeY?: number;
  attackAnimMs?: number;
  touchCooldownMs?: number;
  touchGraceAuthMs?: number;
  touchGraceEnterMs?: number;
  touchGraceAttackMs?: number;
  touchGraceRespawnMs?: number;
  defaultGamePoints?: number;
  adminGamePoints?: number;
  maxDropSlots?: number;
};

function loadRatesFile(): RatesFile {
  const p = path.join(rootDir, "rates.json");
  if (!fs.existsSync(p)) {
    console.warn("[config] rates.json missing — using built-in defaults");
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as RatesFile;
  } catch (e) {
    console.warn("[config] rates.json parse failed:", e);
    return {};
  }
}

const fileRates = loadRatesFile();

/** Env overrides rates.json when set. */
function rate(envName: string, fileVal: number | undefined, fallback: number): number {
  return num(process.env[envName], fileVal ?? fallback);
}

export const rates = {
  /** Multiplier on monster kill EXP awards. */
  killExpRate: rate("KILL_EXP_RATE", fileRates.killExpRate, 1.0),
  /** Level-up mexp growth (legacy $MAXEXPRATE). */
  levelExpCurve: rate("LEVEL_EXP_CURVE", fileRates.levelExpCurve, 1.19),
  questExpRate: rate("QUEST_EXP_RATE", fileRates.questExpRate, 1.2),
  questExpFlat: rate("QUEST_EXP_FLAT", fileRates.questExpFlat, 10),
  dropRate: rate("DROP_RATE", fileRates.dropRate, 1.0),
  goldRate: rate("GOLD_RATE", fileRates.goldRate, 1.0),
  monsterExpPerLevel: rate("MONSTER_EXP_PER_LEVEL", fileRates.monsterExpPerLevel, 12),
  goldMinPerLevel: rate("GOLD_MIN_PER_LEVEL", fileRates.goldMinPerLevel, 8),
  goldRangePerLevel: rate("GOLD_RANGE_PER_LEVEL", fileRates.goldRangePerLevel, 4),
  monsterRespawnMs: rate("MONSTER_RESPAWN_MS", fileRates.monsterRespawnMs, 20000),
  aggroMs: rate("AGGRO_MS", fileRates.aggroMs, 20000),
  attackCooldownMs: rate("ATTACK_COOLDOWN_MS", fileRates.attackCooldownMs, 1300),
  attackRangeX: rate("ATTACK_RANGE_X", fileRates.attackRangeX, 100),
  attackRangeY: rate("ATTACK_RANGE_Y", fileRates.attackRangeY, 110),
  attackAnimMs: rate("ATTACK_ANIM_MS", fileRates.attackAnimMs, 550),
  touchCooldownMs: rate("TOUCH_COOLDOWN_MS", fileRates.touchCooldownMs, 900),
  touchGraceAuthMs: rate("TOUCH_GRACE_AUTH_MS", fileRates.touchGraceAuthMs, 8000),
  touchGraceEnterMs: rate("TOUCH_GRACE_ENTER_MS", fileRates.touchGraceEnterMs, 12000),
  touchGraceAttackMs: rate("TOUCH_GRACE_ATTACK_MS", fileRates.touchGraceAttackMs, 2500),
  touchGraceRespawnMs: rate("TOUCH_GRACE_RESPAWN_MS", fileRates.touchGraceRespawnMs, 5000),
  defaultGamePoints: rate("DEFAULT_GAME_POINTS", fileRates.defaultGamePoints, 10000),
  adminGamePoints: rate("ADMIN_GAME_POINTS", fileRates.adminGamePoints, 99999),
  maxDropSlots: rate("MAX_DROP_SLOTS", fileRates.maxDropSlots, 4),
};

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),
  mysqlSsl: process.env.MYSQL_SSL !== "0",
  loginHost: process.env.LOGIN_HOST ?? "127.0.0.1",
  loginPort: num(process.env.LOGIN_PORT, 15001),
  channelHost: process.env.CHANNEL_HOST ?? "127.0.0.1",
  channelPort: num(process.env.CHANNEL_PORT, 15013),
  fieldHost: process.env.FIELD_HOST ?? "127.0.0.1",
  fieldPort: num(process.env.FIELD_PORT, 15023),
  udpPort: num(process.env.UDP_PORT, 13997),
  /** Primary messenger port (EN client default 17201). */
  messengerPort: num(process.env.MESSENGER_PORT, 17201),
  /** Extra messenger port (Game4 classic 13070). */
  messengerPortAlt: num(process.env.MESSENGER_PORT_ALT, 13070),
  pktLog: process.env.PKT_LOG === "1",
  /** Game data root (drops, prices, cash shop, map_pexels, client assets). */
  dataDir: path.resolve(rootDir, process.env.DATA_DIR ?? "data"),
  rootDir,
  rates,
};

console.log(
  `[config] rates killExp=${rates.killExpRate} levelCurve=${rates.levelExpCurve} drop=${rates.dropRate} gold=${rates.goldRate} respawnMs=${rates.monsterRespawnMs}`,
);
