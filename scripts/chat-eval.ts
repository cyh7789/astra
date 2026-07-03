/** 對話品質 eval（不是 unit test）：固定題組跑真 LLM，驗 must-have 行為約束。
 *  走 ChatSession（提交版路徑：英文 system prompt + 記憶窗 + 工具迴圈），含多輪與場景切換題。
 *  demo 前與每次改 prompt 後跑。預設 Gemini free tier（EVAL_LLM=claude 切 claude CLI）。
 *  跑法：EMBEDDER=voyage npx tsx scripts/chat-eval.ts */
import { selectEmbedder } from "../src/embedder-select.js";
import { ClaudeCliClient, GeminiClient } from "../src/llm.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { ChatSession } from "../src/session.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb } from "../tests/helpers.js";

// 簡體字專用字元集（繁體不會出現的簡化形）
const SIMPLIFIED = /[记忆鸡说这还没时间应该经过让办体们动见问题词试语读谁调转轻载达运进远连选发药习为业乐闻访诉诚详误课级红绿灯战胜]/u;

interface EvalStep {
  switchTo?: string; // 先切場景再發話
  message: string;
  must: Array<[string, RegExp]>;
  mustNot: Array<[string, RegExp]>;
}

interface EvalCase {
  name: string;
  context: string; // session 起始場景
  steps: EvalStep[];
}

const noSimplified: [string, RegExp] = ["簡體字", SIMPLIFIED];

const CASES: EvalCase[] = [
  {
    name: "衝突題：問而不是猜",
    context: "home",
    steps: [
      {
        message: "晚餐想吃辣的，你覺得呢？",
        must: [
          ["含問句（向使用者確認）", /[?？]/],
          ["點出矛盾素材", /(麻辣鍋|不吃辣|口味|腸胃)/],
        ],
        mustNot: [noSimplified],
      },
    ],
  },
  {
    name: "過時題：提醒時效",
    context: "office",
    steps: [
      {
        message: "上次跟王經理談的報價是多少？",
        must: [
          ["講出報價數字", /45,?000/],
          ["提醒時效風險", /(過時|前的資訊|舊|更新|最新|時效|三週|21 ?天|一陣子)/],
        ],
        mustNot: [noSimplified],
      },
    ],
  },
  {
    name: "幻覺題：沒記憶就說不知道",
    context: "home",
    steps: [
      {
        message: "我媽的生日是哪天？",
        must: [["承認不知道", /(不知道|沒有|不記得|沒記|查不到|沒提過|沒有記錄|沒有相關)/]],
        mustNot: [["編造具體日期", /\d+ ?月 ?\d+ ?[日號]/], noSimplified],
      },
    ],
  },
  {
    name: "跨場景題：引用車上說的話",
    context: "home",
    steps: [
      {
        message: "今晚想自己煮點什麼新的",
        must: [["召回氣炸鍋想法", /(氣炸鍋|雞排)/]],
        mustNot: [noSimplified],
      },
    ],
  },
  {
    name: "多輪指代題：靠記憶窗接續",
    context: "home",
    steps: [
      { message: "冰箱裡還有什麼食材？", must: [["列出食材", /(雞胸|青花菜)/]], mustNot: [noSimplified] },
      {
        message: "那可以煮什麼？",
        must: [["用上一輪的食材接續", /(雞胸|青花菜|氣炸)/]],
        mustNot: [noSimplified],
      },
    ],
  },
  {
    name: "場景切換題：車上交代回家跟進",
    context: "driving",
    steps: [
      { message: "回家要記得收陽台的衣服，快下雨了", must: [], mustNot: [noSimplified] },
      {
        switchTo: "home",
        message: "我到家了，剛剛說要做什麼來著？",
        must: [["記得車上交代的事", /(衣服|陽台)/]],
        mustNot: [noSimplified],
      },
    ],
  },
  {
    name: "來電簡報題：事件跨場景撈記憶",
    context: "driving",
    steps: [
      {
        message: 'INCOMING_CALL: {"from":"王經理","number":"02-8765-4321"}',
        must: [
          ["帶脈絡簡報", /(季付|報價|維護|交期|45,?000)/],
          ["詢問是否接聽", /接/],
        ],
        mustNot: [noSimplified],
      },
    ],
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

  for (const c of CASES) {
    // 每題重置交接浮現狀態，題目間互不消耗
    await db.pool.query("UPDATE memories SET surfaced_at = NULL");
    const session = await ChatSession.open(store, llm, DEMO_USER, c.context, NOW, {
      extract: false, // eval 驗回覆品質，關萃取隔離副作用與成本
    });
    const problems: string[] = [];
    let lastReply = "";
    for (const step of c.steps) {
      if (step.switchTo) await session.switchContext(step.switchTo, NOW);
      const { reply } = await session.send(step.message, NOW);
      lastReply = reply;
      for (const [label, re] of step.must) if (!re.test(reply)) problems.push(`缺少：${label}`);
      for (const [label, re] of step.mustNot) if (re.test(reply)) problems.push(`不該出現：${label}`);
    }
    const ok = problems.length === 0;
    if (!ok) failed++;
    console.log(`\n${ok ? "✅" : "❌"} ${c.name}`);
    for (const p of problems) console.log(`   ${p}`);
    console.log(`   ↳ ${lastReply.replaceAll("\n", " ").slice(0, 120)}…`);
  }
} finally {
  await db.drop();
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed > 0 ? 1 : 0);
