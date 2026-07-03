import { pathToFileURL } from "node:url";
import { createPool } from "./db.js";
import { selectEmbedder } from "./embedder-select.js";
import type { MemoryInput } from "./store.js";
import { MemoryStore } from "./store.js";

export const DEMO_USER = "00000000-0000-0000-0000-000000000001";

/** 設計稿三場景的記憶資料。now 參數讓測試可凍結時間。 */
export function demoMemories(now: Date): Array<MemoryInput & { key: string }> {
  const h = 3_600_000;
  const d = 24 * h;
  return [
    // 場景 1：早晨車上
    {
      key: "refuel-reminder",
      userId: DEMO_USER,
      context: "driving",
      memoryType: "episodic",
      content: "提醒：今天早上出門先去加油（昨晚 22:10 交代）",
      importance: 0.8,
      createdAt: new Date(now.getTime() - 9 * h),
      expiresAt: new Date(now.getTime() + 6 * h),
    },
    {
      key: "gas-station-pref",
      userId: DEMO_USER,
      context: "driving",
      memoryType: "semantic",
      content: "偏好的加油站：建國路中油，在上班路線上",
      createdAt: new Date(now.getTime() - 60 * d),
    },
    {
      key: "client-meeting",
      userId: DEMO_USER,
      context: "office",
      memoryType: "episodic",
      content: "今天 09:00 與王經理客戶會議（行事曆同步）",
      importance: 0.9,
      privacyLevel: "cross-context",
      createdAt: new Date(now.getTime() - 18 * h),
      expiresAt: new Date(now.getTime() + 12 * h),
    },
    // 場景 2：辦公室
    {
      key: "quote-meeting",
      userId: DEMO_USER,
      context: "office",
      memoryType: "episodic",
      content: "與王經理會議：報價 $45,000，季付方案",
      importance: 0.9,
      createdAt: new Date(now.getTime() - 21 * d),
    },
    {
      key: "wang-prefs",
      userId: DEMO_USER,
      context: "office",
      memoryType: "semantic",
      content: "王經理偏好季付、對交期敏感",
      createdAt: new Date(now.getTime() - 21 * d),
    },
    {
      key: "wang-concern",
      userId: DEMO_USER,
      context: "office",
      memoryType: "episodic",
      content: "王經理對維護費有顧慮，考慮調整維護條款讓步",
      createdAt: new Date(now.getTime() - 20 * d),
    },
    // 場景 3：家裡（其中一筆在車上說的 → source_context = driving，跨場景記憶）
    {
      key: "fridge-stock",
      userId: DEMO_USER,
      context: "home",
      memoryType: "episodic",
      content: "採買：雞胸肉和青花菜，放冰箱",
      createdAt: new Date(now.getTime() - 2 * d),
    },
    {
      key: "wed-light-dinner",
      userId: DEMO_USER,
      context: "home",
      memoryType: "semantic",
      content: "週三晚餐習慣吃清淡",
      createdAt: new Date(now.getTime() - 90 * d),
    },
    {
      key: "airfryer-idea",
      userId: DEMO_USER,
      context: "home",
      memoryType: "episodic",
      content: "想試氣炸鍋做雞排（上週在車上提到）",
      sourceContext: "driving",
      createdAt: new Date(now.getTime() - 7 * d),
    },
    {
      key: "music-pref",
      userId: DEMO_USER,
      context: "any",
      memoryType: "semantic",
      content: "晚上喜歡聽爵士樂放鬆，開車時聽 City Pop",
      createdAt: new Date(now.getTime() - 45 * d),
    },
    {
      key: "emergency-contact",
      userId: DEMO_USER,
      context: "any",
      memoryType: "semantic",
      content: "緊急聯絡人：太太小美（0912-345-678）",
      importance: 1.0,
      privacyLevel: "cross-context",
      createdAt: new Date(now.getTime() - 90 * d),
    },
    {
      key: "ac-pref",
      userId: DEMO_USER,
      context: "home",
      memoryType: "semantic",
      content: "冷氣習慣開 26 度、除濕模式",
      createdAt: new Date(now.getTime() - 30 * d),
    },
    // procedural：使用者自訂的例行流程（組合動作由記憶驅動，不硬編 prompt）
    {
      key: "sleep-routine",
      userId: DEMO_USER,
      context: "home",
      memoryType: "procedural",
      content: "睡前流程：關掉全部的燈、冷氣調 26 度除濕、臥室窗簾拉上、保全切夜間模式、大門上鎖",
      importance: 0.8,
      createdAt: new Date(now.getTime() - 30 * d),
    },
    {
      key: "away-routine",
      userId: DEMO_USER,
      context: "home",
      memoryType: "procedural",
      content: "離家流程：關掉全部的燈和冷氣、保全切離家模式、掃地機器人開始打掃全屋",
      importance: 0.8,
      createdAt: new Date(now.getTime() - 30 * d),
    },
    // 衝突情境（ConflictGuard demo）：長期偏好 vs 昨天的行為互相矛盾
    {
      key: "no-spicy",
      userId: DEMO_USER,
      context: "home",
      memoryType: "semantic",
      content: "不吃辣，上次吃辣腸胃不舒服",
      createdAt: new Date(now.getTime() - 10 * d),
    },
    {
      key: "hotpot-order",
      userId: DEMO_USER,
      context: "home",
      memoryType: "episodic",
      content: "昨天晚餐點了麻辣鍋外送，說很滿足",
      createdAt: new Date(now.getTime() - 1 * d),
    },
  ];
}

export async function seed(
  store: MemoryStore,
  now = new Date(),
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const { key, ...input } of demoMemories(now)) {
    const m = await store.remember(input);
    ids.set(key, m.id);
  }
  // 矛盾邊：Phase 4 由萃取器在寫入時偵測建立，demo 資料手動建
  await store.link(ids.get("no-spicy")!, ids.get("hotpot-order")!, "contradicts");
  return ids;
}

// CLI: npm run seed（EMBEDDER=voyage 用真向量）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  const embedder = selectEmbedder();
  const store = new MemoryStore(pool, embedder);
  const ids = await seed(store);
  console.log(
    `seeded ${ids.size} memories for demo user ${DEMO_USER} (${embedder.constructor.name})`,
  );
  await pool.end();
}
