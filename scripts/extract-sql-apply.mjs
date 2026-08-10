import fs from "node:fs";
import path from "node:path";

function walk(dir, files = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !p.includes("db" + path.sep + "queries")) walk(p, files);
    else if (e.isDirectory() && p.endsWith("db")) {
      for (const e2 of fs.readdirSync(p, { withFileTypes: true })) {
        if (e2.name === "queries") continue;
        const p2 = path.join(p, e2.name);
        if (e2.isDirectory()) walk(p2, files);
        else if (e2.name.endsWith(".ts")) files.push(p2);
      }
    } else if (e.isDirectory()) walk(p, files);
    else if (e.name.endsWith(".ts") && !p.includes("db" + path.sep + "queries")) files.push(p);
  }
  return files;
}

function sqlToName(sql) {
  const s = sql.replace(/\s+/g, " ").trim();
  const verb = (s.match(/^(SELECT|INSERT|UPDATE|DELETE)/i) ?? ["Q"])[0].toUpperCase();
  const tables = [...s.matchAll(/(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]);
  const main = tables[0] ?? "row";
  let suffix = "";
  if (/WHERE/i.test(s)) {
    const w = s.match(/WHERE\s+(.+?)(?:ORDER|LIMIT|GROUP|;|$)/i)?.[1] ?? "";
    const cols = [...w.matchAll(/([a-z_]+)\s*=/gi)].map((m) => m[1]).slice(0, 2);
    suffix = cols.length ? "_BY_" + cols.join("_AND_").toUpperCase() : "";
  }
  if (/IN \(\$\{ph\}\)/.test(s)) suffix = "_BY_CHARIDS_IN";
  if (/\$\{table\}/.test(s)) suffix = "_DYNAMIC_TABLE";
  if (/\$\{t\.table\}/.test(s)) suffix = "_DYNAMIC_TABLE_COL";
  if (/;\s*INSERT/.test(s)) return "CREATE_CHAR_MULTI_STATEMENT";
  if (/DATABASE\(\)/.test(s)) return "CONNECTION_INFO";
  let name = `${verb}_${main.toUpperCase()}${suffix}`;
  name = name.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_");
  return name;
}

const files = walk("src");
const re =
  /(?:await\s+)?(?:query|execute|conn\.query)\s*(?:<[^>]*>)?\s*\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gs;

const entries = [];
const seen = new Map();

for (const f of files) {
  const content = fs.readFileSync(f, "utf8");
  let m;
  while ((m = re.exec(content)) !== null) {
    let raw = m[1];
    let sql;
    let quote;
    if (raw.startsWith("`")) {
      quote = "`";
      sql = raw.slice(1, -1);
    } else if (raw.startsWith('"')) {
      quote = '"';
      sql = raw.slice(1, -1);
    } else {
      quote = "'";
      sql = raw.slice(1, -1);
    }
    if (!/SELECT|INSERT|UPDATE|DELETE/i.test(sql)) continue;
    if (!seen.has(sql)) {
      let base = sqlToName(sql);
      let name = base;
      let n = 2;
      const usedNames = new Set([...seen.values()].map((v) => v.name));
      while (usedNames.has(name)) {
        name = `${base}_${n++}`;
      }
      seen.set(sql, { name, sql, quote });
    }
    entries.push({ file: f.replace(/\\/g, "/"), sql, ...seen.get(sql), raw });
  }
}

// domain routing
function domainFor(sql, name) {
  if (/users|game_points|gift_points|bonus_points/i.test(sql) && !/characters/i.test(sql)) return "users";
  if (/characters/i.test(sql) && !/friends|letters|gifts/i.test(sql)) return "characters";
  if (/friends|letters/i.test(sql)) return "messenger";
  if (/cash_shop|gifts|cash_inven/i.test(sql)) return "cashshop";
  if (/monster_drops/i.test(sql)) return "drops";
  if (/monster[^_]/i.test(sql)) return "monsters";
  if (/quests/i.test(sql)) return "quests";
  if (/skill_hotkeys/i.test(sql)) return "hotkeys";
  if (/skills/i.test(sql)) return "skills";
  if (/item_prices/i.test(sql)) return "prices";
  if (/DATABASE\(\)/i.test(sql)) return "system";
  if (/CREATE_CHAR|INSERT INTO characters.*INSERT INTO equip/s.test(sql)) return "channel";
  return "inventory";
}

const byDomain = new Map();
for (const v of seen.values()) {
  const d = domainFor(v.sql, v.name);
  if (!byDomain.has(d)) byDomain.set(d, []);
  byDomain.get(d).push(v);
}

const queriesDir = "src/db/queries";
fs.mkdirSync(queriesDir, { recursive: true });

for (const [domain, items] of [...byDomain.entries()].sort()) {
  items.sort((a, b) => a.name.localeCompare(b.name));
  const lines = items.map((item) => {
    const escaped = item.sql.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
    return `export const ${item.name} = \`${escaped}\`;`;
  });
  fs.writeFileSync(path.join(queriesDir, `${domain}.ts`), lines.join("\n\n") + "\n");
}

// index barrel
const domains = [...byDomain.keys()].sort();
fs.writeFileSync(
  path.join(queriesDir, "index.ts"),
  domains.map((d) => `export * from "./${d}.js";`).join("\n") + "\n",
);

// patch source files
for (const f of files) {
  let content = fs.readFileSync(f, "utf8");
  const fileEntries = entries.filter((e) => e.file === f.replace(/\\/g, "/"));
  if (!fileEntries.length) continue;

  const domainsUsed = new Set(fileEntries.map((e) => domainFor(e.sql, e.name)));
  const importNames = [...new Set(fileEntries.map((e) => e.name))].sort();
  const importPath = (() => {
    const rel = path.relative(path.dirname(f), "src/db/queries").replace(/\\/g, "/");
    return rel.startsWith(".") ? rel : "./" + rel;
  })();

  let patched = content;
  for (const e of [...fileEntries].sort((a, b) => b.raw.length - a.raw.length)) {
    patched = patched.split(e.raw).join(e.name);
  }

  // add imports after last import or at top
  const importLine = `import { ${importNames.join(", ")} } from "${importPath}.js";`;
  if (!patched.includes(importLine)) {
    const lastImport = [...patched.matchAll(/^import .+$/gm)].pop();
    if (lastImport) {
      const idx = lastImport.index + lastImport[0].length;
      patched = patched.slice(0, idx) + "\n" + importLine + patched.slice(idx);
    } else {
      patched = importLine + "\n" + patched;
    }
  }

  fs.writeFileSync(f, patched);
}

// patch connection.ts
const connPath = "src/db/connection.ts";
let conn = fs.readFileSync(connPath, "utf8");
const sysEntry = [...seen.values()].find((v) => /DATABASE\(\)/.test(v.sql));
if (sysEntry) {
  conn = conn.replace(sysEntry.raw, "CONNECTION_INFO");
  if (!conn.includes('from "./queries/system.js"')) {
    conn = conn.replace(
      'import { config } from "../config.js";',
      'import { config } from "../config.js";\nimport { CONNECTION_INFO } from "./queries/system.js";',
    );
  }
  fs.writeFileSync(connPath, conn);
}

console.log("Domains:", domains.join(", "));
console.log("Total unique queries:", seen.size);
console.log("Patched files:", new Set(entries.map((e) => e.file)).size);
