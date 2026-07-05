import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import type { LlmClient } from "../src/llm.js";
import { DEMO_USER, seed } from "../src/seed.js";
import { ChatSession } from "../src/session.js";
import type { MemoryStore } from "../src/store.js";
import type { Transcriber } from "../src/stt.js";
import { initialDeviceState, reduceDeviceState } from "./device-state.js";

/** Fastify 薄殼（demo UI 設計文件）：所有智慧在 ChatSession 後面，這裡只做
 *  session 生命週期（resume 優先 → open fallback）、裝置板折疊、序列化。 */

const SCENES = ["driving", "office", "home"];

export interface AppDeps {
  pool: pg.Pool;
  store: MemoryStore;
  llm: LlmClient;
  /** 動態路由 v1：本地模型收斂失敗時接手的強模型 */
  strongLlm?: LlmClient;
  /** server 端 STT（瀏覽器無關）；沒掛就回 503，前端降級成純打字 */
  transcribe?: Transcriber;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();
  let session: ChatSession | null = null;
  let deviceState = initialDeviceState();
  /** 同一個 ChatSession 不能並發 send（transcript 順序會亂）— 回合一律排隊 */
  let turnQueue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = turnQueue.then(work);
    turnQueue = result.catch(() => {}); // 失敗的回合不卡死佇列
    return result;
  }

  /** resume 優先：session 態在 CockroachDB，server 重啟、換終端都接得回來。 */
  async function ensureSession(context = "home"): Promise<ChatSession> {
    if (session) return session;
    const opts = { strongLlm: deps.strongLlm };
    session =
      (await ChatSession.resume(deps.store, deps.llm, DEMO_USER, new Date(), opts)) ??
      (await ChatSession.open(deps.store, deps.llm, DEMO_USER, context, new Date(), opts));
    return session;
  }

  /** Inspector 用的窗快照（score 由高到低） */
  function windowSnapshot(s: ChatSession) {
    return s.window.entries().map((e) => ({
      id: e.memory.id,
      content: e.memory.content,
      memoryType: e.memory.memoryType,
      context: e.memory.context,
      via: e.via,
      score: e.score,
      pinned: e.pinned,
    }));
  }

  // MediaRecorder 送來的原始音訊（audio/webm、audio/mp4 等）— 整包收進 Buffer
  app.addContentTypeParser(/^audio\//, { parseAs: "buffer" }, (_req, body, done) =>
    done(null, body),
  );

  /** server 端 STT：收一段音訊、回轉錄文字。與對話回合無關，不進 turnQueue。 */
  app.post("/api/stt", async (req, reply) => {
    if (!deps.transcribe) return reply.code(503).send({ error: "stt not configured" });
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return reply.code(400).send({ error: "body must be raw audio bytes" });
    }
    const text = await deps.transcribe(audio, req.headers["content-type"] ?? "audio/webm");
    return { text };
  });

  app.post("/api/chat", async (req, reply) => {
    const { message, location, disabled } = (req.body ?? {}) as {
      message?: unknown;
      location?: unknown;
      disabled?: unknown;
    };
    if (typeof message !== "string" || message.trim().length === 0) {
      return reply.code(400).send({ error: "message must be a non-empty string" });
    }
    // 瀏覽器 GPS（拿得到權限才有）— 查詢類工具打真 API 用；沒有就全走 mock。
    // disabled = 資料源面板手動關掉的來源（雙軌：不給權限/手動關都照跑，只是誠實退 mock）
    const loc = location as { lat?: unknown; lng?: unknown } | undefined;
    const env = {
      ...(typeof loc?.lat === "number" && typeof loc?.lng === "number"
        ? { location: { lat: loc.lat, lng: loc.lng } }
        : {}),
      ...(Array.isArray(disabled) ? { disabled: disabled.filter((d) => typeof d === "string") } : {}),
    };
    return enqueue(async () => {
      const s = await ensureSession();
      const turn = await s.send(message, new Date(), env);
      deviceState = reduceDeviceState(deviceState, turn.toolCalls);
      return {
        reply: turn.reply,
        toolCalls: turn.toolCalls,
        admitted: turn.admitted,
        escalated: turn.escalated,
        turns: turn.turns,
        context: s.context,
        window: windowSnapshot(s),
        deviceState,
      };
    });
  });

  app.post("/api/scene", async (req, reply) => {
    const { context } = (req.body ?? {}) as { context?: unknown };
    if (typeof context !== "string" || !SCENES.includes(context)) {
      return reply.code(400).send({ error: `context must be one of ${SCENES.join("/")}` });
    }
    return enqueue(async () => {
      const s = await ensureSession(context);
      let surfaced: Array<{ id: string; content: string }> = [];
      let evicted: Array<{ id: string; content: string }> = [];
      if (s.context !== context) {
        const r = await s.switchContext(context);
        surfaced = r.surfaced.map((m) => ({ id: m.id, content: m.content }));
        evicted = r.evicted.map((e) => ({ id: e.memory.id, content: e.memory.content }));
      }
      return { context: s.context, surfaced, evicted, window: windowSnapshot(s), deviceState };
    });
  });

  /** 全快照：分頁載入與跨終端 resume 用。對話態直接讀 DB（每輪都有 persist）—
   *  這個端點本身就是「記憶住 CockroachDB」的活證據。 */
  app.get("/api/state", async () => {
    const s = await ensureSession();
    const persisted = await deps.store.loadSessionState(DEMO_USER);
    return {
      context: s.context,
      turn: persisted?.turn ?? 0,
      transcript: persisted?.transcript ?? [],
      digest: persisted?.digest ?? "",
      openThreads: persisted?.openThreads ?? [],
      window: windowSnapshot(s),
      deviceState,
    };
  });

  /** 重置 demo（評審玩壞了自己救）：清掉 demo user 的所有資料重新 seed。 */
  app.post("/api/reset", async () => {
    return enqueue(async () => {
      await deps.pool.query("DELETE FROM session_state WHERE user_id = $1", [DEMO_USER]);
      await deps.pool.query(
        `DELETE FROM memory_links
          WHERE source_id IN (SELECT id FROM memories WHERE user_id = $1)
             OR target_id IN (SELECT id FROM memories WHERE user_id = $1)`,
        [DEMO_USER],
      );
      await deps.pool.query("DELETE FROM memories WHERE user_id = $1", [DEMO_USER]);
      await seed(deps.store);
      session = null;
      deviceState = initialDeviceState();
      return { ok: true };
    });
  });

  return app;
}
