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
  console.log("\n=== S1 窗跨輪常駐：T1 問食材、T2 指代接續");
  {
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
  console.log("\n=== S2 主動深查：車上問回家晚餐（home private 記憶，場景 scope 撈不到）");
  {
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
  console.log("\n=== S3 場景切換：車上→到家，交接浮現氣炸鍋");
  {
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
  console.log("\n=== S4 來電事件：driving 場景收到王經理來電");
  {
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
} finally {
  await db.drop();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n========== 結果：${checks.length - failed.length}/${checks.length} 通過`);
for (const f of failed) console.log(`  ❌ ${f.name}${f.note ? `（${f.note}）` : ""}`);
process.exit(failed.length > 0 ? 1 : 0);
