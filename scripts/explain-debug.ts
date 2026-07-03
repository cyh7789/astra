/** EXPLAIN 診斷：向量索引在 placeholder vs 字面量、不同過濾組合下的使用情況。 */
import { encodeVector } from "../src/db.js";
import { FakeEmbedder } from "../src/embedder.js";
import { DEMO_USER } from "../src/seed.js";
import { createTestDb } from "../tests/helpers.js";

const db = await createTestDb();
try {
  const fake = new FakeEmbedder();
  // 灌 2000 筆假向量（planner 行為看列數，不看向量真假）
  const CHUNK = 200;
  for (let i = 0; i < 2000; i += CHUNK) {
    const rows: string[] = [];
    const params: unknown[] = [];
    for (let j = i; j < i + CHUNK; j++) {
      const base = params.length;
      rows.push(`($${base + 1}, 'home', 'episodic', $${base + 2}, $${base + 3}::vector)`);
      params.push(DEMO_USER, `記憶內容 ${j}`, encodeVector(await fake.embed(`記憶 ${j}`)));
    }
    await db.pool.query(
      `INSERT INTO memories (user_id, context, memory_type, content, embedding) VALUES ${rows.join(",")}`,
      params,
    );
  }
  const qv = encodeVector(await fake.embed("查詢"));

  const variants: Array<[string, string, unknown[]]> = [
    [
      "A. placeholder + deleted_at 過濾（bench 原查詢）",
      `EXPLAIN SELECT id FROM memories WHERE user_id = $1 AND deleted_at IS NULL ORDER BY embedding <-> $2::vector LIMIT 200`,
      [DEMO_USER, qv],
    ],
    [
      "B. 字面量向量 + deleted_at 過濾",
      `EXPLAIN SELECT id FROM memories WHERE user_id = '${DEMO_USER}' AND deleted_at IS NULL ORDER BY embedding <-> '${qv}'::vector LIMIT 200`,
      [],
    ],
    [
      "C. 字面量向量、無其他過濾",
      `EXPLAIN SELECT id FROM memories WHERE user_id = '${DEMO_USER}' ORDER BY embedding <-> '${qv}'::vector LIMIT 200`,
      [],
    ],
    [
      "D. fetchCandidates 完整形狀（placeholder）",
      `EXPLAIN SELECT id, 1 - (embedding <=> $2::vector) AS vector_sim FROM memories
       WHERE user_id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > $3)
         AND ($4 OR context = $5 OR context = 'any' OR privacy_level IN ('cross-context','public'))
       ORDER BY embedding <-> $2::vector LIMIT 200`,
      [DEMO_USER, qv, new Date(), false, "home"],
    ],
    [
      "E. 字面量 + LIMIT 20（k 較小）",
      `EXPLAIN SELECT id FROM memories WHERE user_id = '${DEMO_USER}' ORDER BY embedding <-> '${qv}'::vector LIMIT 20`,
      [],
    ],
  ];

  // 嫌疑 1：idx_mem_vec 在測試 DB 到底建成了沒
  const idx = await db.pool.query(`SHOW INDEXES FROM memories`);
  const idxNames = [...new Set(idx.rows.map((r) => r.index_name))];
  console.log(`indexes: ${idxNames.join(", ")}`);
  console.log(`idx_mem_vec 存在: ${idxNames.includes("idx_mem_vec") ? "✅" : "❌"}`);

  for (const [name, sql, params] of variants) {
    const r = await db.pool.query(sql, params);
    const text = r.rows.map((row) => Object.values(row)[0]).join("\n");
    const uses = /vector/i.test(text) && /search/i.test(text);
    console.log(`\n===== ${name} → vector search: ${uses ? "✅" : "❌"}`);
    console.log(text.split("\n").slice(0, 14).join("\n"));
  }

  // 嫌疑 2：缺統計 → ANALYZE 後跑過濾條件矩陣
  await db.pool.query(`ANALYZE memories`);
  const post: Array<[string, string, unknown[]]> = [
    [
      "A' placeholder + deleted_at",
      `EXPLAIN SELECT id FROM memories WHERE user_id = $1 AND deleted_at IS NULL ORDER BY embedding <-> $2::vector LIMIT 200`,
      [DEMO_USER, qv],
    ],
    [
      "B' 字面量 + deleted_at",
      `EXPLAIN SELECT id FROM memories WHERE user_id = '${DEMO_USER}' AND deleted_at IS NULL ORDER BY embedding <-> '${qv}'::vector LIMIT 200`,
      [],
    ],
    [
      "F placeholder、無過濾",
      `EXPLAIN SELECT id FROM memories WHERE user_id = $1 ORDER BY embedding <-> $2::vector LIMIT 200`,
      [DEMO_USER, qv],
    ],
    [
      "G 兩段式：內層純向量 top-k、外層補全部過濾",
      `EXPLAIN SELECT id FROM (
         SELECT id, content, context, privacy_level, deleted_at, expires_at,
                1 - (embedding <=> $2::vector) AS vector_sim
         FROM memories WHERE user_id = $1
         ORDER BY embedding <-> $2::vector LIMIT 400
       ) WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > $3)
         AND ($4 OR context = $5 OR context = 'any' OR privacy_level IN ('cross-context','public'))
       LIMIT 200`,
      [DEMO_USER, qv, new Date(), false, "home"],
    ],
  ];
  for (const [name, sql, params] of post) {
    const r = await db.pool.query(sql, params);
    const text = r.rows.map((row) => Object.values(row)[0]).join("\n");
    const uses = /vector/i.test(text) && /search/i.test(text);
    console.log(`\n===== [ANALYZE 後] ${name} → vector search: ${uses ? "✅" : "❌"}`);
    console.log(text.split("\n").slice(0, 16).join("\n"));
  }
} finally {
  await db.drop();
}
