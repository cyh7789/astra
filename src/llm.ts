import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LlmClient {
  complete(systemPrompt: string, userMessage: string): Promise<string>;
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
