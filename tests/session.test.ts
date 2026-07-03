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
});
