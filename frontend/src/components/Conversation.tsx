import { useEffect, useRef, useState } from "react";
import type { ToolCall } from "../api.js";

export interface Message {
  role: "user" | "astra" | "system";
  text: string;
  toolCalls?: ToolCall[];
  escalated?: boolean;
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
      <div className="grow space-y-3 overflow-y-auto p-4">
        {messages.map((m, i) =>
          m.role === "system" ? (
            <div key={i} className="text-xs text-[var(--amber-dim)]">
              ▸ {m.text}
            </div>
          ) : (
            <div key={i} className={m.role === "user" ? "text-right" : ""}>
              {m.toolCalls?.map((t, j) => (
                <div key={j} className="mb-1 inline-block border border-[var(--amber-dim)] px-2 py-0.5 text-xs">
                  ⚙ {t.tool}({Object.entries(t.args).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(", ")})
                </div>
              ))}
              <div
                className={`inline-block max-w-[80%] whitespace-pre-wrap px-3 py-2 text-left text-sm ${
                  m.role === "user"
                    ? "border border-[var(--amber-dim)]"
                    : "bg-[color-mix(in_srgb,var(--amber)_12%,transparent)]"
                }`}
              >
                {m.escalated && (
                  <span className="mr-1 text-xs text-[var(--amber-dim)]" title="escalated to cloud model">
                    ⚡
                  </span>
                )}
                {m.text}
              </div>
            </div>
          ),
        )}
        {busy && <div className="animate-pulse text-xs text-[var(--amber-dim)]">…</div>}
        <div ref={bottom} />
      </div>
      <div className="flex gap-2 border-t border-[var(--amber-dim)] p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Talk to ASTRA…"
          className="grow border border-[var(--amber-dim)] bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--amber-dim)] focus:border-[var(--amber)]"
        />
        <button
          onClick={submit}
          disabled={busy}
          className="border border-[var(--amber-dim)] px-4 text-sm hover:border-[var(--amber)] disabled:opacity-40"
        >
          send
        </button>
      </div>
    </section>
  );
}
