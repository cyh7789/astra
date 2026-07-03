import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";
import type { LlmClient } from "../src/llm.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { ChatSession } from "../src/session.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb, type TestDb } from "./helpers.js";

const NOW = new Date("2026-07-04T19:00:00+08:00");

/** 永遠直接 reply 的 stub — 這裡測的是 session 狀態機，不是模型行為。 */
const replyLlm: LlmClient = {
  async complete() {
    return JSON.stringify({ action: "reply", text: "好的" });
  },
};

describe("ChatSession 持久化與跨終端接續", () => {
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

  it("send 後狀態落庫；短 gap resume（換終端）全量接續", async () => {
    const car = await ChatSession.open(store, replyLlm, DEMO_USER, "home", NOW);
    // open(home) 應交接浮現氣炸鍋（source_context=driving）+ pin 安全關鍵記憶
    expect(car.window.has(ids.get("airfryer-idea")!)).toBe(true);
    expect(car.window.has(ids.get("emergency-contact")!)).toBe(true);

    await car.send("嗨", NOW);

    // 「另一個終端」5 分鐘後 resume：窗與對話完整接續
    const speaker = await ChatSession.resume(
      store,
      replyLlm,
      DEMO_USER,
      new Date(NOW.getTime() + 5 * 60_000),
    );
    expect(speaker).not.toBeNull();
    expect(speaker!.context).toBe("home");
    expect(new Set(speaker!.window.serialize().map((e) => e.memoryId))).toEqual(
      new Set(car.window.serialize().map((e) => e.memoryId)),
    );
  });

  it("冷 resume（3 天後）：非 pinned 低分冷卻退場、pinned 存活、過期記憶不復位", async () => {
    const later = new Date(NOW.getTime() + 72 * 3_600_000);
    const s = await ChatSession.resume(store, replyLlm, DEMO_USER, later);
    expect(s).not.toBeNull();
    // handoff 進窗分 0.6，72h 冷卻（半衰期 24h）→ 0.075 < floor 0.2 → 退場
    expect(s!.window.has(ids.get("airfryer-idea")!)).toBe(false);
    // pinned 豁免冷卻
    expect(s!.window.has(ids.get("emergency-contact")!)).toBe(true);
    // client-meeting（pin，expires NOW+12h）已過期 → 不復位
    expect(s!.window.has(ids.get("client-meeting")!)).toBe(false);
  });

  it("交接浮現 surfaced_at 去重：跨 session 不重複嘮叨", async () => {
    // 第一個 session 的 open(home) 已浮現過氣炸鍋 → 新 session 不再浮現
    const fresh = await ChatSession.open(store, replyLlm, DEMO_USER, "home", NOW);
    expect(fresh.window.has(ids.get("airfryer-idea")!)).toBe(false);
    const candidates = await store.handoffCandidates(DEMO_USER, "home", NOW);
    expect(candidates.map((m) => m.id)).not.toContain(ids.get("airfryer-idea"));
  });

  it("沒有既存 session 時 resume 回 null", async () => {
    const nobody = "00000000-0000-0000-0000-00000000dead";
    expect(await ChatSession.resume(store, replyLlm, nobody, NOW)).toBeNull();
  });

  it("高水位壓縮折疊 digest + open threads，resume 後注入 prompt", async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const llm: LlmClient = {
      async complete(system, user) {
        seen.push({ system, user });
        if (system.includes("conversation condenser")) {
          return '{"digest":"聊了週末出遊規劃","openThreads":["訂宜蘭民宿還沒訂"]}';
        }
        return JSON.stringify({ action: "reply", text: "好的" });
      },
    };
    const opts = { transcriptHighWater: 6, transcriptKeep: 2, extract: false };
    const s = await ChatSession.open(store, llm, DEMO_USER, "home", NOW, opts);
    for (const msg of ["週末想出去玩", "宜蘭如何？", "民宿晚點訂", "先看天氣"]) {
      await s.send(msg, NOW);
    }
    // 第 4 次 send 後 8 行 > 6 → 觸發壓縮：digest 落庫
    const state = await store.loadSessionState(DEMO_USER);
    expect(state!.digest).toBe("聊了週末出遊規劃");
    expect(state!.openThreads).toEqual(["訂宜蘭民宿還沒訂"]);
    expect(state!.transcript.length).toBe(2);

    // resume 還原 digest/threads，且下一輪 prompt 收得到
    const r = await ChatSession.resume(store, llm, DEMO_USER, NOW, opts);
    await r!.send("繼續", NOW);
    const lastChat = seen.filter((c) => c.system.includes("ASTRA")).at(-1)!;
    expect(lastChat.user).toContain("Earlier summary: 聊了週末出遊規劃");
    expect(lastChat.user).toContain("Open: 訂宜蘭民宿還沒訂");
  });

  it("行為地板：解鎖後的敏感操作「說了沒做」會被 SYSTEM_GUARD 攔下逼執行", async () => {
    const queue = [
      // T1：嘗試鎖門 → 被攔 → 回頭問使用者
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"secured"}}',
      '{"action":"reply","text":"要幫你把門鎖上嗎？"}',
      // T2：先謊稱鎖好了（該被地板攔）→ 收到 SYSTEM_GUARD 後真的執行 → 再回覆
      '{"action":"reply","text":"鎖好了！"}',
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"secured"}}',
      '{"action":"reply","text":"已鎖上，晚安"}',
    ];
    const payloads: string[] = [];
    const llm: LlmClient = {
      async complete(_system, user) {
        payloads.push(user);
        return queue.shift()!;
      },
    };
    const s = await ChatSession.open(store, llm, DEMO_USER, "home", NOW, { extract: false });
    const t1 = await s.send("幫我把門鎖上", NOW);
    expect(t1.toolCalls).toHaveLength(0); // 第一次嘗試被敏感攔截
    expect(t1.reply).toContain("嗎");

    const t2 = await s.send("好", NOW);
    expect(t2.toolCalls.map((c) => c.tool)).toContain("set_lock"); // 地板逼出真執行
    expect(t2.reply).toBe("已鎖上，晚安");
    expect(payloads.some((p) => p.includes("SYSTEM_GUARD:"))).toBe(true);
  });

  it("行為地板：使用者拒絕時 nudge 一次後放行，不無限逼", async () => {
    const queue = [
      '{"action":"tool_call","tool":"set_lock","args":{"lockTargetState":"secured"}}',
      '{"action":"reply","text":"要幫你把門鎖上嗎？"}',
      '{"action":"reply","text":"好，先不鎖"}', // 被 nudge 一次
      '{"action":"reply","text":"好，先不鎖，需要再叫我"}', // 第二次放行
    ];
    const llm: LlmClient = { async complete() { return queue.shift()!; } };
    const s = await ChatSession.open(store, llm, DEMO_USER, "home", NOW, { extract: false });
    await s.send("幫我把門鎖上", NOW);
    const t2 = await s.send("先不要好了", NOW);
    expect(t2.toolCalls).toHaveLength(0);
    expect(t2.reply).toContain("先不鎖");
  });

  it("行為地板：危險事件 + 無回應必須 emergency_call，reply 會被攔", async () => {
    const queue = [
      '{"action":"reply","text":"請注意安全"}', // 該被地板攔
      '{"action":"tool_call","tool":"emergency_call","args":{"service":"119","reason":"gas leak, user unresponsive"}}',
      '{"action":"reply","text":"已通報 119 並分享位置"}',
    ];
    const payloads: string[] = [];
    const llm: LlmClient = {
      async complete(_system, user) {
        payloads.push(user);
        return queue.shift()!;
      },
    };
    const s = await ChatSession.open(store, llm, DEMO_USER, "home", NOW, { extract: false });
    const t = await s.send(
      'HOME_EVENT: {"type":"gas_leak","room":"kitchen"}\nUSER_NO_RESPONSE（15 秒無回應）',
      NOW,
    );
    expect(t.toolCalls.some((c) => c.tool === "emergency_call")).toBe(true);
    expect(payloads.some((p) => p.includes("SYSTEM_GUARD:"))).toBe(true);
  });

  it("save_memory：明令記錄走確定性寫入，跨場景帶 sourceContext", async () => {
    const queue = [
      '{"action":"tool_call","tool":"save_memory","args":{"content":"下週一與王經理簽約","type":"episodic","context":"office","importance":0.9}}',
      '{"action":"reply","text":"記好了"}',
    ];
    const llm: LlmClient = { async complete() { return queue.shift()!; } };
    const s = await ChatSession.open(store, llm, DEMO_USER, "driving", NOW, { extract: false });
    const t = await s.send("記一下，下週一要跟王經理簽約", NOW);
    expect(t.toolCalls.some((c) => c.tool === "save_memory")).toBe(true);

    const found = await store.recall({
      userId: DEMO_USER,
      query: "王經理簽約",
      context: "office",
      topK: 5,
      now: NOW,
    });
    const saved = found.find((m) => m.content === "下週一與王經理簽約");
    expect(saved).toBeDefined();
    expect(saved!.sourceContext).toBe("driving"); // 車上記的 office 事
    expect(s.window.has(saved!.id)).toBe(true); // 剛記的事進窗，本場對話直接可用
  });

  it("萃取寫回：跨場景主題自動帶 sourceContext，餵得進交接浮現", async () => {
    const llm: LlmClient = {
      async complete(system) {
        if (system.includes("memory extractor")) {
          return '[{"memoryType":"episodic","content":"到家後要澆陽台的花","context":"home","importance":0.6}]';
        }
        return JSON.stringify({ action: "reply", text: "好的" });
      },
    };
    const s = await ChatSession.open(store, llm, DEMO_USER, "driving", NOW);
    await s.send("回家提醒我澆陽台的花", NOW);

    const candidates = await store.handoffCandidates(DEMO_USER, "home", NOW);
    const flower = candidates.find((m) => m.content.includes("澆陽台的花"));
    expect(flower).toBeDefined();
    expect(flower!.sourceContext).toBe("driving"); // 在車上說的 home 事 → 交接浮現的資格
  });
});
