import { EMBEDDING_DIM } from "./config.js";
import type { Embedder } from "./embedder.js";

/** Voyage AI embedder（預設 voyage-4-large，1024 維）。開發與調校用；提交版評估換 Bedrock Titan。
 *  model 傳 voyage-multimodal-3.5 時走 multimodal 端點（文字+圖，文字檢索 A/B 用）。
 *  Voyage 支援 input_type: query/document 區分（品質更好），Phase 4 調校時再拆 —
 *  目前照 Embedder 契約單一 embed()，省略 input_type。 */
export class VoyageEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  private readonly apiKey: string;

  constructor(
    private readonly model = "voyage-4-large",
    apiKey = process.env.VOYAGE_API_KEY,
  ) {
    if (!apiKey) throw new Error("VOYAGE_API_KEY not set");
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const multimodal = this.model.includes("multimodal");
    const url = multimodal
      ? "https://api.voyageai.com/v1/multimodalembeddings"
      : "https://api.voyageai.com/v1/embeddings";
    const body = multimodal
      ? { model: this.model, inputs: [{ content: [{ type: "text", text }] }] }
      : { model: this.model, input: [text] };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`voyage embed failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const v = data.data[0]!.embedding;
    if (v.length !== this.dim) {
      throw new Error(`${this.model} returned ${v.length} dims, schema expects ${this.dim}`);
    }
    // Voyage 已 normalize，照契約再保險一次（冪等）
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}
