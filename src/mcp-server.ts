import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createPool } from "./db.js";
import { FakeEmbedder } from "./embedder.js";
import type { GuardedMemory } from "./guards.js";
import { DEMO_USER } from "./seed.js";
import { MemoryStore } from "./store.js";

/** 工具回傳統一走 JSON text content */
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/** recall 結果瘦身：不回 embedding（1024 維進 context 是雜訊）、Date 轉 ISO 字串 */
function publicMemory(m: GuardedMemory) {
  return {
    id: m.id,
    context: m.context,
    memoryType: m.memoryType,
    content: m.content,
    importance: m.importance,
    privacyLevel: m.privacyLevel,
    createdAt: m.createdAt.toISOString(),
    expiresAt: m.expiresAt?.toISOString() ?? null,
    sourceContext: m.sourceContext,
    score: m.score,
    signals: m.signals,
    annotations: m.annotations,
    conflictsWith: m.conflictsWith ?? [],
  };
}

const MEMORY_TYPE = z.enum(["episodic", "semantic", "procedural"]);
const PRIVACY = z.enum(["private", "cross-context", "public"]);

/** userId 綁裝置（env），不進工具參數 — 單使用者夥伴模型，LLM 不碰身分欄位。 */
export function createAstraServer(store: MemoryStore, userId: string): McpServer {
  const server = new McpServer({ name: "astra-memory", version: "0.1.0" });

  server.registerTool(
    "remember",
    {
      description:
        "寫入一筆新記憶。事件與互動用 episodic、萃取的事實/偏好用 semantic。" +
        "跨場景可見的記憶設 privacyLevel=cross-context；有時效的提醒設 expiresAt。",
      inputSchema: {
        context: z.string().describe("記憶所屬場景，如 driving / office / home / any"),
        memoryType: MEMORY_TYPE,
        content: z.string().min(1),
        importance: z.number().min(0).max(1).optional(),
        privacyLevel: PRIVACY.optional(),
        expiresAt: z.string().datetime({ offset: true }).optional().describe("ISO 8601 時效"),
        sourceContext: z.string().optional().describe("記憶產生時所在的場景（若與 context 不同）"),
      },
    },
    async (args) => {
      try {
        const m = await store.remember({
          userId,
          context: args.context,
          memoryType: args.memoryType,
          content: args.content,
          importance: args.importance,
          privacyLevel: args.privacyLevel,
          expiresAt: args.expiresAt ? new Date(args.expiresAt) : undefined,
          sourceContext: args.sourceContext,
        });
        return jsonResult({ id: m.id, createdAt: m.createdAt.toISOString() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "recall",
    {
      description:
        "多訊號融合檢索：從記憶庫撈出與 query 最相關的記憶" +
        "（SQL 場景/隱私過濾 + 向量語意 + BM25 關鍵字 + 時近性）。" +
        "回傳含 Guard Chain 安全標注（annotations：跨場景來源/過時警告/矛盾偵測）；" +
        "conflictsWith 非空時應向使用者確認而非自行假設。",
      inputSchema: {
        query: z.string().min(1),
        context: z.string().describe("當前場景，決定隱私過濾範圍"),
        topK: z.number().int().min(1).max(20).optional(),
      },
    },
    async (args) => {
      try {
        const memories = await store.recallGuarded({
          userId,
          query: args.query,
          context: args.context,
          topK: args.topK,
        });
        return jsonResult({ memories: memories.map(publicMemory) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_memory",
    {
      description: "更新既有記憶（偏好改變、事實修正）。改 content 會自動重算 embedding。",
      inputSchema: {
        id: z.string().uuid(),
        content: z.string().min(1).optional(),
        importance: z.number().min(0).max(1).optional(),
        privacyLevel: PRIVACY.optional(),
      },
    },
    async (args) => {
      try {
        const m = await store.update(args.id, {
          content: args.content,
          importance: args.importance,
          privacyLevel: args.privacyLevel,
        });
        return jsonResult({ id: m.id, content: m.content, importance: m.importance });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "forget",
    {
      description: "標記記憶過時（soft delete），之後 recall 不再回傳。",
      inputSchema: { id: z.string().uuid() },
    },
    async (args) => {
      try {
        await store.forget(args.id);
        return jsonResult({ forgotten: args.id });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

// stdio entry: npm run mcp
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const userId = process.env.ASTRA_USER_ID ?? DEMO_USER;
  const store = new MemoryStore(createPool(), new FakeEmbedder());
  const server = createAstraServer(store, userId);
  await server.connect(new StdioServerTransport());
  console.error(`astra-memory mcp server ready (user ${userId})`);
}
