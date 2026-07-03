import type pg from "pg";
import type { FusionWeights } from "./config.js";
import { CANDIDATE_LIMIT, DEFAULT_FUSION_WEIGHTS } from "./config.js";
import { encodeVector } from "./db.js";
import type { Embedder } from "./embedder.js";
import type { ContradictsLink, GuardedMemory, RecallGuard } from "./guards.js";
import { applyGuards, DEFAULT_GUARDS, toGuarded } from "./guards.js";
import { bm25Scores, fuse, minMaxNormalize, recencyScore } from "./retrieval.js";
import { tokenize } from "./text.js";

export type MemoryType = "episodic" | "semantic" | "procedural";
export type PrivacyLevel = "private" | "cross-context" | "public";

export interface MemoryInput {
  userId: string;
  context: string;
  memoryType: MemoryType;
  content: string;
  importance?: number;
  privacyLevel?: PrivacyLevel;
  expiresAt?: Date;
  sourceContext?: string;
  createdAt?: Date; // seed/測試用；正常寫入不帶
}

export interface Memory {
  id: string;
  userId: string;
  context: string;
  memoryType: MemoryType;
  content: string;
  importance: number;
  privacyLevel: PrivacyLevel;
  accessCount: number;
  createdAt: Date;
  lastAccessed: Date;
  expiresAt: Date | null;
  sourceContext: string | null;
}

export interface RecallQuery {
  userId: string;
  query: string;
  context: string;
  topK?: number;
  now?: Date; // 測試用時間凍結
  weights?: FusionWeights;
  /** scene（預設）= 場景+隱私過濾；cross = 跨場景（事件/顯式深查用，流動政策 §4.8 — 呼叫端負責來源標注） */
  scope?: "scene" | "cross";
  /** 准入門檻：原始 cosine 低於此值的候選剔除（校準：scripts/threshold-calibrate.ts） */
  minSim?: number;
}

export interface Candidate extends Memory {
  vectorSim: number;
}

export interface ScoredMemory extends Candidate {
  signals: { vector: number; bm25: number; recency: number };
  score: number;
}

const MEMORY_COLS = `id, user_id, context, memory_type, content, importance,
  privacy_level, access_count, created_at, last_accessed, expires_at, source_context`;

function rowToMemory(r: Record<string, unknown>): Memory {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    context: r.context as string,
    memoryType: r.memory_type as MemoryType,
    content: r.content as string,
    importance: r.importance as number,
    privacyLevel: r.privacy_level as PrivacyLevel,
    accessCount: r.access_count as number,
    createdAt: r.created_at as Date,
    lastAccessed: r.last_accessed as Date,
    expiresAt: (r.expires_at as Date | null) ?? null,
    sourceContext: (r.source_context as string | null) ?? null,
  };
}

export class MemoryStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly embedder: Embedder,
  ) {}

  async remember(input: MemoryInput): Promise<Memory> {
    const embedding = await this.embedder.embed(input.content);
    const r = await this.pool.query(
      `INSERT INTO memories
         (user_id, context, memory_type, content, embedding, importance,
          privacy_level, expires_at, source_context, created_at)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9, COALESCE($10, now()))
       RETURNING ${MEMORY_COLS}`,
      [
        input.userId,
        input.context,
        input.memoryType,
        input.content,
        encodeVector(embedding),
        input.importance ?? 0.5,
        input.privacyLevel ?? "private",
        input.expiresAt ?? null,
        input.sourceContext ?? null,
        input.createdAt ?? null,
      ],
    );
    return rowToMemory(r.rows[0]);
  }

  async get(id: string): Promise<Memory | null> {
    const r = await this.pool.query(
      `SELECT ${MEMORY_COLS} FROM memories WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return r.rows[0] ? rowToMemory(r.rows[0]) : null;
  }

  async update(
    id: string,
    patch: {
      content?: string;
      importance?: number;
      privacyLevel?: PrivacyLevel;
      expiresAt?: Date | null;
    },
  ): Promise<Memory> {
    const embedding =
      patch.content !== undefined ? await this.embedder.embed(patch.content) : null;
    const r = await this.pool.query(
      `UPDATE memories SET
         content = COALESCE($2, content),
         embedding = COALESCE($3::vector, embedding),
         importance = COALESCE($4, importance),
         privacy_level = COALESCE($5, privacy_level),
         expires_at = CASE WHEN $6 THEN $7 ELSE expires_at END
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING ${MEMORY_COLS}`,
      [
        id,
        patch.content ?? null,
        embedding ? encodeVector(embedding) : null,
        patch.importance ?? null,
        patch.privacyLevel ?? null,
        patch.expiresAt !== undefined,
        patch.expiresAt ?? null,
      ],
    );
    if (!r.rows[0]) throw new Error(`memory not found: ${id}`);
    return rowToMemory(r.rows[0]);
  }

  async forget(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE memories SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
  }

  /** Hybrid query：SQL 範圍過濾（user/場景/隱私/時效/未刪）+ 向量距離排序，一條 query 進 CockroachDB。
   *  ORDER BY 用 <->（L2）：向量索引預設 vector_l2_ops，EXPLAIN 實測 <=> 不走索引、<-> 走 vector search。
   *  Embedder 產出的向量皆 L2 normalized，L2 排序 ≡ cosine 排序（L2² = 2−2cos）；
   *  SELECT 仍算 cosine 相似度供顯示與融合。 */
  async fetchCandidates(q: RecallQuery): Promise<Candidate[]> {
    const now = q.now ?? new Date();
    const queryEmbedding = await this.embedder.embed(q.query);
    const r = await this.pool.query(
      `SELECT ${MEMORY_COLS},
              1 - (embedding <=> $2::vector) AS vector_sim
       FROM memories
       WHERE user_id = $1
         AND deleted_at IS NULL
         AND (expires_at IS NULL OR expires_at > $4)
         AND ($6 OR context = $3 OR context = 'any' OR privacy_level IN ('cross-context', 'public'))
       ORDER BY embedding <-> $2::vector
       LIMIT $5`,
      [q.userId, encodeVector(queryEmbedding), q.context, now, CANDIDATE_LIMIT, q.scope === "cross"],
    );
    return r.rows.map((row) => ({ ...rowToMemory(row), vectorSim: Number(row.vector_sim) }));
  }

  /** 多訊號融合檢索：候選集 → BM25 + recency → 歸一化 → 加權融合 → top-K，並回寫 access 統計。 */
  async recall(q: RecallQuery): Promise<ScoredMemory[]> {
    const now = q.now ?? new Date();
    const weights = q.weights ?? DEFAULT_FUSION_WEIGHTS;
    const topK = q.topK ?? 5;

    let candidates = await this.fetchCandidates(q);
    if (q.minSim !== undefined) {
      const minSim = q.minSim;
      candidates = candidates.filter((c) => c.vectorSim >= minSim);
    }
    if (candidates.length === 0) return [];

    const queryTokens = tokenize(q.query);
    const docTokens = candidates.map((c) => tokenize(c.content));
    const signals = {
      vector: minMaxNormalize(candidates.map((c) => c.vectorSim)),
      bm25: minMaxNormalize(bm25Scores(queryTokens, docTokens)),
      recency: minMaxNormalize(candidates.map((c) => recencyScore(c.createdAt, now))),
    };
    const fused = fuse(signals, weights);

    const scored: ScoredMemory[] = candidates
      .map((c, i) => ({
        ...c,
        signals: {
          vector: signals.vector[i]!,
          bm25: signals.bm25[i]!,
          recency: signals.recency[i]!,
        },
        score: fused[i]!,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    if (scored.length > 0) {
      await this.pool.query(
        `UPDATE memories
         SET access_count = access_count + 1, last_accessed = $2
         WHERE id = ANY($1::uuid[])`,
        [scored.map((m) => m.id), now],
      );
    }
    return scored;
  }

  /** 建立記憶關係邊（Phase 4 萃取器偵測到矛盾/更新時呼叫；seed 手動建）。 */
  async link(
    sourceId: string,
    targetId: string,
    relation: "contradicts" | "updates" | "supports" | "caused_by",
  ): Promise<void> {
    await this.pool.query(
      "INSERT INTO memory_links (source_id, target_id, relation) VALUES ($1, $2, $3)",
      [sourceId, targetId, relation],
    );
  }

  async getMany(ids: string[]): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const r = await this.pool.query(
      `SELECT ${MEMORY_COLS} FROM memories WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    return r.rows.map(rowToMemory);
  }

  /** 單端匹配的邊查詢（記憶窗 link 一跳擴展用 — 對照 loadContradictsLinks 要求兩端都在集合內）。 */
  async loadLinksFor(
    ids: string[],
  ): Promise<Array<{ sourceId: string; targetId: string; relation: string }>> {
    if (ids.length === 0) return [];
    const r = await this.pool.query(
      `SELECT source_id, target_id, relation FROM memory_links
       WHERE source_id = ANY($1::uuid[]) OR target_id = ANY($1::uuid[])`,
      [ids],
    );
    return r.rows.map((row) => ({
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      relation: row.relation as string,
    }));
  }

  /** 交接浮現候選（§4.5）：在其他場景交代、屬於新場景的近況記憶。
   *  純 SQL 零 embedding。PoC 版 surfaced 去重由 session 端記錄（surfaced_at 欄位 = migration 002）。 */
  async handoffCandidates(userId: string, context: string, now = new Date()): Promise<Memory[]> {
    const r = await this.pool.query(
      `SELECT ${MEMORY_COLS} FROM memories
       WHERE user_id = $1 AND context = $2 AND deleted_at IS NULL
         AND source_context IS NOT NULL AND source_context != $2
         AND (expires_at IS NULL OR expires_at > $3)
         AND created_at > $3::timestamptz - INTERVAL '14 days'
       ORDER BY importance DESC
       LIMIT 3`,
      [userId, context, now],
    );
    return r.rows.map(rowToMemory);
  }

  /** 場景 pin 候選（§4.5）：安全關鍵、跨場景可見的常駐記憶（如緊急聯絡人）。 */
  async pinCandidates(userId: string, now = new Date()): Promise<Memory[]> {
    const r = await this.pool.query(
      `SELECT ${MEMORY_COLS} FROM memories
       WHERE user_id = $1 AND deleted_at IS NULL
         AND (expires_at IS NULL OR expires_at > $2)
         AND importance >= 0.9
         AND (context = 'any' OR privacy_level IN ('cross-context', 'public'))
       ORDER BY importance DESC
       LIMIT 2`,
      [userId, now],
    );
    return r.rows.map(rowToMemory);
  }

  async loadContradictsLinks(ids: string[]): Promise<ContradictsLink[]> {
    if (ids.length === 0) return [];
    const r = await this.pool.query(
      `SELECT source_id, target_id FROM memory_links
       WHERE relation = 'contradicts'
         AND source_id = ANY($1::uuid[])
         AND target_id = ANY($1::uuid[])`,
      [ids],
    );
    return r.rows.map((row) => ({
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
    }));
  }

  /** recall + guard chain：agent 與 demo UI 的標準入口，回傳帶安全標注。 */
  async recallGuarded(
    q: RecallQuery,
    guards: RecallGuard[] = DEFAULT_GUARDS,
  ): Promise<GuardedMemory[]> {
    const memories = await this.recall(q);
    return applyGuards(
      guards,
      toGuarded(memories),
      { currentContext: q.context, now: q.now ?? new Date() },
      { loadContradictsLinks: (ids) => this.loadContradictsLinks(ids) },
    );
  }
}
