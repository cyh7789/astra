# ASTRA — Adaptive Spatial-Temporal Recall Agent

跨場景記憶型 AI 夥伴：車上 → 辦公室 → 家，同一份記憶、不同介面。
CockroachDB × AWS Hackathon 參賽作品。

核心問題：「記住」很簡單，**在對的時間想起對的事**才難。ASTRA 從幾萬筆記憶裡精準撈出當下需要的 3-5 筆。

## 檢索管線

```
使用者輸入
  → [1] 場景偵測（driving / office / home）        （Phase 3）
  → [2] SQL 範圍過濾（user + context + 隱私 + 時效）  ┐ 一條 hybrid query
  → [3] 向量搜尋（cosine，CockroachDB 向量索引）      ┘ 進 CockroachDB
  → [4] BM25 關鍵字補強（人名/地名精確匹配，應用層）
  → [5] 三訊號融合排序（vector 0.4 / bm25 0.3 / recency 0.3）
  → [6] LLM Reranker 精排                          （Phase 4）
  → [7] 注入 context window                        （Phase 4）
  → [8] Agent 回應 + Guard Chain                    （Phase 3/4）
```

Phase 1（本狀態）= 步驟 2-5 完整落地，含三場景端到端測試。

## 記憶模型

| memory_type | 存什麼 | 例子 |
|-------------|--------|------|
| episodic | 事件與互動 | 「昨晚說今天要先去加油」 |
| semantic | 萃取的事實/偏好 | 「王經理偏好季付」 |
| procedural | Guard 規則/SOP | （Phase 3） |

隱私模型：`privacy_level = private / cross-context / public`。private 記憶只在自己的場景出現（辦公室報價不會在家裡被撈出）；cross-context 記憶跨場景流動（車上說的話回家還記得）。時效性記憶用 `expires_at`（提醒過期自動消失）。`forget` 是 soft delete（`deleted_at`）。

## CockroachDB 整合

- **Hybrid query**：SQL 過濾（user/場景/隱私/時效）+ 向量距離排序在同一條 query、同一顆 DB — 不用 Postgres + Pinecone 兩套系統做 2PC
- **向量索引**：`CREATE VECTOR INDEX idx_mem_vec ON memories (user_id, embedding)`（v26.2 實測：前綴欄位過濾式向量搜尋直接支援、`<=>` cosine、免 cluster setting）
- **ACID**：記憶寫入與業務邏輯同交易；跨區一致性（出差寫的記憶回家讀得到）是 CockroachDB 天生的
- 注意：CockroachDB 的 INT 是 INT8，node-postgres 預設回字串 — `src/db.ts` 設了 type parser

## Dev

```bash
brew install cockroachdb/tap/cockroach
./scripts/dev-db.sh          # 啟動本地單節點 CockroachDB（insecure，僅 localhost）
npm install
npm run migrate              # 建 schema（建 astra DB + 跑 migrations/）
npm run seed                 # 灌三場景 demo 記憶
npm test                     # 28 tests（純函數單元 + DB 整合 + 三場景端到端）
```

## CockroachDB Cloud

同一套程式碼直接切 Cloud（Basic cluster on AWS）：

```bash
export ASTRA_DB_URL='postgresql://<user>:<pass>@<host>:26257/astra?sslmode=verify-full'
npm run migrate && npm run seed
npm run cli -- recall --context driving "今天行程怎麼安排？"
# 測試套件也能整套對 Cloud 跑（測試庫建在 defaultdb 同 cluster）：
export ASTRA_TEST_BASE_URL='postgresql://<user>:<pass>@<host>:26257/defaultdb?sslmode=verify-full'
npm test
```

已驗證（2026-07-03，cluster v25.4 / AWS us-east-1）：33/33 tests 通過。Cloud schema 由 CockroachDB Cloud 官方 MCP Server 佈建（`create_database` / `create_table` 含 inline `VECTOR INDEX`），與本地 migration 001 一致。

## Demo CLI

```bash
npm run cli -- recall --context driving "今天行程怎麼安排？"
npm run cli -- recall --context office "上次跟王經理談的報價是多少？"
npm run cli -- recall --context home "冰箱裡還有什麼？晚餐吃什麼好？"
```

輸出帶三訊號分解（vec / bm25 / rec），檢索透明可解釋：

```
0.700  [episodic/office]  與王經理會議：報價 $45,000，季付方案
       vec=1.00 bm25=1.00 rec=0.00
```

已知展示面小瑕疵：候選集小的時候 min-max 歸一化會把最弱候選壓到 0.00（仍會回傳、排序正確）。Phase 4 進 reranker 時一併處理。

## Guard Chain（安全標注層）

Recall 結果經過確定性 guard chain 後才交給 agent — **標注不攔截**（隱私攔截在 SQL 層），讓安全訊號對 agent 與使用者可見：

| 情境 | Guard | 實際輸出 |
|------|-------|---------|
| 跨場景透明 | PrivacyGuard | `⚠ 來自 office 場景的記憶` / `⚠ 當時在 driving 場景提到` |
| 過時警告 | RecencyGuard | `⚠ 21 天前的資訊，可能已過時`（episodic 限定，semantic 長期事實不標） |
| 矛盾偵測 | ConflictGuard | `⚠ 與記憶「昨天晚餐點了麻辣鍋外送…」矛盾，建議確認而非假設` + `conflictsWith` ids |

設計原則：**建邊是寫入時智能**（Phase 4 萃取器偵測矛盾寫 `memory_links`），**查邊是讀取時規則**（guard 零 LLM、完全確定性、可重複測試）。Agent 看到 `conflictsWith` 非空就「問而不是猜」。

Hallucination / Capability guard 屬 agent 回應層，隨 Phase 4 agent 一起實作。

## MCP Server

ASTRA 記憶層透過 MCP 協定暴露，任何 MCP 相容 client 都能接：

```bash
npm run mcp                              # stdio server
# 或註冊給 Claude Code：
claude mcp add astra-memory -- npx tsx /path/to/astra/src/mcp-server.ts
```

| 工具 | 功能 |
|------|------|
| `remember` | 寫入記憶（episodic/semantic/procedural、隱私分級、時效） |
| `recall` | 多訊號融合檢索（回傳含訊號分解，不含 embedding） |
| `update_memory` | 更新記憶，改 content 自動重算 embedding |
| `forget` | soft delete，之後 recall 不再回傳 |

使用者身分綁 `ASTRA_USER_ID` 環境變數（單使用者夥伴模型），不暴露在工具參數。錯誤走 MCP `isError` content，不炸 session。

Phase 1 用確定性 FakeEmbedder（token 重疊 ≈ 相似度）讓測試不依賴外部 API；真語意（「氣炸鍋」↔「晚餐」）等 Phase 4 換 Bedrock Titan Embeddings V2。

## Roadmap

| Phase | 內容 |
|-------|------|
| 1 ✅ | 記憶核心：schema + 多訊號融合檢索 + 三場景測試 |
| 2 ✅ | MCP server（remember / recall / update_memory / forget 工具） |
| 3 ✅ | Guard Chain（Privacy/Recency/Conflict 確定性版 + 情境資料） |
| 4 | Bedrock agent + LLM reranker + demo UI + 真 embeddings + 記憶萃取器 + Hallucination/Capability guard |
| 5 | AWS 部署（Lambda pre-warming、ECS）+ CockroachDB Cloud |

設計稿與實作計畫在 `docs/plans/`。
