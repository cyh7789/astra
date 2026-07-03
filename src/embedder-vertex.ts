import { execFileSync } from "node:child_process";
import { EMBEDDING_DIM } from "./config.js";
import type { Embedder } from "./embedder.js";

/** 開發用真語意 embedder（Vertex AI gemini-embedding-001，ADC 認證）。
 *  用於檢索品質驗證與權重調校；提交版換 Bedrock Titan（Phase 4）。
 *  該模型每請求限一筆輸入；輸出照 Embedder 契約 L2 normalize。 */
export class VertexEmbedder implements Embedder {
  readonly dim = EMBEDDING_DIM;
  private readonly token: string;

  constructor(
    private readonly project = process.env.VERTEX_PROJECT ?? "yuhina-496113",
    private readonly location = "us-central1",
  ) {
    this.token = execFileSync(
      "gcloud",
      ["auth", "application-default", "print-access-token"],
      { encoding: "utf8" },
    ).trim();
  }

  async embed(text: string): Promise<number[]> {
    const url =
      `https://aiplatform.googleapis.com/v1/projects/${this.project}` +
      `/locations/${this.location}/publishers/google/models/gemini-embedding-001:predict`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: [{ content: text }],
        parameters: { outputDimensionality: this.dim },
      }),
    });
    if (!res.ok) {
      throw new Error(`vertex embed failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      predictions: Array<{ embeddings: { values: number[] } }>;
    };
    const v = data.predictions[0]!.embeddings.values;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}
