/** Live API STT spike：驗證 (1) generateContent 429 期間 Live API 是否可用（額度分開？）
 *  (2) inputAudioTranscription 能否當即時 STT 用。
 *  跑法：npx tsx scripts/live-stt-spike.ts /tmp/stt-test.pcm  （16kHz mono s16le PCM） */
import { readFileSync } from "node:fs";

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY not set");
const pcm = readFileSync(process.argv[2] ?? "/tmp/stt-test.pcm");

const MODEL = process.env.LIVE_MODEL ?? "models/gemini-2.5-flash-native-audio-latest";
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

const ws = new WebSocket(url);
const timer = setTimeout(() => {
  console.log("TIMEOUT — no transcription within 30s");
  ws.close();
  process.exit(2);
}, 30_000);

ws.onopen = () => {
  console.log("[ws] open — setup", MODEL);
  ws.send(
    JSON.stringify({
      setup: {
        model: MODEL,
        generationConfig: { responseModalities: ["AUDIO"] },
        inputAudioTranscription: {},
      },
    }),
  );
};

let transcript = "";
ws.onmessage = async (ev) => {
  const text = typeof ev.data === "string" ? ev.data : Buffer.from(await (ev.data as Blob).arrayBuffer()).toString();
  const msg = JSON.parse(text) as Record<string, any>;
  if (msg.setupComplete !== undefined) {
    console.log("[ws] setup complete — sending audio", pcm.length, "bytes");
    // 分塊送（模擬串流）
    for (let i = 0; i < pcm.length; i += 16_000) {
      ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: { mimeType: "audio/pcm;rate=16000", data: pcm.subarray(i, i + 16_000).toString("base64") },
          },
        }),
      );
    }
    ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    return;
  }
  const sc = msg.serverContent;
  if (sc?.inputTranscription?.text) {
    transcript += sc.inputTranscription.text;
    console.log("[stt]", JSON.stringify(transcript));
  }
  if (sc?.turnComplete) {
    console.log("RESULT:", JSON.stringify(transcript));
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
};
ws.onerror = () => console.log("[ws] error");
ws.onclose = (ev) => {
  console.log("[ws] closed", ev.code, ev.reason?.slice(0, 200));
  clearTimeout(timer);
  process.exit(transcript ? 0 : 1);
};
