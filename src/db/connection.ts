import mysql, { type Pool, type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import { config } from "../config.js";
import { CONNECTION_INFO } from "./queries/system.js";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) throw new Error("DB not initialized");
  return pool;
}

export async function initDb(): Promise<void> {
  const url = new URL(config.databaseUrl);
  pool = mysql.createPool({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || "defaultdb",
    waitForConnections: true,
    connectionLimit: 10,
    // Needed for createChar: name-check + all inserts in one network round-trip.
    multipleStatements: true,
    ssl: config.mysqlSsl ? { rejectUnauthorized: false } : undefined,
  });
  const [rows] = await pool.query<RowDataPacket[]>(CONNECTION_INFO);
  console.log(`[db] connected ${rows[0]?.db} (${rows[0]?.ver})`);
}

export async function query<T extends RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
  const [rows] = await getPool().query<T>(sql, params);
  return rows;
}

export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [res] = await getPool().execute<ResultSetHeader>(sql, params as (string | number | null | Buffer | Date)[]);
  return res;
}

/** Borrow a pool connection (e.g. multi-statement createChar). Always release. */
export async function withConnection<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}
