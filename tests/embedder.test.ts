import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "../src/embedder.js";

function cosine(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i]!, 0);
}

describe("FakeEmbedder", () => {
  const e = new FakeEmbedder(64);

  it("is deterministic and unit-length", async () => {
    const a = await e.embed("加油站在建國路");
    const b = await e.embed("加油站在建國路");
    expect(a).toEqual(b);
    expect(Math.hypot(...a)).toBeCloseTo(1, 5);
  });

  it("scores overlapping text higher than unrelated text", async () => {
    const q = await e.embed("今天早上要去加油");
    const related = await e.embed("提醒：早上出門先去加油");
    const unrelated = await e.embed("王經理偏好季付方案");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });
});
