import { useCallback, useEffect, useRef, useState } from "react";

/** Server 端 STT 的前端錄音（瀏覽器無關 — Web Speech 只有正版 Chrome 有 Google 服務金鑰）。
 *  MediaRecorder 連續錄、VAD 只決定切點：speech→silence 800ms 就收整段送 /api/stt。
 *  段落從上一個切點開始（含前置靜音），所以字頭零損失；純靜音段每 5 秒丟棄不送。 */

const SPEECH_RMS = 0.03; // 講話門檻（一般麥克風底噪 ~0.003-0.008；0.015 會被冷氣/風扇誤觸）
const SPEECH_MIN_TICKS = 3; // 連續超門檻 300ms 才算真的在講話 — 單發突刺（關門聲、喀噠）不算
const SILENCE_MS = 900; // 講完停這麼久 = 一句結束
const IDLE_ROTATE_MS = 5_000; // 整段都沒人講話就丟棄重錄，避免段落無限長
const SUPPRESS_TAIL_MS = 400; // TTS 結束後喇叭殘響仍在 — suppress 多蓋一小段
const TICK_MS = 100;

export interface RecorderController {
  supported: boolean;
  /** 麥克風開著（免持持續聽 / push-to-talk 錄音中） */
  listening: boolean;
  /** 有段落在 /api/stt 轉錄中 */
  processing: boolean;
  start(opts?: { handsFree?: boolean }): void;
  stop(): void;
  /** TTS 播放期間設 true — 免持不把喇叭裡自己的聲音當使用者輸入 */
  setSuppressed(on: boolean): void;
}

function pickMimeType(): string {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return ""; // 讓瀏覽器自選
}

export function useRecorder(onFinal: (text: string) => void): RecorderController {
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const suppressedRef = useRef(false);
  const suppressedUntilRef = useRef(0);
  // 一次 start 的所有資源掛在同一個 session 物件 — stop/重進場景不留殭屍 track
  interface MicSession {
    stream: MediaStream;
    ctx: AudioContext;
    timer: ReturnType<typeof setInterval> | null;
    rec: MediaRecorder | null;
    stopped: boolean;
  }
  const sessionRef = useRef<MicSession | null>(null);

  const transcribe = useCallback(async (blob: Blob) => {
    setProcessing(true);
    try {
      const res = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      if (!res.ok) throw new Error(`stt ${res.status}`);
      const { text } = (await res.json()) as { text: string };
      if (text) onFinalRef.current(text);
    } catch (err) {
      console.warn("[stt]", err);
    } finally {
      setProcessing(false);
    }
  }, []);

  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    sessionRef.current = null;
    s.stopped = true;
    if (s.timer) clearInterval(s.timer);
    // push-to-talk：放開 = 這句講完，收尾段照送
    if (s.rec && s.rec.state !== "inactive") s.rec.stop();
    s.stream.getTracks().forEach((t) => t.stop());
    void s.ctx.close();
    setListening(false);
  }, []);

  const start = useCallback(
    (opts?: { handsFree?: boolean }) => {
      if (sessionRef.current || !navigator.mediaDevices?.getUserMedia) return;
      const handsFree = opts?.handsFree ?? false;
      const mimeType = pickMimeType();
      void navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          const ctx = new AudioContext();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          ctx.createMediaStreamSource(stream).connect(analyser);
          const buf = new Float32Array(analyser.fftSize);

          const s: MicSession = { stream, ctx, timer: null, rec: null, stopped: false };
          sessionRef.current = s;
          setListening(true);

          let hadSpeech = false;
          let speechTicks = 0;
          let lastSpeechAt = 0;
          let segStart = 0;
          let sendOnStop = false;

          const newSegment = () => {
            const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            const chunks: Blob[] = [];
            rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
            rec.onstop = () => {
              if (sendOnStop && chunks.length > 0) {
                void transcribe(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
              }
              sendOnStop = false;
              // 免持：段落收掉後立刻開下一段；push-to-talk 一次一段
              if (handsFree && !s.stopped) newSegment();
            };
            rec.start();
            s.rec = rec;
            hadSpeech = false;
            speechTicks = 0;
            segStart = performance.now();
          };
          newSegment();

          const rotate = (send: boolean) => {
            if (!s.rec || s.rec.state === "inactive") return;
            sendOnStop = send;
            s.rec.stop();
          };

          // 免持才需要 VAD 切點；push-to-talk 由使用者的 stop() 決定切點
          if (handsFree) {
            s.timer = setInterval(() => {
              analyser.getFloatTimeDomainData(buf);
              let sum = 0;
              for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
              const rms = Math.sqrt(sum / buf.length);
              const now = performance.now();
              const suppressed = suppressedRef.current || now < suppressedUntilRef.current;
              if (rms > SPEECH_RMS && !suppressed) {
                speechTicks++;
                if (speechTicks >= SPEECH_MIN_TICKS) {
                  hadSpeech = true;
                  lastSpeechAt = now;
                }
              } else {
                speechTicks = 0;
              }
              if (hadSpeech && now - lastSpeechAt > SILENCE_MS) rotate(true);
              else if (!hadSpeech && now - segStart > IDLE_ROTATE_MS) rotate(false);
            }, TICK_MS);
          } else {
            sendOnStop = true; // push-to-talk：stop() 收的那段就是要送的
          }
        })
        .catch((err) => {
          console.warn("[recorder] mic denied:", err);
          setListening(false);
        });
    },
    [transcribe],
  );

  const setSuppressed = useCallback((on: boolean) => {
    // 解除時多蓋一段殘響尾巴 — TTS onend 之後喇叭聲還沒完全消
    if (!on && suppressedRef.current) {
      suppressedUntilRef.current = performance.now() + SUPPRESS_TAIL_MS;
    }
    suppressedRef.current = on;
  }, []);

  useEffect(() => stop, [stop]); // unmount 收麥克風

  return {
    supported: typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices),
    listening,
    processing,
    start,
    stop,
    setSuppressed,
  };
}
