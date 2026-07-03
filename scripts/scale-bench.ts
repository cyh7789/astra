/** 量級壓測（#26-D）：評分第一項「大量記憶中精準撈」的證據 —
 *  灌 N 筆真向量干擾記憶後：①已知相關記憶仍進 top-5（品質不劣化）②檢索延遲 p50/p95 ③EXPLAIN 走向量索引。
 *  跑法：EMBEDDER=voyage SCALE_N=2000 npx tsx scripts/scale-bench.ts（本地 dev DB；設 ASTRA_TEST_BASE_URL 可打 Cloud） */
import { encodeVector } from "../src/db.js";
import { VoyageEmbedder } from "../src/embedder-voyage.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { MemoryStore } from "../src/store.js";
import { createTestDb } from "../tests/helpers.js";

const N = Number(process.env.SCALE_N ?? 2000);

/** 干擾記憶生成：主題遠近混合（近似題材製造真實的檢索壓力） */
function distractors(n: number): string[] {
  const people = ["陳姐", "小林", "阿哲", "美玲", "老張", "怡君", "大衛", "淑芬"];
  const places = ["信義區", "板橋", "公司樓下", "河濱公園", "好市多", "巷口", "台中", "宜蘭"];
  const things = ["瑜珈課", "牙醫", "羽球", "讀書會", "保養廠", "美髮", "健檢", "聚餐"];
  const foods = ["滷肉飯", "壽司", "義大利麵", "牛肉麵", "沙拉", "鹹酥雞", "早午餐", "火鍋料"];
  const items = ["雨傘", "行動電源", "維他命", "貓砂", "咖啡豆", "衛生紙", "檯燈", "延長線"];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = people[i % people.length]!;
    const pl = places[(i * 3) % places.length]!;
    const t = things[(i * 5) % things.length]!;
    const f = foods[(i * 7) % foods.length]!;
    const it = items[(i * 11) % items.length]!;
    const variant = i % 5;
    out.push(
      variant === 0
        ? `${p}約下週${(i % 7) + 1}點在${pl}${t}，記得先確認時間`
        : variant === 1
          ? `上次在${pl}吃的${f}不錯，${p}也說想再去`
          : variant === 2
            ? `要補買${it}，${pl}的比較便宜（第 ${i} 次購物清單）`
            : variant === 3
              ? `${t}改到週${(i % 6) + 1}，${p}會一起去${pl}`
              : `${p}推薦的${f}店在${pl}，人均約 ${200 + (i % 12) * 30} 元`,
    );
  }
  return out;
}

const db = await createTestDb();
try {
  const embedder = new VoyageEmbedder();
  const store = new MemoryStore(db.pool, embedder);
  const ids = await seed(store);
  console.error(`seeded 15 real memories; generating ${N} distractors...`);

  const texts = distractors(N);
  const t0 = Date.now();
  const vecs = await embedder.embedBatch(texts);
  console.error(`embedded ${N} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 批次 INSERT（context/type/時間分散）
  const contexts = ["home", "office", "driving", "any"];
  const types = ["episodic", "semantic"];
  const CHUNK = 200;
  const now = Date.now();
  for (let i = 0; i < N; i += CHUNK) {
    const rows: string[] = [];
    const params: unknown[] = [];
    for (let j = i; j < Math.min(i + CHUNK, N); j++) {
      const base = params.length;
      rows.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector, $${base + 6}, $${base + 7})`,
      );
      params.push(
        DEMO_USER,
        contexts[j % contexts.length],
        types[j % types.length],
        texts[j],
        encodeVector(vecs[j]!),
        0.3 + (j % 5) * 0.1,
        new Date(now - (j % 180) * 86_400_000),
      );
    }
    await db.pool.query(
      `INSERT INTO memories (user_id, context, memory_type, content, embedding, importance, created_at)
       VALUES ${rows.join(",")}`,
      params,
    );
  }
  console.error(`inserted ${N} distractors`);
  // 批量匯入後必 ANALYZE：missing stats 時 planner 不選向量索引（explain-debug.ts 實證，
  // 給官方的 tool feedback 素材）— 生產環境 CRDB 會自動收集，冷啟動/大量匯入後要手動補
  await db.pool.query(`ANALYZE memories`);
  console.error(`analyzed`);

  // ① 品質不劣化：校準題組的已知相關記憶仍進 top-5
  const CASES: Array<{ context: string; query: string; expectKeys: string[] }> = [
    { context: "driving", query: "等下要去加油", expectKeys: ["refuel-reminder", "gas-station-pref"] },
    { context: "office", query: "上次跟王經理談的報價是多少？", expectKeys: ["quote-meeting"] },
    { context: "home", query: "冰箱裡還有什麼？晚餐吃什麼好？", expectKeys: ["fridge-stock"] },
    { context: "home", query: "晚上想聽點音樂放鬆", expectKeys: ["music-pref"] },
    { context: "home", query: "我要睡了", expectKeys: ["sleep-routine"] },
    { context: "driving", query: "今天行程怎麼安排？", expectKeys: ["client-meeting"] },
  ];
  let qualityFails = 0;
  const latencies: number[] = [];
  for (const c of CASES) {
    for (let rep = 0; rep < 5; rep++) {
      const t = Date.now();
      const top = await store.recall({ userId: DEMO_USER, query: c.query, context: c.context, topK: 5 });
      latencies.push(Date.now() - t);
      if (rep === 0) {
        const got = new Set(top.map((m) => m.id));
        for (const k of c.expectKeys) {
          const hit = got.has(ids.get(k)!);
          console.log(`  ${hit ? "✅" : "❌"} [${c.context}] ${c.query} → ${k}`);
          if (!hit) qualityFails++;
        }
      }
    }
  }

  // ② 延遲分布（含 embed query 的端到端 recall）
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  console.log(
    `\nrecall 端到端延遲（${sorted.length} 次，${N + 15} 筆記憶）：p50=${pct(0.5)}ms p95=${pct(0.95)}ms max=${sorted[sorted.length - 1]}ms`,
  );

  // ③ 純 SQL 延遲（拆掉 embed 網路時間）+ EXPLAIN 走索引證據（兩段式查詢，同 fetchCandidates 形狀）
  const q = await embedder.embed("等下要去加油");
  const qv = encodeVector(q);
  const TWO_PHASE = `SELECT id, vector_sim FROM (
       SELECT id, deleted_at, expires_at, context, privacy_level,
              1 - (embedding <=> $2::vector) AS vector_sim
       FROM memories WHERE user_id = $1
       ORDER BY embedding <-> $2::vector LIMIT 400
     )
     WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       AND (context = 'driving' OR context = 'any' OR privacy_level IN ('cross-context','public'))
     ORDER BY vector_sim DESC LIMIT 200`;
  const sqlLat: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = Date.now();
    await db.pool.query(TWO_PHASE, [DEMO_USER, qv]);
    sqlLat.push(Date.now() - t);
  }
  const s2 = [...sqlLat].sort((a, b) => a - b);
  console.log(
    `純 SQL 檢索延遲（20 次）：p50=${s2[Math.floor(s2.length / 2)]}ms max=${s2[s2.length - 1]}ms`,
  );
  const plan = await db.pool.query(`EXPLAIN ${TWO_PHASE}`, [DEMO_USER, qv]);
  const planText = plan.rows.map((r) => Object.values(r)[0]).join("\n");
  const usesIndex = /vector search/i.test(planText);
  console.log(`\nEXPLAIN 走向量索引：${usesIndex ? "✅" : "❌"}`);
  console.log(planText.split("\n").slice(0, 12).join("\n"));

  console.log(`\n===== 量級壓測（${N} 干擾 + 15 真實）：品質失敗 ${qualityFails} 項 =====`);
  process.exit(qualityFails > 0 || !usesIndex ? 1 : 0);
} finally {
  await db.drop();
}
