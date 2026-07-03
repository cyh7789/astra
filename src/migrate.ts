import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type pg from "pg";
import { createPool } from "./db.js";
import { DB_URL } from "./config.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** 天真的 statement 切分：以行尾分號切。migrations 內不可使用含 ';' 的字串常值或預存程序。 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));
}

export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const applied = new Set(
    (await pool.query("SELECT version FROM schema_migrations")).rows.map(
      (r) => r.version as string,
    ),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of splitStatements(sql)) {
      await pool.query(stmt);
    }
    await pool.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    ran.push(file);
  }
  return ran;
}

// CLI: npm run migrate
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // astra DB 可能還不存在：先連 defaultdb 建立
  const adminUrl = new URL(DB_URL);
  const dbName = adminUrl.pathname.slice(1) || "astra";
  adminUrl.pathname = "/defaultdb";
  const admin = createPool(adminUrl.toString());
  await admin.query(`CREATE DATABASE IF NOT EXISTS ${dbName}`);
  await admin.end();

  const pool = createPool();
  const ran = await runMigrations(pool);
  console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
  await pool.end();
}
