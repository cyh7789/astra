import { buildExtractionPrompt, parseExtraction } from "./agent.js";
import { MIN_VECTOR_SIM, MIN_VECTOR_SIM_INTENT } from "./config.js";
import type { GuardedMemory } from "./guards.js";
import { applyGuards, DEFAULT_GUARDS } from "./guards.js";
import type { LlmClient } from "./llm.js";
import type { WindowEntry, WindowVia } from "./memory-window.js";
import { MemoryWindow } from "./memory-window.js";
import type { Memory, MemoryStore, ScoredMemory } from "./store.js";
import { parseAction } from "./tool-agent.js";
import type { DeviceTool } from "./tools.js";
import { TOOLS, toolsForContext } from "./tools.js";

/** 多輪對話 session（設計文件 §4.4）：三層記憶穿梭的載體。
 *  Layer 1 被動增量（θ gating）→ Layer 2 記憶窗（跨輪工作集）→ Layer 3 recall_memory tool。
 *  PoC 範圍：不含萃取寫回、session 持久化、digest、open threads。 */

const MAX_TURNS = 8; // 組合動作（睡眠模式一次串 5+ 工具）要夠的迴圈空間
/** transcript 高水位批次壓縮：逐則滑動每輪都毀 prefix cache，
 *  批次丟（滿 24 砍到 12）讓失效變成低頻計畫性事件；被丟段同一時刻折進 digest（§4.9/4.10 —
 *  digest 改寫發生在本來就要全量 prefill 的壓縮邊界，等於免費）。 */
const TRANSCRIPT_HIGH_WATER = 24;
const TRANSCRIPT_KEEP = 12;

export interface SessionOptions {
  /** 測試用：調低壓縮水位 */
  transcriptHighWater?: number;
  transcriptKeep?: number;
  /** 每輪萃取寫回記憶（預設開；測試可關以隔離行為） */
  extract?: boolean;
  /** 動態路由 v1（#25）：本地模型收斂失敗時接手同一輪的強模型（如 Bedrock Claude） */
  strongLlm?: LlmClient;
}

/** digest 只扛「聊到哪、剛決定什麼」的對話態；個人事實歸記憶層（§4.9 分工）。
 *  system prompt 一律英文（7/5 阿毛拍板：指令遵循較穩、評審可讀；輸出語言跟隨對話）。 */
const CONDENSE_SYSTEM = [
  "You are a conversation condenser. Input: the previous summary, existing open items, and conversation lines about to be dropped from the window.",
  'Return exactly one JSON object: {"digest":"1-2 sentence updated summary","openThreads":["open item", ...]}',
  "The digest merges the previous summary with the new content, keeping only: what topics were discussed, what was decided, and the current mood. Do NOT record personal facts or preferences (the memory system owns those).",
  "openThreads holds only unresolved items: unanswered questions, promised actions, topics still in progress. Remove items that are done or no longer relevant. Use an empty array if none.",
  "Write the digest and openThreads in the language of the conversation.",
].join("\n");
const EVENT_TTL_TURNS = 3; // 事件記憶處理完即退場，不長駐污染場景
const LINK_SCORE = 0.4; // link 擴展條目的窗內分（可淘汰、不搶位）
const SHORT_QUERY_CHARS = 10; // 被動空手 + 短訊息 → 併前句重試（Zep past-two-messages）

const EVENT_RE = /^(INCOMING_CALL|INCOMING_EMAIL|VEHICLE_EVENT|HOME_EVENT|CALENDAR_EVENT):\s*(\{.*\})/s;

/** 邊界重打分（§4.9）：gap 超過此值視為冷 resume，窗要冷卻。 */
const RESUME_WARM_GAP_MINUTES = 30;

export interface SessionTurnResult {
  reply: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: Record<string, unknown> }>;
  /** 本輪新進窗的記憶（透明度展示 + spike 斷言用） */
  admitted: Array<{ id: string; via: WindowVia; content: string }>;
  windowSize: number;
  turns: number;
  /** 本輪是否升級到強模型（demo 透明度展示） */
  escalated: boolean;
}

interface LoopCtx {
  system: string;
  working: string[];
  tools: DeviceTool[];
  toolCalls: SessionTurnResult["toolCalls"];
  pendingToolHits: ScoredMemory[];
  unlockedThisTurn: Set<string>;
  message: string;
  now: Date;
  floorNudged: boolean;
  calls: number;
  /** 同輪已嘗試的 tool+args 簽名 — 重複呼叫地板（VoxGuard RepetitionGuard 移植） */
  attempted: Set<string>;
}

export class ChatSession {
  window = new MemoryWindow();
  private turn = 0;
  private transcript: string[] = [];
  private digest = "";
  private openThreads: string[] = [];
  private confirmedTools = new Set<string>();
  /** 被攔下的敏感工具：要等「下一則使用者訊息」才解鎖 — 同輪重試仍被攔，確認權真的在使用者手上 */
  private pendingConfirm = new Set<string>();
  private lastUserMessage = "";
  private readonly highWater: number;
  private readonly keep: number;
  private readonly extract: boolean;
  private readonly strongLlm?: LlmClient;

  private constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmClient,
    private readonly userId: string,
    public context: string,
    opts?: SessionOptions,
  ) {
    this.highWater = opts?.transcriptHighWater ?? TRANSCRIPT_HIGH_WATER;
    this.keep = opts?.transcriptKeep ?? TRANSCRIPT_KEEP;
    this.extract = opts?.extract ?? true;
    this.strongLlm = opts?.strongLlm;
  }

  /** 進場即跑場景進入程序（pin + 交接浮現），所以用 async factory。 */
  static async open(
    store: MemoryStore,
    llm: LlmClient,
    userId: string,
    context: string,
    now = new Date(),
    opts?: SessionOptions,
  ): Promise<ChatSession> {
    const s = new ChatSession(store, llm, userId, context, opts);
    await s.enterScene(now);
    return s;
  }

  /** 跨終端/跨 session 接續（§4.6 + §4.9）：載回工作集、按 gap 冷卻。
   *  沒有既存 session 回 null（呼叫端 fallback 到 open）。 */
  static async resume(
    store: MemoryStore,
    llm: LlmClient,
    userId: string,
    now = new Date(),
    opts?: SessionOptions,
  ): Promise<ChatSession | null> {
    const state = await store.loadSessionState(userId);
    if (!state) return null;

    const memories = await store.getMany(state.windowEntries.map((e) => e.memoryId));
    const byId = new Map(
      memories
        .filter((m) => !m.expiresAt || m.expiresAt > now) // 過期記憶不復位
        .map((m) => [m.id, m]),
    );
    const s = new ChatSession(store, llm, userId, state.context, opts);
    s.turn = state.turn;
    s.transcript = state.transcript;
    s.digest = state.digest;
    s.openThreads = state.openThreads.filter((t): t is string => typeof t === "string");
    s.window = MemoryWindow.restore(state.windowEntries, byId);
    const lastUser = [...state.transcript].reverse().find((l) => l.startsWith("User: "));
    s.lastUserMessage = lastUser?.slice("User: ".length) ?? "";

    const gapMinutes = (now.getTime() - state.updatedAt.getTime()) / 60_000;
    if (gapMinutes > RESUME_WARM_GAP_MINUTES) {
      s.window.cool(gapMinutes / 60); // 長 gap：冷卻退場；短 gap（換終端）：全量接續
    }
    return s;
  }

  /** 場景切換（§4.5）：隱私 carry-over → 換場景 → pin + 交接浮現。 */
  async switchContext(
    newContext: string,
    now = new Date(),
  ): Promise<{ surfaced: Memory[]; evicted: WindowEntry[] }> {
    const evicted = this.window.carryOver(newContext);
    this.context = newContext;
    this.transcript.push(`System: scene switched → ${newContext}`);
    const surfaced = await this.enterScene(now);
    await this.persist(now);
    return { surfaced, evicted };
  }

  private async enterScene(now: Date): Promise<Memory[]> {
    for (const m of await this.store.pinCandidates(this.userId, now)) {
      this.window.admit(m, { score: m.importance, turn: this.turn, via: "pin", pinned: true });
    }
    const surfaced: Memory[] = [];
    for (const m of await this.store.handoffCandidates(this.userId, this.context, now)) {
      this.window.admit(m, { score: Math.max(m.importance, 0.6), turn: this.turn, via: "handoff" });
      surfaced.push(m);
    }
    // DB 層去重（surfaced_at）：跨 session、跨終端都不重複嘮叨
    await this.store.markSurfaced(surfaced.map((m) => m.id), now);
    return surfaced;
  }

  /** 每輪落庫（CockroachDB UPSERT）：任何終端 resume 即接續。digest/openThreads 待 §4.9 正式版。 */
  private async persist(now: Date): Promise<void> {
    await this.store.saveSessionState(
      {
        userId: this.userId,
        context: this.context,
        turn: this.turn,
        windowEntries: this.window.serialize(),
        transcript: this.transcript,
        digest: this.digest,
        openThreads: this.openThreads,
      },
      now,
    );
  }

  async send(message: string, now = new Date()): Promise<SessionTurnResult> {
    this.turn++;
    this.window.beginTurn(this.turn, now);
    // 新的使用者訊息 = 對上一輪被攔敏感操作的回應已到 → 解鎖（是否執行仍由模型解讀使用者意圖）
    const unlockedThisTurn = new Set(this.pendingConfirm);
    for (const t of this.pendingConfirm) this.confirmedTools.add(t);
    this.pendingConfirm.clear();
    const admitted: SessionTurnResult["admitted"] = [];

    // 事件訊息（流動政策 §4.8：事件主體決定 scope）
    const event = EVENT_RE.exec(message);
    if (event) {
      const query = this.eventQuery(event[2]!);
      const hits = await this.store.recall({
        userId: this.userId,
        query,
        context: this.context,
        scope: "cross",
        minSim: MIN_VECTOR_SIM_INTENT,
        topK: 5,
        now,
      });
      this.admitScored(hits, "event", admitted, { ttlTurns: EVENT_TTL_TURNS });
    } else {
      // Layer 1 被動增量：θ gating，多數輪空手而回
      let hits = await this.store.recall({
        userId: this.userId,
        query: message,
        context: this.context,
        minSim: MIN_VECTOR_SIM,
        topK: 5,
        now,
      });
      if (hits.length === 0 && message.length < SHORT_QUERY_CHARS && this.lastUserMessage) {
        hits = await this.store.recall({
          userId: this.userId,
          query: `${this.lastUserMessage} ${message}`,
          context: this.context,
          minSim: MIN_VECTOR_SIM,
          topK: 5,
          now,
        });
      }
      this.admitScored(hits, "passive", admitted);
      this.lastUserMessage = message;
    }
    await this.expandLinks(admitted, now);

    // 工具迴圈（harness 同 ToolAgent）。system 整輪固定（KV cache prefix 穩定）：
    // tool 撈到的記憶模型在輪內靠 TOOL_RESULT 看得到，進窗延後到輪末。
    const tools = toolsForContext(this.context);
    const system = await this.buildPrompt(tools, now);
    // digest / open threads 放 working 頭部：只在壓縮邊界變動，不污染 prefix（§4.10）
    const head: string[] = [];
    if (this.digest) head.push(`(Earlier summary: ${this.digest})`);
    for (const t of this.openThreads) head.push(`(Open: ${t})`);
    const working = [...head, ...this.transcript, `User: ${message}`];
    const toolCalls: SessionTurnResult["toolCalls"] = [];
    const pendingToolHits: ScoredMemory[] = [];
    const ctx: LoopCtx = {
      system,
      working,
      tools,
      toolCalls,
      pendingToolHits,
      unlockedThisTurn,
      message,
      now,
      floorNudged: false, // 行為地板整輪只 nudge 一次（使用者可能是拒絕，不無限逼）
      calls: 0,
      attempted: new Set<string>(),
    };

    // 動態路由 v1（#25）：本地模型收斂失敗 → 強模型「接手同一輪」——
    // 看得到已有的 TOOL_RESULT（不重複副作用），working 附升級註記。
    let replyText = await this.driveLoop(this.llm, ctx);
    let escalated = false;
    if (replyText === null && this.strongLlm) {
      escalated = true;
      working.push(
        "SYSTEM_GUARD: escalated — the previous model could not complete this turn. Review the conversation and TOOL_RESULT lines above (those actions are already done; do not repeat them) and finish the turn correctly.",
      );
      replyText = await this.driveLoop(this.strongLlm, ctx);
    }

    const finalReply =
      replyText ?? "(Interrupted: too many consecutive actions — please tell me again what you need.)";
    this.transcript.push(`User: ${message}`, `(You): ${finalReply}`);
    await this.compactTranscript();
    await this.finishTurn(pendingToolHits, admitted, now);
    if (this.extract && replyText !== null) await this.extractMemories(message, now);
    await this.persist(now);
    return {
      reply: finalReply,
      toolCalls,
      admitted,
      windowSize: this.window.size,
      turns: ctx.calls,
      escalated,
    };
  }

  /** 工具迴圈本體：收斂到 reply 回文字、預算用完回 null（觸發升級或中斷回覆）。 */
  private async driveLoop(llm: LlmClient, ctx: LoopCtx): Promise<string | null> {
    const { system, working, tools, toolCalls, pendingToolHits, message, now } = ctx;
    for (let i = 1; i <= MAX_TURNS; i++) {
      ctx.calls++;
      // 時間戳放尾端、分鐘粒度：每輪資料不污染 prefix
      const raw = await llm.complete(
        system,
        [...working, `(Current time: ${now.toISOString().slice(0, 16)})`].join("\n"),
      );
      const action = parseAction(raw);

      if (!action) {
        working.push(
          "System: your last output was not a valid action JSON. Output exactly one JSON object.",
        );
        continue;
      }
      if (action.action === "reply") {
        // 行為地板（CAR-bench 經驗：prompt 是上限、harness 是下限）— 攔 reply 不是攔對話
        if (!ctx.floorNudged) {
          const nudge = safetyFloorNudge(message, toolCalls, ctx.unlockedThisTurn);
          if (nudge) {
            ctx.floorNudged = true;
            working.push(`(You): ${JSON.stringify(action)}`, `SYSTEM_GUARD: ${nudge}`);
            continue;
          }
        }
        return action.text;
      }

      // 重複呼叫地板：同輪同工具同參數第二次 → 攔下換路（小模型鬼打牆的確定性剎車）
      const sig = `${action.tool}:${JSON.stringify(action.args)}`;
      if (ctx.attempted.has(sig)) {
        working.push(
          `(You): ${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({
            ok: false,
            error: "Duplicate call this turn (identical tool and args already attempted) — do something different or reply.",
          })}`,
        );
        continue;
      }
      ctx.attempted.add(sig);

      // save_memory：使用者明說要記的事 → 確定性寫入（與萃取器的隱式路徑互補）
      if (action.tool === "save_memory") {
        const content = typeof action.args.content === "string" ? action.args.content.trim() : "";
        if (!content) {
          working.push(
            `(You): ${JSON.stringify(action)}`,
            `TOOL_RESULT: ${JSON.stringify({ ok: false, error: "content must be a non-empty string" })}`,
          );
          continue;
        }
        const memoryType =
          action.args.type === "semantic" || action.args.type === "procedural"
            ? action.args.type
            : "episodic";
        const targetContext =
          typeof action.args.context === "string" && action.args.context ? action.args.context : this.context;
        const saved = await this.store.remember({
          userId: this.userId,
          context: targetContext,
          memoryType,
          content,
          importance: typeof action.args.importance === "number" ? action.args.importance : 0.7,
          expiresAt:
            typeof action.args.expiresInHours === "number"
              ? new Date(now.getTime() + action.args.expiresInHours * 3_600_000)
              : undefined,
          sourceContext: targetContext !== this.context ? this.context : undefined,
        });
        this.window.admit(saved, { score: 0.8, turn: this.turn, via: "tool" });
        const result = { ok: true, saved: content, type: memoryType, context: targetContext };
        toolCalls.push({ tool: "save_memory", args: action.args, result });
        working.push(`(You): ${JSON.stringify(action)}`, `TOOL_RESULT: ${JSON.stringify(result)}`);
        continue;
      }

      // Layer 3：recall_memory 是 harness 級工具，不在裝置目錄
      if (action.tool === "recall_memory") {
        const query = typeof action.args.query === "string" ? action.args.query : "";
        if (!query) {
          working.push(
            `(You): ${JSON.stringify(action)}`,
            `TOOL_RESULT: ${JSON.stringify({ ok: false, error: "query must be a non-empty string" })}`,
          );
          continue;
        }
        const scope = action.args.scope === "all" ? "cross" : "scene";
        const hits = await this.store.recall({
          userId: this.userId,
          query,
          context: this.context,
          scope,
          minSim: MIN_VECTOR_SIM_INTENT,
          topK: 5,
          now,
        });
        pendingToolHits.push(...hits);
        const result = {
          ok: true,
          memories: hits.map((m) => ({
            content: m.content,
            context: m.context,
            created: m.createdAt.toISOString().slice(0, 10),
          })),
        };
        toolCalls.push({ tool: "recall_memory", args: action.args, result });
        working.push(`(You): ${JSON.stringify(action)}`, `TOOL_RESULT: ${JSON.stringify(result)}`);
        continue;
      }

      const tool = tools.find((t) => t.name === action.tool);
      if (!tool) {
        const existsElsewhere = TOOLS.some((t) => t.name === action.tool);
        const error = existsElsewhere
          ? `Tool ${action.tool} is not available in the current scene (${this.context})`
          : `No tool named ${action.tool}`;
        working.push(
          `(You): ${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({ ok: false, error })}`,
        );
        continue;
      }
      if (tool.sensitive && !this.confirmedTools.has(tool.name)) {
        this.pendingConfirm.add(tool.name);
        working.push(
          `(You): ${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({
            ok: false,
            requires_confirmation: true,
            message:
              "Safety-sensitive operation, NOT executed — first confirm the user's intent via a reply",
          })}`,
        );
        continue;
      }
      const invalid = tool.validate(action.args);
      if (invalid) {
        working.push(
          `(You): ${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({ ok: false, error: `Invalid args: ${invalid}` })}`,
        );
        continue;
      }
      const result = tool.execute(action.args);
      // 敏感確認單次有效：執行一次即重新上鎖，下次呼叫重走確認（7/6 edge case 衝刺抓到的語意漏洞）
      if (tool.sensitive) this.confirmedTools.delete(tool.name);
      toolCalls.push({ tool: tool.name, args: action.args, result });
      working.push(`(You): ${JSON.stringify(action)}`, `TOOL_RESULT: ${JSON.stringify(result)}`);
    }
    return null;
  }

  /** 高水位壓縮 + 折疊 digest（§4.9）：被丟的對話行不是消失，是濃縮成對話態。 */
  private async compactTranscript(): Promise<void> {
    if (this.transcript.length <= this.highWater) return;
    const dropped = this.transcript.slice(0, this.transcript.length - this.keep);
    this.transcript = this.transcript.slice(-this.keep);
    try {
      const raw = await this.llm.complete(
        CONDENSE_SYSTEM,
        [
          `舊摘要：${this.digest || "（無）"}`,
          `既有未完成事項：${this.openThreads.length ? this.openThreads.join("；") : "（無）"}`,
          "被移出的對話行：",
          ...dropped,
        ].join("\n"),
      );
      const obj = JSON.parse(raw.replace(/```json\s*|```\s*/g, "").trim()) as {
        digest?: unknown;
        openThreads?: unknown;
      };
      if (typeof obj.digest === "string") this.digest = obj.digest;
      if (Array.isArray(obj.openThreads)) {
        this.openThreads = obj.openThreads.filter((t): t is string => typeof t === "string");
      }
    } catch {
      // 摘要失敗不炸對話：舊 digest 續用，被丟段的事實仍在記憶層
    }
  }

  /** 萃取寫回（記憶 × 對話閉環）：跨場景主題自動帶 sourceContext → 餵交接浮現。
   *  best-effort：萃取失敗（API 掛掉/retry 耗盡）不得炸掉對話。 */
  private async extractMemories(message: string, now: Date): Promise<void> {
    try {
      const raw = await this.llm.complete(buildExtractionPrompt(this.context, now), message);
      for (const m of parseExtraction(raw, this.userId, now)) {
        await this.store.remember({
          ...m,
          sourceContext: m.context !== this.context ? this.context : undefined,
        });
      }
    } catch {
      // 這輪沒萃取到 — 事實仍在 transcript/digest，下次對話還有機會
    }
  }

  /** 輪末結算：tool 撈到的記憶進窗 + link 擴展（輪內 system 不動，下一輪才反映）。 */
  private async finishTurn(
    hits: ScoredMemory[],
    admitted: SessionTurnResult["admitted"],
    now: Date,
  ): Promise<void> {
    if (hits.length === 0) return;
    this.admitScored(hits, "tool", admitted);
    await this.expandLinks(admitted, now);
  }

  private admitScored(
    hits: ScoredMemory[],
    via: WindowVia,
    admitted: SessionTurnResult["admitted"],
    opts?: { ttlTurns?: number },
  ): void {
    for (const m of hits) {
      const isNew = this.window.admit(m, {
        score: m.score,
        turn: this.turn,
        via,
        ttlTurns: opts?.ttlTurns,
      });
      if (isNew) admitted.push({ id: m.id, via, content: m.content });
    }
  }

  /** link 一跳擴展（§4.3）：新進窗記憶的邊對端拉進窗 → ConflictGuard 不再靠兩端碰巧同進 top-K。 */
  private async expandLinks(admitted: SessionTurnResult["admitted"], now: Date): Promise<void> {
    const newIds = admitted.filter((a) => a.via !== "link").map((a) => a.id);
    if (newIds.length === 0) return;
    const links = await this.store.loadLinksFor(newIds);
    const otherEnds = new Set<string>();
    for (const l of links) {
      for (const id of [l.sourceId, l.targetId]) {
        if (!this.window.has(id)) otherEnds.add(id);
      }
    }
    if (otherEnds.size === 0) return;
    for (const m of await this.store.getMany([...otherEnds])) {
      // 隱私仍守：link 對端若是場景外 private，不進窗
      const visible =
        m.context === this.context ||
        m.context === "any" ||
        m.privacyLevel !== "private";
      if (!visible) continue;
      if (m.expiresAt && m.expiresAt <= now) continue;
      const isNew = this.window.admit(m, { score: LINK_SCORE, turn: this.turn, via: "link" });
      if (isNew) admitted.push({ id: m.id, via: "link", content: m.content });
    }
  }

  private eventQuery(payloadRaw: string): string {
    try {
      const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
      const parts = ["from", "subject", "preview", "type", "event", "room", "detail"]
        .map((k) => payload[k])
        .filter((v): v is string => typeof v === "string");
      return `${parts.join(", ")} — last discussions, background, todos and preferences`;
    } catch {
      return payloadRaw;
    }
  }

  /** 窗 → guard chain → system prompt。prefix 穩定性：窗用插入序 render、時間戳不進 system —
   *  多數輪 θ gating 空手而回 = 窗不變 = system 逐字不變 → 自部署 vLLM/SGLang prefix cache 全命中。 */
  private async buildPrompt(tools: DeviceTool[], now: Date): Promise<string> {
    const entries = this.window.stableEntries();
    const guarded = await applyGuards(
      DEFAULT_GUARDS,
      entries.map((e) => ({
        ...e.memory,
        vectorSim: e.score,
        signals: { vector: e.score, bm25: 0, recency: 0 },
        score: e.score,
        annotations: [],
      })),
      { currentContext: this.context, now },
      { loadContradictsLinks: (ids) => this.store.loadContradictsLinks(ids) },
    );
    const viaById = new Map(entries.map((e) => [e.memory.id, e.via]));
    return buildSessionPrompt(this.context, guarded, viaById, tools);
  }
}

/** 確定性行為地板：回 null = 放行 reply；回字串 = 攔下 reply、把訊息餵回模型再跑一步。 */
export function safetyFloorNudge(
  message: string,
  toolCalls: SessionTurnResult["toolCalls"],
  unlockedThisTurn: Set<string>,
): string | null {
  // 地板 1：危險事件 + 無回應 → emergency_call 不可缺席（人命優先）
  const hazardNoResponse =
    /USER_NO_RESPONSE/.test(message) &&
    /(airbag_deployed|collision|smoke_detected|gas_leak)/.test(message);
  if (hazardNoResponse && !toolCalls.some((t) => t.tool === "emergency_call")) {
    return "Hazard event with USER_NO_RESPONSE: emergency_call is required NOW (life first, no confirmation needed) — call it, unless the user has clearly responded since.";
  }
  // 地板 2：已解鎖的敏感操作不得「說了沒做」
  const unexecuted = [...unlockedThisTurn].filter((t) => !toolCalls.some((c) => c.tool === t));
  if (unexecuted.length > 0) {
    return `Confirmed sensitive actions not yet executed: ${unexecuted.join(", ")}. If the user approved, call them now; if the user declined, reply WITHOUT claiming they were done.`;
  }
  return null;
}

const VIA_LABEL: Partial<Record<WindowVia, string>> = {
  pin: "[pinned] ",
  handoff: "[handoff] ",
  event: "[event] ",
};

/** Prompt 分層排列（§4.10 KV cache 對齊）：靜態（persona/規則/工具）在前、
 *  慢變（記憶窗）殿後、每輪資料（時間戳）放 user 尾端 — prefix 失效點越後面越好。 */
export function buildSessionPrompt(
  context: string,
  memories: GuardedMemory[],
  viaById: Map<string, WindowVia>,
  tools: DeviceTool[],
): string {
  const toolBlock = [
    ...tools.map(
      (t) =>
        `- ${t.name}${t.sensitive ? " (safety-sensitive)" : t.readonly ? " (read-only)" : ""}: ${t.description}. args: ${t.argsSpec}`,
    ),
    '- recall_memory: Search your long-term memory. When the user asks about a personal fact that is not in the memory section, search first, then answer (rewrite any pronouns/references into a complete standalone query); if nothing is found, honestly say you don\'t know. args: {"query": "complete search sentence", "scope": "current"|"all"} (all = search across scenes; when citing cross-scene results, mention the source scene)',
    '- save_memory: Explicitly save something the user asks you to remember (meeting notes, decisions, facts) as a self-contained sentence in the user\'s language. args: {"content": "the fact", "type": "episodic"|"semantic"|"procedural", "context": "driving"|"office"|"home"|"any", "importance": 0-1, "expiresInHours": number (optional)}',
  ].join("\n");

  const memoryBlock =
    memories.length === 0
      ? "(No relevant memories loaded — for personal-fact questions, search with recall_memory first)"
      : memories
          .map((m) => {
            const label = VIA_LABEL[viaById.get(m.id) ?? "passive"] ?? "";
            const lines = [`- ${label}${m.content}`];
            for (const a of m.annotations) lines.push(`  ⚠ ${a}`);
            return lines.join("\n");
          })
          .join("\n");

  return [
    "You are ASTRA, a cross-scene personal AI companion — the same you, with the same memory, in the car, at the office, and at home. You can operate the user's devices.",
    `Current scene: ${context}.`,
    "",
    "## Output rules (strict)",
    "Output exactly one JSON object and nothing else:",
    '- To operate a device or search memory: {"action":"tool_call","tool":"<tool name>","args":{...}}',
    '- To reply to the user: {"action":"reply","text":"..."}',
    'Tool results come back as messages starting with "TOOL_RESULT: {...}"; continue with the next step (another tool call or a reply).',
    "Only use the tools listed below. If the user asks for something with no matching tool, reply honestly that you can't do it — never pretend you did.",
    "Tools marked (read-only) only report state; finding something via a query never implies you can act on it — acting requires its own tool from the list.",
    "When asking the user to confirm an action, state exactly what you will do, including the argument values (e.g., \"lock the front door (secured)\" — not just \"adjust things\").",
    "Never call the same tool with identical arguments twice in one turn — the system rejects duplicates.",
    'Composite requests (e.g., "good night", "I\'m heading out") usually need several device actions: execute them one tool call at a time, then reply with a summary of everything done.',
    "Never claim an action was performed unless you called the tool and saw an ok TOOL_RESULT this turn.",
    "Tools marked (safety-sensitive) need user confirmation, handled by the system: attempt the tool call directly — the system intercepts it and tells you to confirm; put that question in your reply, and after the user approves in their next message, call the tool again to actually execute.",
    "",
    "## Memory rules",
    "Personal facts about the user must come only from the memory section; when a memory carries an annotation (stale / conflicting / from another scene), reflect it in your reply.",
    "Memories tagged [handoff] are things the user mentioned in another scene that matter now — bring them up naturally and proactively in this turn.",
    "Memories tagged [event] are background fetched for the current event — use them to brief the user.",
    "Lines at the top of the conversation like (Earlier summary: …) and (Open: …) are condensed earlier conversation: use them to stay continuous, and follow up on open items at a fitting moment.",
    "",
    "## Event rules",
    'A message starting with "VEHICLE_EVENT:" is a vehicle system event (not the user speaking): for safety events (airbag_deployed, collision), first reply to check on the user; if "USER_NO_RESPONSE" follows, treat it as a major accident — immediately emergency_call (119) and notify the emergency contact found in memory, no confirmation needed. For non-safety events (low_fuel, service_due), inform the user and suggest a concrete action (e.g., search_poi for a gas station on the route, using their preferences from memory).',
    'A message starting with "INCOMING_CALL:" or "INCOMING_EMAIL:" is a call/email event (not the user speaking): announce who it is, brief the user in one line using the [event] memories (what was last discussed, what to watch for), then ask whether to answer/reply. Never answer on your own.',
    'A message starting with "HOME_EVENT:" is a home system event (not the user speaking): for hazard events (smoke_detected, gas_leak), act immediately to reduce danger first (e.g., set_outlet off for the suspect appliance), then warn the user and ask if they are okay; if "USER_NO_RESPONSE" follows or the hazard is confirmed spreading, emergency_call (119) immediately, no confirmation needed. If the user says it is a false alarm, do not escalate — give practical advice instead. For doorbell events, announce the visitor; never unlock the door without explicit user approval. For geofence events (geofence_exit = user left home, geofence_enter = user arriving), run the matching routine from memory if one exists.',
    'A message starting with "CALENDAR_EVENT:" is a schedule event (not the user speaking), e.g. a departure reminder computed from the calendar and travel time: brief the user on the appointment using the [event] memories, tell them when to leave, and offer helpful actions available in the current scene (e.g., start navigation in the car).',
    "",
    "Reply in the same language the user speaks. For Chinese, use Traditional Chinese (Taiwan usage) only — simplified characters are strictly forbidden. Be conversational and concise, like a close companion, not customer service.",
    "",
    "## Tools available in this scene",
    toolBlock,
    "",
    "## Memory (working set)",
    memoryBlock,
  ].join("\n");
}
