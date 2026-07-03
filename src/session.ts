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

const MAX_TURNS = 6;
/** transcript 高水位批次壓縮：逐則滑動每輪都毀 prefix cache，
 *  批次丟（滿 24 砍到 12）讓失效變成低頻計畫性事件。被丟段折進 digest = 正式版（§4.9/4.10）。 */
const TRANSCRIPT_HIGH_WATER = 24;
const TRANSCRIPT_KEEP = 12;
const EVENT_TTL_TURNS = 3; // 事件記憶處理完即退場，不長駐污染場景
const LINK_SCORE = 0.4; // link 擴展條目的窗內分（可淘汰、不搶位）
const SHORT_QUERY_CHARS = 10; // 被動空手 + 短訊息 → 併前句重試（Zep past-two-messages）

const EVENT_RE = /^(INCOMING_CALL|INCOMING_EMAIL):\s*(\{.*\})/s;

export interface SessionTurnResult {
  reply: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: Record<string, unknown> }>;
  /** 本輪新進窗的記憶（透明度展示 + spike 斷言用） */
  admitted: Array<{ id: string; via: WindowVia; content: string }>;
  windowSize: number;
  turns: number;
}

export class ChatSession {
  readonly window = new MemoryWindow();
  private turn = 0;
  private transcript: string[] = [];
  private surfacedIds = new Set<string>(); // PoC：surfaced_at 欄位的 session 內替代
  private confirmedTools = new Set<string>();
  private lastUserMessage = "";

  private constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmClient,
    private readonly userId: string,
    public context: string,
  ) {}

  /** 進場即跑場景進入程序（pin + 交接浮現），所以用 async factory。 */
  static async open(
    store: MemoryStore,
    llm: LlmClient,
    userId: string,
    context: string,
    now = new Date(),
  ): Promise<ChatSession> {
    const s = new ChatSession(store, llm, userId, context);
    await s.enterScene(now);
    return s;
  }

  /** 場景切換（§4.5）：隱私 carry-over → 換場景 → pin + 交接浮現。 */
  async switchContext(
    newContext: string,
    now = new Date(),
  ): Promise<{ surfaced: Memory[]; evicted: WindowEntry[] }> {
    const evicted = this.window.carryOver(newContext);
    this.context = newContext;
    this.transcript.push(`系統：場景切換 → ${newContext}`);
    const surfaced = await this.enterScene(now);
    return { surfaced, evicted };
  }

  private async enterScene(now: Date): Promise<Memory[]> {
    for (const m of await this.store.pinCandidates(this.userId, now)) {
      this.window.admit(m, { score: m.importance, turn: this.turn, via: "pin", pinned: true });
    }
    const surfaced: Memory[] = [];
    for (const m of await this.store.handoffCandidates(this.userId, this.context, now)) {
      if (this.surfacedIds.has(m.id)) continue;
      this.surfacedIds.add(m.id);
      this.window.admit(m, { score: Math.max(m.importance, 0.6), turn: this.turn, via: "handoff" });
      surfaced.push(m);
    }
    return surfaced;
  }

  async send(message: string, now = new Date()): Promise<SessionTurnResult> {
    this.turn++;
    this.window.beginTurn(this.turn);
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
    const working = [...this.transcript, `使用者：${message}`];
    const toolCalls: SessionTurnResult["toolCalls"] = [];
    const pendingToolHits: ScoredMemory[] = [];

    for (let i = 1; i <= MAX_TURNS; i++) {
      // 時間戳放尾端、分鐘粒度：每輪資料不污染 prefix
      const raw = await this.llm.complete(
        system,
        [...working, `（現在時間：${now.toISOString().slice(0, 16)}）`].join("\n"),
      );
      const action = parseAction(raw);

      if (!action) {
        working.push("系統：上一則輸出不是合法的 action JSON，請重新只輸出一個 JSON 物件。");
        continue;
      }
      if (action.action === "reply") {
        this.transcript.push(`使用者：${message}`, `（你）：${action.text}`);
        this.compactTranscript();
        await this.finishTurn(pendingToolHits, admitted, now);
        return {
          reply: action.text,
          toolCalls,
          admitted,
          windowSize: this.window.size,
          turns: i,
        };
      }

      // Layer 3：recall_memory 是 harness 級工具，不在裝置目錄
      if (action.tool === "recall_memory") {
        const query = typeof action.args.query === "string" ? action.args.query : "";
        if (!query) {
          working.push(
            `（你）：${JSON.stringify(action)}`,
            `TOOL_RESULT: ${JSON.stringify({ ok: false, error: "query 必須是非空字串" })}`,
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
        working.push(`（你）：${JSON.stringify(action)}`, `TOOL_RESULT: ${JSON.stringify(result)}`);
        continue;
      }

      const tool = tools.find((t) => t.name === action.tool);
      if (!tool) {
        const existsElsewhere = TOOLS.some((t) => t.name === action.tool);
        const error = existsElsewhere
          ? `工具 ${action.tool} 不在當前場景（${this.context}）可用，無法執行`
          : `不存在名為 ${action.tool} 的工具`;
        working.push(
          `（你）：${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({ ok: false, error })}`,
        );
        continue;
      }
      if (tool.sensitive && !this.confirmedTools.has(tool.name)) {
        this.confirmedTools.add(tool.name);
        working.push(
          `（你）：${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({
            ok: false,
            requires_confirmation: true,
            message: "此為安全敏感操作，尚未執行 — 請先用 reply 向使用者確認意圖",
          })}`,
        );
        continue;
      }
      const invalid = tool.validate(action.args);
      if (invalid) {
        working.push(
          `（你）：${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({ ok: false, error: `參數錯誤：${invalid}` })}`,
        );
        continue;
      }
      const result = tool.execute(action.args);
      toolCalls.push({ tool: tool.name, args: action.args, result });
      working.push(`（你）：${JSON.stringify(action)}`, `TOOL_RESULT: ${JSON.stringify(result)}`);
    }

    this.transcript.push(`使用者：${message}`);
    this.compactTranscript();
    await this.finishTurn(pendingToolHits, admitted, now);
    return {
      reply: "（操作中斷：連續動作過多，請再說一次你要做什麼）",
      toolCalls,
      admitted,
      windowSize: this.window.size,
      turns: MAX_TURNS,
    };
  }

  private compactTranscript(): void {
    if (this.transcript.length > TRANSCRIPT_HIGH_WATER) {
      this.transcript = this.transcript.slice(-TRANSCRIPT_KEEP);
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
      const parts = ["from", "subject", "preview"]
        .map((k) => payload[k])
        .filter((v): v is string => typeof v === "string");
      return `${parts.join("、")}：上次談了什麼、相關背景、待辦與偏好`;
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

const VIA_LABEL: Partial<Record<WindowVia, string>> = {
  pin: "【常駐】",
  handoff: "【交接】",
  event: "【事件相關】",
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
    ...tools.map((t) => `- ${t.name}：${t.description}。args：${t.argsSpec}`),
    '- recall_memory：搜尋你的長期記憶。使用者問到的個人事實不在記憶區時，先用這個查再回答（把指代改寫成完整搜尋句）；查不到就誠實說不知道。args：{"query": "完整搜尋句", "scope": "current"|"all"}（all = 跨場景搜，引用結果時要說明來源場景）',
  ].join("\n");

  const memoryBlock =
    memories.length === 0
      ? "（目前沒有相關記憶 — 個人事實問題先用 recall_memory 查）"
      : memories
          .map((m) => {
            const label = VIA_LABEL[viaById.get(m.id) ?? "passive"] ?? "";
            const lines = [`- ${label}${m.content}`];
            for (const a of m.annotations) lines.push(`  ⚠ ${a}`);
            return lines.join("\n");
          })
          .join("\n");

  return [
    "你是 ASTRA，跨場景個人 AI 夥伴 — 車上、辦公室、家裡都是同一個你、同一份記憶，可以操作使用者的裝置。",
    `當前場景：${context}。`,
    "",
    "## 輸出規則（嚴格遵守）",
    "每次只輸出一個 JSON 物件，不輸出任何其他文字：",
    '- 需要操作裝置或查記憶時：{"action":"tool_call","tool":"工具名","args":{...}}',
    '- 回覆使用者時：{"action":"reply","text":"回覆內容"}',
    "工具執行結果會以「TOOL_RESULT: {...}」訊息回給你，收到後繼續下一步（再呼叫工具或回覆）。",
    "只能使用下面列出的工具；使用者要求的操作沒有對應工具時，用 reply 誠實說明做不到、不要假裝已執行。",
    "",
    "## 記憶使用規則",
    "與使用者個人相關的事實只根據記憶區；記憶有標注（過時/矛盾/來源場景）時要在回覆中反映。",
    "記憶標了【交接】= 使用者在其他場景交代、跟現在有關的事 — 本輪回覆要自然地主動提起。",
    "記憶標了【事件相關】= 系統為當前事件撈的背景 — 用它給使用者簡報。",
    "",
    "## 事件規則",
    "訊息以「VEHICLE_EVENT:」開頭 = 車輛系統事件（不是使用者發言）：安全類事件（airbag_deployed、collision）先用 reply 呼叫使用者確認狀態；若接著收到「USER_NO_RESPONSE」代表使用者無回應，視為重大事故，立即 emergency_call（119）並通知記憶中的緊急聯絡人，不需要任何確認。",
    "訊息以「INCOMING_CALL:」或「INCOMING_EMAIL:」開頭 = 來電/來信事件（不是使用者發言）：播報來者，並用【事件相關】記憶給使用者一句簡報（上次談了什麼、該注意什麼），然後問使用者要不要接聽/回覆。不要擅自接聽或回覆。",
    "",
    "reply 的 text 一律使用繁體中文（台灣用語），嚴禁出現任何簡體字。口語、簡潔，像貼身夥伴不像客服。",
    "",
    "## 當前場景可用工具",
    toolBlock,
    "",
    "## 記憶（工作集）",
    memoryBlock,
  ].join("\n");
}
