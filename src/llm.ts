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

/** AWS Bedrock client：SigV4 自簽，不拉 SDK（省 bundle、部署零額外相依）。
 *  介面與 GeminiClient 相同，prompt 完全不動，只換 client。 */
export class BedrockClient implements LlmClient {
  constructor(
    private readonly modelId = process.env.BEDROCK_MODEL_ID ?? "google.gemma-4-31b",
    private readonly region = process.env.AWS_REGION ?? "us-east-1",
    private readonly accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "",
    private readonly secretKey = process.env.AWS_SECRET_ACCESS_KEY ?? "",
    private readonly sessionToken = process.env.AWS_SESSION_TOKEN,
  ) {
    if (!this.accessKeyId || !this.secretKey) {
      throw new Error("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set");
    }
  }

  /** Gemma 4 只在 bedrock-mantle 端點供應，走 OpenAI 相容的 /responses；
   *  其餘模型走標準 bedrock-runtime 的 /converse。兩者請求與回應格式不同。 */
  private get isMantle(): boolean {
    return this.modelId.startsWith("google.gemma-4");
  }

  async complete(systemPrompt: string, userMessage: string): Promise<string> {
    const mantle = this.isMantle;
    const host = mantle
      ? `bedrock-mantle.${this.region}.api.aws`
      : `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = mantle
      ? "/openai/v1/responses"
      : `/model/${this.modelId}/converse`;
    // /converse 的 canonical URI 要求 model id 的冒號編成 %3A，請求路徑則不編碼
    const canonicalPath = mantle
      ? path
      : `/model/${encodeURIComponent(this.modelId)}/converse`;
    const body = mantle
      ? JSON.stringify({
          model: this.modelId,
          instructions: systemPrompt,
          input: userMessage,
          max_output_tokens: 2048,
        })
      : JSON.stringify({
          system: [{ text: systemPrompt }],
          messages: [{ role: "user", content: [{ text: userMessage }] }],
          inferenceConfig: { maxTokens: 2048, temperature: 0.7 },
        });

    const maxRetries = Number(process.env.BEDROCK_RETRIES ?? 3);
    for (let attempt = 0; ; attempt++) {
      const headers = await signV4({
        method: "POST", host, path: canonicalPath, body, region: this.region, service: "bedrock",
        accessKeyId: this.accessKeyId, secretKey: this.secretKey, sessionToken: this.sessionToken,
      });
      const res = await fetch(`https://${host}${path}`, { method: "POST", headers, body });

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`bedrock failed: ${res.status} ${await res.text()}`);

      const data = (await res.json()) as Record<string, any>;
      if (mantle) {
        // /responses：output 陣列裡取 final_answer 的 output_text（過濾推理階段）
        const msgs = (data.output ?? []) as Array<{ phase?: string; content?: Array<{ type?: string; text?: string }> }>;
        return msgs
          .filter((m) => m.phase !== "reasoning")
          .flatMap((m) => m.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("")
          .trim();
      }
      return ((data.output?.message?.content ?? []) as Array<{ text?: string }>)
        .map((c) => c.text ?? "").join("").trim();
    }
  }
}

/** SigV4 簽章（Node 內建 crypto，零相依）。 */
async function signV4(o: {
  method: string; host: string; path: string; body: string;
  region: string; service: string;
  accessKeyId: string; secretKey: string; sessionToken?: string;
}): Promise<Record<string, string>> {
  const { createHash, createHmac } = await import("node:crypto");
  const sha256 = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
  const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256(o.body);
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    host: o.host,
    "x-amz-date": amzDate,
  };
  if (o.sessionToken) baseHeaders["x-amz-security-token"] = o.sessionToken;

  const signedHeaders = Object.keys(baseHeaders).sort().join(";");
  const canonicalHeaders = Object.keys(baseHeaders).sort()
    .map((k) => `${k}:${baseHeaders[k]}\n`).join("");
  const canonicalRequest =
    `${o.method}\n${o.path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/${o.region}/${o.service}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;

  let key: Buffer = hmac(`AWS4${o.secretKey}`, dateStamp);
  for (const part of [o.region, o.service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  return {
    ...baseHeaders,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** 開發用 LLM：claude CLI headless（訂閱 quota、零 key）。 */
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
