/** 記憶穿梭 PoC spike：驗三個模型風險最高的行為（設計文件 §4）。
 *  S1 窗跨輪常駐（指代輪靠窗不靠重撈）
 *  S2 recall_memory 主動跨場景深查（Gemma 自己改寫 query + scope:"all"）
 *  S3 場景切換交接浮現（車上說的事回家主動提）+ 隱私 carry-over
 *  S4 INCOMING_CALL 事件跨 scope 簡報（回家路上王經理來電）
 *  跑法：EMBEDDER=voyage GEMINI_MODEL=gemma-4-31b-it npx tsx scripts/traversal-spike.ts */
import { selectEmbedder } from "../src/embedder-select.js";
import { GeminiClient } from "../src/llm.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { ChatSession } from "../src/session.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb } from "../tests/helpers.js";

const model = process.env.GEMINI_MODEL ?? "gemma-4-31b-it";
const llm = new GeminiClient(model);
console.error(`traversal spike llm: ${model} / embedder: ${process.env.EMBEDDER ?? "fake"}`);

const checks: Array<{ name: string; pass: boolean; note: string }> = [];
function check(name: string, pass: boolean, note = ""): void {
  checks.push({ name, pass, note });
  console.log(`  ${pass ? "✅" : "❌"} ${name}${note ? `（${note}）` : ""}`);
}

/** SPIKE_ONLY=s6,s7 只跑指定劇本（迭代省 LLM 呼叫） */
const ONLY = (process.env.SPIKE_ONLY ?? "").toLowerCase().split(",").filter(Boolean);
const skip = (id: string): boolean => ONLY.length > 0 && !ONLY.includes(id);

function show(label: string, r: { reply: string; toolCalls: Array<{ tool: string; args: Record<string, unknown> }>; admitted: Array<{ via: string; content: string }>; windowSize: number }): void {
  console.log(`\n--- ${label}`);
  for (const a of r.admitted) console.log(`  ⊕ [${a.via}] ${a.content.slice(0, 40)}`);
  for (const t of r.toolCalls) console.log(`  🔧 ${t.tool}(${JSON.stringify(t.args)})`);
  console.log(`  💬 ${r.reply.replaceAll("\n", " ").slice(0, 160)}`);
  console.log(`  窗大小: ${r.windowSize}`);
}

const db = await createTestDb();
try {
  const store = new MemoryStore(db.pool, selectEmbedder());
  const ids = await seed(store);
  const byKey = (k: string) => ids.get(k)!;

  // ── S1 窗跨輪常駐（home）──────────────────────────────
  if (!skip("s1")) {
    console.log("\n=== S1 窗跨輪常駐：T1 問食材、T2 指代接續");
    const s = await ChatSession.open(store, llm, DEMO_USER, "home");
    const t1 = await s.send("冰箱裡還有什麼食材？");
    show("T1 冰箱裡還有什麼食材？", t1);
    check("S1-T1 fridge-stock 被動進窗", s.window.has(byKey("fridge-stock")));

    const t2 = await s.send("那晚餐可以做什麼？");
    show("T2 那晚餐可以做什麼？", t2);
    check("S1-T2 fridge-stock 仍在窗（跨輪常駐）", s.window.has(byKey("fridge-stock")));
    check(
      "S1-T2 回覆用到窗內食材",
      /雞胸|青花菜/.test(t2.reply),
      t2.reply.slice(0, 50),
    );
    check("S1 窗 ≤ 12", s.window.size <= 12, `size=${s.window.size}`);
  }

  // ── S2 recall_memory 主動跨場景深查（driving 問 home 的事）──
  if (!skip("s2")) {
    console.log("\n=== S2 主動深查：車上問回家晚餐（home private 記憶，場景 scope 撈不到）");
    const s = await ChatSession.open(store, llm, DEMO_USER, "driving");
    const t1 = await s.send("回家之後晚餐想煮什麼好？幫我想想");
    show("T1 回家之後晚餐想煮什麼好？", t1);
    const usedRecall = t1.toolCalls.some((t) => t.tool === "recall_memory");
    check("S2 模型主動呼叫 recall_memory", usedRecall);
    check(
      "S2 跨場景撈到 home 記憶進窗",
      s.window.has(byKey("fridge-stock")) || s.window.has(byKey("airfryer-idea")),
    );
    check("S2 回覆引用食材或氣炸鍋", /雞胸|青花菜|氣炸/.test(t1.reply), t1.reply.slice(0, 50));
  }

  // ── S3 場景切換：driving → home 交接浮現 + 隱私 carry-over ──
  if (!skip("s3")) {
    console.log("\n=== S3 場景切換：車上→到家，交接浮現氣炸鍋");
    // S1 的 open(home) 已消耗過交接浮現（surfaced_at DB 層去重）— spike 劇本間重置
    await db.pool.query("UPDATE memories SET surfaced_at = NULL");
    const s = await ChatSession.open(store, llm, DEMO_USER, "driving");
    const t1 = await s.send("我出發回家囉");
    show("T1（driving）我出發回家囉", t1);

    const sw = await s.switchContext("home");
    console.log(`  ⇄ 切換 home：交接浮現 ${sw.surfaced.length} 筆、踢出 ${sw.evicted.length} 筆`);
    check("S3 airfryer-idea 交接浮現進窗", s.window.has(byKey("airfryer-idea")));
    check("S3 office private 不在窗", !s.window.has(byKey("quote-meeting")));

    const t2 = await s.send("我到家了！");
    show("T2（home）我到家了！", t2);
    check("S3 回覆主動提起氣炸鍋", /氣炸/.test(t2.reply), t2.reply.slice(0, 60));
  }

  // ── S4 回家路上來電：事件跨 scope 簡報 ──────────────────
  if (!skip("s4")) {
    console.log("\n=== S4 來電事件：driving 場景收到王經理來電");
    const s = await ChatSession.open(store, llm, DEMO_USER, "driving");
    const t1 = await s.send('INCOMING_CALL: {"from":"王經理","number":"02-8765-4321"}');
    show("T1 INCOMING_CALL 王經理", t1);
    check(
      "S4 事件跨 scope 撈到 office 報價記憶",
      s.window.has(byKey("quote-meeting")) || s.window.has(byKey("wang-prefs")),
    );
    check("S4 回覆含簡報內容（報價/維護費/季付）", /45,?000|報價|維護|季付/.test(t1.reply), t1.reply.slice(0, 80));
    check("S4 詢問是否接聽而非擅自接", /接/.test(t1.reply));
  }

  // ── S5 跨終端接續：車機聊到一半 → 家中終端 resume 續聊 ──
  if (!skip("s5")) {
    console.log("\n=== S5 跨終端接續：車上交代的事，回家問「剛剛說到哪」");
    const carHead = await ChatSession.open(store, llm, DEMO_USER, "driving");
    const t1 = await carHead.send("到家之後記得提醒我傳季度報告給李協理，很重要");
    show("T1（車機）提醒我傳報告給李協理", t1);

    // 換終端：家中音箱 resume（5 分鐘後 — 對話工作集從 CockroachDB 拉回）
    const speaker = await ChatSession.resume(store, llm, DEMO_USER, new Date(Date.now() + 5 * 60_000));
    check("S5 家中終端 resume 成功", speaker !== null);
    await speaker!.switchContext("home");
    const t2 = await speaker!.send("我到家了，剛剛車上說到哪？");
    show("T2（家中音箱）剛剛車上說到哪？", t2);
    check("S5 跨終端記得話題（報告/李協理）", /報告|李協理/.test(t2.reply), t2.reply.slice(0, 80));
  }

  // ── S6 睡眠模式：一句話串多裝置 + 敏感操作兩段式確認 ──
  if (!skip("s6")) {
    console.log("\n=== S6 睡眠模式：組合動作 + 敏感確認");
    const s = await ChatSession.open(store, llm, DEMO_USER, "home");
    const t1 = await s.send("我要睡了，晚安");
    show("T1 我要睡了，晚安", t1);
    const NON_SENSITIVE = ["set_light", "set_thermostat", "set_window_covering", "set_outlet"];
    const SENSITIVE = ["set_lock", "set_security_system"];
    const t1Names = t1.toolCalls.map((t) => t.tool);
    check(
      "S6 一次串多個非敏感裝置（≥2 種）",
      new Set(t1Names.filter((n) => NON_SENSITIVE.includes(n))).size >= 2,
      t1Names.join(","),
    );
    check("S6 敏感操作未先斬後奏", !t1Names.some((n) => SENSITIVE.includes(n)));
    check("S6 回覆問到門鎖/保全", /(門鎖|保全|鎖門|上鎖)/.test(t1.reply), t1.reply.slice(0, 80));

    const t2 = await s.send("好，門鎖和保全都上");
    show("T2 好，門鎖和保全都上", t2);
    const t2Sensitive = new Set(t2.toolCalls.map((t) => t.tool).filter((n) => SENSITIVE.includes(n)));
    check("S6 確認後執行門鎖+保全", t2Sensitive.size >= 2, [...t2Sensitive].join(","));
  }

  // ── S7 HOME_EVENT：廚房煙霧三分支 ──────────────────────
  if (!skip("s7")) {
    console.log("\n=== S7 HOME_EVENT：廚房煙霧事件");
    const SMOKE =
      'HOME_EVENT: {"type":"smoke_detected","room":"kitchen","detail":"smoke level rising, air fryer outlet is on"}';

    {
      const s = await ChatSession.open(store, llm, DEMO_USER, "home");
      const t = await s.send(SMOKE);
      show("分支1 煙霧事件", t);
      const outletOff = t.toolCalls.some((c) => c.tool === "set_outlet" && c.args.on === false);
      check("S7-1 先斷可疑電器電源", outletOff, t.toolCalls.map((c) => c.tool).join(","));
      check("S7-1 警告並確認人的狀態", /[?？]/.test(t.reply), t.reply.slice(0, 80));
      check("S7-1 未直接 119", !t.toolCalls.some((c) => c.tool === "emergency_call"));
    }
    {
      const s = await ChatSession.open(store, llm, DEMO_USER, "home");
      const t = await s.send(`${SMOKE}\nUSER_NO_RESPONSE（15 秒無回應）`);
      show("分支2 無回應自動升級", t);
      check(
        "S7-2 無回應 → emergency_call 119",
        t.toolCalls.some((c) => c.tool === "emergency_call" && c.args.service === "119"),
        t.toolCalls.map((c) => c.tool).join(","),
      );
    }
    {
      const s = await ChatSession.open(store, llm, DEMO_USER, "home");
      const t = await s.send(`${SMOKE}\n使用者：沒事沒事！只是煎魚燒焦了，煙有點大而已`);
      show("分支3 誤報不升級", t);
      check("S7-3 誤報不撥 119", !t.toolCalls.some((c) => c.tool === "emergency_call"));
    }
  }

  // ── S8 行事曆出發提醒：事件把導航+會議簡報串成一場 ──────
  if (!skip("s8")) {
    console.log("\n=== S8 CALENDAR_EVENT：早晨上車出發提醒");
    const s = await ChatSession.open(store, llm, DEMO_USER, "driving");
    const t = await s.send(
      'CALENDAR_EVENT: {"type":"departure_reminder","event":"與王經理客戶會議","at":"09:00","location":"客戶公司","travel_minutes":24,"leave_by":"08:30"}',
    );
    show("T1 出發提醒事件", t);
    check("S8 簡報會議內容", /(王經理|會議|09|9 ?點)/.test(t.reply), t.reply.slice(0, 80));
    check(
      "S8 提出發時間或導航",
      t.toolCalls.some((c) => c.tool === "start_navigation" || c.tool === "get_routes") ||
        /(出發|導航|8[:：]30)/.test(t.reply),
      t.toolCalls.map((c) => c.tool).join(","),
    );
  }

  // ── S9 save_memory：會議記錄明令寫入（記憶來源的故事閉環）──
  if (!skip("s9")) {
    console.log("\n=== S9 save_memory：辦公室會後明令記錄");
    const s = await ChatSession.open(store, llm, DEMO_USER, "office");
    const t = await s.send("幫我記下來：王經理最後接受報價 $43,500，改成月付，下週一簽約");
    show("T1 幫我記下來", t);
    const savedCall = t.toolCalls.find((c) => c.tool === "save_memory");
    check("S9 呼叫 save_memory", savedCall !== undefined, t.toolCalls.map((c) => c.tool).join(","));
    const found = await store.recall({
      userId: DEMO_USER,
      query: "王經理簽約 報價",
      context: "office",
      topK: 3,
    });
    check(
      "S9 記憶真的落庫可召回",
      found.some((m) => /43,?500/.test(m.content)),
      found[0]?.content.slice(0, 40) ?? "(nothing)",
    );
  }

  // ── S10 geofence 離家模式：事件觸發 procedural 流程 ─────
  if (!skip("s10")) {
    console.log("\n=== S10 HOME_EVENT geofence_exit：離家模式");
    const s = await ChatSession.open(store, llm, DEMO_USER, "home");
    const t = await s.send('HOME_EVENT: {"type":"geofence_exit","detail":"user left home, no one inside"}');
    show("T1 geofence_exit", t);
    const names = t.toolCalls.map((c) => c.tool);
    check(
      "S10 執行離家流程的非敏感部分（燈/冷氣/掃地機 ≥2 種）",
      new Set(names.filter((n) => ["set_light", "set_thermostat", "start_vacuum"].includes(n))).size >= 2,
      names.join(","),
    );
    check("S10 保全不先斬後奏", !names.includes("set_security_system"));
    check("S10 回覆問到保全", /(保全|安防|離家模式)/.test(t.reply), t.reply.slice(0, 80));
  }

  // ── S11 低油量事件：非安全車輛事件 × 記憶偏好 ───────────
  if (!skip("s11")) {
    console.log("\n=== S11 VEHICLE_EVENT low_fuel：油量低 × 加油站偏好");
    const s = await ChatSession.open(store, llm, DEMO_USER, "driving");
    const t = await s.send('VEHICLE_EVENT: {"type":"low_fuel","detail":"fuel 12%, range 58km"}');
    show("T1 low_fuel", t);
    check(
      "S11 建議加油（提到加油站或呼叫 search_poi）",
      t.toolCalls.some((c) => c.tool === "search_poi") || /(加油|中油)/.test(t.reply),
      t.reply.slice(0, 80),
    );
    check("S11 不誤觸 emergency_call", !t.toolCalls.some((c) => c.tool === "emergency_call"));
  }
} finally {
  await db.drop();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n========== 結果：${checks.length - failed.length}/${checks.length} 通過`);
for (const f of failed) console.log(`  ❌ ${f.name}${f.note ? `（${f.note}）` : ""}`);
process.exit(failed.length > 0 ? 1 : 0);
