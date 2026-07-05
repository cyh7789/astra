/** 真語意煙霧驗證：用真 embeddings 重跑三場景 + 語意壓力題，
 *  對照 FakeEmbedder 的已知盲點（氣炸鍋↔晚餐）看檢索品質。
 *  跑法：npx tsx scripts/semantic-smoke.ts（預設 Voyage，EMBEDDER=vertex 切 Vertex/ADC；需本地 dev DB） */
import { VertexEmbedder } from "../src/embedder-vertex.js";
import { VoyageEmbedder } from "../src/embedder-voyage.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb } from "../tests/helpers.js";

// 每題帶 ground truth：召回結果必須命中 expect regex，否則 exit 1（devin P0：原本零斷言只 console.log，
// 換 embedder 檢索退化肉眼看不出）。壓力題（氣炸鍋↔晚餐）是真 embedder 語意召回的關鍵指標。
const SCENARIOS: Array<[string, string, RegExp]> = [
  ["driving", "今天行程怎麼安排？", /加油|王經理|會議/],
  ["office", "上次跟王經理談的報價是多少？", /報價|45,?000/],
  ["home", "冰箱裡還有什麼？晚餐吃什麼好？", /氣炸鍋|雞胸|青花菜/], // 壓力題：氣炸鍋該被語意召回
  ["home", "晚餐想吃辣的嗎？", /辣|麻辣鍋/], // 衝突情境
];

const db = await createTestDb();
try {
  const embedder =
    process.env.EMBEDDER === "vertex"
      ? new VertexEmbedder()
      : new VoyageEmbedder(process.env.VOYAGE_MODEL ?? "voyage-4-large");
  console.error(`embedder: ${embedder.constructor.name} ${process.env.VOYAGE_MODEL ?? ""}`);
  const store = new MemoryStore(db.pool, embedder);
  console.error("seeding with real embeddings...");
  await seed(store);

  let failed = 0;
  for (const [context, query, expect] of SCENARIOS) {
    console.log(`\n=== [${context}] ${query} ===`);
    const out = await store.recallGuarded({ userId: DEMO_USER, query, context, topK: 5 });
    for (const m of out) {
      const s = m.signals;
      console.log(
        `${m.score.toFixed(3)}  vec=${s.vector.toFixed(2)} bm25=${s.bm25.toFixed(2)} rec=${s.recency.toFixed(2)}  ${m.content}`,
      );
      for (const a of m.annotations) console.log(`       ⚠ ${a}`);
    }
    const hit = out.some((m) => expect.test(m.content));
    if (!hit) {
      console.error(`  ✗ 未召回預期記憶（${expect}）— 檢索退化`);
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} 題未命中 ground truth`);
    process.exit(1);
  }
  console.error("\n所有場景命中 ground truth ✓");
} finally {
  await db.drop();
}
