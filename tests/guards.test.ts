import { describe, expect, it } from "vitest";
import {
  applyGuards,
  ConflictGuard,
  PrivacyGuard,
  RecencyGuard,
  toGuarded,
  type GuardDeps,
} from "../src/guards.js";
import type { ScoredMemory } from "../src/store.js";

const NOW = new Date("2026-07-03T20:00:00+08:00");

function mem(over: Partial<ScoredMemory>): ScoredMemory {
  return {
    id: over.id ?? crypto.randomUUID(),
    userId: "u",
    context: "home",
    memoryType: "episodic",
    content: "x",
    importance: 0.5,
    privacyLevel: "private",
    accessCount: 0,
    createdAt: NOW,
    lastAccessed: NOW,
    expiresAt: null,
    sourceContext: null,
    vectorSim: 0.5,
    signals: { vector: 0.5, bm25: 0.5, recency: 0.5 },
    score: 0.5,
    ...over,
  };
}

const noDeps: GuardDeps = { loadContradictsLinks: async () => [] };

describe("PrivacyGuard", () => {
  it("annotates cross-context memories", async () => {
    const ms = toGuarded([
      mem({ context: "office", privacyLevel: "cross-context" }),
      mem({ context: "home" }),
    ]);
    const out = await applyGuards([PrivacyGuard], ms, { currentContext: "home", now: NOW }, noDeps);
    expect(out[0]!.annotations).toContain("來自 office 場景的記憶");
    expect(out[1]!.annotations).toHaveLength(0);
  });

  it("annotates source context divergence", async () => {
    const ms = toGuarded([mem({ context: "home", sourceContext: "driving" })]);
    const out = await applyGuards([PrivacyGuard], ms, { currentContext: "home", now: NOW }, noDeps);
    expect(out[0]!.annotations).toContain("當時在 driving 場景提到");
  });

  it("反向 + 同場景負控制：home→office 標注、sourceContext===context 不標（devin P2）", async () => {
    const ms = toGuarded([
      mem({ context: "home", privacyLevel: "cross-context" }), // 反向：在 office 看 home 記憶
      mem({ context: "office", sourceContext: "office" }), // 同源同場景：不該標
    ]);
    const out = await applyGuards([PrivacyGuard], ms, { currentContext: "office", now: NOW }, noDeps);
    expect(out[0]!.annotations).toContain("來自 home 場景的記憶");
    expect(out[1]!.annotations).toHaveLength(0);
  });
});

describe("RecencyGuard", () => {
  const old = new Date(NOW.getTime() - 21 * 24 * 3_600_000);
  it("flags stale episodic memories", async () => {
    const ms = toGuarded([mem({ createdAt: old, memoryType: "episodic" })]);
    const out = await applyGuards([RecencyGuard], ms, { currentContext: "home", now: NOW }, noDeps);
    expect(out[0]!.annotations).toContain("21 天前的資訊，可能已過時");
  });
  it("does not flag semantic facts or fresh memories", async () => {
    const ms = toGuarded([
      mem({ createdAt: old, memoryType: "semantic" }),
      mem({ createdAt: NOW, memoryType: "episodic" }),
    ]);
    const out = await applyGuards([RecencyGuard], ms, { currentContext: "home", now: NOW }, noDeps);
    expect(out[0]!.annotations).toHaveLength(0);
    expect(out[1]!.annotations).toHaveLength(0);
  });
});

describe("ConflictGuard", () => {
  it("annotates both sides of a contradicts link within the result set", async () => {
    const a = mem({ content: "不吃辣" });
    const b = mem({ content: "昨天點了麻辣鍋" });
    const deps: GuardDeps = {
      loadContradictsLinks: async () => [{ sourceId: a.id, targetId: b.id }],
    };
    const out = await applyGuards(
      [ConflictGuard],
      toGuarded([a, b]),
      { currentContext: "home", now: NOW },
      deps,
    );
    expect(out[0]!.conflictsWith).toEqual([b.id]);
    expect(out[1]!.conflictsWith).toEqual([a.id]);
    expect(out[0]!.annotations[0]).toContain("矛盾");
  });

  it("ignores links whose other end is outside the result set", async () => {
    const a = mem({});
    const deps: GuardDeps = {
      loadContradictsLinks: async () => [{ sourceId: a.id, targetId: "not-in-set" }],
    };
    const out = await applyGuards(
      [ConflictGuard],
      toGuarded([a]),
      { currentContext: "home", now: NOW },
      deps,
    );
    expect(out[0]!.conflictsWith).toBeUndefined();
    expect(out[0]!.annotations).toHaveLength(0);
  });
});
