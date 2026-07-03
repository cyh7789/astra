import type { Embedder } from "./embedder.js";
import { FakeEmbedder } from "./embedder.js";
import { VertexEmbedder } from "./embedder-vertex.js";
import { VoyageEmbedder } from "./embedder-voyage.js";
import type { Reranker } from "./reranker.js";
import { VoyageReranker } from "./reranker.js";

/** EMBEDDER env 選 embedder：fake（預設，測試/離線）/ voyage / vertex。
 *  注意：切換 embedder 後既有記憶的向量空間不相容，要重 seed。 */
export function selectEmbedder(): Embedder {
  const kind = process.env.EMBEDDER ?? "fake";
  if (kind === "voyage") {
    return new VoyageEmbedder(process.env.VOYAGE_MODEL ?? "voyage-4-large");
  }
  if (kind === "vertex") return new VertexEmbedder();
  return new FakeEmbedder();
}

/** RERANKER env 選精排器：none（預設）/ voyage（rerank-2.5）。顯式 opt-in — 每次 recall 多一個 API call。 */
export function selectReranker(): Reranker | undefined {
  if ((process.env.RERANKER ?? "none") === "voyage") {
    return new VoyageReranker(process.env.RERANK_MODEL ?? "rerank-2.5");
  }
  return undefined;
}
