export const DB_URL =
  process.env.ASTRA_DB_URL ??
  "postgresql://root@localhost:26257/astra?sslmode=disable";

/** 與 migrations/001_init.sql 的 VECTOR(N) 必須一致。
 *  1024 = AWS Bedrock Titan Text Embeddings V2 預設維度。 */
export const EMBEDDING_DIM = 1024;

export interface FusionWeights {
  vector: number;
  bm25: number;
  recency: number;
}

export const DEFAULT_FUSION_WEIGHTS: FusionWeights = {
  vector: 0.4,
  bm25: 0.3,
  recency: 0.3,
};

/** 候選集大小：SQL+向量先砍到這個量，BM25/融合在應用層做 */
export const CANDIDATE_LIMIT = 200;

/** 兩段式向量查詢的內層過取樣倍率（7/5 EXPLAIN 實證）：
 *  向量索引不吃 prefix 欄位以外的過濾（deleted_at/expires/context 會讓 planner 放棄索引），
 *  改為內層純向量 top-(LIMIT×倍率) 走索引、外層補過濾 — 被濾掉的由過取樣補償。 */
export const CANDIDATE_OVERSAMPLE = 2;

/** 記憶窗准入門檻（原始 cosine）。voyage-4-large 校準 2026-07-04：
 *  相關最低 0.375、真不相關最高 0.27 — 換 embedder 必重跑 scripts/threshold-calibrate.ts。 */
export const MIN_VECTOR_SIM = 0.35;

/** 高意圖檢索（recall_memory tool / 事件觸發）的放寬門檻：
 *  θ 主要防被動路的雜訊，起頭者意圖明確時放寬。 */
export const MIN_VECTOR_SIM_INTENT = MIN_VECTOR_SIM / 2;

/** 記憶窗容量（對齊 Letta 2k / Zep 2.5k chars 的量級） */
export const WINDOW_CAPACITY = 12;
export const WINDOW_CHAR_BUDGET = 1500;

/** recency 半衰期（小時）：7 天 */
export const RECENCY_HALF_LIFE_HOURS = 168;
