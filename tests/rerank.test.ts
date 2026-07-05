import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";
import type { Reranker } from "../src/reranker.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

const USER = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-07-05T21:00:00+08:00");

describe("reranker 精排層", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    const seedStore = new MemoryStore(db.pool, new FakeEmbedder());
    for (const content of ["高鐵票訂了週五下午", "高鐵便當要先買", "週五要開會"]) {
      await seedStore.remember({ userId: USER, context: "office", memoryType: "episodic", content, createdAt: NOW });
    }
  });
  afterAll(async () => {
    await db.drop();
  });

  it("有 reranker：依精排順序回傳並帶 rerankScore", async () => {
    const flipped: Reranker = {
      async rerank(_q, docs, topK) {
        // 故意反轉融合排序 → 驗證最終順序由 reranker 決定
        return docs.map((_, i) => ({ index: docs.length - 1 - i, score: 1 - i * 0.1 })).slice(0, topK);
      },
    };
    const store = new MemoryStore(db.pool, new FakeEmbedder(), flipped);
    const base = await new MemoryStore(db.pool, new FakeEmbedder()).recall({
      userId: USER, query: "高鐵", context: "office", topK: 3, now: NOW,
    });
    const reranked = await store.recall({ userId: USER, query: "高鐵", context: "office", topK: 3, now: NOW });
    expect(reranked.map((m) => m.id)).toEqual([...base.map((m) => m.id)].reverse());
    expect(reranked[0]!.rerankScore).toBe(1);
  });

  it("reranker 掛掉：退回融合排序，檢索不中斷", async () => {
    const broken: Reranker = {
      async rerank() { throw new Error("rerank service down"); },
    };
    const store = new MemoryStore(db.pool, new FakeEmbedder(), broken);
    const out = await store.recall({ userId: USER, query: "高鐵", context: "office", topK: 2, now: NOW });
    expect(out).toHaveLength(2);
    for (const m of out) expect(m.rerankScore).toBeUndefined(); // 每筆都不殘留（devin P2）
  });
});
