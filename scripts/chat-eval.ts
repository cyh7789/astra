/** 對話品質 eval（不是 unit test）：固定題組跑真 LLM，驗 must-have 行為約束。
 *  demo 前與每次改 prompt 後跑。預設 Gemini free tier（EVAL_LLM=claude 切 claude CLI）。
 *  跑法：EMBEDDER=voyage npx tsx scripts/chat-eval.ts */
import { AstraAgent } from "../src/agent.js";
import { selectEmbedder } from "../src/embedder-select.js";
import { ClaudeCliClient, GeminiClient } from "../src/llm.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb } from "../tests/helpers.js";

// 簡體字專用字元集（繁體不會出現的簡化形）
const SIMPLIFIED = /[记忆鸡说这还没时间应该经过让办体们动见问题词试语读谁调转轻载达运进远连选发药习为业乐闻访诉诚详误课级红绿灯战胜]/u;

interface EvalCase {
  name: string;
  context: string;
  message: string;
  must: Array<[string, RegExp]>;
  mustNot: Array<[string, RegExp]>;
}

const CASES: EvalCase[] = [
  {
    name: "衝突題：問而不是猜",
    context: "home",
    message: "晚餐想吃辣的，你覺得呢？",
    must: [
      ["含問句（向使用者確認）", /[?？]/],
      ["點出矛盾素材", /(麻辣鍋|不吃辣|口味|腸胃)/],
    ],
    mustNot: [["簡體字", SIMPLIFIED]],
  },
  {
    name: "過時題：提醒時效",
    context: "office",
    message: "上次跟王經理談的報價是多少？",
    must: [
      ["講出報價數字", /45,?000/],
      ["提醒時效風險", /(過時|前的資訊|舊|更新|最新|時效|三週|21 ?天)/],
    ],
    mustNot: [["簡體字", SIMPLIFIED]],
  },
  {
    name: "幻覺題：沒記憶就說不知道",
    context: "home",
    message: "我媽的生日是哪天？",
    must: [["承認不知道", /(不知道|沒有|不記得|沒記|查不到|沒提過|沒有記錄|沒有相關)/]],
    mustNot: [
      ["編造具體日期", /\d+ ?月 ?\d+ ?[日號]/],
      ["簡體字", SIMPLIFIED],
    ],
  },
  {
    name: "跨場景題：引用車上說的話",
    context: "home",
    message: "今晚想自己煮點什麼新的",
    must: [["召回氣炸鍋想法", /(氣炸鍋|雞排)/]],
    mustNot: [["簡體字", SIMPLIFIED]],
  },
];

const NOW = new Date();
const llm = process.env.EVAL_LLM === "claude" ? new ClaudeCliClient("sonnet") : new GeminiClient();
console.error(`eval llm: ${llm.constructor.name} / embedder: ${process.env.EMBEDDER ?? "fake"}`);

const db = await createTestDb();
let failed = 0;
try {
  const store = new MemoryStore(db.pool, selectEmbedder());
  await seed(store, NOW);
  const agent = new AstraAgent(store, llm, DEMO_USER);

  for (const c of CASES) {
    const { reply } = await agent.chat(c.message, c.context, NOW);
    const problems: string[] = [];
    for (const [label, re] of c.must) if (!re.test(reply)) problems.push(`缺少：${label}`);
    for (const [label, re] of c.mustNot) if (re.test(reply)) problems.push(`不該出現：${label}`);
    const ok = problems.length === 0;
    if (!ok) failed++;
    console.log(`\n${ok ? "✅" : "❌"} ${c.name}`);
    for (const p of problems) console.log(`   ${p}`);
    console.log(`   ↳ ${reply.replaceAll("\n", " ").slice(0, 120)}…`);
  }
} finally {
  await db.drop();
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed > 0 ? 1 : 0);
