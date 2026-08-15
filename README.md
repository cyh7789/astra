# ASTRA

One AI companion with one memory, across the car, the office, and home. Say something on the drive home and the assistant at home already knows it, and tells you where it heard it.

**Live demo: https://astra.hcytlog.com** (no signup, each visitor gets an isolated memory space)
**Demo video: https://youtu.be/di8OHxfPgso**

Built for the CockroachDB × AWS "Build with Agentic Memory" hackathon.

Remembering is easy. Recalling the right thing at the right moment, in a scene the memory was not created in, is the hard part. ASTRA treats a person, not an app, as the unit of memory.

## What makes it different

We compared six agent-memory systems (Letta, Mem0, Zep, LangMem, A-MEM, CarMem). All six attach memory to a single agent or a single application. In that survey, none treats cross-context recall with source attribution as a first-class primitive. That gap is the product.

Measured on the live deployment: each benchmark run stores 5 memories across the driving and office scenes, switches to a third scene, and asks 5 recall questions. Across 3 runs, 14/15 answers recalled the right memory with detail, and 13/15 named the scene it came from. No miss was a fabrication: the one recall miss surfaced a different real memory about the car, and the attribution misses recalled the right fact but skipped the scene label.

```bash
bash tests/recall-benchmark.sh https://astra.hcytlog.com
```

## Memory model

| memory_type | What it holds | Example |
|---|---|---|
| `episodic` | Events and interactions | "Said last night that we need to refuel first today" |
| `semantic` | Extracted facts and preferences | "Manager Wang prefers quarterly billing" |
| `procedural` | Rules and routines | "Meeting notes in bullet points, never paragraphs" |

Every memory carries `privacy_level`: `private` surfaces only in the scene that created it (an office quote never shows up at home), `cross-context` follows you between scenes (a fact stated in the car is known at home), `public` is unrestricted. Time-bounded memories use `expires_at` and disappear on their own. `forget` is a soft delete via `deleted_at`.

When a memory crosses scenes, the prompt labels it with the scene it came from (`[said in the car]`) so the model states the provenance in its own words rather than guessing or staying silent.

## Retrieval pipeline

```
user input
  → scene detection (driving / office / home)
  → SQL scope filter (user + context + privacy + expiry)   ┐ one hybrid query,
  → vector search (cosine, CockroachDB vector index)        ┘ one database
  → BM25 keyword pass (exact names, model numbers)
  → three-signal fusion (vector 0.4 / bm25 0.3 / recency 0.3)
  → optional LLM reranker
  → guard chain annotation
  → agent response
```

## CockroachDB integration

- **Hybrid query.** Scope filtering (user, scene, privacy, expiry) and vector distance ordering happen in the same query against the same database. No Postgres-plus-vector-store split, so no two-phase commit between a row store and an index service.
- **Vector index.** `CREATE VECTOR INDEX idx_mem_vec ON memories (user_id, embedding)`. Prefix-column filtered vector search is supported directly, `<=>` for cosine, no cluster setting required.
- **Typed memory links.** `memory_links` holds contradiction and association edges, so conflict detection is a read-time rule over a write-time graph rather than a second LLM call.
- **Cross-device session state.** `session_state` lives on the same cluster, so identity belongs to the database rather than the device. A thread started in the car resumes at home.
- **ACID.** Memory writes and business logic share a transaction. Multi-region consistency is the database's job, not ours.
- Note: CockroachDB `INT` is `INT8` and node-postgres returns it as a string by default. `src/db.ts` installs a type parser.

## AWS integration

- **Bedrock** runs the reasoning layer (Gemma 4 31B via Mantle, `us-east-1`, same region as the cluster).
- **EC2** serves the Fastify gateway behind Caddy and Cloudflare for HTTPS, which the browser requires before it will grant microphone access.

## Guard chain

Recall results pass through a deterministic guard chain before reaching the agent. It annotates rather than intercepts, because privacy interception already happened in SQL. Safety signals stay visible to both the agent and the user.

| Situation | Guard | Output |
|---|---|---|
| Cross-scene transparency | PrivacyGuard | "from the office scene" / "mentioned while in the car" |
| Staleness | RecencyGuard | "21 days old, may be out of date" (episodic only; semantic facts are long-lived) |
| Contradiction | ConflictGuard | "contradicts an earlier memory, confirm rather than assume" plus `conflictsWith` ids |

Building edges is write-time intelligence. Reading edges is a read-time rule: zero LLM calls, fully deterministic, repeatable in tests. When `conflictsWith` is non-empty the agent asks instead of guessing.

## Integration boundary

The demo labels every data source as live, simulated, or mocked, in a Data Sources panel judges can open. Mocks are not filler: the interfaces are shaped after the real SDKs, so swapping an adapter is the only remaining work.

| Source | Now | Real interface |
|---|---|---|
| Clock | **live**, real time (`ASTRA_TZ`, default Asia/Taipei) | — |
| Weather | **live** with GPS, Open-Meteo | same |
| Places | **live** with GPS, OSM Overpass | Google Places API |
| Navigation | **live** with GPS, Nominatim + OSRM, opens in Google Maps | Android Auto / CarPlay SDK |
| Web search | **live**, Gemini Google Search grounding | same |
| Calendar | **sim**, events generated relative to the real clock | Google Calendar / CalDAV |
| Home devices | **mock**, args match HomeKit accessory/characteristic vocabulary | homebridge / HAP-NodeJS / Matter |
| Vehicle control | **mock**, shaped after vehicle domain interfaces | OEM SDK (no real car, so this cannot be live) |

Dual-track by design: if GPS is denied, a public API fails, or the network drops, the demo keeps running by falling back to mock and saying so in the panel.

## Run it locally

```bash
brew install cockroachdb/tap/cockroach
./scripts/dev-db.sh          # local single-node CockroachDB (insecure, localhost only)
npm install
npm run migrate              # create schema
npm run seed                 # load demo memories for three scenes
npm test                     # ~110 tests: pure units, DB integration, end-to-end scenes
```

The default embedder is a deterministic fake (token overlap approximates similarity) so the test suite needs no external API. Set `EMBEDDER=voyage` with `VOYAGE_API_KEY` for real semantics. Switching embedders invalidates existing vectors, so re-seed after changing it.

## Run against CockroachDB Cloud

```bash
export ASTRA_DB_URL='postgresql://<user>:<pass>@<host>:26257/astra?sslmode=verify-full'
npm run migrate && npm run seed
npm run cli -- recall --context driving "what is on my schedule today?"

# the whole suite can run against Cloud as well
export ASTRA_TEST_BASE_URL='postgresql://<user>:<pass>@<host>:26257/defaultdb?sslmode=verify-full'
npm test
```

## Run the demo server

```bash
export ASTRA_DB_URL='...'      # CockroachDB Cloud
export VOYAGE_API_KEY='...'    # embeddings
export GEMINI_API_KEY='...'    # speech to text
npm run demo                   # http://localhost:8080
```

## CLI

```bash
npm run cli -- recall --context driving "what is on my schedule today?"
npm run cli -- recall --context office "what quote did we discuss with Manager Wang?"
npm run cli -- recall --context home "what is in the fridge?"
```

Output carries the three-signal breakdown, so retrieval stays explainable:

```
0.700  [episodic/office]  Meeting with Manager Wang: quote $45,000, quarterly billing
       vec=1.00 bm25=1.00 rec=0.00
```

## MCP server

The memory layer is exposed over MCP, so any compatible client can use it:

```bash
npm run mcp
# or register with Claude Code:
claude mcp add astra-memory -- npx tsx /path/to/astra/src/mcp-server.ts
```

| Tool | Purpose |
|---|---|
| `remember` | Write a memory (type, privacy level, expiry) |
| `recall` | Multi-signal retrieval, returns the score breakdown |
| `update_memory` | Update a memory; changing content recomputes the embedding |
| `forget` | Soft delete; later recalls skip it |

Identity binds to the `ASTRA_USER_ID` environment variable rather than a tool argument. Errors return MCP `isError` content instead of tearing down the session.

## Scope and known gaps

Named honestly, because they are the next things we would build:

- **Idempotent memory writes.** A retried event can currently double-write a memory. A transaction ledger keyed on `(session, turn, call)` is the fix.
- **Persisted approval state.** Pending confirmations for sensitive actions live in process memory, so a restart loses them.
- **Least-privilege database role.** The demo connects with a broader-privileged account than production should use.
- **A larger benchmark.** 15 queries over 3 runs is a starting point, not a claim about the general case. Adversarial cases we do not yet test: conflicting memories, expired items, and privacy-scoped items that must *not* surface.

## License

MIT. See [LICENSE](LICENSE).
