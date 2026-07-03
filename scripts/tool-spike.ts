/** Gemma 工具調用 spike：驗證開源模型走 JSON 協議 + harness 能否可靠操作裝置。
 *  跑法：EMBEDDER=voyage GEMINI_MODEL=gemma-4-31b-it npx tsx scripts/tool-spike.ts */
import { selectEmbedder } from "../src/embedder-select.js";
import { GeminiClient } from "../src/llm.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { ToolAgent } from "../src/tool-agent.js";
import { createTestDb } from "../tests/helpers.js";

const CASES: Array<{ name: string; context: string; message: string }> = [
  { name: "直接指令", context: "home", message: "幫我把冷氣調到 24 度" },
  { name: "記憶 × 工具", context: "home", message: "照我平常的習慣開冷氣" },
  { name: "工具結果推理", context: "driving", message: "油還夠嗎？夠不夠開去台中？" },
  { name: "跨場景攔截", context: "driving", message: "幫我先把家裡的氣炸鍋開起來預熱" },
  { name: "不存在的能力", context: "home", message: "幫我把浴缸放好熱水" },
  { name: "純聊天不亂呼叫", context: "home", message: "今天工作好累喔" },
];

const model = process.env.GEMINI_MODEL ?? "gemma-4-31b-it";
const llm = new GeminiClient(model);
console.error(`tool spike llm: ${model} / embedder: ${process.env.EMBEDDER ?? "fake"}`);

const db = await createTestDb();
try {
  const store = new MemoryStore(db.pool, selectEmbedder());
  await seed(store);
  const agent = new ToolAgent(store, llm, DEMO_USER);

  for (const c of CASES) {
    const r = await agent.chat(c.message, c.context);
    console.log(`\n=== ${c.name} [${c.context}] ${c.message}`);
    for (const t of r.toolCalls) {
      console.log(`  🔧 ${t.tool}(${JSON.stringify(t.args)}) → ${JSON.stringify(t.result)}`);
    }
    console.log(`  💬 ${r.reply.replaceAll("\n", " ").slice(0, 150)}`);
    console.log(`  （${r.turns} 輪）`);
  }
} finally {
  await db.drop();
}
