import { randomBytes } from "node:crypto";
import type pg from "pg";
import { createPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";

/** 測試基底連線（defaultdb）。設 ASTRA_TEST_BASE_URL 可對 Cloud cluster 跑同一套測試。 */
const BASE =
  process.env.ASTRA_TEST_BASE_URL ??
  "postgresql://root@localhost:26257/defaultdb?sslmode=disable";

function urlWithDb(dbName: string): string {
  const u = new URL(BASE);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export interface TestDb {
  pool: pg.Pool;
  dbName: string;
  drop(): Promise<void>;
}

/** 每個測試檔一顆隨機命名的 DB，跑完 migration，測後整顆 drop */
export async function createTestDb(): Promise<TestDb> {
  const dbName = `astra_test_${randomBytes(4).toString("hex")}`;
  const admin = createPool(BASE);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = createPool(urlWithDb(dbName));
  await runMigrations(pool);
  return {
    pool,
    dbName,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE ${dbName} CASCADE`);
      await admin.end();
    },
  };
}
