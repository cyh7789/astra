import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AstraAgent,
  buildSystemPrompt,
  parseExtraction,
} from "../src/agent.js";
import { FakeEmbedder } from "../src/embedder.js";
import { toGuarded, type GuardedMemory } from "../src/guards.js";
import type { LlmClient } from "../src/llm.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

const USER = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-07-03T20:00:00+08:00");

function guarded(over: Partial<GuardedMemory>): GuardedMemory {
  const base = toGuarded([
    {
      id: crypto.randomUUID(),
      userId: USER,
      context: "home",
      memoryType: "episodic",
      content: "x",
      importance: 0.5,
      privacyLevel: "private",
      accessCount: 0,
      createdAt: NOW,
      lastAccessed: NOW,
      expiresAt: null,
      sourceContext: null,
      vectorSim: 0.5,
      signals: { vector: 0.5, bm25: 0.5, recency: 0.5 },
      score: 0.5,
    },
  ])[0]!;
  return { ...base, ...over };
}

describe("buildSystemPrompt", () => {
  it("includes memory content and annotations", () => {
    const p = buildSystemPrompt("home", NOW, [
      guarded({ content: "不吃辣", annotations: ["21 天前的資訊，可能已過時"] }),
    ]);
    expect(p).toContain("不吃辣");
    expect(p).toContain("可能已過時");
    expect(p).toContain("當前場景：home");
  });

  it("adds conflict confirmation rule only when conflicts exist", () => {
    const without = buildSystemPrompt("home", NOW, [guarded({})]);
    expect(without).not.toContain("向使用者確認");
    const withConflict = buildSystemPrompt("home", NOW, [
      guarded({ conflictsWith: ["some-id"], annotations: ["與記憶「…」矛盾"] }),
    ]);
    expect(withConflict).toContain("向使用者確認");
  });
});

describe("parseExtraction", () => {
  it("parses fenced json and converts expiresInHours", () => {
    const raw =
      '```json\n[{"memoryType":"episodic","content":"明早要加油","context":"driving","importance":0.8,"expiresInHours":12}]\n```';
    const out = parseExtraction(raw, USER, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("明早要加油");
    expect(out[0]!.expiresAt!.getTime()).toBe(NOW.getTime() + 12 * 3_600_000);
  });

  it("returns empty on invalid json or wrong shapes", () => {
    expect(parseExtraction("我不會回json", USER, NOW)).toEqual([]);
    expect(parseExtraction('[{"memoryType":"procedural","content":"x"}]', USER, NOW)).toEqual([]);
    expect(parseExtraction("[]", USER, NOW)).toEqual([]);
  });
});

describe("AstraAgent.chat", () => {
  let db: TestDb;
  let store: MemoryStore;

  beforeAll(async () => {
    db = await createTestDb();
    store = new MemoryStore(db.pool, new FakeEmbedder());
  });
  afterAll(async () => {
    await db.drop();
  });

  it("recalls, replies, extracts and persists memories", async () => {
    await store.remember({
      userId: USER,
      context: "driving",
      memoryType: "semantic",
      content: "偏好的加油站：建國路中油",
    });

    const calls: Array<{ system: string; user: string }> = [];
    const mockLlm: LlmClient = {
      async complete(system, user) {
        calls.push({ system, user });
        if (system.includes("記憶萃取器")) {
          return '[{"memoryType":"episodic","content":"明天要先去加油","context":"driving","importance":0.7,"expiresInHours":24}]';
        }
        return "好，明天早上提醒你去建國路中油加油。";
      },
    };

    const agent = new AstraAgent(store, mockLlm, USER);
    const result = await agent.chat("明天早上記得提醒我先去加油", "driving", NOW);

    expect(result.reply).toContain("加油");
    // 對話 prompt 收到了撈回的記憶
    expect(calls[0]!.system).toContain("建國路中油");
    // 萃取的記憶真的落庫（可被之後 recall 撈到）
    expect(result.extracted).toHaveLength(1);
    const later = await store.recall({
      userId: USER,
      query: "加油",
      context: "driving",
      topK: 5,
      now: NOW,
    });
    expect(later.some((m) => m.content === "明天要先去加油")).toBe(true);
  });
});
