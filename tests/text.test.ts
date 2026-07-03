import { describe, expect, it } from "vitest";
import { tokenize } from "../src/text.js";

describe("tokenize", () => {
  it("splits latin words lowercase", () => {
    expect(tokenize("Hello CockroachDB v26")).toEqual(["hello", "cockroachdb", "v26"]);
  });

  it("bigrams CJK runs", () => {
    expect(tokenize("王經理")).toEqual(["王經", "經理"]);
  });

  it("keeps single CJK char", () => {
    expect(tokenize("油")).toEqual(["油"]);
  });

  it("handles mixed text and punctuation", () => {
    expect(tokenize("上次跟王經理談的報價是 $45,000")).toEqual([
      "上次", "次跟", "跟王", "王經", "經理", "理談", "談的", "的報", "報價", "價是", "45", "000",
    ]);
  });
});
