import type { Embedder } from "./embedder.js";
import { FakeEmbedder } from "./embedder.js";
import { VertexEmbedder } from "./embedder-vertex.js";
import { VoyageEmbedder } from "./embedder-voyage.js";

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
