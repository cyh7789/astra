import { describe, expect, it } from "vitest";
import { createPool, decodeVector, encodeVector } from "../src/db.js";

describe("db", () => {
  it("connects to local crdb", async () => {
    const pool = createPool();
    const r = await pool.query("SELECT 1 AS one");
    expect(r.rows[0].one).toBe(1);
    await pool.end();
  });

  it("encodes/decodes vectors", () => {
    const v = [0.1, -0.5, 2];
    expect(decodeVector(encodeVector(v))).toEqual(v);
  });
});
