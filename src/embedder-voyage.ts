import { EMBEDDING_DIM } from "./config.js";
import type { Embedder } from "./embedder.js";

/** Voyage AI embedder（voyage-4-large，1024 維）。開發與調校用；提交版評估換 Bedrock Titan。
 *  Voyage 支援 input_type: query/document 區分（品質更好），Phase 4 調校時再拆 —
 *  目前照 Embedder 契約單一 embed()，省略 input_type。 */
export class VoyageEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  private readonly apiKey: string;

  constructor(apiKey = process.env.VOYAGE_API_KEY) {
    if (!apiKey) throw new Error("VOYAGE_API_KEY not set");
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "voyage-4-large", input: [text] }),
    });
    if (!res.ok) {
      throw new Error(`voyage embed failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const v = data.data[0]!.embedding;
    // Voyage 已 normalize，照契約再保險一次（冪等）
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}
