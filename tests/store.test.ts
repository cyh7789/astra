import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

const USER = "00000000-0000-0000-0000-000000000001";

describe("MemoryStore CRUD", () => {
  let db: TestDb;
  let store: MemoryStore;

  beforeAll(async () => {
    db = await createTestDb();
    store = new MemoryStore(db.pool, new FakeEmbedder());
  });
  afterAll(async () => {
    await db.drop();
  });

  it("remember + get roundtrip", async () => {
    const m = await store.remember({
      userId: USER,
      context: "driving",
      memoryType: "episodic",
      content: "提醒：今天早上出門先去加油",
    });
    expect(m.id).toBeTruthy();
    const got = await store.get(m.id);
    expect(got?.content).toBe("提醒：今天早上出門先去加油");
    expect(got?.importance).toBe(0.5);
    expect(got?.privacyLevel).toBe("private");
  });

  it("update re-embeds content", async () => {
    const m = await store.remember({
      userId: USER,
      context: "office",
      memoryType: "semantic",
      content: "王經理偏好月付",
    });
    const updated = await store.update(m.id, { content: "王經理偏好季付", importance: 0.8 });
    expect(updated.content).toBe("王經理偏好季付");
    expect(updated.importance).toBe(0.8);
    // embedding 真的跟著內容變了（DB 層驗證，不只驗 return value）
    const embA = await db.pool.query("SELECT embedding::text AS e FROM memories WHERE id = $1", [m.id]);
    const fresh = await new FakeEmbedder().embed("王經理偏好季付");
    expect(JSON.parse(embA.rows[0].e)[0]).toBeCloseTo(fresh[0]!, 5);
  });

  it("forget soft-deletes (get returns null)", async () => {
    const m = await store.remember({
      userId: USER,
      context: "home",
      memoryType: "episodic",
      content: "臨時記事",
    });
    await store.forget(m.id);
    expect(await store.get(m.id)).toBeNull();
    // row 還在（soft delete）
    const raw = await db.pool.query("SELECT deleted_at FROM memories WHERE id = $1", [m.id]);
    expect(raw.rows[0].deleted_at).not.toBeNull();
  });
});
