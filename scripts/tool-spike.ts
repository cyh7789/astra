/** Gemma 工具調用 spike：驗證開源模型走 JSON 協議 + harness 能否可靠操作裝置。
 *  跑法：EMBEDDER=voyage GEMINI_MODEL=gemma-4-31b-it npx tsx scripts/tool-spike.ts */
import { selectEmbedder } from "../src/embedder-select.js";
import { GeminiClient } from "../src/llm.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { ToolAgent } from "../src/tool-agent.js";
import { createTestDb } from "../tests/helpers.js";

const AIRBAG_EVENT =
  'VEHICLE_EVENT: {"type":"airbag_deployed","speed_before_impact_kmh":62,"gps":"25.0330,121.5654","timestamp":"now"}';

const CASES: Array<{ name: string; context: string; message: string }> = [
  { name: "氣囊事件：先確認人", context: "driving", message: AIRBAG_EVENT },
  {
    name: "氣囊事件 + 無回應：自動升級",
    context: "driving",
    message: `${AIRBAG_EVENT}\nUSER_NO_RESPONSE（15 秒無回應）`,
  },
  {
    name: "氣囊事件 + 人沒事：不誤報",
    context: "driving",
    message: `${AIRBAG_EVENT}\n使用者：我沒事！只是低速追撞，氣囊彈出來嚇一跳而已`,
  },
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
