import { createPool } from "../src/db.js";
import { selectEmbedder, selectReranker } from "../src/embedder-select.js";
import { ClaudeCliClient, GeminiClient } from "../src/llm.js";
import { MemoryStore } from "../src/store.js";
import { buildApp } from "./app.js";

/** demo server 入口。跑法：
 *  EMBEDDER=voyage GEMINI_MODEL=gemma-4-31b-it npx tsx server/index.ts
 *  STRONG_LLM=claude-cli 掛動態路由的強模型（開發用 claude CLI；提交版換 Bedrock）。 */

const pool = createPool();
const store = new MemoryStore(pool, selectEmbedder(), selectReranker());
const llm = new GeminiClient();
const strongLlm =
  process.env.STRONG_LLM === "claude-cli"
    ? new ClaudeCliClient(process.env.STRONG_MODEL ?? "sonnet")
    : undefined;

const app = buildApp({ pool, store, llm, strongLlm });
const port = Number(process.env.PORT ?? 8787);
await app.listen({ port });
console.log(`ASTRA demo server on http://localhost:${port}`);
