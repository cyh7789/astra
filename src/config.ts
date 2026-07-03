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

/** recency 半衰期（小時）：7 天 */
export const RECENCY_HALF_LIFE_HOURS = 168;
