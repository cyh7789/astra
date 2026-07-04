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
  }, [messages.length]);

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
              className="anim-rise flex items-center gap-1 text-[11px] tracking-wide text-[var(--accent-dim)]"
            >
              <ChevronIcon /> {m.text}
            </div>
          ) : (
            <div key={i} className={`anim-rise ${m.role === "user" ? "text-right" : ""}`}>
              {m.toolCalls?.map((t, j) => (
                <div
                  key={j}
                  className="mb-1.5 mr-1 inline-flex items-center gap-1.5 rounded-sm border border-[var(--accent-faint)] bg-[var(--panel)] px-2.5 py-1 text-[11px] text-[var(--accent-dim)]"
                >
                  <span className="text-[var(--accent)]">
                    <WrenchIcon />
                  </span>
                  <span className="text-[var(--ink)]">{t.tool}</span>
                  <span className="opacity-80">{argsPreview(t.args)}</span>
                </div>
              ))}
              <div
                className={`inline-block max-w-[78%] whitespace-pre-wrap rounded-sm px-4 py-2.5 text-left text-[13.5px] leading-relaxed ${
                  m.role === "user"
                    ? "border border-[var(--accent-dim)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
                    : "border border-transparent bg-[color-mix(in_srgb,var(--accent)_13%,var(--panel))] shadow-[0_0_24px_-12px_var(--accent)]"
                }`}
              >
                {m.escalated && (
                  <span
                    className="mr-1.5 inline-flex items-center gap-1 rounded-sm bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--accent)]"
                    title="escalated to cloud model"
                  >
                    <ZapIcon /> cloud
                  </span>
                )}
                {m.text}
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-[11px] text-[var(--accent-dim)]">
            <span className="inline-block h-1.5 w-1.5 animate-ping rounded-full bg-[var(--accent)]" />
            thinking…
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
          className="grow rounded-sm border border-[var(--accent-faint)] bg-[var(--panel)] px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-[var(--accent-faint)] focus:border-[var(--accent)]"
        />
        <button
          onClick={submit}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-sm border border-[var(--accent-dim)] px-4 text-sm text-[var(--accent)] transition-colors hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] disabled:opacity-40"
        >
          <SendIcon />
        </button>
      </div>
    </section>
  );
}
