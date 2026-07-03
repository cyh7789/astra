import { EMBEDDING_DIM } from "./config.js";
import { tokenize } from "./text.js";

export interface Embedder {
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

/** 確定性假 embedder：token FNV-1a hash 進固定維度桶、L2 normalize。
 *  token 重疊度 ≈ cosine 相似度，讓檢索測試不依賴外部 API。
 *  Phase 4 換成 Bedrock Titan Text Embeddings V2（1024 維）。 */
export class FakeEmbedder implements Embedder {
  constructor(readonly dim: number = EMBEDDING_DIM) {}

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[Math.abs(h) % this.dim]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}
