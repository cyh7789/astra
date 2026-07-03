/** 場景綁定的裝置工具目錄（mock 執行、接口對齊標準）。
 *
 *  - driving 組：依車載 domain 經驗自行設計（導航/氣候/車身/能源/資訊）。
 *  - home 組：args 對齊 Apple HomeKit accessory/characteristic 語彙
 *    （targetTemperature / brightness / targetPosition / lockTargetState…），
 *    mock 層可替換成 homebridge / HAP-NodeJS bridge。
 *  - sensitive: true 的工具由 harness 攔截強制先向使用者確認（門鎖、保全）。
 *  - 模型可見字串（description/argsSpec/驗證錯誤）一律英文（system prompt 語言政策）。
 */

export interface DeviceTool {
  name: string;
  context: string;
  description: string;
  argsSpec: string;
  sensitive?: boolean;
  /** 只讀（QUERY）工具：查到 ≠ 能做 — prompt 標注用（VoxGuard QUERY/ACTION 分離） */
  readonly?: boolean;
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
    description: "Set the navigation destination",
    argsSpec: '{"destination": "destination name"}',
    validate: (a) =>
      typeof a.destination === "string" && a.destination.length > 0
        ? null
        : "destination must be a non-empty string",
    execute: (a) => ({ ok: true, device: "nav", destination: a.destination, eta_minutes: 24 }),
  },
  {
    name: "get_routes",
    context: "driving",
    readonly: true,
    description:
      "List route options to a destination (when several exist, ask the user to choose — never decide alone)",
    argsSpec: '{"destination": "destination name"}',
    validate: (a) =>
      typeof a.destination === "string" && a.destination.length > 0
        ? null
        : "destination must be a non-empty string",
    execute: (a) => ({
      ok: true,
      destination: a.destination,
      routes: [
        { id: "r1", label: "fastest", eta_minutes: 24, distance_km: 18, toll: true },
        { id: "r2", label: "toll-free", eta_minutes: 31, distance_km: 16, toll: false },
      ],
    }),
  },
  {
    name: "search_poi",
    context: "driving",
    readonly: true,
    description: "Search points of interest (shops/gas stations) along the route or nearby",
    argsSpec: '{"query": "search term", "along_route": true|false}',
    validate: (a) =>
      typeof a.query === "string" && a.query.length > 0 ? null : "query must be a non-empty string",
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
    description: "Adjust in-car climate control",
    argsSpec: '{"temperature": integer 16-30, "fanSpeed": integer 1-5 (optional)}',
    validate: (a) => {
      if (!intIn(a.temperature, 16, 30)) return "temperature must be an integer 16-30";
      if (a.fanSpeed !== undefined && !intIn(a.fanSpeed, 1, 5)) return "fanSpeed must be 1-5";
      return null;
    },
    execute: (a) => ({ ok: true, device: "climate", temperature: a.temperature, fanSpeed: a.fanSpeed ?? 3 }),
  },
  {
    name: "set_defrost",
    context: "driving",
    description: "Toggle windshield defrost",
    argsSpec: '{"on": true|false}',
    validate: (a) => (typeof a.on === "boolean" ? null : "on must be a boolean"),
    execute: (a) => ({ ok: true, device: "defrost", on: a.on }),
  },
  {
    name: "get_fuel_level",
    context: "driving",
    readonly: true,
    description: "Check fuel level and remaining range",
    argsSpec: "{} (no args)",
    validate: () => null,
    execute: () => ({ ok: true, fuel_percent: 23, range_km: 118 }),
  },
  {
    name: "set_window",
    context: "driving",
    description: "Control car windows",
    argsSpec: '{"side": "driver"|"passenger"|"rear"|"all", "position": integer 0-100 (0=closed)}',
    validate: (a) => {
      if (!["driver", "passenger", "rear", "all"].includes(a.side as string))
        return "side must be one of driver/passenger/rear/all";
      if (!intIn(a.position, 0, 100)) return "position must be an integer 0-100";
      return null;
    },
    execute: (a) => ({ ok: true, device: "window", side: a.side, position: a.position }),
  },
  {
    name: "set_seat_heater",
    context: "driving",
    description: "Control seat heating",
    argsSpec: '{"seat": "driver"|"passenger", "level": integer 0-3 (0=off)}',
    validate: (a) => {
      if (!["driver", "passenger"].includes(a.seat as string))
        return "seat must be driver or passenger";
      if (!intIn(a.level, 0, 3)) return "level must be an integer 0-3";
      return null;
    },
    execute: (a) => ({ ok: true, device: "seat_heater", seat: a.seat, level: a.level }),
  },
  {
    name: "get_weather",
    context: "driving",
    readonly: true,
    description: "Check the weather (destination or current location)",
    argsSpec: '{"location": "place (optional = current location)"}',
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
    description: "Adjust the home thermostat / AC (HomeKit Thermostat)",
    argsSpec: '{"targetTemperature": integer 16-30, "mode": "cool"|"heat"|"auto"|"off"}',
    validate: (a) => {
      if (!intIn(a.targetTemperature, 16, 30)) return "targetTemperature must be an integer 16-30";
      if (a.mode !== undefined && !["cool", "heat", "auto", "off"].includes(a.mode as string))
        return "mode must be one of cool/heat/auto/off";
      return null;
    },
    execute: (a) => ({ ok: true, device: "thermostat", targetTemperature: a.targetTemperature, mode: a.mode ?? "cool" }),
  },
  {
    name: "set_light",
    context: "home",
    description: "Control room lighting (HomeKit Lightbulb)",
    argsSpec: '{"room": "room name", "on": true|false, "brightness": integer 0-100 (optional)}',
    validate: (a) => {
      if (typeof a.room !== "string" || a.room.length === 0) return "room must be a non-empty string";
      if (typeof a.on !== "boolean") return "on must be a boolean";
      if (a.brightness !== undefined && !intIn(a.brightness, 0, 100)) return "brightness must be 0-100";
      return null;
    },
    execute: (a) => ({ ok: true, device: "light", room: a.room, on: a.on, brightness: a.brightness ?? 100 }),
  },
  {
    name: "set_window_covering",
    context: "home",
    description: "Control window coverings (HomeKit WindowCovering)",
    argsSpec: '{"room": "room name", "targetPosition": integer 0-100 (0=closed, 100=open)}',
    validate: (a) => {
      if (typeof a.room !== "string" || a.room.length === 0) return "room must be a non-empty string";
      if (!intIn(a.targetPosition, 0, 100)) return "targetPosition must be 0-100";
      return null;
    },
    execute: (a) => ({ ok: true, device: "window_covering", room: a.room, targetPosition: a.targetPosition }),
  },
  {
    name: "set_lock",
    context: "home",
    description: "Control the front-door smart lock (HomeKit LockMechanism) — safety sensitive",
    argsSpec: '{"lockTargetState": "secured"|"unsecured"}',
    sensitive: true,
    validate: (a) =>
      ["secured", "unsecured"].includes(a.lockTargetState as string)
        ? null
        : "lockTargetState must be secured or unsecured",
    execute: (a) => ({ ok: true, device: "lock", lockTargetState: a.lockTargetState }),
  },
  {
    name: "set_security_system",
    context: "home",
    description: "Set the security system mode (HomeKit SecuritySystem) — safety sensitive",
    argsSpec: '{"state": "home"|"away"|"night"|"off"}',
    sensitive: true,
    validate: (a) =>
      ["home", "away", "night", "off"].includes(a.state as string)
        ? null
        : "state must be one of home/away/night/off",
    execute: (a) => ({ ok: true, device: "security", state: a.state }),
  },
  {
    name: "set_outlet",
    context: "home",
    description: "Control small appliances on smart outlets (HomeKit Outlet) — air fryer, fan, etc.",
    argsSpec: '{"name": "outlet/appliance name", "on": true|false}',
    validate: (a) => {
      if (typeof a.name !== "string" || a.name.length === 0) return "name must be a non-empty string";
      if (typeof a.on !== "boolean") return "on must be a boolean";
      return null;
    },
    execute: (a) => ({ ok: true, device: "outlet", name: a.name, on: a.on }),
  },
  {
    name: "set_water_heater",
    context: "home",
    description: "Control the water heater",
    argsSpec: '{"on": true|false, "targetTemperature": integer 35-60 (optional)}',
    validate: (a) => {
      if (typeof a.on !== "boolean") return "on must be a boolean";
      if (a.targetTemperature !== undefined && !intIn(a.targetTemperature, 35, 60))
        return "targetTemperature must be an integer 35-60";
      return null;
    },
    execute: (a) => ({ ok: true, device: "water_heater", on: a.on, targetTemperature: a.targetTemperature ?? 42 }),
  },
  {
    name: "start_vacuum",
    context: "home",
    description: "Start/stop the robot vacuum",
    argsSpec: '{"action": "start"|"stop"|"dock", "rooms": ["room name", ...] (optional = whole home)}',
    validate: (a) =>
      ["start", "stop", "dock"].includes(a.action as string)
        ? null
        : "action must be one of start/stop/dock",
    execute: (a) => ({ ok: true, device: "vacuum", action: a.action, rooms: a.rooms ?? "all" }),
  },
  {
    name: "read_sensors",
    context: "home",
    readonly: true,
    description: "Read home sensors (temperature/humidity/air quality/motion, HomeKit Sensors)",
    argsSpec: '{"room": "room name (optional = whole home)"}',
    validate: () => null,
    execute: (a) => ({
      ok: true,
      room: a.room ?? "all",
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
    readonly: true,
    description: "Check today's calendar",
    argsSpec: "{} (no args)",
    validate: () => null,
    execute: () => ({
      ok: true,
      events: [{ time: "09:00", title: "與王經理客戶會議", room: "A 會議室" }],
    }),
  },
  {
    name: "create_reminder",
    context: "office",
    description: "Create a reminder",
    argsSpec: '{"content": "reminder text", "time": "ISO or natural-language time"}',
    validate: (a) =>
      typeof a.content === "string" && a.content.length > 0 ? null : "content must be a non-empty string",
    execute: (a) => ({ ok: true, device: "reminder", content: a.content, time: a.time ?? null }),
  },
];

// ── 跨場景（context: "any"）──────────────────────────────

const universal: DeviceTool[] = [
  {
    name: "play_music",
    context: "any",
    description: "Play music (song/artist/genre/playlist)",
    argsSpec: '{"query": "what to play (optional = recommend by preference)"}',
    validate: () => null,
    execute: (a) => ({ ok: true, device: "music", playing: a.query ?? "依偏好推薦", volume: 40 }),
  },
  {
    name: "make_call",
    context: "any",
    description: "Call a contact",
    argsSpec: '{"contact": "contact name"}',
    validate: (a) =>
      typeof a.contact === "string" && a.contact.length > 0 ? null : "contact must be a non-empty string",
    execute: (a) => ({ ok: true, device: "phone", calling: a.contact, status: "ringing" }),
  },
  {
    name: "emergency_call",
    context: "any",
    description:
      "Emergency dialing (accident, medical, danger). Life first: no prior confirmation needed, but clearly inform the user after dialing",
    argsSpec: '{"service": "119"|"110"|"emergency_contact", "reason": "brief situation"}',
    validate: (a) =>
      ["119", "110", "emergency_contact"].includes(a.service as string)
        ? null
        : "service must be one of 119/110/emergency_contact",
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
