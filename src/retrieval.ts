import type { FusionWeights } from "./config.js";
import { RECENCY_HALF_LIFE_HOURS } from "./config.js";

/** Okapi BM25。corpus = 候選集（SQL+向量過濾後的幾百筆），in-process 計分。 */
export function bm25Scores(
  queryTokens: string[],
  docs: string[][],
  k1 = 1.2,
  b = 0.75,
): number[] {
  const N = docs.length;
  if (N === 0) return [];
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const uniqueQuery = [...new Set(queryTokens)];
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of uniqueQuery) {
      const n = df.get(q);
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const f = tf.get(q) ?? 0;
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.length) / avgdl));
    }
    return score;
  });
}

/** 指數衰減：每過一個半衰期分數減半。未來時間戳 clamp 成 1。 */
export function recencyScore(
  createdAt: Date,
  now: Date,
  halfLifeHours = RECENCY_HALF_LIFE_HOURS,
): number {
  const ageHours = (now.getTime() - createdAt.getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours)) return 0; // invalid date → 不讓 NaN 汙染整條訊號（devin P0）
  if (ageHours <= 0) return 1;
  return Math.pow(2, -ageHours / halfLifeHours);
}

/** min-max 歸一化到 [0,1]；全部相等時回 1（訊號無鑑別度、對排序無影響）。
 *  非有限值先歸零 — 單一 NaN 會讓 Math.min/max 全塌成 NaN、fused 全 NaN、sort 靜默亂序（devin P0）。 */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const clean = values.map((v) => (Number.isFinite(v) ? v : 0));
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (max === min) return clean.map(() => 1);
  return clean.map((v) => (v - min) / (max - min));
}

export interface SignalMatrix {
  vector: number[];
  bm25: number[];
  recency: number[];
}

/** 三訊號加權融合。輸入應已各自歸一化。權重和正規化 → score 恆在 [0,1]，
 *  下游用 score 當門檻的地方（window.cool floor）不因權重總和漂移（devin P2）。 */
export function fuse(signals: SignalMatrix, w: FusionWeights): number[] {
  const wsum = w.vector + w.bm25 + w.recency || 1;
  return signals.vector.map(
    (v, i) =>
      (v * w.vector + signals.bm25[i]! * w.bm25 + signals.recency[i]! * w.recency) / wsum,
  );
}
