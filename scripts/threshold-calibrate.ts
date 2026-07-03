/** 分數門檻校準：用真 embeddings 量測「相關 vs 不相關 query」的原始 cosine 相似度分布，
 *  決定記憶窗的准入門檻（fused score 經 min-max 是相對值，門檻只能定在 vectorSim 上）。
 *  跑法：EMBEDDER=voyage npx tsx scripts/threshold-calibrate.ts（需本地 dev DB） */
import { selectEmbedder } from "../src/embedder-select.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb } from "../tests/helpers.js";

/** relevant = 這個 query 該召回的記憶 key（人工標注）；空陣列 = 故意不相關的 query */
const CASES: Array<{ context: string; query: string; relevant: string[] }> = [
  { context: "driving", query: "今天行程怎麼安排？", relevant: ["refuel-reminder", "client-meeting"] },
  { context: "driving", query: "等下要去加油", relevant: ["refuel-reminder", "gas-station-pref"] },
  { context: "office", query: "上次跟王經理談的報價是多少？", relevant: ["quote-meeting", "wang-prefs", "wang-concern"] },
  { context: "home", query: "冰箱裡還有什麼？晚餐吃什麼好？", relevant: ["fridge-stock", "airfryer-idea", "wed-light-dinner"] },
  { context: "home", query: "晚上想聽點音樂放鬆", relevant: ["music-pref"] },
  { context: "home", query: "冷氣幫我開一下", relevant: ["ac-pref"] },
  // 不相關 query：max sim = 雜訊天花板（門檻要壓在這之上）
  { context: "driving", query: "你覺得量子力學有趣嗎？", relevant: [] },
  { context: "office", query: "印表機怎麼連 wifi？", relevant: [] },
  { context: "home", query: "推薦一部好看的電影", relevant: [] },
  // 退化 query：多輪對話指代語（「那個呢」直接 embed 的下場）
  { context: "home", query: "那個呢？", relevant: [] },
];

const db = await createTestDb();
try {
  const embedder = selectEmbedder();
  console.error(`embedder: ${embedder.constructor.name}`);
  const store = new MemoryStore(db.pool, embedder);
  const ids = await seed(store);
  const keyById = new Map([...ids.entries()].map(([k, v]) => [v, k]));

  const relSims: number[] = [];
  const irrSims: number[] = [];

  for (const c of CASES) {
    const candidates = await store.fetchCandidates({
      userId: DEMO_USER,
      query: c.query,
      context: c.context,
    });
    console.log(`\n=== [${c.context}] ${c.query}`);
    for (const m of candidates.sort((a, b) => b.vectorSim - a.vectorSim)) {
      const key = keyById.get(m.id) ?? "?";
      const isRel = c.relevant.includes(key);
      (isRel ? relSims : irrSims).push(m.vectorSim);
      console.log(`  ${isRel ? "✅" : "  "} ${m.vectorSim.toFixed(4)}  ${key}`);
    }
  }

  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    return `n=${s.length} min=${s[0]!.toFixed(3)} p25=${q(0.25).toFixed(3)} med=${q(0.5).toFixed(3)} p75=${q(0.75).toFixed(3)} max=${s[s.length - 1]!.toFixed(3)}`;
  };
  console.log(`\n相關   ：${stats(relSims)}`);
  console.log(`不相關 ：${stats(irrSims)}`);
} finally {
  await db.drop();
}
