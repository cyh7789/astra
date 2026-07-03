import { parseArgs } from "node:util";
import { AstraAgent } from "./agent.js";
import { createPool } from "./db.js";
import { selectEmbedder } from "./embedder-select.js";
import { ClaudeCliClient } from "./llm.js";
import { DEMO_USER } from "./seed.js";
import { MemoryStore } from "./store.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    context: { type: "string", default: "home" },
    user: { type: "string", default: DEMO_USER },
    model: { type: "string", default: "sonnet" },
  },
});

const [message] = positionals;
if (!message) {
  console.error('usage: EMBEDDER=voyage npm run chat -- --context driving "今天行程怎麼安排？"');
  process.exit(1);
}

const pool = createPool();
const store = new MemoryStore(pool, selectEmbedder());
const agent = new AstraAgent(store, new ClaudeCliClient(values.model!), values.user!);

const result = await agent.chat(message, values.context!);

console.log("── 撈到的記憶 ──");
for (const m of result.recalled) {
  console.log(`  ${m.score.toFixed(2)} [${m.memoryType}/${m.context}] ${m.content}`);
  for (const a of m.annotations) console.log(`       ⚠ ${a}`);
}
console.log("\n── ASTRA ──");
console.log(result.reply);
if (result.extracted.length > 0) {
  console.log("\n── 寫入的新記憶 ──");
  for (const m of result.extracted) {
    console.log(`  + [${m.memoryType}/${m.context}] ${m.content}`);
  }
}
await pool.end();
