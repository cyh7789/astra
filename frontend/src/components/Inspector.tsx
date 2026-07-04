import type { WindowEntry } from "../api.js";
import { PinIcon } from "./icons.js";

/** via 徽章：每條進窗路徑一個色相 — 記憶怎麼進來的一眼可辨。 */
const VIA_STYLE: Record<WindowEntry["via"], { border: string; chip: string }> = {
  pin: { border: "border-[var(--accent)]", chip: "bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] text-[var(--accent)]" },
  handoff: { border: "border-emerald-400/70", chip: "bg-emerald-400/15 text-emerald-300" },
  event: { border: "border-sky-400/70", chip: "bg-sky-400/15 text-sky-300" },
  passive: { border: "border-[var(--accent-dim)]", chip: "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent-dim)]" },
  tool: { border: "border-fuchsia-400/70", chip: "bg-fuchsia-400/15 text-fuchsia-300" },
  link: { border: "border-stone-400/60", chip: "bg-stone-400/15 text-stone-400" },
};

/** 記憶窗透明化（demo UI 設計決策 3）：via 徽章 + 分數條 = 評分第一項的可觀測性證據。 */
export function Inspector({ entries }: { entries: WindowEntry[] }) {
  return (
    <div>
      <h2 className="mb-3 text-[11px] uppercase tracking-[0.2em] text-[var(--accent-dim)]">
        memory window
        <span className="ml-2 rounded-sm bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] px-1.5 text-[var(--accent)]">
          {entries.length}
        </span>
      </h2>
      <div className="space-y-2.5">
        {entries.map((e) => {
          const s = VIA_STYLE[e.via];
          return (
            <div
              key={e.id}
              className={`anim-slide rounded-sm border-l-2 bg-[var(--panel)] py-2 pl-3 pr-2 ${s.border}`}
            >
              <div className="mb-1 flex items-center gap-1.5 text-[9.5px] uppercase tracking-wider">
                <span className={`rounded-sm px-1.5 py-px ${s.chip}`}>{e.via}</span>
                {e.pinned && (
                  <span className="text-[var(--accent)]" title="pinned">
                    <PinIcon />
                  </span>
                )}
                <span className="text-[var(--accent-faint)]">
                  {e.memoryType} · {e.context}
                </span>
              </div>
              <p className="text-xs leading-snug text-[var(--ink)]">{e.content}</p>
              <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[var(--accent-dim)] to-[var(--accent)] transition-[width] duration-500"
                  style={{ width: `${Math.min(100, Math.round(e.score * 100))}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
