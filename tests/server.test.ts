import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { FakeEmbedder } from "../src/embedder.js";
import type { LlmClient } from "../src/llm.js";
import { seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

/** 對話回應照佇列吐；萃取呼叫（session 每輪都會發）回空陣列，不吃佇列。 */
function queueLlm(responses: string[]): LlmClient {
  const queue = [...responses];
  return {
    async complete(system: string) {
      if (system.startsWith("You are a memory extractor")) return "[]";
      if (system.startsWith("You are a conversation condenser")) {
        return '{"digest":"","openThreads":[]}';
      }
      const next = queue.shift();
      if (!next) throw new Error("queueLlm exhausted");
      return next;
    },
  };
}

describe("demo server API", () => {
  let db: TestDb;
  let store: MemoryStore;

  beforeAll(async () => {
    db = await createTestDb();
    store = new MemoryStore(db.pool, new FakeEmbedder());
    await seed(store);
  });
  afterAll(async () => {
    await db.drop();
  });

  function appWith(llm: LlmClient): FastifyInstance {
    return buildApp({ pool: db.pool, store, llm });
  }

  it("chat：工具執行折進裝置板、回窗快照；空 message 拒收", async () => {
    const app = appWith(
      queueLlm([
        '{"action":"tool_call","tool":"set_light","args":{"room":"客廳","on":true,"brightness":40}}',
        '{"action":"reply","text":"客廳燈開好了"}',
      ]),
    );
    const bad = await app.inject({ method: "POST", url: "/api/chat", body: {} });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: "/api/chat",
      body: { message: "幫我開客廳的燈，調暗一點" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toBe("客廳燈開好了");
    expect(body.deviceState.home.lights["客廳"]).toEqual({ on: true, brightness: 40 });
    expect(body.toolCalls).toHaveLength(1);
    expect(body.window.length).toBeGreaterThan(0); // open(home) 至少有 pin/handoff 進窗
    await app.close();
  });

  it("scene：切場景回 surfaced/evicted、context 更新；未知場景拒收", async () => {
    const app = appWith(queueLlm([]));
    const bad = await app.inject({ method: "POST", url: "/api/scene", body: { context: "moon" } });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: "POST",
      url: "/api/scene",
      body: { context: "driving" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().context).toBe("driving");
    await app.close();
  });

  it("state：對話態讀自 DB — server 重啟（新 app 實例）接得回來", async () => {
    const app = appWith(queueLlm(['{"action":"reply","text":"好"}']));
    await app.inject({ method: "POST", url: "/api/scene", body: { context: "driving" } });
    await app.inject({ method: "POST", url: "/api/chat", body: { message: "嗨" } });
    await app.close();

    // 「重啟」：全新 app（session 記憶體態歸零），只共用同一顆 DB
    const app2 = appWith(queueLlm([]));
    const res = await app2.inject({ method: "GET", url: "/api/state" });
    const body = res.json();
    expect(body.context).toBe("driving");
    expect(body.turn).toBeGreaterThanOrEqual(1);
    expect(body.transcript.some((l: string) => l.includes("嗨"))).toBe(true);
    expect(body.window.length).toBeGreaterThan(0);
    await app2.close();
  });

  it("reset：session 態清空、記憶重 seed、裝置板歸零", async () => {
    const app = appWith(
      queueLlm([
        '{"action":"tool_call","tool":"set_outlet","args":{"name":"氣炸鍋","on":true}}',
        '{"action":"reply","text":"開了"}',
      ]),
    );
    await app.inject({ method: "POST", url: "/api/scene", body: { context: "home" } });
    await app.inject({ method: "POST", url: "/api/chat", body: { message: "開氣炸鍋" } });

    const reset = await app.inject({ method: "POST", url: "/api/reset" });
    expect(reset.statusCode).toBe(200);

    const state = (await app.inject({ method: "GET", url: "/api/state" })).json();
    expect(state.turn).toBe(0);
    expect(state.transcript).toEqual([]);
    expect(state.deviceState.home.outlets).toEqual({});

    const { rows } = await db.pool.query(
      "SELECT count(*)::int AS n FROM memories WHERE deleted_at IS NULL",
    );
    expect(rows[0].n).toBeGreaterThan(0); // 重 seed 後記憶在
    await app.close();
  });
});
