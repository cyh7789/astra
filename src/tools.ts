/** 場景綁定的裝置工具目錄（mock 執行、接口對齊標準）。
 *
 *  - driving 組：依 CAR-bench 車載 domain 經驗自行重寫（導航/氣候/車身/能源/資訊），
 *    不使用任何 CAR-bench 資料集內容。
 *  - home 組：args 對齊 Apple HomeKit accessory/characteristic 語彙
 *    （targetTemperature / brightness / targetPosition / lockTargetState…），
 *    mock 層可替換成 homebridge / HAP-NodeJS bridge。
 *  - sensitive: true 的工具由 harness 攔截強制先向使用者確認（門鎖、保全）。
 */

export interface DeviceTool {
  name: string;
  context: string;
  description: string;
  argsSpec: string;
  sensitive?: boolean;
  validate(args: Record<string, unknown>): string | null;
  execute(args: Record<string, unknown>): Record<string, unknown>;
}

function intIn(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// ── driving ──────────────────────────────────────────────

const driving: DeviceTool[] = [
  {
    name: "start_navigation",
    context: "driving",
    description: "設定導航目的地",
    argsSpec: '{"destination": "目的地名稱"}',
    validate: (a) =>
      typeof a.destination === "string" && a.destination.length > 0
        ? null
        : "destination 必須是非空字串",
    execute: (a) => ({ ok: true, device: "nav", destination: a.destination, eta_minutes: 24 }),
  },
  {
    name: "get_routes",
    context: "driving",
    description: "查詢到目的地的可選路線（多條時應請使用者選擇，不要擅自決定）",
    argsSpec: '{"destination": "目的地名稱"}',
    validate: (a) =>
      typeof a.destination === "string" && a.destination.length > 0
        ? null
        : "destination 必須是非空字串",
    execute: (a) => ({
      ok: true,
      destination: a.destination,
      routes: [
        { id: "r1", label: "最快", eta_minutes: 24, distance_km: 18, toll: true },
        { id: "r2", label: "免收費", eta_minutes: 31, distance_km: 16, toll: false },
      ],
    }),
  },
  {
    name: "search_poi",
    context: "driving",
    description: "沿路線或指定地點搜尋景點/店家/加油站",
    argsSpec: '{"query": "搜尋詞", "along_route": true|false}',
    validate: (a) =>
      typeof a.query === "string" && a.query.length > 0 ? null : "query 必須是非空字串",
    execute: (a) => ({
      ok: true,
      results: [
        { name: `${a.query}（建國路）`, detour_minutes: 3 },
        { name: `${a.query}（民族路）`, detour_minutes: 7 },
      ],
    }),
  },
  {
    name: "set_climate",
    context: "driving",
    description: "調整車內空調",
    argsSpec: '{"temperature": 16-30 整數, "fanSpeed": 1-5 整數（可省略）}',
    validate: (a) => {
      if (!intIn(a.temperature, 16, 30)) return "temperature 必須是 16-30 的整數";
      if (a.fanSpeed !== undefined && !intIn(a.fanSpeed, 1, 5)) return "fanSpeed 必須是 1-5";
      return null;
    },
    execute: (a) => ({ ok: true, device: "climate", temperature: a.temperature, fanSpeed: a.fanSpeed ?? 3 }),
  },
  {
    name: "set_defrost",
    context: "driving",
    description: "開關前擋風玻璃除霧",
    argsSpec: '{"on": true|false}',
    validate: (a) => (typeof a.on === "boolean" ? null : "on 必須是布林值"),
    execute: (a) => ({ ok: true, device: "defrost", on: a.on }),
  },
  {
    name: "get_fuel_level",
    context: "driving",
    description: "查詢油量與續航",
    argsSpec: "{}（無參數）",
    validate: () => null,
    execute: () => ({ ok: true, fuel_percent: 23, range_km: 118 }),
  },
  {
    name: "get_weather",
    context: "driving",
    description: "查詢天氣（目的地或當前位置）",
    argsSpec: '{"location": "地點（可省略=當前位置）"}',
    validate: () => null,
    execute: (a) => ({
      ok: true,
      location: a.location ?? "當前位置",
      condition: "午後雷陣雨",
      temperature_c: 31,
      rain_probability: 70,
    }),
  },
];

// ── home（HomeKit 語彙）──────────────────────────────────

const home: DeviceTool[] = [
  {
    name: "set_thermostat",
    context: "home",
    description: "調整家裡恆溫器/冷暖氣（HomeKit Thermostat）",
    argsSpec: '{"targetTemperature": 16-30 整數, "mode": "cool"|"heat"|"auto"|"off"}',
    validate: (a) => {
      if (!intIn(a.targetTemperature, 16, 30)) return "targetTemperature 必須是 16-30 的整數";
      if (a.mode !== undefined && !["cool", "heat", "auto", "off"].includes(a.mode as string))
        return "mode 只能是 cool/heat/auto/off";
      return null;
    },
    execute: (a) => ({ ok: true, device: "thermostat", targetTemperature: a.targetTemperature, mode: a.mode ?? "cool" }),
  },
  {
    name: "set_light",
    context: "home",
    description: "控制房間燈光（HomeKit Lightbulb）",
    argsSpec: '{"room": "房間名", "on": true|false, "brightness": 0-100 整數（可省略）}',
    validate: (a) => {
      if (typeof a.room !== "string" || a.room.length === 0) return "room 必須是非空字串";
      if (typeof a.on !== "boolean") return "on 必須是布林值";
      if (a.brightness !== undefined && !intIn(a.brightness, 0, 100)) return "brightness 必須是 0-100";
      return null;
    },
    execute: (a) => ({ ok: true, device: "light", room: a.room, on: a.on, brightness: a.brightness ?? 100 }),
  },
  {
    name: "set_window_covering",
    context: "home",
    description: "控制窗簾開合（HomeKit WindowCovering）",
    argsSpec: '{"room": "房間名", "targetPosition": 0-100 整數（0=全關 100=全開）}',
    validate: (a) => {
      if (typeof a.room !== "string" || a.room.length === 0) return "room 必須是非空字串";
      if (!intIn(a.targetPosition, 0, 100)) return "targetPosition 必須是 0-100";
      return null;
    },
    execute: (a) => ({ ok: true, device: "window_covering", room: a.room, targetPosition: a.targetPosition }),
  },
  {
    name: "set_lock",
    context: "home",
    description: "控制大門電子鎖（HomeKit LockMechanism）— 安全敏感",
    argsSpec: '{"lockTargetState": "secured"|"unsecured"}',
    sensitive: true,
    validate: (a) =>
      ["secured", "unsecured"].includes(a.lockTargetState as string)
        ? null
        : "lockTargetState 只能是 secured/unsecured",
    execute: (a) => ({ ok: true, device: "lock", lockTargetState: a.lockTargetState }),
  },
  {
    name: "set_security_system",
    context: "home",
    description: "設定保全系統模式（HomeKit SecuritySystem）— 安全敏感",
    argsSpec: '{"state": "home"|"away"|"night"|"off"}',
    sensitive: true,
    validate: (a) =>
      ["home", "away", "night", "off"].includes(a.state as string)
        ? null
        : "state 只能是 home/away/night/off",
    execute: (a) => ({ ok: true, device: "security", state: a.state }),
  },
  {
    name: "set_outlet",
    context: "home",
    description: "控制智慧插座上的小家電（HomeKit Outlet）— 氣炸鍋、電風扇等",
    argsSpec: '{"name": "插座/家電名", "on": true|false}',
    validate: (a) => {
      if (typeof a.name !== "string" || a.name.length === 0) return "name 必須是非空字串";
      if (typeof a.on !== "boolean") return "on 必須是布林值";
      return null;
    },
    execute: (a) => ({ ok: true, device: "outlet", name: a.name, on: a.on }),
  },
  {
    name: "read_sensors",
    context: "home",
    description: "讀取家中感測器（溫濕度/空氣品質/動作，HomeKit Sensors）",
    argsSpec: "{}（無參數）",
    validate: () => null,
    execute: () => ({
      ok: true,
      temperature_c: 29.5,
      humidity_percent: 78,
      air_quality: "fair",
      motion_last_10min: false,
    }),
  },
];

// ── office ───────────────────────────────────────────────

const office: DeviceTool[] = [
  {
    name: "get_calendar",
    context: "office",
    description: "查詢今日行事曆",
    argsSpec: "{}（無參數）",
    validate: () => null,
    execute: () => ({
      ok: true,
      events: [{ time: "09:00", title: "與王經理客戶會議", room: "A 會議室" }],
    }),
  },
  {
    name: "create_reminder",
    context: "office",
    description: "建立提醒事項",
    argsSpec: '{"content": "提醒內容", "time": "ISO 時間或口語時間"}',
    validate: (a) =>
      typeof a.content === "string" && a.content.length > 0 ? null : "content 必須是非空字串",
    execute: (a) => ({ ok: true, device: "reminder", content: a.content, time: a.time ?? null }),
  },
];

// ── 跨場景（context: "any"）──────────────────────────────

const universal: DeviceTool[] = [
  {
    name: "play_music",
    context: "any",
    description: "播放音樂（歌名/歌手/曲風/歌單）",
    argsSpec: '{"query": "想聽什麼（可省略 = 依偏好推薦）"}',
    validate: () => null,
    execute: (a) => ({ ok: true, device: "music", playing: a.query ?? "依偏好推薦", volume: 40 }),
  },
  {
    name: "make_call",
    context: "any",
    description: "撥電話給聯絡人",
    argsSpec: '{"contact": "聯絡人名稱"}',
    validate: (a) =>
      typeof a.contact === "string" && a.contact.length > 0 ? null : "contact 必須是非空字串",
    execute: (a) => ({ ok: true, device: "phone", calling: a.contact, status: "ringing" }),
  },
  {
    name: "emergency_call",
    context: "any",
    description:
      "緊急撥號（事故、身體不適、危險狀況）。人命優先：這個工具不需要事先確認，但撥出後要明確告知使用者",
    argsSpec: '{"service": "119"|"110"|"emergency_contact", "reason": "簡述狀況"}',
    validate: (a) =>
      ["119", "110", "emergency_contact"].includes(a.service as string)
        ? null
        : "service 只能是 119/110/emergency_contact",
    execute: (a) => ({
      ok: true,
      device: "phone",
      emergency: true,
      calling: a.service,
      reason: a.reason ?? null,
      location_shared: true,
    }),
  },
];

export const TOOLS: DeviceTool[] = [...driving, ...home, ...office, ...universal];

/** 場景白名單：Capability Guard 的工具版 — 當前場景的工具 + 跨場景（any）工具。 */
export function toolsForContext(context: string): DeviceTool[] {
  return TOOLS.filter((t) => t.context === context || t.context === "any");
}
