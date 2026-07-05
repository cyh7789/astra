/** Gemini Live API 即時 STT session（spike 驗證：scripts/live-stt-spike.ts）。
 *  - 額度與 generateContent 分開（7/5 實測：429 期間 Live 照通）— demo 日語音不受對話額度影響
 *  - inputAudioTranscription = 原語言逐字轉錄；模型自己的語音回應直接丟棄
 *  - Live 內建 VAD：使用者講完自動 turn → turnComplete 就是句子邊界 */

const LIVE_MODEL = process.env.LIVE_STT_MODEL ?? "models/gemini-2.5-flash-native-audio-latest";

export interface LiveSttSession {
  sendPcm(chunk: Buffer): void;
  /** push-to-talk 放開：宣告這段音訊結束（免持模式靠內建 VAD，不用呼叫） */
  endAudio(): void;
  close(): void;
}

export interface LiveSttHandlers {
  /** 逐字累積的 interim 轉錄（同一句內每次都是「目前為止的全文」） */
  onInterim(text: string): void;
  /** 一句結束（turnComplete）— text 為整句 */
  onFinal(text: string): void;
  onClose(reason: string): void;
}

export function openLiveStt(handlers: LiveSttHandlers, apiKey = process.env.GEMINI_API_KEY): LiveSttSession {
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
  const ws = new WebSocket(url);
  let ready = false;
  const pending: string[] = []; // setup 完成前先排隊，別丟音訊
  let sentence = "";

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        setup: {
          model: LIVE_MODEL,
          generationConfig: { responseModalities: ["AUDIO"] },
          // 模型的回應我們不用 — 叫它極簡輸出，省時省量
          systemInstruction: { parts: [{ text: "You are a transcription tap. Always reply with just 'ok'." }] },
          inputAudioTranscription: {},
        },
      }),
    );
  };

  ws.onmessage = async (ev) => {
    const raw =
      typeof ev.data === "string" ? ev.data : Buffer.from(await (ev.data as Blob).arrayBuffer()).toString();
    const msg = JSON.parse(raw) as {
      setupComplete?: unknown;
      serverContent?: {
        inputTranscription?: { text?: string };
        turnComplete?: boolean;
      };
    };
    if (msg.setupComplete !== undefined) {
      if (process.env.STT_DEBUG) console.log("[live-stt] setup complete, flushing", pending.length);
      ready = true;
      for (const p of pending.splice(0)) ws.send(p);
      return;
    }
    const sc = msg.serverContent;
    if (sc?.inputTranscription?.text) {
      sentence += sc.inputTranscription.text;
      handlers.onInterim(sentence.trim());
    }
    if (sc?.turnComplete) {
      const text = sentence.trim();
      sentence = "";
      if (text) handlers.onFinal(text);
    }
  };

  ws.onerror = () => handlers.onClose("error");
  ws.onclose = (ev) => {
    if (process.env.STT_DEBUG) console.log("[live-stt] upstream closed", ev.code, ev.reason);
    handlers.onClose(`closed ${ev.code}`);
  };

  const send = (payload: string) => {
    // setup 完成前（含上游還在 CONNECTING）一律排隊 — 早到的音訊不能丟
    if (ready && ws.readyState === WebSocket.OPEN) ws.send(payload);
    else if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      pending.push(payload);
    }
  };

  return {
    sendPcm: (chunk) =>
      send(
        JSON.stringify({
          realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: chunk.toString("base64") } },
        }),
      ),
    endAudio: () => send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })),
    close: () => ws.close(),
  };
}
