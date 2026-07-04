import type { SessionTurnResult } from "../src/session.js";

/** 裝置板狀態 = toolCalls 的 reducer（demo UI 設計決策 2）：
 *  tools.ts 的 execute 是純 mock、不持有狀態 — 前端要顯示的「燈開了沒、鎖上了沒」
 *  由伺服器層折疊每輪 toolCalls 推導，零後端改動。
 *  值一律取自 result 而非 args（execute 會補預設值，如 fanSpeed=3、brightness=100）。 */

type ToolCall = SessionTurnResult["toolCalls"][number];

export interface DeviceState {
  driving: {
    nav: { destination: string; etaMinutes: number } | null;
    climate: { temperature: number; fanSpeed: number } | null;
    defrost: boolean;
    /** side → position（0=關） */
    windows: Record<string, number>;
    /** seat → level（0=關） */
    seatHeaters: Record<string, number>;
  };
  home: {
    thermostat: { targetTemperature: number; mode: string } | null;
    lights: Record<string, { on: boolean; brightness: number }>;
    /** room → targetPosition（0=關 100=全開） */
    coverings: Record<string, number>;
    lock: "secured" | "unsecured" | null;
    security: "home" | "away" | "night" | "off" | null;
    outlets: Record<string, boolean>;
    waterHeater: { on: boolean; targetTemperature: number } | null;
    vacuum: { action: string; rooms: string | string[] } | null;
  };
  office: {
    reminders: Array<{ content: string; time: string | null }>;
  };
  any: {
    music: { playing: string; volume: number } | null;
    phone: { calling: string; status?: string; emergency?: boolean; reason?: string | null } | null;
  };
}

export function initialDeviceState(): DeviceState {
  return {
    driving: { nav: null, climate: null, defrost: false, windows: {}, seatHeaters: {} },
    home: {
      thermostat: null,
      lights: {},
      coverings: {},
      lock: null,
      security: null,
      outlets: {},
      waterHeater: null,
      vacuum: null,
    },
    office: { reminders: [] },
    any: { music: null, phone: null },
  };
}

/** 純函數：折疊一輪的 toolCalls 進裝置狀態，回傳新物件（prev 不變）。
 *  只讀工具（search_poi/read_sensors…）與記憶工具（recall/save_memory）不改裝置態，自然落空。 */
export function reduceDeviceState(prev: DeviceState, toolCalls: ToolCall[]): DeviceState {
  const next = structuredClone(prev);
  for (const { tool, result } of toolCalls) {
    if (result.ok !== true) continue;
    switch (tool) {
      case "start_navigation":
        next.driving.nav = {
          destination: result.destination as string,
          etaMinutes: result.eta_minutes as number,
        };
        break;
      case "set_climate":
        next.driving.climate = {
          temperature: result.temperature as number,
          fanSpeed: result.fanSpeed as number,
        };
        break;
      case "set_defrost":
        next.driving.defrost = result.on as boolean;
        break;
      case "set_window": {
        const sides = result.side === "all" ? ["driver", "passenger", "rear"] : [result.side as string];
        for (const s of sides) next.driving.windows[s] = result.position as number;
        break;
      }
      case "set_seat_heater":
        next.driving.seatHeaters[result.seat as string] = result.level as number;
        break;
      case "set_thermostat":
        next.home.thermostat = {
          targetTemperature: result.targetTemperature as number,
          mode: result.mode as string,
        };
        break;
      case "set_light":
        next.home.lights[result.room as string] = {
          on: result.on as boolean,
          brightness: result.brightness as number,
        };
        break;
      case "set_window_covering":
        next.home.coverings[result.room as string] = result.targetPosition as number;
        break;
      case "set_lock":
        next.home.lock = result.lockTargetState as DeviceState["home"]["lock"];
        break;
      case "set_security_system":
        next.home.security = result.state as DeviceState["home"]["security"];
        break;
      case "set_outlet":
        next.home.outlets[result.name as string] = result.on as boolean;
        break;
      case "set_water_heater":
        next.home.waterHeater = {
          on: result.on as boolean,
          targetTemperature: result.targetTemperature as number,
        };
        break;
      case "start_vacuum":
        next.home.vacuum = {
          action: result.action as string,
          rooms: result.rooms as string | string[],
        };
        break;
      case "create_reminder":
        next.office.reminders.push({
          content: result.content as string,
          time: (result.time as string | null) ?? null,
        });
        break;
      case "play_music":
        next.any.music = { playing: result.playing as string, volume: result.volume as number };
        break;
      case "make_call":
        next.any.phone = { calling: result.calling as string, status: result.status as string };
        break;
      case "emergency_call":
        next.any.phone = {
          calling: result.calling as string,
          emergency: true,
          reason: (result.reason as string | null) ?? null,
        };
        break;
    }
  }
  return next;
}
