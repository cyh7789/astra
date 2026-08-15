import { randomUUID } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type pg from "pg";
import { openLiveStt } from "../src/live-stt.js";
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

interface UserSlot {
  userId: string;
  session: ChatSession | null;
  deviceState: ReturnType<typeof initialDeviceState>;
  turnQueue: Promise<unknown>;
}

const COOKIE_NAME = "astra_uid";
const MAX_SLOTS = 20;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();
  void app.register(fastifyCookie);

  const slots = new Map<string, UserSlot>();

  function getSlot(req: FastifyRequest, reply: { setCookie?: Function }): UserSlot {
    let uid = (req.cookies as Record<string, string>)?.[COOKIE_NAME];
    if (!uid || !slots.has(uid)) {
      uid = randomUUID();
      if (slots.size >= MAX_SLOTS) {
        const oldest = slots.keys().next().value!;
        slots.delete(oldest);
      }
      slots.set(uid, {
        userId: uid,
        session: null,
        deviceState: initialDeviceState(),
        turnQueue: Promise.resolve(),
      });
    }
    if (reply.setCookie) {
      (reply as any).setCookie(COOKIE_NAME, uid, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 86400 });
    }
    return slots.get(uid)!;
  }

  function enqueue<T>(slot: UserSlot, work: () => Promise<T>): Promise<T> {
    const result = slot.turnQueue.then(work);
    slot.turnQueue = result.catch(() => {});
    return result;
  }

  async function ensureSession(slot: UserSlot, context = "home"): Promise<ChatSession> {
    if (slot.session) return slot.session;
    const opts = { strongLlm: deps.strongLlm };
    slot.session =
      (await ChatSession.resume(deps.store, deps.llm, slot.userId, new Date(), opts)) ??
      (await ChatSession.open(deps.store, deps.llm, slot.userId, context, new Date(), opts));
    return slot.session;
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

  // Live API 即時 STT relay：前端送 16kHz PCM（binary）→ Google Live → 逐字轉錄推回。
  // 金鑰留在 server；額度與 generateContent 分開（7/5 spike 實證）。段落式 /api/stt 是 fallback。
  // maxPayload：16kHz Int16 一秒 32KB，256KB 綽綽有餘 — 超大 frame 直接斷，別替人搬磚打爆額度
  void app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });
  let sttConnections = 0;
  void app.register(async (scope) => {
    scope.get("/ws/stt", { websocket: true }, (socket) => {
      // demo 是單使用者 — 同時 >2 條（主分頁 + 換頁殘留）就是濫用，拒收保護 Gemini 額度
      if (sttConnections >= 2) {
        socket.close(1013, "too many stt sessions");
        return;
      }
      sttConnections++;
      if (process.env.STT_DEBUG) console.log("[ws/stt] client connected", sttConnections);
      let live: ReturnType<typeof openLiveStt>;
      try {
        live = openLiveStt({
          onInterim: (text) => socket.send(JSON.stringify({ interim: text })),
          onFinal: (text) => socket.send(JSON.stringify({ final: text })),
          onClose: (reason) => socket.close(1011, reason),
        });
      } catch {
        sttConnections--;
        socket.close(1011, "stt not configured");
        return;
      }
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) live.sendPcm(data);
        else if (data.toString() === '{"end":true}') live.endAudio();
      });
      socket.on("close", () => {
        sttConnections--;
        live.close();
      });
    });
  });

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
    const slot = getSlot(req, reply);
    const { message, location, disabled } = (req.body ?? {}) as {
      message?: unknown;
      location?: unknown;
      disabled?: unknown;
    };
    if (typeof message !== "string" || message.trim().length === 0) {
      return reply.code(400).send({ error: "message must be a non-empty string" });
    }
    const loc = location as { lat?: unknown; lng?: unknown } | undefined;
    const env = {
      ...(typeof loc?.lat === "number" && typeof loc?.lng === "number"
        ? { location: { lat: loc.lat, lng: loc.lng } }
        : {}),
      ...(Array.isArray(disabled) ? { disabled: disabled.filter((d) => typeof d === "string") } : {}),
    };
    const streaming = (req.query as { stream?: string }).stream === "1";
    if (streaming) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.flushHeaders();
      let clientGone = false;
      reply.raw.on("close", () => {
        clientGone = true;
      });
      const push = (event: string, data: unknown) => {
        if (clientGone || reply.raw.writableEnded) return;
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          clientGone = true;
        }
      };
      try {
        const result = await enqueue(slot, async () => {
          const s = await ensureSession(slot);
          const turn = await s.send(message, new Date(), env, (tool, args, r) =>
            push("tool", { tool, args, result: r }),
          );
          slot.deviceState = reduceDeviceState(slot.deviceState, turn.toolCalls);
          return {
            reply: turn.reply,
            toolCalls: turn.toolCalls,
            admitted: turn.admitted,
            escalated: turn.escalated,
            turns: turn.turns,
            context: s.context,
            window: windowSnapshot(s),
            deviceState: slot.deviceState,
          };
        });
        push("done", result);
      } catch (err) {
        push("error", { message: (err as Error).message });
      }
      reply.raw.end();
      return reply;
    }
    return enqueue(slot, async () => {
      const s = await ensureSession(slot);
      const turn = await s.send(message, new Date(), env);
      slot.deviceState = reduceDeviceState(slot.deviceState, turn.toolCalls);
      return {
        reply: turn.reply,
        toolCalls: turn.toolCalls,
        admitted: turn.admitted,
        escalated: turn.escalated,
        turns: turn.turns,
        context: s.context,
        window: windowSnapshot(s),
        deviceState: slot.deviceState,
      };
    });
  });

  app.post("/api/scene", async (req, reply) => {
    const slot = getSlot(req, reply);
    const { context } = (req.body ?? {}) as { context?: unknown };
    if (typeof context !== "string" || !SCENES.includes(context)) {
      return reply.code(400).send({ error: `context must be one of ${SCENES.join("/")}` });
    }
    return enqueue(slot, async () => {
      const s = await ensureSession(slot, context);
      let surfaced: Array<{ id: string; content: string }> = [];
      let evicted: Array<{ id: string; content: string }> = [];
      if (s.context !== context) {
        const r = await s.switchContext(context);
        surfaced = r.surfaced.map((m) => ({ id: m.id, content: m.content }));
        evicted = r.evicted.map((e) => ({ id: e.memory.id, content: e.memory.content }));
      }
      return { context: s.context, surfaced, evicted, window: windowSnapshot(s), deviceState: slot.deviceState };
    });
  });

  app.get("/api/state", async (req, reply) => {
    const slot = getSlot(req, reply);
    const s = await ensureSession(slot);
    const persisted = await deps.store.loadSessionState(slot.userId);
    return {
      context: s.context,
      turn: persisted?.turn ?? 0,
      transcript: persisted?.transcript ?? [],
      digest: persisted?.digest ?? "",
      openThreads: persisted?.openThreads ?? [],
      window: windowSnapshot(s),
      deviceState: slot.deviceState,
    };
  });

  app.post("/api/reset", async (req, reply) => {
    const slot = getSlot(req, reply);
    return enqueue(slot, async () => {
      await deps.pool.query("DELETE FROM session_state WHERE user_id = $1", [slot.userId]);
      await deps.pool.query(
        `DELETE FROM memory_links
          WHERE source_id IN (SELECT id FROM memories WHERE user_id = $1)
             OR target_id IN (SELECT id FROM memories WHERE user_id = $1)`,
        [slot.userId],
      );
      await deps.pool.query("DELETE FROM memories WHERE user_id = $1", [slot.userId]);
      slot.session = null;
      slot.deviceState = initialDeviceState();
      return { ok: true };
    });
  });

  app.post<{ Body: { text?: string; voice?: string } }>("/api/tts", async (req, reply) => {
    const { text, voice } = req.body ?? {};
    if (typeof text !== "string" || text.trim().length === 0) {
      return reply.code(400).send({ error: "text must be a non-empty string" });
    }
    const v = voice || "en-US-AvaMultilingualNeural";
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { readFile, unlink } = await import("node:fs/promises");
    const exec = promisify(execFile);
    const tmp = `/tmp/astra-tts-${randomUUID()}.mp3`;
    const bin = process.env.EDGE_TTS_BIN || `${process.env.HOME}/.local/bin/edge-tts`;
    try {
      await exec(bin, ["--voice", v, "--text", text.trim(), "--write-media", tmp], { timeout: 15_000 });
      const buf = await readFile(tmp);
      reply.type("audio/mpeg").send(buf);
    } catch (e: any) {
      reply.code(500).send({ error: e.message ?? "tts failed" });
    } finally {
      unlink(tmp).catch(() => {});
    }
  });

  return app;
}
