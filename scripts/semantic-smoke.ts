/** 真語意煙霧驗證：用 Vertex embeddings 重跑三場景 + 語意壓力題，
 *  對照 FakeEmbedder 的已知盲點（氣炸鍋↔晚餐）看檢索品質。
 *  跑法：npx tsx scripts/semantic-smoke.ts（需 gcloud ADC + 本地 dev DB） */
import { VertexEmbedder } from "../src/embedder-vertex.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb } from "../tests/helpers.js";

const SCENARIOS: Array<[string, string]> = [
  ["driving", "今天行程怎麼安排？"],
  ["office", "上次跟王經理談的報價是多少？"],
  ["home", "冰箱裡還有什麼？晚餐吃什麼好？"], // 壓力題：氣炸鍋記憶該被語意召回
  ["home", "晚餐想吃辣的嗎？"], // 衝突情境
];

const db = await createTestDb();
try {
  const store = new MemoryStore(db.pool, new VertexEmbedder());
  console.error("seeding with real embeddings...");
  await seed(store);

  for (const [context, query] of SCENARIOS) {
    console.log(`\n=== [${context}] ${query} ===`);
    const out = await store.recallGuarded({
      userId: DEMO_USER,
      query,
      context,
      topK: 5,
    });
    for (const m of out) {
      const s = m.signals;
      console.log(
        `${m.score.toFixed(3)}  vec=${s.vector.toFixed(2)} bm25=${s.bm25.toFixed(2)} rec=${s.recency.toFixed(2)}  ${m.content}`,
      );
      for (const a of m.annotations) console.log(`       ⚠ ${a}`);
    }
  }
} finally {
  await db.drop();
}
