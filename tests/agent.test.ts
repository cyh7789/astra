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
    expect(p).toContain("Current scene: home");
  });

  it("adds conflict confirmation rule only when conflicts exist", () => {
    const without = buildSystemPrompt("home", NOW, [guarded({})]);
    expect(without).not.toContain("confirm with the user");
    const withConflict = buildSystemPrompt("home", NOW, [
      guarded({ conflictsWith: ["some-id"], annotations: ["與記憶「…」矛盾"] }),
    ]);
    expect(withConflict).toContain("confirm with the user");
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

  it("萃取的 semantic 事實帶 cross-context，episodic 留 private（與 save_memory 同一條規則）", () => {
    const out = parseExtraction(
      '[{"memoryType":"semantic","content":"偏好會議記錄用條列","context":"office"},{"memoryType":"episodic","content":"油快沒了剩 30 公里","context":"driving"}]',
      USER,
      NOW,
    );
    expect(out.map((m) => m.privacyLevel)).toEqual(["cross-context", "private"]);
  });

  it("returns empty on invalid json or wrong shapes", () => {
    expect(parseExtraction("我不會回json", USER, NOW)).toEqual([]);
    expect(parseExtraction('[{"memoryType":"procedural","content":"x"}]', USER, NOW)).toEqual([]);
    expect(parseExtraction("[]", USER, NOW)).toEqual([]);
  });

  it("非法 context 落 any、缺 content 整筆丟棄（devin P2 越界值）", () => {
    // context:"moon" 不在白名單 → 落 "any"（不當機、不採信亂值當場景）
    const moon = parseExtraction(
      '[{"memoryType":"semantic","content":"測試","context":"moon"}]',
      USER,
      NOW,
    );
    expect(moon).toHaveLength(1);
    expect(moon[0]!.context).toBe("any");
    // 缺 content → 整筆丟棄（不寫空記憶）
    expect(parseExtraction('[{"memoryType":"semantic","context":"home"}]', USER, NOW)).toEqual([]);
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
        if (system.includes("memory extractor")) {
          return '[{"memoryType":"episodic","content":"明天要先去加油","context":"driving","importance":0.7,"expiresInHours":24}]';
        }
        return "好，明天早上提醒你去建國路中油加油。";
      },
    };

    const agent = new AstraAgent(store, mockLlm, USER);
    const result = await agent.chat("明天早上記得提醒我先去加油", "driving", NOW);

    // 綁定記憶素材而非「加油」單詞（既可指 refuel 也可指鼓勵 devin P1）
    expect(result.reply).toMatch(/建國路|中油|加油站/);
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
