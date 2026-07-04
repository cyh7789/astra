import type { WindowEntry } from "../api.js";

const VIA_COLOR: Record<WindowEntry["via"], string> = {
  pin: "border-[var(--amber)]",
  handoff: "border-emerald-500",
  event: "border-sky-500",
  passive: "border-[var(--amber-dim)]",
  tool: "border-fuchsia-500",
  link: "border-stone-500",
};

/** 記憶窗透明化（demo UI 設計決策 3）：via 徽章 + 分數條 = 評分第一項的可觀測性證據。 */
export function Inspector({ entries }: { entries: WindowEntry[] }) {
  return (
    <div>
      <h2 className="mb-2 text-xs uppercase tracking-widest text-[var(--amber-dim)]">
        memory window（{entries.length}）
      </h2>
      <div className="space-y-2">
        {entries.map((e) => (
          <div key={e.id} className={`border-l-2 pl-2 ${VIA_COLOR[e.via]}`}>
            <div className="flex items-center gap-1 text-[10px] uppercase text-[var(--amber-dim)]">
              <span>{e.via}</span>
              {e.pinned && <span title="pinned">📌</span>}
              <span>· {e.memoryType}</span>
              <span>· {e.context}</span>
            </div>
            <p className="text-xs leading-snug">{e.content}</p>
            <div className="mt-0.5 h-0.5 w-full bg-[color-mix(in_srgb,var(--amber)_15%,transparent)]">
              <div
                className="h-full bg-[var(--amber)]"
                style={{ width: `${Math.min(100, Math.round(e.score * 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
