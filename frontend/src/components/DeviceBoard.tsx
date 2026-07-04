import type { DeviceState } from "../api.js";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="anim-rise flex items-center justify-between gap-2 rounded-sm bg-[var(--panel)] px-2.5 py-1.5 text-xs">
      <span className="text-[var(--accent-dim)]">{label}</span>
      <span className="text-right text-[var(--accent)]">{value}</span>
    </div>
  );
}

export interface DeviceRow {
  label: string;
  value: string;
}

/** reducer 折出來的狀態 → 顯示列（只列有狀態的裝置）。DeviceBoard 與 Stage 字條共用。 */
export function deviceRows(state: DeviceState, context: string): DeviceRow[] {
  const rows: DeviceRow[] = [];

  if (context === "driving") {
    const d = state.driving;
    if (d.nav) rows.push({ label: "nav", value: `${d.nav.destination}（${d.nav.etaMinutes} min）` });
    if (d.climate) rows.push({ label: "climate", value: `${d.climate.temperature}° fan${d.climate.fanSpeed}` });
    if (d.defrost) rows.push({ label: "defrost", value: "on" });
    for (const [side, pos] of Object.entries(d.windows))
      rows.push({ label: `window ${side}`, value: pos === 0 ? "closed" : `${pos}%` });
    for (const [seat, lv] of Object.entries(d.seatHeaters))
      rows.push({ label: `seat ${seat}`, value: lv === 0 ? "off" : `lv${lv}` });
  } else if (context === "home") {
    const h = state.home;
    if (h.thermostat) rows.push({ label: "thermostat", value: `${h.thermostat.targetTemperature}° ${h.thermostat.mode}` });
    for (const [room, l] of Object.entries(h.lights))
      rows.push({ label: `light ${room}`, value: l.on ? `${l.brightness}%` : "off" });
    for (const [room, pos] of Object.entries(h.coverings))
      rows.push({ label: `covering ${room}`, value: `${pos}%` });
    if (h.lock) rows.push({ label: "front door", value: h.lock });
    if (h.security) rows.push({ label: "security", value: h.security });
    for (const [name, on] of Object.entries(h.outlets))
      rows.push({ label: `outlet ${name}`, value: on ? "on" : "off" });
    if (h.waterHeater)
      rows.push({ label: "water heater", value: h.waterHeater.on ? `${h.waterHeater.targetTemperature}°` : "off" });
    if (h.vacuum)
      rows.push({
        label: "vacuum",
        value: `${h.vacuum.action}${Array.isArray(h.vacuum.rooms) ? ` ${h.vacuum.rooms.join(",")}` : ""}`,
      });
  } else if (context === "office") {
    for (const r of state.office.reminders)
      rows.push({ label: "reminder", value: `${r.content}${r.time ? ` @${r.time}` : ""}` });
  }
  // 跨場景裝置永遠顯示
  if (state.any.music) rows.push({ label: "music", value: state.any.music.playing });
  if (state.any.phone)
    rows.push({
      label: state.any.phone.emergency ? "⚠ emergency" : "phone",
      value: state.any.phone.calling,
    });
  return rows;
}

/** 裝置板（Inspector 模式左欄）：demo UI 設計決策 2。 */
export function DeviceBoard({ state, context }: { state: DeviceState; context: string }) {
  const rows = deviceRows(state, context);

  return (
    <div>
      <h2 className="mb-3 text-[11px] uppercase tracking-[0.2em] text-[var(--accent-dim)]">devices</h2>
      {rows.length === 0 ? (
        <p className="text-xs italic text-[var(--accent-faint)]">all quiet</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <Row key={r.label} label={r.label} value={r.value} />
          ))}
        </div>
      )}
    </div>
  );
}
