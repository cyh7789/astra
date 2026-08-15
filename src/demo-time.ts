/** Demo 世界的時鐘規則：真實時間 + 固定時區，mock 事件相對真實時間生成 —
 *  模型唸出來的時刻才不會跟使用者的手錶脫節（實測：UTC 直出被唸成「早上 05:56」）。 */

const TZ = process.env.ASTRA_TZ ?? "Asia/Taipei";

/** 給 prompt 的本地時間字串（分鐘粒度）："2026-07-05 13:56" */
export function formatLocalTime(now: Date): string {
  return now.toLocaleString("sv-SE", { timeZone: TZ }).slice(0, 16);
}

/** demo 會議時刻：now + 3 小時取整點。行事曆 mock 與 seed 記憶共用同一條規則，
 *  出發提醒劇本（「距離會議還有 N 小時」）在任何時候測都成立。 */
export function demoMeetingTime(now = new Date()): { time: string; dayWord: string } {
  const t = new Date(now.getTime() + 3 * 3_600_000);
  const [datePart, timePart] = t.toLocaleString("sv-SE", { timeZone: TZ }).split(" ");
  const today = now.toLocaleString("sv-SE", { timeZone: TZ }).split(" ")[0];
  return {
    time: `${timePart!.slice(0, 2)}:00`,
    dayWord: datePart === today ? "今天" : "明天",
  };
}
