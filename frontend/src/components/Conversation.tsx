import { useEffect, useRef, useState } from "react";
import type { ToolCall } from "../api.js";
import { ChevronIcon, SendIcon, WrenchIcon, ZapIcon } from "./icons.js";

export interface Message {
  role: "user" | "astra" | "system";
  text: string;
  toolCalls?: ToolCall[];
  escalated?: boolean;
}

function argsPreview(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

/** 小夏頭像：立繪頭部裁切 — 對話流裡「她」的存在感。 */
function Avatar() {
  return (
    <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full ring-1 ring-[var(--accent-dim)]">
      <img src="/xiaoxia.png" alt="" className="h-16 w-8 object-cover object-top" />
    </div>
  );
}

function AstraBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-chat inline-block max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-tl-md bg-[color-mix(in_srgb,var(--accent)_14%,var(--panel))] px-4 py-2.5 text-left text-[14px] leading-relaxed shadow-[0_2px_20px_-8px_color-mix(in_srgb,var(--accent)_45%,transparent)]">
      {children}
    </div>
  );
}

/** 對話流 + free-text 輸入列（評審保底：不開麥克風也能玩）。 */
export function Conversation({
  messages,
  busy,
  onSend,
}: {
  messages: Message[];
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, busy]);

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text);
  }

  return (
    <section className="flex min-h-0 flex-col">
      <div className="grow space-y-4 overflow-y-auto px-6 py-5">
        {messages.map((m, i) =>
          m.role === "system" ? (
            <div
              key={i}
              className="anim-rise flex items-center gap-1 pl-11 text-[11px] tracking-wide text-[var(--accent-dim)]"
            >
              <ChevronIcon /> {m.text}
            </div>
          ) : m.role === "user" ? (
            <div key={i} className="anim-rise text-right">
              <div className="font-chat inline-block max-w-[78%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-[color-mix(in_srgb,var(--accent-dim)_60%,transparent)] bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-4 py-2.5 text-left text-[14px] leading-relaxed">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="anim-rise flex items-start gap-3">
              <Avatar />
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-[var(--accent-dim)]">
                  astra
                  {m.escalated && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] px-1.5 py-px text-[9px] text-[var(--accent)]"
                      title="escalated to cloud model"
                    >
                      <ZapIcon /> cloud
                    </span>
                  )}
                </div>
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {m.toolCalls.map((t, j) => (
                      <span
                        key={j}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--accent-faint)] bg-[var(--panel)] px-2.5 py-1 text-[11px] text-[var(--accent-dim)]"
                      >
                        <span className="text-[var(--accent)]">
                          <WrenchIcon />
                        </span>
                        <span className="text-[var(--ink)]">{t.tool}</span>
                        <span className="opacity-80">{argsPreview(t.args)}</span>
                      </span>
                    ))}
                  </div>
                )}
                <AstraBubble>{m.text}</AstraBubble>
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="anim-rise flex items-start gap-3">
            <Avatar />
            <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-tl-md bg-[color-mix(in_srgb,var(--accent)_14%,var(--panel))] px-4 py-3">
              {[0, 1, 2].map((k) => (
                <span key={k} className="typing-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              ))}
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="flex gap-2 border-t border-[var(--accent-faint)] p-4">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Talk to ASTRA…"
          className="font-chat grow rounded-full border border-[var(--accent-faint)] bg-[var(--panel)] px-4 py-2.5 text-sm outline-none transition-colors placeholder:text-[var(--accent-faint)] focus:border-[var(--accent)]"
        />
        <button
          onClick={submit}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full border border-[var(--accent-dim)] px-4 text-sm text-[var(--accent)] transition-colors hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] disabled:opacity-40"
        >
          <SendIcon />
        </button>
      </div>
    </section>
  );
}
