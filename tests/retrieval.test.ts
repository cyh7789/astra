import { describe, expect, it } from "vitest";
import { bm25Scores, fuse, minMaxNormalize, recencyScore } from "../src/retrieval.js";
import { tokenize } from "../src/text.js";

describe("bm25Scores", () => {
  const docs = [
    tokenize("與王經理會議：報價 $45,000，季付方案"),
    tokenize("週三晚餐習慣吃清淡"),
    tokenize("王經理對維護費有顧慮"),
  ];

  it("ranks docs mentioning query terms higher", () => {
    const scores = bm25Scores(tokenize("王經理 報價"), docs);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[2]).toBeGreaterThan(scores[1]!);
    expect(scores[0]).toBeGreaterThan(scores[2]!); // 同時命中「王經理」+「報價」
  });

  it("returns zeros when nothing matches", () => {
    expect(bm25Scores(tokenize("氣炸鍋"), docs)).toEqual([0, 0, 0]);
  });

  it("handles empty corpus", () => {
    expect(bm25Scores(tokenize("x"), [])).toEqual([]);
  });
});

describe("recencyScore", () => {
  const now = new Date("2026-07-03T12:00:00Z");
  it("halves per half-life", () => {
    const week = new Date("2026-06-26T12:00:00Z");
    expect(recencyScore(now, now)).toBeCloseTo(1, 5);
    expect(recencyScore(week, now)).toBeCloseTo(0.5, 5);
  });
  it("clamps future timestamps to 1", () => {
    expect(recencyScore(new Date("2026-07-04T00:00:00Z"), now)).toBe(1);
  });
});

describe("minMaxNormalize", () => {
  it("maps to [0,1]", () => {
    expect(minMaxNormalize([2, 4, 6])).toEqual([0, 0.5, 1]);
  });
  it("returns all 1 when values are equal", () => {
    expect(minMaxNormalize([3, 3])).toEqual([1, 1]);
  });
  it("handles empty", () => {
    expect(minMaxNormalize([])).toEqual([]);
  });
});

describe("fuse", () => {
  it("weights signals", () => {
    const fused = fuse(
      { vector: [1, 0], bm25: [0, 1], recency: [0.5, 0.5] },
      { vector: 0.4, bm25: 0.3, recency: 0.3 },
    );
    expect(fused[0]).toBeCloseTo(0.4 + 0 + 0.15, 5);
    expect(fused[1]).toBeCloseTo(0 + 0.3 + 0.15, 5);
  });
});
