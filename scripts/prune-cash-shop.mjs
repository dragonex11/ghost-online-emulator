/**
 * Prune cash_shop seed rows using the same client-compatibility rules as the
 * former runtime filter. Requires data/client/table/item.itm and PET sprites.
 *
 * Usage: node scripts/prune-cash-shop.mjs [--dry-run]
 *
 * Run once against the full historical seed. Re-running on an already-pruned
 * schema will remove additional rows — restore schema.sql from git first.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const schemaPath = path.join(root, "database", "schema.sql");
const dryRun = process.argv.includes("--dry-run");

const PET_EQ_SUPPORTED = new Set([7820501, 9220011, 9220012, 9220013]);
const RUN_TRAIL_IDS = new Set([8950101, 8950102, 8950103, 8950104, 8950105]);
const UNSUPPORTED_PRODUCE_IDS = new Set([8950106, 8950107]);
const FASHION_CATEGORY_INDICES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const PET_CATEGORY_INDEX = 15;
const PET_EQ_CATEGORY_INDEX = 16;
const PRODUCE_CATEGORY_INDEX = 11;
const PILL_CATEGORY_INDEX = 13;
const TREASURE_CATEGORY_INDEX = 19;
const LUCKBAG_CATEGORY_INDEX = 10;
const COMPANION_PET_ID_MIN = 9_210_000;
const COMPANION_PET_ID_MAX = 9_220_000;
const CASH_CATEGORY_COUNT = 20;
const ROWS_PER_INSERT = 200;

function loadItemItmIds(dataDir) {
  const itmPath = path.join(dataDir, "client", "table", "item.itm");
  if (!fs.existsSync(itmPath)) {
    throw new Error(`Missing ${itmPath} — set DATA_DIR or place client files under data/client/`);
  }
  const itm = fs.readFileSync(itmPath);
  const ids = new Set();
  for (let i = 0; i + 8 < itm.length; ) {
    if (
      itm[i] >= 32 &&
      itm[i] < 127 &&
      itm[i + 1] === 0 &&
      itm[i + 2] >= 32 &&
      itm[i + 2] < 127 &&
      itm[i + 3] === 0
    ) {
      if (i >= 4) {
        const id = itm.readUInt32LE(i - 4);
        if (id >= 1_000_000 && id <= 99_999_999) ids.add(id);
      }
      let j = i;
      while (j + 1 < itm.length && !(itm[j] === 0 && itm[j + 1] === 0)) j += 2;
      i = j + 2;
      continue;
    }
    i++;
  }
  return ids;
}

function loadPetSpriteIds(dataDir) {
  const dir = path.join(dataDir, "client", "data", "OBJ", "PET");
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing ${dir}`);
  }
  const ids = new Set();
  for (const name of fs.readdirSync(dir)) {
    const m = /^pet_(\d+)/i.exec(name);
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

function parseCashShopRows(sql) {
  const re = /\((\d+),\s*(\d+),\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(-?\d+)\)/g;
  const start = sql.indexOf("-- Seed: cash shop");
  const end = sql.indexOf("-- Seed: monster drops");
  if (start < 0 || end < 0) throw new Error("Could not locate cash_shop section in schema.sql");
  const section = sql.slice(start, end);
  const rows = [];
  for (const m of section.matchAll(re)) {
    rows.push({
      category: Number(m[1]),
      itemId: Number(m[2]),
      bargain: Number(m[3]),
      term: Number(m[4]),
      price: Number(m[5]),
      flag: Number(m[6]),
    });
  }
  return { rows, start, end };
}

function isCompanionPetId(itemId) {
  return itemId >= COMPANION_PET_ID_MIN && itemId < COMPANION_PET_ID_MAX;
}

function isPetEquipmentId(itemId) {
  return PET_EQ_SUPPORTED.has(itemId);
}

function rowsToByCat(rows) {
  const byCat = Array.from({ length: CASH_CATEGORY_COUNT }, () => []);
  const seen = new Map();
  for (const row of rows) {
    const cat = row.category;
    if (cat < 0 || cat > 19) continue;
    const set = seen.get(cat) ?? new Set();
    seen.set(cat, set);
    if (set.has(row.itemId)) continue;
    set.add(row.itemId);
    byCat[cat].push({ ...row, category: cat });
  }
  return byCat;
}

function flat(byCat) {
  return byCat.flat();
}

/** Mirrors rearrangePetEquipment() in state.ts */
function rearrangePetEquipment(byCat) {
  const pets = byCat[PET_CATEGORY_INDEX] ?? [];
  const keepPets = [];
  const peteq = [];
  const peteqSeen = new Set();

  for (const it of pets) {
    if (
      isPetEquipmentId(it.itemId) ||
      (it.itemId >= 9220000 && it.itemId < 9230000) ||
      it.itemId === 7820501
    ) {
      if (PET_EQ_SUPPORTED.has(it.itemId) && !peteqSeen.has(it.itemId)) {
        peteq.push({ ...it, category: PET_EQ_CATEGORY_INDEX });
        peteqSeen.add(it.itemId);
      }
    } else if (isCompanionPetId(it.itemId)) {
      keepPets.push(it);
    }
  }

  byCat[PET_CATEGORY_INDEX] = keepPets;
  byCat[PET_EQ_CATEGORY_INDEX] = peteq;
}

/** Mirrors filterClientItems() in state.ts */
function filterClientItems(byCat, itmIds, petSpr) {
  for (let c = 0; c < byCat.length; c++) {
    if (c === PET_CATEGORY_INDEX) {
      byCat[c] = byCat[c].filter((it) => {
        if (!isCompanionPetId(it.itemId)) return false;
        const spr = Math.floor(it.itemId / 10) % 1000;
        return petSpr.has(spr) && spr > 0;
      });
    } else if (c === PET_EQ_CATEGORY_INDEX) {
      byCat[c] = byCat[c].filter((it) => PET_EQ_SUPPORTED.has(it.itemId));
    } else if (FASHION_CATEGORY_INDICES.has(c) && itmIds.size > 0) {
      byCat[c] = byCat[c].filter((it) => itmIds.has(it.itemId));
    }
  }
}

/** Mirrors rearrangeHotMileageTabs() in state.ts */
function rearrangeHotMileageTabs(byCat) {
  const produce = byCat[PRODUCE_CATEGORY_INDEX] ?? [];
  const trails = [];
  const frames = [];
  for (const it of produce) {
    if (UNSUPPORTED_PRODUCE_IDS.has(it.itemId)) continue;
    if (RUN_TRAIL_IDS.has(it.itemId)) {
      trails.push({ ...it, category: PILL_CATEGORY_INDEX });
    } else {
      frames.push(it);
    }
  }
  byCat[PRODUCE_CATEGORY_INDEX] = frames;
  const existingPill = (byCat[PILL_CATEGORY_INDEX] ?? []).filter((it) => !RUN_TRAIL_IDS.has(it.itemId));
  byCat[PILL_CATEGORY_INDEX] = [...trails, ...existingPill];

  const treasure = byCat[TREASURE_CATEGORY_INDEX] ?? [];
  const treasureIds = new Set(treasure.map((i) => i.itemId));
  byCat[LUCKBAG_CATEGORY_INDEX] = (byCat[LUCKBAG_CATEGORY_INDEX] ?? []).filter(
    (it) => !treasureIds.has(it.itemId),
  );
}

function formatRow(r) {
  return `(${r.category}, ${r.itemId}, ${r.bargain}, ${r.term}, ${r.price}, ${r.flag})`;
}

function buildCashShopSection(rows) {
  const lines = [
    "-- ============================================================",
    `-- Seed: cash shop (${rows.length} items)`,
    "-- ============================================================",
  ];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    lines.push("INSERT INTO `cash_shop` (`category`, `item_id`, `bargain`, `term`, `price`, `flag`) VALUES");
    for (let j = 0; j < chunk.length; j++) {
      const suffix = j === chunk.length - 1 && i + chunk.length === rows.length ? ";" : ",";
      lines.push(`${formatRow(chunk[j])}${suffix}`);
    }
    if (i + chunk.length < rows.length) lines.push("");
  }
  lines.push("");
  return lines.join("\n");
}

function resolveDataDir() {
  const envPath = path.join(root, ".env");
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, "utf8").match(/^DATA_DIR=(.+)$/m);
    if (m) return path.resolve(root, m[1].trim());
  }
  return path.join(root, "data");
}

const dataDir = resolveDataDir();
const itmIds = loadItemItmIds(dataDir);
const petSpr = loadPetSpriteIds(dataDir);
console.log(`[prune] item.itm ids=${itmIds.size}, pet sprites=${petSpr.size} (${dataDir})`);

const sql = fs.readFileSync(schemaPath, "utf8");
const { rows: originalRows, start, end } = parseCashShopRows(sql);
console.log(`[prune] parsed ${originalRows.length} cash_shop rows from schema.sql`);

const byCat = rowsToByCat(originalRows);
rearrangePetEquipment(byCat);
filterClientItems(byCat, itmIds, petSpr);
rearrangeHotMileageTabs(byCat);

const pruned = flat(byCat).sort((a, b) => a.category - b.category || a.itemId - b.itemId);
const removed = originalRows.length - pruned.length;
console.log(`[prune] kept ${pruned.length}, removed ${removed}`);

const counts = pruned.reduce((acc, r) => {
  acc[r.category] = (acc[r.category] ?? 0) + 1;
  return acc;
}, {});
console.log("[prune] per category:", counts);

if (dryRun) {
  console.log("[prune] dry-run — schema.sql unchanged");
  process.exit(0);
}

const newSection = buildCashShopSection(pruned);
const newSql = sql.slice(0, start) + newSection + sql.slice(end);
fs.writeFileSync(schemaPath, newSql);

const headerRe = /--   - ~\d+ cash shop items/;
if (headerRe.test(newSql)) {
  fs.writeFileSync(schemaPath, fs.readFileSync(schemaPath, "utf8").replace(headerRe, `--   - ${pruned.length} cash shop items`));
}

// Migration: replace cash_shop with pruned catalog for live DBs
const migPath = path.join(root, "database", "migrations", "002_prune_incompatible_cash_shop.sql");
const migLines = [
  "-- Replace cash_shop with client-compatible catalog (run once on existing DBs).",
  `-- ${originalRows.length} rows -> ${pruned.length} rows (${removed} removed).`,
  "",
  "TRUNCATE TABLE `cash_shop`;",
  "",
  "INSERT INTO `cash_shop` (`category`, `item_id`, `bargain`, `term`, `price`, `flag`) VALUES",
];
for (let i = 0; i < pruned.length; i++) {
  const suffix = i === pruned.length - 1 ? ";" : ",";
  migLines.push(`${formatRow(pruned[i])}${suffix}`);
}
migLines.push("");
fs.writeFileSync(migPath, migLines.join("\n") + "\n");

console.log(`[prune] wrote ${schemaPath}`);
console.log(`[prune] wrote ${migPath}`);
