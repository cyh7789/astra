import pg from "pg";
import { DB_URL } from "./config.js";

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
