import pg from "pg";
import { DB_URL } from "./config.js";

// CockroachDB 的 INT 一律是 INT8，node-postgres 預設回字串。
// 本專案的整數欄位（access_count 等）都在安全整數範圍內，直接轉 number。
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export function createPool(url: string = DB_URL): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** CockroachDB VECTOR 型別的文字表示：'[0.1,0.2,...]' */
export function encodeVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

export function decodeVector(s: string): number[] {
  return JSON.parse(s) as number[];
}
