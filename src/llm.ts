import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LlmClient {
  complete(systemPrompt: string, userMessage: string): Promise<string>;
}

/** Gemini free tier client：eval 迴歸與記憶萃取用（免費、量大）。 */
export class GeminiClient implements LlmClient {
  private readonly apiKey: string;

  constructor(
    private readonly model = "gemini-2.5-flash",
    apiKey = process.env.GEMINI_API_KEY,
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    this.apiKey = apiKey;
  }

  async complete(systemPrompt: string, userMessage: string): Promise<string> {
    // free tier 限流常態：429 等 20s 重試最多兩次，不夠再說
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
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 20_000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`gemini failed: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return parts.map((p) => p.text ?? "").join("").trim();
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
