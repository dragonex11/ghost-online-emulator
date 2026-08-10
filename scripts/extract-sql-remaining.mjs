import fs from "node:fs";
import path from "node:path";

const queriesRoot = "src/db/queries";
const nameBySql = new Map();

for (const file of fs.readdirSync(queriesRoot)) {
  if (!file.endsWith(".ts") || file === "index.ts") continue;
  const content = fs.readFileSync(path.join(queriesRoot, file), "utf8");
  const re = /export const ([A-Z0-9_]+) = `((?:[^`\\]|\\.)*)`;/gs;
  let m;
  while ((m = re.exec(content)) !== null) {
    nameBySql.set(m[2], m[1]);
  }
}

function walk(dir, files = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !p.includes(path.join("db", "queries"))) walk(p, files);
    else if (e.isDirectory()) continue;
    else if (e.name.endsWith(".ts")) files.push(p);
  }
  return files;
}

const re =
  /(?:await\s+)?(?:query|execute|conn\.query)\s*(?:<[^>]*>)?\s*\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gs;

for (const f of walk("src")) {
  if (f.includes(`${path.sep}db${path.sep}queries${path.sep}`)) continue;
  let content = fs.readFileSync(f, "utf8");
  const replacements = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    let raw = m[1];
    let sql;
    if (raw.startsWith("`")) sql = raw.slice(1, -1);
    else if (raw.startsWith('"')) sql = raw.slice(1, -1);
    else sql = raw.slice(1, -1);
    if (!/SELECT|INSERT|UPDATE|DELETE/i.test(sql)) continue;
    const name = nameBySql.get(sql);
    if (!name) {
      console.warn("Missing constant for:", f, sql.slice(0, 80));
      continue;
    }
    replacements.push({ raw, name });
  }
  if (!replacements.length) continue;

  replacements.sort((a, b) => b.raw.length - a.raw.length);
  let patched = content;
  for (const r of replacements) patched = patched.split(r.raw).join(r.name);

  const names = [...new Set(replacements.map((r) => r.name))].sort();
  const rel = path.relative(path.dirname(f), "src/db/queries").replace(/\\/g, "/");
  const importPath = rel.startsWith(".") ? rel : `./${rel}`;
  const importLine = `import { ${names.join(", ")} } from "${importPath}.js";`;

  if (!patched.includes(importLine)) {
    const imports = [...patched.matchAll(/^import[\s\S]*?;\s*$/gm)];
    if (imports.length) {
      const last = imports[imports.length - 1];
      const idx = last.index + last[0].length;
      patched = patched.slice(0, idx) + "\n" + importLine + patched.slice(idx);
    } else {
      patched = importLine + "\n" + patched;
    }
  }

  fs.writeFileSync(f, patched);
  console.log("Patched", f.replace(/\\/g, "/"), `(${replacements.length})`);
}
