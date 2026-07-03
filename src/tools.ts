/** 場景綁定的 mock 裝置工具（demo 模擬）。
 *  Phase 4 工具層的最小集合：每個工具宣告所屬場景，Capability 白名單據此攔截。 */

export interface DeviceTool {
  name: string;
  context: string; // 工具所在場景
  description: string;
  argsSpec: string; // 給 LLM 看的參數說明
  validate(args: Record<string, unknown>): string | null; // 錯誤訊息或 null
  execute(args: Record<string, unknown>): Record<string, unknown>; // mock 執行
}

export const TOOLS: DeviceTool[] = [
  {
    name: "set_ac",
    context: "home",
    description: "調整家裡冷氣",
    argsSpec: '{"temperature": 16-30 的整數, "mode": "cool" | "dry" | "fan"}',
    validate(args) {
      const t = args.temperature;
      if (typeof t !== "number" || t < 16 || t > 30) return "temperature 必須是 16-30 的整數";
      if (args.mode !== undefined && !["cool", "dry", "fan"].includes(args.mode as string))
        return "mode 只能是 cool/dry/fan";
      return null;
    },
    execute(args) {
      return { ok: true, device: "ac", temperature: args.temperature, mode: args.mode ?? "cool" };
    },
  },
  {
    name: "preheat_airfryer",
    context: "home",
    description: "預熱家裡的氣炸鍋",
    argsSpec: '{"temperature": 80-200 的整數}',
    validate(args) {
      const t = args.temperature;
      if (typeof t !== "number" || t < 80 || t > 200) return "temperature 必須是 80-200 的整數";
      return null;
    },
    execute(args) {
      return { ok: true, device: "airfryer", preheating: true, temperature: args.temperature };
    },
  },
  {
    name: "start_navigation",
    context: "driving",
    description: "設定車上導航目的地",
    argsSpec: '{"destination": "目的地名稱"}',
    validate(args) {
      if (typeof args.destination !== "string" || args.destination.length === 0)
        return "destination 必須是非空字串";
      return null;
    },
    execute(args) {
      return { ok: true, device: "nav", destination: args.destination, eta_minutes: 24 };
    },
  },
  {
    name: "get_fuel_level",
    context: "driving",
    description: "查詢油量與續航",
    argsSpec: "{}（無參數）",
    validate() {
      return null;
    },
    execute() {
      return { ok: true, fuel_percent: 23, range_km: 118 };
    },
  },
];

/** 場景白名單：Capability Guard 的工具版 — 只暴露當前場景的工具。 */
export function toolsForContext(context: string): DeviceTool[] {
  return TOOLS.filter((t) => t.context === context);
}
