import type { GeoStatus } from "../hooks/useGeo.js";

/** 資料源面板：老實呈現哪些資料是真的、哪些是 mock（阿毛 7/5：誠實比假裝全真更能讓評審理解）。
 *  - 可切的（weather/poi/nav）：有 GPS 才能開 live；手動關 = 強制 mock
 *  - 鎖定的：time 永遠真實、家電/車控永遠 mock（標注真實接口在哪 — Integration Boundary）
 */

export const TOGGLABLE = [
  { key: "weather", label: "Weather", liveNote: "Open-Meteo" },
  { key: "poi", label: "Places (POI)", liveNote: "OpenStreetMap" },
  { key: "nav", label: "Navigation", liveNote: "OSRM + Google Maps" },
] as const;

const LOCKED = [
  { label: "Clock", state: "LIVE", note: "real time" },
  { label: "Calendar", state: "SIM", note: "relative to real clock" },
  { label: "Home devices", state: "MOCK", note: "HomeKit-shaped interface" },
  { label: "Vehicle", state: "MOCK", note: "vehicle SDK interface" },
];

export function DataSources({
  geoStatus,
  disabled,
  onToggle,
}: {
  geoStatus: GeoStatus;
  disabled: Set<string>;
  onToggle: (key: string) => void;
}) {
  const gps = geoStatus === "granted";
  return (
    <div className="space-y-1.5 text-[11px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="tracking-[0.2em] text-[var(--accent-dim)]">DATA SOURCES</span>
        <span className={gps ? "text-[var(--accent)]" : "text-[var(--accent-faint)]"}>
          {gps ? "● GPS" : geoStatus === "pending" ? "… GPS" : "○ no GPS"}
        </span>
      </div>
      {TOGGLABLE.map((s) => {
        const live = gps && !disabled.has(s.key);
        return (
          <button
            key={s.key}
            onClick={() => gps && onToggle(s.key)}
            disabled={!gps}
            title={gps ? "click to toggle" : "grant location permission to go live"}
            className={`flex w-full items-center justify-between rounded-sm border px-2 py-1 text-left transition-colors ${
              live
                ? "border-[var(--accent-dim)] text-[var(--ink)]"
                : "border-[var(--accent-faint)] text-[var(--accent-dim)]"
            } ${gps ? "hover:border-[var(--accent)]" : "cursor-default opacity-70"}`}
          >
            <span>{s.label}</span>
            <span className={live ? "text-[var(--accent)]" : ""}>
              {live ? `LIVE · ${s.liveNote}` : "MOCK"}
            </span>
          </button>
        );
      })}
      {LOCKED.map((s) => (
        <div
          key={s.label}
          className="flex items-center justify-between rounded-sm border border-[var(--accent-faint)] px-2 py-1 text-[var(--accent-dim)] opacity-70"
          title={s.note}
        >
          <span>{s.label}</span>
          <span>
            {s.state} · {s.note}
          </span>
        </div>
      ))}
    </div>
  );
}
