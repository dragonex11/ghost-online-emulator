import fs from "node:fs";
import path from "node:path";

function walk(dir, files = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (e.name.endsWith(".ts")) files.push(p);
  }
  return files;
}

const files = walk("src");
const sqls = new Map();
const re =
  /(?:await\s+)?(?:query|execute|conn\.query)\s*(?:<[^>]*>)?\s*\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gs;

for (const f of files) {
  const content = fs.readFileSync(f, "utf8");
  let m;
  while ((m = re.exec(content)) !== null) {
    let sql = m[1];
    if (sql.startsWith("`")) sql = sql.slice(1, -1);
    else if (sql.startsWith('"')) sql = sql.slice(1, -1);
    else if (sql.startsWith("'")) sql = sql.slice(1, -1);
    if (/SELECT|INSERT|UPDATE|DELETE/i.test(sql)) {
      const key = sql;
      if (!sqls.has(key)) sqls.set(key, []);
      sqls.get(key).push(f.replace(/\\/g, "/"));
    }
  }
}

console.log("Unique SQL count:", sqls.size);
for (const [sql, locs] of [...sqls.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log("---");
  console.log("FILES:", [...new Set(locs)].join(", "));
  console.log(sql);
}
