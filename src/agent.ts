import type { GuardedMemory } from "./guards.js";
import type { LlmClient } from "./llm.js";
import type { MemoryInput, MemoryStore, MemoryType } from "./store.js";

/** 對話 system prompt：記憶注入 + guard 標注的行為規則。
 *  Hallucination 防線 v0 = prompt 級（個人事實必須有記憶依據）；驗證型 guard 在 Phase 4 後段。 */
export function buildSystemPrompt(
  context: string,
  now: Date,
  memories: GuardedMemory[],
): string {
  const memoryBlock =
    memories.length === 0
      ? "（沒有撈到相關記憶）"
      : memories
          .map((m, i) => {
            const lines = [
              `${i + 1}. [${m.memoryType}] ${m.content}（${m.createdAt.toISOString().slice(0, 10)}）`,
            ];
            for (const a of m.annotations) lines.push(`   ⚠ ${a}`);
            return lines.join("\n");
          })
          .join("\n");

  const hasConflict = memories.some((m) => m.conflictsWith?.length);

  return [
    "你是 ASTRA，跨場景的個人 AI 夥伴 — 車上、辦公室、家裡都是同一個你、同一份記憶。",
    `當前場景：${context}。現在時間：${now.toISOString()}。`,
    "",
    "## 相關記憶（依相關度排序）",
    memoryBlock,
    "",
    "## 回應規則",
    "- 關於使用者的個人事實（行程、偏好、過去說過的話）只能根據上面的記憶回答；記憶裡沒有的就誠實說不知道或不記得，嚴禁編造。",
    "- 記憶標注「可能已過時」時，回答要主動提醒這個時效風險。",
    "- 記憶標注「來自其他場景」時，可以自然引用（這正是你跨場景的價值），必要時說明來源場景。",
    hasConflict
      ? "- 記憶之間有矛盾標注：不要自行假設哪邊是對的，回應中要向使用者確認（例如「你之前說不吃辣，但昨天點了麻辣鍋 — 現在口味有變嗎？」）。"
      : "",
    "- 一律使用繁體中文（台灣用語），嚴禁出現任何簡體字。口語、簡潔，像貼身夥伴不像客服。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildExtractionPrompt(context: string, now: Date): string {
  return [
    "你是記憶萃取器。從使用者這句話抽出值得長期記住的記憶，只回 JSON 陣列、不回任何其他文字。",
    `當前場景：${context}。現在時間：${now.toISOString()}。`,
    "",
    '每筆格式：{"memoryType":"episodic"|"semantic","content":"...","context":"driving"|"office"|"home"|"any","importance":0到1,"expiresInHours":數字或null}',
    "",
    "規則：",
    "- episodic = 事件、行程、提醒（有時間性；提醒類設 expiresInHours）",
    "- semantic = 長期事實、偏好、習慣",
    "- content 寫成獨立完整的事實句（之後單獨讀要能懂）",
    "- context 按記憶主題歸類（車上說的家務事歸 home），與當前場景不同也可以",
    "- 純問句、閒聊、查詢類不是記憶 → 回 []",
  ].join("\n");
}

/** 從 LLM 輸出解析記憶陣列；容錯 ```json fence；解析失敗回空（萃取失敗不該炸對話）。 */
export function parseExtraction(
  raw: string,
  userId: string,
  now: Date,
): MemoryInput[] {
  const stripped = raw.replace(/```json\s*|```\s*/g, "").trim();
  try {
    const arr = JSON.parse(stripped) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x) =>
          (x.memoryType === "episodic" || x.memoryType === "semantic") &&
          typeof x.content === "string" &&
          x.content.length > 0,
      )
      .map((x) => ({
        userId,
        context: typeof x.context === "string" ? x.context : "any",
        memoryType: x.memoryType as MemoryType,
        content: x.content as string,
        importance: typeof x.importance === "number" ? x.importance : undefined,
        expiresAt:
          typeof x.expiresInHours === "number"
            ? new Date(now.getTime() + x.expiresInHours * 3_600_000)
            : undefined,
      }));
  } catch {
    return [];
  }
}

export interface ChatResult {
  reply: string;
  recalled: GuardedMemory[];
  extracted: MemoryInput[];
}

export class AstraAgent {
  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmClient,
    private readonly userId: string,
  ) {}

  async chat(message: string, context: string, now = new Date()): Promise<ChatResult> {
    const recalled = await this.store.recallGuarded({
      userId: this.userId,
      query: message,
      context,
      topK: 5,
      now,
    });

    const reply = await this.llm.complete(buildSystemPrompt(context, now, recalled), message);

    const extractionRaw = await this.llm.complete(buildExtractionPrompt(context, now), message);
    const extracted = parseExtraction(extractionRaw, this.userId, now);
    for (const m of extracted) {
      await this.store.remember(m);
    }

    return { reply, recalled, extracted };
  }
}
