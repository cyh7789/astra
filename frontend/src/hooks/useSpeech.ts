import { useCallback, useEffect, useRef, useState } from "react";

/** Web Speech API 語音偵測（零部署零成本；品質要求低 — 使用者看得到轉錄可修正）。
 *  push-to-talk：一段話結束回 final 停止；continuous（driving 免持）：靜音自動重啟持續聽。 */

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

const RecognitionCtor = (
  globalThis as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  }
).SpeechRecognition ??
  (globalThis as unknown as { webkitSpeechRecognition?: new () => RecognitionLike })
    .webkitSpeechRecognition;

export interface SpeechController {
  supported: boolean;
  listening: boolean;
  /** 即時轉錄（未定稿）— 顯示在輸入列讓使用者看得到 */
  interim: string;
  start(opts?: { continuous?: boolean }): void;
  stop(): void;
}

export function useSpeech(onFinal: (text: string) => void, lang = "zh-TW"): SpeechController {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recRef = useRef<RecognitionLike | null>(null);
  const wantContinuous = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    wantContinuous.current = false;
    recRef.current?.abort();
    recRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(
    (opts?: { continuous?: boolean }) => {
      if (!RecognitionCtor || recRef.current) return;
      const rec = new RecognitionCtor();
      recRef.current = rec;
      wantContinuous.current = opts?.continuous ?? false;
      rec.lang = lang;
      rec.continuous = wantContinuous.current;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let interimText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]!;
          if (r.isFinal) onFinalRef.current(r[0].transcript.trim());
          else interimText += r[0].transcript;
        }
        setInterim(interimText);
      };
      rec.onend = () => {
        setInterim("");
        // 免持：Chrome 靜音一段時間會自己停 — 還想聽就重啟
        if (wantContinuous.current && recRef.current === rec) {
          try {
            rec.start();
            return;
          } catch {
            /* 重啟失敗（分頁背景化等）→ 落到停止 */
          }
        }
        if (recRef.current === rec) {
          recRef.current = null;
          setListening(false);
        }
      };
      rec.onerror = (e) => {
        // 權限被拒 / 無音訊裝置：不重啟，安靜退場（輸入列照常可打字）
        if (e.error === "not-allowed" || e.error === "audio-capture") {
          wantContinuous.current = false;
        }
      };
      try {
        rec.start();
        setListening(true);
      } catch {
        recRef.current = null;
      }
    },
    [lang],
  );

  useEffect(() => stop, [stop]); // unmount 收麥克風

  return { supported: Boolean(RecognitionCtor), listening, interim, start, stop };
}
