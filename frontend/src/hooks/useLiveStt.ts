import { useCallback, useEffect, useRef, useState } from "react";

/** Live API 即時 STT（走 server 的 /ws/stt relay — 瀏覽器無關、逐字即時、額度獨立）。
 *  麥克風 → AudioWorklet 抓 PCM → 16kHz Int16 → ws binary；server 推回 {interim}/{final}。
 *  VAD 在 Google 端（Live 內建）— 前端不用自己切句。連不上由呼叫端退段落式 useRecorder。 */

// AudioWorklet：Float32 → 轉發 main thread（inline blob，免多一個靜態檔）
const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

function toInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]!));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** 瀏覽器不一定給 16kHz AudioContext — 給多少都收，線性重採樣到 16k */
function resampleTo16k(f32: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16_000) return f32;
  const ratio = fromRate / 16_000;
  const out = new Float32Array(Math.floor(f32.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = f32[Math.floor(i * ratio)]!;
  return out;
}

export interface LiveSttController {
  supported: boolean;
  listening: boolean;
  /** 逐字 interim（講話中即時浮現） */
  interim: string;
  /** ws relay 掛了 — 呼叫端該退段落式 fallback */
  failed: boolean;
  start(): void;
  stop(): void;
  /** TTS 播放期間暫停送音訊 — 不把喇叭裡自己的聲音餵給轉錄 */
  setSuppressed(on: boolean): void;
}

export function useLiveStt(onFinal: (text: string) => void): LiveSttController {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [failed, setFailed] = useState(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const suppressedRef = useRef(false);
  const sessionRef = useRef<{
    ws: WebSocket;
    ctx: AudioContext;
    stream: MediaStream;
    node: AudioWorkletNode | null;
  } | null>(null);

  const stop = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    sessionRef.current = null;
    s.node?.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    void s.ctx.close();
    if (s.ws.readyState === WebSocket.OPEN) s.ws.close(1000);
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(() => {
    if (sessionRef.current || !navigator.mediaDevices?.getUserMedia) return;
    setFailed(false);
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new AudioContext();
        const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
        await ctx.audioWorklet.addModule(URL.createObjectURL(blob));
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/stt`);
        const s = { ws, ctx, stream, node: null as AudioWorkletNode | null };
        sessionRef.current = s;

        ws.onopen = () => {
          const node = new AudioWorkletNode(ctx, "pcm-tap");
          node.port.onmessage = (e) => {
            if (suppressedRef.current || ws.readyState !== WebSocket.OPEN) return;
            const pcm = toInt16(resampleTo16k(e.data as Float32Array, ctx.sampleRate));
            ws.send(pcm.buffer);
          };
          ctx.createMediaStreamSource(stream).connect(node);
          s.node = node;
          setListening(true);
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data as string) as { interim?: string; final?: string };
          if (msg.interim !== undefined) setInterim(msg.interim);
          if (msg.final !== undefined) {
            setInterim("");
            onFinalRef.current(msg.final);
          }
        };
        ws.onerror = ws.onclose = () => {
          // relay 掛了（額度/網路/session TTL）— 標 failed 讓呼叫端退段落式
          if (sessionRef.current === s) {
            setFailed(true);
            stop();
          }
        };
      } catch (err) {
        console.warn("[live-stt]", err);
        setFailed(true);
        stop();
      }
    })();
  }, [stop]);

  const setSuppressed = useCallback((on: boolean) => {
    suppressedRef.current = on;
  }, []);

  useEffect(() => stop, [stop]);

  return {
    supported: typeof AudioWorkletNode !== "undefined" && Boolean(navigator.mediaDevices),
    listening,
    interim,
    failed,
    start,
    stop,
    setSuppressed,
  };
}
