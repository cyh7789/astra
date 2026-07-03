import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

const NOW = new Date("2026-07-03T07:30:00+08:00");

describe("recall end-to-end (three-scene demo data)", () => {
  let db: TestDb;
  let store: MemoryStore;
  let ids: Map<string, string>;

  beforeAll(async () => {
    db = await createTestDb();
    store = new MemoryStore(db.pool, new FakeEmbedder());
    ids = await seed(store, NOW);
  });
  afterAll(async () => {
    await db.drop();
  });

  it("scene 1 driving: candidates are exactly driving + cross-context memories", async () => {
    const candidates = await store.fetchCandidates({
      userId: DEMO_USER,
      query: "今天行程怎麼安排？",
      context: "driving",
      now: NOW,
    });
    const got = new Set(candidates.map((c) => c.id));
    expect(got).toEqual(
      new Set([
        ids.get("refuel-reminder"),
        ids.get("gas-station-pref"),
        ids.get("client-meeting"),
      ]),
    );
  });

  it("scene 1 driving: recall top-3 covers reminder + station + meeting", async () => {
    const result = await store.recall({
      userId: DEMO_USER,
      query: "今天行程怎麼安排？",
      context: "driving",
      topK: 3,
      now: NOW,
    });
    expect(result.map((m) => m.id).sort()).toEqual(
      [
        ids.get("refuel-reminder"),
        ids.get("gas-station-pref"),
        ids.get("client-meeting"),
      ].sort(),
    );
    // 每筆都有訊號分解（demo UI 的透明度展示用）
    for (const m of result) {
      expect(m.signals.vector).toBeGreaterThanOrEqual(0);
      expect(m.signals.bm25).toBeGreaterThanOrEqual(0);
      expect(m.signals.recency).toBeGreaterThanOrEqual(0);
    }
  });

  it("scene 2 office: BM25 puts 王經理報價 memory first", async () => {
    const result = await store.recall({
      userId: DEMO_USER,
      query: "上次跟王經理談的報價是多少？",
      context: "office",
      topK: 3,
      now: NOW,
    });
    expect(result[0]!.id).toBe(ids.get("quote-meeting"));
  });

  it("scene 3 home: cross-scene memory (said in car, tagged home) is in candidates", async () => {
    const candidates = await store.fetchCandidates({
      userId: DEMO_USER,
      query: "冰箱裡還有什麼？晚餐吃什麼好？",
      context: "home",
      now: NOW,
    });
    const got = candidates.map((c) => c.id);
    expect(got).toContain(ids.get("airfryer-idea")); // source_context=driving 但 context=home
    expect(got).toContain(ids.get("fridge-stock"));
    // office 的 private 記憶不得洩漏到 home
    expect(got).not.toContain(ids.get("quote-meeting"));
    expect(got).not.toContain(ids.get("wang-prefs"));
  });

  it("expired memories drop out of candidates", async () => {
    const later = new Date(NOW.getTime() + 24 * 3_600_000); // 隔天：加油提醒已過期
    const candidates = await store.fetchCandidates({
      userId: DEMO_USER,
      query: "今天行程怎麼安排？",
      context: "driving",
      now: later,
    });
    expect(candidates.map((c) => c.id)).not.toContain(ids.get("refuel-reminder"));
  });

  it("recall bumps access_count", async () => {
    const before = await store.get(ids.get("gas-station-pref")!);
    await store.recall({
      userId: DEMO_USER,
      query: "加油站在哪",
      context: "driving",
      topK: 1,
      now: NOW,
    });
    const after = await store.get(ids.get("gas-station-pref")!);
    expect(after!.accessCount).toBeGreaterThan(before!.accessCount);
  });
});
