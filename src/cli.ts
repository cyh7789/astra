import { parseArgs } from "node:util";
import { createPool } from "./db.js";
import { selectEmbedder } from "./embedder-select.js";
import { DEMO_USER } from "./seed.js";
import { MemoryStore } from "./store.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    context: { type: "string", default: "any" },
    user: { type: "string", default: DEMO_USER },
    topK: { type: "string", default: "5" },
  },
});

const [command, query] = positionals;
if (command !== "recall" || !query) {
  console.error('usage: npm run cli -- recall --context driving "今天行程怎麼安排？"');
  process.exit(1);
}

const pool = createPool();
const store = new MemoryStore(pool, selectEmbedder());
const results = await store.recallGuarded({
  userId: values.user!,
  query,
  context: values.context!,
  topK: Number(values.topK),
});

for (const m of results) {
  const sig = m.signals;
  console.log(
    `${m.score.toFixed(3)}  [${m.memoryType}/${m.context}]  ${m.content}` +
      `\n       vec=${sig.vector.toFixed(2)} bm25=${sig.bm25.toFixed(2)} rec=${sig.recency.toFixed(2)}` +
      (m.sourceContext ? `  (source: ${m.sourceContext})` : ""),
  );
  for (const a of m.annotations) console.log(`       ⚠ ${a}`);
}
await pool.end();
