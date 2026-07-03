import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

const NOW = new Date("2026-07-03T20:00:00+08:00");

describe("recallGuarded scenarios", () => {
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

  it("S1: cross-context meeting memory is annotated in driving scene", async () => {
    const out = await store.recallGuarded({
      userId: DEMO_USER,
      query: "今天行程怎麼安排？",
      context: "driving",
      topK: 3,
      now: NOW,
    });
    const meeting = out.find((m) => m.id === ids.get("client-meeting"))!;
    expect(meeting.annotations).toContain("來自 office 場景的記憶");
  });

  it("S2: three-week-old quote is flagged stale in office scene", async () => {
    const out = await store.recallGuarded({
      userId: DEMO_USER,
      query: "上次跟王經理談的報價是多少？",
      context: "office",
      topK: 3,
      now: NOW,
    });
    const quote = out.find((m) => m.id === ids.get("quote-meeting"))!;
    expect(quote.annotations.some((a) => a.includes("可能已過時"))).toBe(true);
  });

  it("S3: spicy-food contradiction is detected with conflictsWith on both sides", async () => {
    const out = await store.recallGuarded({
      userId: DEMO_USER,
      query: "晚餐想吃辣的嗎？",
      context: "home",
      topK: 5,
      now: NOW,
    });
    const noSpicy = out.find((m) => m.id === ids.get("no-spicy"))!;
    const hotpot = out.find((m) => m.id === ids.get("hotpot-order"))!;
    expect(noSpicy.conflictsWith).toContain(hotpot.id);
    expect(hotpot.conflictsWith).toContain(noSpicy.id);
    expect(noSpicy.annotations.some((a) => a.includes("矛盾"))).toBe(true);
  });
});
