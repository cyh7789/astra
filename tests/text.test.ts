import { describe, expect, it } from "vitest";
import { bm25Scores } from "../src/retrieval.js";
import { tokenize } from "../src/text.js";

describe("tokenize", () => {
  it("splits latin words lowercase", () => {
    expect(tokenize("Hello CockroachDB v26")).toEqual(["hello", "cockroachdb", "v26"]);
  });

  it("CJK 連段同時發 unigram + bigram", () => {
    expect(tokenize("王經理")).toEqual(["王", "經", "理", "王經", "經理"]);
  });

  it("keeps single CJK char", () => {
    expect(tokenize("油")).toEqual(["油"]);
  });

  it("單字 CJK query 命中多字 doc（devin P1：unigram 修復前 BM25 靜默歸零）", () => {
    const scores = bm25Scores(tokenize("王"), [tokenize("王經理今天請假"), tokenize("天氣很好")]);
    expect(scores[0]).toBeGreaterThan(0); // 「王」對「王經理」現在有交集（unigram）
    expect(scores[1]).toBe(0);
  });
});
