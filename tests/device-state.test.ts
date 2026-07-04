import { describe, expect, it } from "vitest";
import { initialDeviceState, reduceDeviceState } from "../server/device-state.js";
import { TOOLS } from "../src/tools.js";

/** 用真工具的 execute 產生 result 餵 reducer — 驗的是「工具執行 → 裝置板」的完整資料流，
 *  不是手寫 fixture 自證自己。 */
function run(tool: string, args: Record<string, unknown>) {
  const t = TOOLS.find((x) => x.name === tool)!;
  expect(t.validate(args)).toBeNull();
  return { tool, args, result: t.execute(args) };
}

describe("reduceDeviceState", () => {
  it("折疊多輪動作：燈/鎖/恆溫累積，後寫覆蓋先寫", () => {
    let s = initialDeviceState();
    s = reduceDeviceState(s, [
      run("set_light", { room: "客廳", on: true, brightness: 60 }),
      run("set_thermostat", { targetTemperature: 26, mode: "cool" }),
    ]);
    s = reduceDeviceState(s, [
      run("set_light", { room: "臥室", on: true }),
      run("set_light", { room: "客廳", on: false }),
      run("set_lock", { lockTargetState: "secured" }),
    ]);
    expect(s.home.lights["客廳"]).toEqual({ on: false, brightness: 100 }); // execute 補預設亮度
    expect(s.home.lights["臥室"]).toEqual({ on: true, brightness: 100 });
    expect(s.home.thermostat).toEqual({ targetTemperature: 26, mode: "cool" });
    expect(s.home.lock).toBe("secured");
  });

  it("純函數：prev 不被改動", () => {
    const before = initialDeviceState();
    reduceDeviceState(before, [run("set_light", { room: "客廳", on: true })]);
    expect(before).toEqual(initialDeviceState());
  });

  it("只讀與記憶工具不改裝置態", () => {
    const s = reduceDeviceState(initialDeviceState(), [
      run("get_fuel_level", {}),
      run("read_sensors", {}),
      run("search_poi", { query: "加油站" }),
      { tool: "recall_memory", args: { query: "x" }, result: { ok: true, memories: [] } },
      { tool: "save_memory", args: { content: "x" }, result: { ok: true } },
    ]);
    expect(s).toEqual(initialDeviceState());
  });

  it("車窗 side=all 展開到三個窗；緊急撥號標 emergency", () => {
    const s = reduceDeviceState(initialDeviceState(), [
      run("set_window", { side: "all", position: 0 }),
      run("emergency_call", { service: "119", reason: "smoke" }),
    ]);
    expect(s.driving.windows).toEqual({ driver: 0, passenger: 0, rear: 0 });
    expect(s.any.phone).toEqual({ calling: "119", emergency: true, reason: "smoke" });
  });

  it("提醒累加不覆蓋；導航/音樂取 execute 的正規化值", () => {
    let s = initialDeviceState();
    s = reduceDeviceState(s, [run("create_reminder", { content: "帶傘", time: "18:00" })]);
    s = reduceDeviceState(s, [
      run("create_reminder", { content: "回電" }),
      run("start_navigation", { destination: "公司" }),
      run("play_music", {}),
    ]);
    expect(s.office.reminders).toEqual([
      { content: "帶傘", time: "18:00" },
      { content: "回電", time: null },
    ]);
    expect(s.driving.nav).toEqual({ destination: "公司", etaMinutes: 24 });
    expect(s.any.music).toEqual({ playing: "依偏好推薦", volume: 40 });
  });
});
