export interface RerankHit {
  index: number; // 對應輸入 docs 的下標
  score: number; // 相關性分數（reranker 校準比 cosine 好，可靠度高）
}

export interface Reranker {
  rerank(query: string, docs: string[], topK: number): Promise<RerankHit[]>;
}

/** Voyage rerank-2.5：融合粗排後的精排層（cross-encoder 級品質，一次 API call）。 */
export class VoyageReranker implements Reranker {
  private readonly apiKey: string;

  constructor(
    private readonly model = "rerank-2.5",
    apiKey = process.env.VOYAGE_API_KEY,
  ) {
    if (!apiKey) throw new Error("VOYAGE_API_KEY not set");
    this.apiKey = apiKey;
  }

  async rerank(query: string, docs: string[], topK: number): Promise<RerankHit[]> {
    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, query, documents: docs, top_k: topK }),
    });
    if (!res.ok) {
      throw new Error(`voyage rerank failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: Array<{ index: number; relevance_score: number }>;
    };
    return data.data.map((d) => ({ index: d.index, score: d.relevance_score }));
  }
}
