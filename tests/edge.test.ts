import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";
import type { LlmClient } from "../src/llm.js";
import { MemoryWindow } from "../src/memory-window.js";
import { ChatSession } from "../src/session.js";
import { MemoryStore } from "../src/store.js";
import { parseAction } from "../src/tool-agent.js";
import { createTestDb, type TestDb } from "./helpers.js";

const USER = "00000000-0000-0000-0000-00000000e001";
const NOW = new Date("2026-07-06T09:00:00+08:00");

function queueLlm(queue: string[]): LlmClient {
  return { async complete() { return queue.shift() ?? '{"action":"reply","text":"（腳本用盡）"}'; } };
}

describe("parseAction 容錯", () => {
  it("抓第一個完整 JSON 物件（後面接垃圾/第二個物件）", () => {
    expect(parseAction('{"action":"reply","text":"好"} 以及一些廢話 {"action":"tool_call"}')).toEqual({
      action: "reply",
      text: "好",
    });
  });
  it("reply text 內含巢狀大括號", () => {
    expect(parseAction('{"action":"reply","text":"設定 {mode: dry} 完成"}')).toEqual({
      action: "reply",
      text: "設定 {mode: dry} 完成",
    });
  });
  it("多層 fence 與前置說明文字", () => {
    expect(
      parseAction('好的，我來執行：\n```json\n{"action":"tool_call","tool":"set_light","args":{"room":"all","on":false}}\n```'),
    ).toMatchObject({ action: "tool_call", tool: "set_light" });
  });
  it("省略 action 外層時由形狀推斷（Bedrock Gemma 4 實測輸出）", () => {
    expect(
      parseAction('{"tool":"save_memory","args":{"content":"tire pressure is low","memoryType":"episodic"}}'),
    ).toEqual({
      action: "tool_call",
      tool: "save_memory",
      args: { content: "tire pressure is low", memoryType: "episodic" },
    });
    expect(parseAction('{"text":"好的，已經幫你記下來了"}')).toEqual({
      action: "reply",
      text: "好的，已經幫你記下來了",
    });
  });
  it("工具名寫在 action 欄位、args 攤平在頂層（Bedrock Gemma 4 實測輸出）", () => {
    expect(
      parseAction('{"action":"save_memory","args":{"content":"tire is low","type":"episodic"}}'),
    ).toEqual({
      action: "tool_call",
      tool: "save_memory",
      args: { content: "tire is low", type: "episodic" },
    });
    expect(
      parseAction('{"action":"save_memory","content":"tire is low","type":"episodic","importance":0.8}'),
    ).toEqual({
      action: "tool_call",
      tool: "save_memory",
      args: { content: "tire is low", type: "episodic", importance: 0.8 },
    });
  });
  it("垃圾輸入回 null（純文字/沒有大括號/爛 JSON）", () => {
    expect(parseAction("我不會輸出 JSON")).toBeNull();
    expect(parseAction('{"action":"tool_call","tool":123}')).toBeNull();
    expect(parseAction('{"action":"reply"}')).toBeNull();
  });
});

describe("session 邊角案例", () => {
  let db: TestDb;
  let store: MemoryStore;

  beforeAll(async () => {
    db = await createTestDb();
    store = new MemoryStore(db.pool, new FakeEmbedder());
  });
  afterAll(async () => {
    await db.drop();
  });

  it("敏感確認單次有效：執行一次後再呼叫要重新確認", async () => {
    const llm = queueLlm([
      // T1：嘗試 → 被攔 → 問
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"secured"}}',
      '{"action":"reply","text":"要鎖門嗎？"}',
      // T2：同意 → 執行 → 回報
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"secured"}}',
      '{"action":"reply","text":"鎖好了"}',
      // T3：模型又想直接開鎖（未經確認）→ 必須再被攔 → 問
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"unsecured"}}',
      '{"action":"reply","text":"要開門嗎？"}',
    ]);
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    await s.send("鎖門", NOW);
    const t2 = await s.send("好", NOW);
    expect(t2.toolCalls.map((c) => c.tool)).toContain("set_lock");
    const t3 = await s.send("順便看一下門", NOW);
    expect(t3.toolCalls).toHaveLength(0); // 重新上鎖 — 沒有再確認不得執行
    expect(t3.reply).toContain("嗎");
  });

  it("對話中途過期：expiresAt 走到的記憶會離開窗", async () => {
    const m = await store.remember({
      userId: USER,
      context: "home",
      memoryType: "episodic",
      content: "提醒：中午前把包裹拿去寄",
      expiresAt: new Date(NOW.getTime() + 3_600_000), // 1 小時後過期
      createdAt: NOW,
    });
    const llm = queueLlm([
      '{"action":"reply","text":"好"}',
      '{"action":"reply","text":"好"}',
    ]);
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    // FakeEmbedder 下用全同字串保證過 θ 門檻（測的是過期離窗，不是檢索品質）
    await s.send("提醒：中午前把包裹拿去寄", NOW);
    expect(s.window.has(m.id)).toBe(true);
    await s.send("下午的事之後再說", new Date(NOW.getTime() + 2 * 3_600_000)); // 已過期
    expect(s.window.has(m.id)).toBe(false);
  });

  it("未知事件型別不崩潰、照常回覆", async () => {
    const llm = queueLlm(['{"action":"reply","text":"收到一個我不認識的事件，先幫你記著"}']);
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    const t = await s.send('HOME_EVENT: {"type":"quantum_flux","detail":"???"}', NOW);
    expect(t.reply).toContain("事件");
  });

  it("重複呼叫地板：同輪同工具同參數第二次被攔、不重複執行", async () => {
    const payloads: string[] = [];
    const queue = [
      '{"action":"tool_call","tool":"set_light","args":{"room":"all","on":false}}',
      '{"action":"tool_call","tool":"set_light","args":{"room":"all","on":false}}', // 一模一樣
      '{"action":"reply","text":"燈關好了"}',
    ];
    const llm: LlmClient = {
      async complete(_s, user) {
        payloads.push(user);
        return queue.shift()!;
      },
    };
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    const t = await s.send("關燈", NOW);
    expect(t.toolCalls).toHaveLength(1); // 只執行一次
    expect(payloads.some((p) => p.includes("Duplicate call"))).toBe(true);
  });

  it("敏感工具重複呼叫也被地板攔（devin P2：不只 set_light）", async () => {
    // 先確認鎖門 → 執行後 confirmedTools 立即重上鎖，同輪第二次 set_lock 走確認/重複攔截，不連發
    const queue = [
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"secured"}}',
      '{"action":"reply","text":"要鎖門嗎？"}',
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"secured"}}',
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"secured"}}', // 同參數再來
      '{"action":"reply","text":"門鎖好了"}',
    ];
    const llm: LlmClient = { async complete() { return queue.shift()!; } };
    const s = await ChatSession.open(store, llm, USER, "home", NOW, { extract: false });
    await s.send("鎖門", NOW);
    const t = await s.send("好", NOW);
    expect(t.toolCalls.filter((c) => c.tool === "set_lock")).toHaveLength(1); // 只執行一次
  });

  it("參數邊界：上界與下界越界都被攔（devin P2）", async () => {
    for (const bad of [31, 5, -1]) {
      const llm = queueLlm([
        `{"action":"tool_call","tool":"set_climate","args":{"temperature":${bad}}}`,
        '{"action":"reply","text":"這個溫度我設不了"}',
      ]);
      const s = await ChatSession.open(store, llm, USER, "driving", NOW, { extract: false });
      const t = await s.send("設溫度", NOW);
      expect(t.toolCalls).toHaveLength(0); // 越界不執行
    }
  });

  it("參數邊界：驗證錯誤回饋後模型修正重試", async () => {
    const llm = queueLlm([
      '{"action":"tool_call","tool":"set_climate","args":{"temperature":31}}', // 超界
      '{"action":"tool_call","tool":"set_climate","args":{"temperature":30}}', // 修正
      '{"action":"reply","text":"冷氣調到 30 度"}',
    ]);
    const s = await ChatSession.open(store, llm, USER, "driving", NOW, { extract: false });
    const t = await s.send("冷氣開最強", NOW);
    expect(t.toolCalls).toHaveLength(1);
    expect(t.toolCalls[0]!.args.temperature).toBe(30);
  });
});

describe("MemoryWindow 邊角", () => {
  it("單筆超預算長記憶不會把自己淘汰成空窗", () => {
    const w = new MemoryWindow(10, 100);
    w.admit(
      {
        id: "huge", userId: "u", context: "home", memoryType: "semantic",
        content: "長".repeat(500), importance: 0.5, privacyLevel: "private",
        accessCount: 0, createdAt: new Date(0), lastAccessed: new Date(0),
        expiresAt: null, sourceContext: null,
      },
      { score: 0.9, turn: 1, via: "passive" },
    );
    expect(w.size).toBe(1); // 至少留 1 筆
  });
});
