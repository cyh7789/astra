import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";
import type { LlmClient } from "../src/llm.js";
import { ChatSession } from "../src/session.js";
import type { RecallQuery, SessionState } from "../src/store.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

const NOW = new Date("2026-07-06T09:00:00+08:00");

function queueLlm(queue: string[]): LlmClient {
  return { async complete() { return queue.shift() ?? '{"action":"reply","text":"（腳本用盡）"}'; } };
}

let db: TestDb;
let store: MemoryStore;

beforeAll(async () => {
  db = await createTestDb();
  store = new MemoryStore(db.pool, new FakeEmbedder());
});
afterAll(async () => {
  await db.drop();
});

describe("敏感確認 × 事件交錯", () => {
  const USER = "00000000-0000-0000-0000-00000000e101";

  it("事件訊息不解鎖敏感確認：門鈴事件當下 set_lock 仍須被攔，使用者親口同意才執行", async () => {
    const llm = queueLlm([
      // T1：使用者要開門 → 嘗試 → 被攔 → 問
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"unsecured"}}',
      '{"action":"reply","text":"要開門嗎？"}',
      // T2：門鈴事件（不是使用者回應）→ 模型若呼叫 set_lock 必須仍被攔
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"unsecured"}}',
      '{"action":"reply","text":"門口有訪客，要開門嗎？"}',
      // T3：使用者親口同意 → 解鎖執行
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"unsecured"}}',
      '{"action":"reply","text":"開好了"}',
    ]);
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    await s.send("幫我開門", NOW);
    const t2 = await s.send('HOME_EVENT: {"type":"doorbell","detail":"訪客按鈴"}', NOW);
    expect(t2.toolCalls.filter((c) => c.tool === "set_lock")).toHaveLength(0); // 事件 ≠ 使用者同意
    const t3 = await s.send("好，開門", NOW);
    expect(t3.toolCalls.map((c) => c.tool)).toContain("set_lock");
  });
});

describe("resume 韌性", () => {
  it("resume 略過已刪除的窗內記憶，不崩潰", async () => {
    const USER = "00000000-0000-0000-0000-00000000e102";
    const m1 = await store.remember({
      userId: USER, context: "home", memoryType: "semantic",
      content: "客廳燈泡上週剛換過",
    });
    const m2 = await store.remember({
      userId: USER, context: "home", memoryType: "procedural",
      content: "陽台盆栽每週三澆水",
    });
    const llm = queueLlm(['{"action":"reply","text":"好"}', '{"action":"reply","text":"好"}']);
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    // FakeEmbedder 下用全同字串保證過 θ（測的是 resume 韌性，不是檢索品質）
    await s.send("客廳燈泡上週剛換過", NOW);
    await s.send("陽台盆栽每週三澆水", NOW);
    expect(s.window.has(m1.id)).toBe(true);
    expect(s.window.has(m2.id)).toBe(true);

    await db.pool.query("UPDATE memories SET deleted_at = now() WHERE id = $1", [m1.id]);
    const r = await ChatSession.resume(
      store, queueLlm([]), USER, new Date(NOW.getTime() + 5 * 60_000), { extract: false },
    );
    expect(r).not.toBeNull();
    expect(r!.window.has(m1.id)).toBe(false); // 已刪除 → 不復位
    expect(r!.window.has(m2.id)).toBe(true); // 其餘照常
  });

  it("resume 時間早於最後持久化（時鐘倒退/亂序）不冷卻、不崩潰", async () => {
    const USER = "00000000-0000-0000-0000-00000000e103";
    const m = await store.remember({
      userId: USER, context: "home", memoryType: "semantic",
      content: "熱水器每半年要除垢保養",
    });
    const llm = queueLlm(['{"action":"reply","text":"好"}']);
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    await s.send("熱水器每半年要除垢保養", NOW);
    expect(s.window.has(m.id)).toBe(true);

    const r = await ChatSession.resume(
      store, queueLlm([]), USER, new Date(NOW.getTime() - 10 * 60_000), { extract: false },
    );
    expect(r).not.toBeNull();
    expect(r!.window.has(m.id)).toBe(true); // 負 gap 不觸發冷卻清窗
  });
});

describe("矛盾 link 擴展", () => {
  it("矛盾對端經 link 一跳進窗，prompt 同輪標注矛盾", async () => {
    const USER = "00000000-0000-0000-0000-00000000e104";
    const old = await store.remember({
      userId: USER, context: "any", memoryType: "semantic",
      content: "阿毛住在台北市大安區",
    });
    const neu = await store.remember({
      userId: USER, context: "any", memoryType: "semantic",
      content: "阿毛上個月搬到新竹市東區",
    });
    await store.link(neu.id, old.id, "contradicts");

    const systems: string[] = [];
    const llm: LlmClient = {
      async complete(system) {
        systems.push(system);
        return '{"action":"reply","text":"好"}';
      },
    };
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    await s.send("阿毛上個月搬到新竹市東區", NOW);
    expect(s.window.has(old.id)).toBe(true); // 對端被拉進窗（passive 或 link 皆可）
    expect(systems[0]).toContain("矛盾，建議確認而非假設"); // ConflictGuard 兩端到齊 → 同輪標注
  });
});

describe("DB 故障退化", () => {
  class FlakyStore extends MemoryStore {
    failRecall = false;
    failPersist = false;
    async recall(q: RecallQuery) {
      if (this.failRecall) throw new Error("connection refused (simulated)");
      return super.recall(q);
    }
    async saveSessionState(s: Omit<SessionState, "updatedAt">, now = new Date()) {
      if (this.failPersist) throw new Error("connection refused (simulated)");
      return super.saveSessionState(s, now);
    }
  }

  it("recall 失敗（DB 瞬斷）→ 該輪以無記憶模式回覆，不炸對話", async () => {
    const flaky = new FlakyStore(db.pool, new FakeEmbedder());
    const llm = queueLlm(['{"action":"reply","text":"我在，怎麼了？"}']);
    const s = await ChatSession.open(flaky, llm, "00000000-0000-0000-0000-00000000e105", "home", NOW, {
      extract: false,
    });
    flaky.failRecall = true;
    const t = await s.send("你好嗎", NOW);
    expect(t.reply).toContain("我在");
    expect(t.admitted).toHaveLength(0); // 這輪撈不到記憶 — 空手但活著
  });

  it("persist 失敗（DB 瞬斷）→ 回覆仍送達使用者，狀態下輪再補寫", async () => {
    const flaky = new FlakyStore(db.pool, new FakeEmbedder());
    const llm = queueLlm(['{"action":"reply","text":"好，記下了"}']);
    const s = await ChatSession.open(flaky, llm, "00000000-0000-0000-0000-00000000e106", "home", NOW, {
      extract: false,
    });
    flaky.failPersist = true;
    const t = await s.send("等等提醒我倒垃圾", NOW);
    expect(t.reply).toContain("記下了");
  });
});
