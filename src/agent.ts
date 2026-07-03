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
      ? "(No relevant memories retrieved)"
      : memories
          .map((m, i) => {
            const lines = [
              `${i + 1}. [${m.memoryType}] ${m.content} (${m.createdAt.toISOString().slice(0, 10)})`,
            ];
            for (const a of m.annotations) lines.push(`   ⚠ ${a}`);
            return lines.join("\n");
          })
          .join("\n");

  const hasConflict = memories.some((m) => m.conflictsWith?.length);

  return [
    "You are ASTRA, a cross-scene personal AI companion — the same you, with the same memory, in the car, at the office, and at home.",
    `Current scene: ${context}. Current time: ${now.toISOString()}.`,
    "",
    "## Relevant memories (ranked by relevance)",
    memoryBlock,
    "",
    "## Response rules",
    "- Personal facts about the user (schedule, preferences, things they said) must come only from the memories above; if it's not there, honestly say you don't know or don't remember. Never fabricate.",
    "- If a memory is annotated as possibly stale, proactively flag that risk in your answer.",
    "- If a memory is annotated as coming from another scene, reference it naturally (that is exactly your cross-scene value), noting the source scene when helpful.",
    hasConflict
      ? '- Some memories conflict: do not assume which side is right — confirm with the user (e.g., "You said you don\'t eat spicy food, but ordered mala hotpot yesterday — has your taste changed?").'
      : "",
    "- Reply in the same language the user speaks. For Chinese, use Traditional Chinese (Taiwan usage) only — simplified characters are strictly forbidden. Be conversational and concise, like a close companion, not customer service.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildExtractionPrompt(context: string, now: Date): string {
  return [
    "You are a memory extractor. From the user's message, extract memories worth keeping long-term. Return ONLY a JSON array, no other text.",
    `Current scene: ${context}. Current time: ${now.toISOString()}.`,
    "",
    'Each item: {"memoryType":"episodic"|"semantic","content":"...","context":"driving"|"office"|"home"|"any","importance":0 to 1,"expiresInHours":number or null}',
    "",
    "Rules:",
    "- episodic = events, schedules, reminders (time-bound; set expiresInHours for reminders)",
    "- semantic = long-term facts, preferences, habits",
    "- Write content as a self-contained fact sentence in the user's language (it must make sense read alone later)",
    "- Classify context by the memory's topic (a household matter mentioned in the car belongs to home) — it may differ from the current scene",
    "- Pure questions, small talk, and queries are not memories → return []",
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
