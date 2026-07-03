import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "../src/config.js";
import { createPool, decodeVector, encodeVector } from "../src/db.js";
import { createTestDb, type TestDb } from "./helpers.js";

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

describe("schema", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("creates tables and roundtrips a vector", async () => {
    const v = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i % 7) / 7);
    const ins = await db.pool.query(
      `INSERT INTO memories (user_id, context, memory_type, content, embedding)
       VALUES ('00000000-0000-0000-0000-000000000001', 'driving', 'episodic', 'hello', $1::vector)
       RETURNING id, embedding::text AS emb`,
      [encodeVector(v)],
    );
    const out = decodeVector(ins.rows[0].emb);
    expect(out).toHaveLength(EMBEDDING_DIM);
    expect(out[1]).toBeCloseTo(v[1]!, 5);
  });

  it("rejects invalid memory_type (check constraint)", async () => {
    const v = encodeVector(Array.from({ length: EMBEDDING_DIM }, () => 0.1));
    await expect(
      db.pool.query(
        `INSERT INTO memories (user_id, context, memory_type, content, embedding)
         VALUES ('00000000-0000-0000-0000-000000000001', 'driving', 'nonsense', 'x', $1::vector)`,
        [v],
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});
