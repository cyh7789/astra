import { describe, expect, it } from "vitest";
import { MemoryWindow } from "../src/memory-window.js";
import type { Memory } from "../src/store.js";

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    userId: "u",
    context: "home",
    memoryType: "semantic",
    content: "x".repeat(20),
    importance: 0.5,
    privacyLevel: "private",
    accessCount: 0,
    createdAt: new Date(0),
    lastAccessed: new Date(0),
    expiresAt: null,
    sourceContext: null,
    ...over,
  };
}

describe("MemoryWindow", () => {
  it("同 id 再准入 = refresh：score 取 max、lastRelevantTurn 更新、不重複佔位", () => {
    const w = new MemoryWindow(5, 10_000);
    expect(w.admit(mem({ id: "a" }), { score: 0.5, turn: 1, via: "passive" })).toBe(true);
    expect(w.admit(mem({ id: "a" }), { score: 0.3, turn: 3, via: "tool" })).toBe(false);
    expect(w.size).toBe(1);
    const e = w.entries()[0]!;
    expect(e.score).toBe(0.5);
    expect(e.lastRelevantTurn).toBe(3);
    expect(e.via).toBe("passive"); // 首次准入的 via 保留
  });

  it("超容量淘汰 lastRelevantTurn 最舊者（score 高也一樣）", () => {
    const w = new MemoryWindow(3, 10_000);
    w.admit(mem({ id: "old-high" }), { score: 0.9, turn: 1, via: "passive" });
    w.admit(mem({ id: "b" }), { score: 0.5, turn: 2, via: "passive" });
    w.admit(mem({ id: "c" }), { score: 0.8, turn: 3, via: "passive" });
    w.admit(mem({ id: "d" }), { score: 0.4, turn: 4, via: "passive" });
    expect(w.has("old-high")).toBe(false);
    expect(w.size).toBe(3);
  });

  it("同齡淘汰 score 低者", () => {
    const w = new MemoryWindow(2, 10_000);
    w.admit(mem({ id: "low" }), { score: 0.2, turn: 1, via: "passive" });
    w.admit(mem({ id: "high" }), { score: 0.9, turn: 1, via: "passive" });
    w.admit(mem({ id: "new" }), { score: 0.5, turn: 2, via: "passive" });
    expect(w.has("low")).toBe(false);
    expect(w.has("high")).toBe(true);
  });

  it("pinned 豁免淘汰", () => {
    const w = new MemoryWindow(2, 10_000);
    w.admit(mem({ id: "pin" }), { score: 0.1, turn: 1, via: "pin", pinned: true });
    w.admit(mem({ id: "b" }), { score: 0.5, turn: 2, via: "passive" });
    w.admit(mem({ id: "c" }), { score: 0.5, turn: 3, via: "passive" });
    expect(w.has("pin")).toBe(true);
    expect(w.has("b")).toBe(false);
  });

  it("字數預算超標也會淘汰", () => {
    const w = new MemoryWindow(10, 100);
    w.admit(mem({ id: "a", content: "甲".repeat(60) }), { score: 0.5, turn: 1, via: "passive" });
    w.admit(mem({ id: "b", content: "乙".repeat(60) }), { score: 0.9, turn: 2, via: "passive" });
    expect(w.has("a")).toBe(false);
    expect(w.has("b")).toBe(true);
  });

  it("event 條目 TTL 到期由 beginTurn 清除；期間再相關則解除 TTL", () => {
    const w = new MemoryWindow(5, 10_000);
    w.admit(mem({ id: "ev" }), { score: 0.5, turn: 1, via: "event", ttlTurns: 3 });
    w.beginTurn(3);
    expect(w.has("ev")).toBe(true);
    w.beginTurn(4); // 1 + 3 = 4 → 到期
    expect(w.has("ev")).toBe(false);

    w.admit(mem({ id: "ev2" }), { score: 0.5, turn: 4, via: "event", ttlTurns: 3 });
    w.admit(mem({ id: "ev2" }), { score: 0.5, turn: 5, via: "passive" }); // 再相關
    w.beginTurn(9);
    expect(w.has("ev2")).toBe(true);
  });

  it("carryOver：private 且不屬新場景的踢出；any / cross-context / 新場景的留下", () => {
    const w = new MemoryWindow(10, 10_000);
    w.admit(mem({ id: "office-private", context: "office" }), { score: 0.5, turn: 1, via: "passive" });
    w.admit(mem({ id: "home-private", context: "home" }), { score: 0.5, turn: 1, via: "passive" });
    w.admit(mem({ id: "anywhere", context: "any" }), { score: 0.5, turn: 1, via: "pin" });
    w.admit(mem({ id: "office-cross", context: "office", privacyLevel: "cross-context" }), {
      score: 0.5,
      turn: 1,
      via: "passive",
    });
    const evicted = w.carryOver("home");
    expect(evicted.map((e) => e.memory.id)).toEqual(["office-private"]);
    expect(w.has("home-private")).toBe(true);
    expect(w.has("anywhere")).toBe(true);
    expect(w.has("office-cross")).toBe(true);
  });
});
