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

  it("scene 1 driving: candidates are exactly driving + any + cross-context memories", async () => {
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
        ids.get("music-pref"),
        ids.get("emergency-contact"),
      ]),
    );
  });

  it("cross scope 不得漏他場景 private：在家撈王經理報價（office private）必須空手（devin P0-2）", async () => {
    const candidates = await store.fetchCandidates({
      userId: DEMO_USER,
      query: "王經理 報價 維護費",
      context: "home",
      scope: "cross",
      now: NOW,
    });
    const got = new Set(candidates.map((c) => c.id));
    // office 的 private 記憶（報價 $45,000、維護費讓步）不得出現在 home 的 cross 檢索
    expect(got).not.toContain(ids.get("quote-meeting"));
    expect(got).not.toContain(ids.get("wang-concern"));
    // cross-context 級的（行事曆同步會議）仍可跨場景
    expect(got).toContain(ids.get("client-meeting"));
  });

  it("scene 1 driving: recall top-5 covers reminder + station + meeting", async () => {
    const result = await store.recall({
      userId: DEMO_USER,
      query: "今天行程怎麼安排？",
      context: "driving",
      topK: 5,
      now: NOW,
    });
    const got = result.map((m) => m.id);
    for (const key of ["refuel-reminder", "gas-station-pref", "client-meeting"]) {
      expect(got).toContain(ids.get(key));
    }
    // 每筆都有訊號分解（demo UI 的透明度展示用）— 三鍵齊備且 score 落在正規化區間
    for (const m of result) {
      expect(m.signals).toHaveProperty("vector");
      expect(m.signals).toHaveProperty("bm25");
      expect(m.signals).toHaveProperty("recency");
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
  });

  it("scene 2 office: BM25 主導把王經理報價排第一（驗訊號來源，非只驗位置 devin P0）", async () => {
    const result = await store.recall({
      userId: DEMO_USER,
      query: "上次跟王經理談的報價是多少？",
      context: "office",
      topK: 3,
      now: NOW,
    });
    expect(result[0]!.id).toBe(ids.get("quote-meeting"));
    // 排第一那筆的 BM25 訊號是全體最高（專有名詞精確匹配主導），不是靠其他訊號抖上來 —
    // 驗訊號來源而非只驗位置（devin P0）
    const topBm25 = Math.max(...result.map((m) => m.signals.bm25));
    expect(result[0]!.signals.bm25).toBe(topBm25);
    expect(result[0]!.signals.bm25).toBeGreaterThan(0);
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
