import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LlmClient {
  complete(systemPrompt: string, userMessage: string): Promise<string>;
}

/** Gemini free tier client：eval 迴歸與記憶萃取用（免費、量大）。 */
export class GeminiClient implements LlmClient {
  private readonly apiKey: string;

  // 預設 3.1-flash-lite：free tier 額度最寬、行為約束驗證夠用（GEMINI_MODEL 可切 gemini-3.5-flash）
  constructor(
    private readonly model = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
    apiKey = process.env.GEMINI_API_KEY,
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    this.apiKey = apiKey;
  }

  async complete(systemPrompt: string, userMessage: string): Promise<string> {
    // free tier 限流/500 風暴常態：指數退避 10s→20s→40s→80s（連續轟炸時段 2×20s 扛不住，
    // 7/5 穩定性 eval 驗屍實證）。GEMINI_RETRIES 可調。
    const maxRetries = Number(process.env.GEMINI_RETRIES ?? 4);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: userMessage }] }],
          }),
        },
      );
      // 429 = 限流、503 = 高需求、500 = 服務端暫時錯誤 — 指數退避重試
      if ([429, 500, 503].includes(res.status) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 10_000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(`gemini failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        }>;
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      // Gemma/thinking 模型會回 thought parts（推理過程），只取答案
      return parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("")
        .trim();
    }
  }
}

/** 開發用 LLM：claude CLI headless（訂閱 quota、零 key）。
 *  提交版換 Bedrock 上的 Claude（BedrockLlmClient）— prompt 不變、只換 client。 */
export class ClaudeCliClient implements LlmClient {
  constructor(private readonly model = "haiku") {}

  async complete(systemPrompt: string, userMessage: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "claude",
      ["-p", "--model", this.model, "--system-prompt", systemPrompt, userMessage],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  }
}
