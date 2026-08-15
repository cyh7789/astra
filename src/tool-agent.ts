/** ⚠ DEPRECATED（devin P1-2）：ToolAgent 是 Phase 4 早期 spike 的工具迴圈，production 不使用 —
 *  正宗路徑是 ChatSession（src/session.ts），其敏感確認為「跨輪確認、單輪有效」，與本檔語意不同。
 *  只有 parseAction 仍被 session.ts 引用；ToolAgent class 僅供 scripts/tool-spike.ts 歷史參考。 */
import type { GuardedMemory } from "./guards.js";
import type { LlmClient } from "./llm.js";
import type { MemoryStore } from "./store.js";
import type { DeviceTool } from "./tools.js";
import { TOOLS, toolsForContext } from "./tools.js";

/** JSON 協議工具調用：不依賴原生 function calling，開源模型（Gemma）也能跑。
 *  可靠性靠 harness：schema 驗證、場景白名單、parse 重試、迴圈上限 —
 *  架構決定行為下限：prompt 只是上限，harness 才是保證。 */

export interface ToolAction {
  action: "tool_call";
  tool: string;
  args: Record<string, unknown>;
}
export interface ReplyAction {
  action: "reply";
  text: string;
}
export type AgentAction = ToolAction | ReplyAction;

/** 解析 LLM 輸出的 action JSON；容錯 fence 與前後雜訊（抓第一個 {...} 區塊）。 */
export function parseAction(raw: string): AgentAction | null {
  const stripped = raw.replace(/```json\s*|```\s*/g, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) return null;
  // 掃到對應的閉括號（處理巢狀）— 必須忽略字串字面值裡的 {}，否則 reply text 含 } 會提前歸零
  // 切出不合法 JSON（devin P2：{"text":"設定 }"} 被截斷）。
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    else if (!inString && ch === "{") depth++;
    else if (!inString && ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
    if (obj.action === "reply" && typeof obj.text === "string") {
      return { action: "reply", text: obj.text };
    }
    if (
      obj.action === "tool_call" &&
      typeof obj.tool === "string" &&
      obj.args !== null &&
      typeof obj.args === "object"
    ) {
      return { action: "tool_call", tool: obj.tool, args: obj.args as Record<string, unknown> };
    }
    // 外層不合規格時由形狀還原。實測 Bedrock Gemma 4 31B 三種變體：省略 action、
    // 把工具名寫進 action、把 args 攤平在頂層。要求模型改口不可靠，harness 補齊才是保證。
    const tool =
      typeof obj.tool === "string"
        ? obj.tool
        : typeof obj.action === "string" && obj.action !== "reply" && obj.action !== "tool_call"
          ? obj.action
          : undefined;
    if (tool) {
      const args =
        obj.args !== null && typeof obj.args === "object"
          ? (obj.args as Record<string, unknown>)
          : Object.fromEntries(
              Object.entries(obj).filter(([k]) => k !== "action" && k !== "tool" && k !== "args"),
            );
      return { action: "tool_call", tool, args };
    }
    if (typeof obj.text === "string") return { action: "reply", text: obj.text };
    return null;
  } catch {
    return null;
  }
}

export function buildToolSystemPrompt(
  context: string,
  now: Date,
  memories: GuardedMemory[],
  tools: DeviceTool[],
): string {
  const toolBlock = tools
    .map((t) => `- ${t.name}：${t.description}。args：${t.argsSpec}`)
    .join("\n");
  const memoryBlock =
    memories.length === 0
      ? "（沒有相關記憶）"
      : memories
          .map((m) => `- ${m.content}${m.annotations.length ? `（${m.annotations.join("；")}）` : ""}`)
          .join("\n");

  return [
    "你是 ASTRA，跨場景個人 AI 夥伴，可以操作使用者的裝置。",
    `當前場景：${context}。現在時間：${now.toISOString()}。`,
    "",
    "## 當前場景可用工具",
    toolBlock || "（此場景沒有可用工具）",
    "",
    "## 相關記憶",
    memoryBlock,
    "",
    "## 輸出規則（嚴格遵守）",
    "每次只輸出一個 JSON 物件，不輸出任何其他文字：",
    '- 需要操作裝置時：{"action":"tool_call","tool":"工具名","args":{...}}',
    '- 回覆使用者時：{"action":"reply","text":"回覆內容"}',
    "工具執行結果會以「TOOL_RESULT: {...}」訊息回給你，收到後繼續下一步（再呼叫工具或回覆）。",
    "只能使用上面列出的工具；使用者要求的操作沒有對應工具時，用 reply 誠實說明做不到、不要假裝已執行。",
    "訊息以「VEHICLE_EVENT:」開頭時，那是車輛系統事件（不是使用者發言）：安全類事件（airbag_deployed、collision）先用 reply 呼叫使用者確認狀態；若接著收到「USER_NO_RESPONSE」代表使用者無回應，視為重大事故，立即 emergency_call（119）並通知記憶中的緊急聯絡人，不需要任何確認。",
    "與使用者個人相關的事實只根據記憶區；記憶有標注（過時/矛盾）時要在回覆中反映。",
    'reply 的 text 一律使用繁體中文（台灣用語），嚴禁簡體字。',
  ].join("\n");
}

export interface ToolLoopResult {
  reply: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: Record<string, unknown> }>;
  turns: number;
}

const MAX_TURNS = 6;

export class ToolAgent {
  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmClient,
    private readonly userId: string,
  ) {}

  async chat(message: string, context: string, now = new Date()): Promise<ToolLoopResult> {
    const memories = await this.store.recallGuarded({
      userId: this.userId,
      query: message,
      context,
      topK: 5,
      now,
    });
    const tools = toolsForContext(context);
    const system = buildToolSystemPrompt(context, now, memories, tools);

    const transcript: string[] = [`使用者：${message}`];
    const toolCalls: ToolLoopResult["toolCalls"] = [];
    const confirmedTools = new Set<string>();

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const raw = await this.llm.complete(system, transcript.join("\n"));
      const action = parseAction(raw);

      if (!action) {
        transcript.push(`系統：上一則輸出不是合法的 action JSON，請重新只輸出一個 JSON 物件。`);
        continue;
      }

      if (action.action === "reply") {
        return { reply: action.text, toolCalls, turns: turn };
      }

      // Capability Guard：白名單外的工具（含其他場景的）→ 錯誤回饋讓模型誠實轉彎
      const tool = tools.find((t) => t.name === action.tool);
      if (!tool) {
        const existsElsewhere = TOOLS.some((t) => t.name === action.tool);
        const error = existsElsewhere
          ? `工具 ${action.tool} 不在當前場景（${context}）可用，無法執行`
          : `不存在名為 ${action.tool} 的工具`;
        transcript.push(
          `（你）：${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({ ok: false, error })}`,
        );
        continue;
      }

      // 敏感操作確認 Guard：門鎖/保全類第一次呼叫一律攔下，強制先問使用者
      if (tool.sensitive && !confirmedTools.has(tool.name)) {
        confirmedTools.add(tool.name); // spike 版：同一輪對話內第二次呼叫視為已確認
        transcript.push(
          `（你）：${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({
            ok: false,
            requires_confirmation: true,
            message: "此為安全敏感操作，尚未執行 — 請先用 reply 向使用者確認意圖",
          })}`,
        );
        continue;
      }

      // 參數驗證 Guard
      const invalid = tool.validate(action.args);
      if (invalid) {
        transcript.push(
          `（你）：${JSON.stringify(action)}`,
          `TOOL_RESULT: ${JSON.stringify({ ok: false, error: `參數錯誤：${invalid}` })}`,
        );
        continue;
      }

      const result = await tool.execute(action.args);
      toolCalls.push({ tool: tool.name, args: action.args, result });
      transcript.push(`（你）：${JSON.stringify(action)}`, `TOOL_RESULT: ${JSON.stringify(result)}`);

      // 工具執行寫回記憶（episodic）— 記憶 × 工具的閉環
      await this.store.remember({
        userId: this.userId,
        context,
        memoryType: "episodic",
        content: `執行了 ${tool.description}（${JSON.stringify(action.args)}）`,
        importance: 0.4,
        createdAt: now,
      });
    }

    return {
      reply: "（操作中斷：連續動作過多，請再說一次你要做什麼）",
      toolCalls,
      turns: MAX_TURNS,
    };
  }
}
