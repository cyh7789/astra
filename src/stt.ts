/** Server 端語音轉文字 — 瀏覽器無關（Web Speech 只有正版 Chrome 能用，評審體驗不能賭）。
 *  現階段走 Gemini 音訊理解（現有金鑰零部署）；AWS 帳號下來後換 AWS Transcribe，只動這個模組。 */

export type Transcriber = (audio: Buffer, mimeType: string) => Promise<string>;

const TRANSCRIBE_PROMPT =
  "Transcribe this audio verbatim. The speaker uses Taiwanese Mandarin (zh-TW), possibly mixed with English. " +
  "Return ONLY the transcription text — no labels, no punctuation commentary, no translation. " +
  "If the audio contains no intelligible speech, return an empty string.";

export function createGeminiTranscriber(
  model = process.env.GEMINI_STT_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
  apiKey = process.env.GEMINI_API_KEY,
): Transcriber {
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  return async (audio, mimeType) => {
    // STT 是互動路徑，退避比 GeminiClient 短（demo 裡等 10 秒不如失敗重講）
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          signal: AbortSignal.timeout(15_000), // 卡住會讓前端永遠停在 transcribing…
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: TRANSCRIBE_PROMPT },
                  { inlineData: { mimeType, data: audio.toString("base64") } },
                ],
              },
            ],
          }),
        },
      );
      if ([429, 500, 503].includes(res.status) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1_500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`gemini stt failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      };
      return (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("")
        .trim();
    }
  };
}
