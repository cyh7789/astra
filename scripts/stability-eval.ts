/** 穩定性 eval：全量行為劇本連跑 N 輪，聚合每個 check 的通過率。
 *  跨輪比對紀律：穩定失敗（0/N）才是 bug、中間值是取樣抖動（需收斂斷言或 prompt）、N/N 是可交付證據。
 *  跑法：EMBEDDER=voyage GEMINI_MODEL=gemma-4-31b-it RUNS=3 npx tsx scripts/stability-eval.ts */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const RUNS = Number(process.env.RUNS ?? 3);

const passes = new Map<string, number>();
const order: string[] = [];

for (let run = 1; run <= RUNS; run++) {
  console.error(`===== run ${run}/${RUNS} =====`);
  let stdout = "";
  try {
    ({ stdout } = await exec("npx", ["tsx", "scripts/traversal-spike.ts"], {
      env: { ...process.env, SPIKE_JSON: "1" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30 * 60_000,
    }));
  } catch (e) {
    // spike 有 check 失敗時 exit 1，stdout 仍有 SPIKE_JSON 可聚合
    stdout = (e as { stdout?: string }).stdout ?? "";
  }
  const line = stdout.split("\n").find((l) => l.startsWith("SPIKE_JSON:"));
  if (!line) {
    console.error(`run ${run}: 沒拿到 SPIKE_JSON（spike 崩潰？），該輪整輪記 0`);
    continue;
  }
  const results = JSON.parse(line.slice("SPIKE_JSON:".length)) as Array<{
    name: string;
    pass: boolean;
  }>;
  for (const r of results) {
    if (!passes.has(r.name)) {
      passes.set(r.name, 0);
      order.push(r.name);
    }
    if (r.pass) passes.set(r.name, passes.get(r.name)! + 1);
  }
}

console.log(`\n===== 穩定性報告（${RUNS} 輪）=====`);
const stableFail: string[] = [];
const flaky: string[] = [];
for (const name of order) {
  const p = passes.get(name)!;
  const mark = p === RUNS ? "✅" : p === 0 ? "🔴" : "🟡";
  console.log(`${mark} ${p}/${RUNS}  ${name}`);
  if (p === 0) stableFail.push(name);
  else if (p < RUNS) flaky.push(name);
}
console.log(`\n穩定失敗（真 bug）：${stableFail.length ? stableFail.join("；") : "無"}`);
console.log(`抖動（斷言或 prompt 待收斂）：${flaky.length ? flaky.join("；") : "無"}`);
const total = order.length * RUNS;
const passed = [...passes.values()].reduce((a, b) => a + b, 0);
console.log(`總通過率：${passed}/${total}（${((passed / total) * 100).toFixed(1)}%）`);
process.exit(stableFail.length > 0 ? 1 : 0);
