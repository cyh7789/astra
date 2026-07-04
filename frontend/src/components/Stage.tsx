import { useCallback, useEffect, useRef, useState } from "react";
import { createAsciiField, type AsciiField } from "../stage/ascii-field.js";
import type { DeviceRow } from "./DeviceBoard.js";

export interface Announcement {
  /** 單調遞增 — 只有「新到的回覆」才開口（載入還原的歷史不唸） */
  id: number;
  text: string;
}

/** Stage 模式（預設）：字元海 + 小夏說話才浮現 + 字幕 + free-text 輸入列。
 *  語音先走瀏覽器 speechSynthesis（boundary 事件 = 真打點）；UI-3 換 Gemini TTS + AnalyserNode。 */
export function Stage({
  context,
  busy,
  announcement,
  deviceRows,
  onSend,
  onSwitchScene,
  onInspector,
}: {
  context: string;
  busy: boolean;
  announcement: Announcement | null;
  deviceRows: DeviceRow[];
  onSend: (text: string) => void;
  onSwitchScene: (scene: string) => void;
  onInspector: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<AsciiField | null>(null);
  const [subSide, setSubSide] = useState<"left" | "right">("left");
  const [draft, setDraft] = useState("");
  const spokenId = useRef(0);

  useEffect(() => {
    const field = createAsciiField(canvasRef.current!, (p) => setSubSide(p.subSide));
    fieldRef.current = field;
    return () => {
      speechSynthesis.cancel();
      field.destroy();
    };
  }, []);

  useEffect(() => {
    if (!announcement || announcement.id === spokenId.current) return;
    spokenId.current = announcement.id;
    const field = fieldRef.current;
    if (!field) return;
    field.maybeRelocate(); // 完全溶解後才換構圖，講到一半不瞬移
    speechSynthesis.cancel();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let started = false;
    const u = new SpeechSynthesisUtterance(announcement.text);
    u.lang = /[一-鿿]/.test(announcement.text) ? "zh-TW" : "en-US";
    u.rate = 1.05;
    u.onstart = () => {
      started = true;
      field.setSpeaking(true);
    };
    u.onend = u.onerror = () => field.setSpeaking(false);
    u.onboundary = () => field.punch(1); // 每個詞界 = 一記真打點
    speechSynthesis.speak(u);
    // 保底：環境沒有 TTS voice 時 speechSynthesis 靜默失敗 — 用估算時長驅動浮現，字幕不啞場
    timers.push(
      setTimeout(() => {
        if (started) return;
        field.setSpeaking(true);
        timers.push(
          setTimeout(
            () => field.setSpeaking(false),
            Math.min(12_000, 1_800 + announcement.text.length * 140),
          ),
        );
      }, 600),
    );
    return () => timers.forEach(clearTimeout);
  }, [announcement]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text);
  }, [draft, busy, onSend]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0a0806] text-[#e8ddcf]">
      <canvas ref={canvasRef} className="fixed inset-0" />
      <div className="pointer-events-none fixed inset-0 flex flex-col">
        <header className="flex justify-between px-8 py-5 text-xs tracking-[.15em] text-[#8a7d6b]">
          <div className="tracking-[.35em] text-[#d8c9b4]">A S T R A</div>
          <nav className="pointer-events-auto flex gap-3">
            {["driving", "office", "home"].map((s) => (
              <button
                key={s}
                onClick={() => onSwitchScene(s)}
                className={`uppercase ${s === context ? "text-[#f2c184]" : "opacity-45 hover:opacity-80"}`}
              >
                {s === context ? "◉ " : ""}
                {s === "driving" ? "car" : s}
              </button>
            ))}
          </nav>
        </header>

        {announcement && (
          <div
            className="absolute bottom-[24%] w-[min(560px,52vw)] text-[17px] leading-[1.8] text-[#f3e7d3]"
            style={{
              [subSide]: "6%",
              textAlign: subSide,
              textShadow: "0 0 18px #0a0806, 0 0 8px #0a0806",
            }}
          >
            <span className="mb-2 block text-[10px] tracking-[.35em] text-[#9b8a72]">
              ASTRA · {context.toUpperCase()}
            </span>
            <span>{announcement.text}</span>
          </div>
        )}

        <div className="absolute bottom-[70px] left-[6%] flex max-w-[60vw] flex-wrap gap-4 text-[11px] tracking-[.05em] text-[#58503f]">
          {deviceRows.map((r, i) => (
            <span key={i} className="text-[#f2c184]" style={{ textShadow: "0 0 10px #f2c18466" }}>
              [{r.label} {r.value}]
            </span>
          ))}
        </div>

        <div className="absolute bottom-6 left-[6%] flex w-[min(560px,52vw)] gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={busy ? "…" : "Talk to ASTRA…"}
            className="pointer-events-auto grow border border-[#58503f] bg-[#0a0806cc] px-3 py-2 text-sm text-[#f3e7d3] outline-none placeholder:text-[#58503f] focus:border-[#f2c184]"
          />
          <button
            onClick={submit}
            disabled={busy}
            className="pointer-events-auto border border-[#58503f] px-4 text-sm text-[#f2c184] hover:border-[#f2c184] disabled:opacity-40"
          >
            ▸
          </button>
        </div>

        <button
          onClick={onInspector}
          className="pointer-events-auto absolute bottom-[30px] right-8 text-[10px] tracking-[.1em] text-[#58503f] hover:text-[#f2c184]"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mr-1 inline-block align-[-2px]"
          >
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M15 3v18" />
          </svg>
          inspector mode
        </button>
      </div>
    </div>
  );
}
