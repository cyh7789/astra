/** 穩定性 eval：全量行為劇本連跑 N 輪，聚合每個 check 的通過率。
 *  跨輪比對紀律：穩定失敗（0/N）才是 bug、中間值是取樣抖動（需收斂斷言或 prompt）、N/N 是可交付證據。
 *  跑法：EMBEDDER=voyage GEMINI_MODEL=gemma-4-31b-it RUNS=3 npx tsx scripts/stability-eval.ts */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const RUNS = Number(process.env.RUNS ?? 3);
const LOG_DIR = "eval-logs";
mkdirSync(LOG_DIR, { recursive: true });

const passes = new Map<string, number>();
const appearances = new Map<string, number>(); // 缺席（該輪崩潰沒跑到）≠ 失敗 — 分母用實際出現輪數
const order: string[] = [];
let crashedRuns = 0;

for (let run = 1; run <= RUNS; run++) {
  console.error(`===== run ${run}/${RUNS} =====`);
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await exec("npx", ["tsx", "scripts/traversal-spike.ts"], {
      env: { ...process.env, SPIKE_JSON: "1" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 50 * 60_000,
    }));
  } catch (e) {
    // spike 有 check 失敗時 exit 1，stdout 仍有 SPIKE_JSON 可聚合；崩潰/超時也把輸出留下來驗屍
    const err = e as { stdout?: string; stderr?: string; killed?: boolean };
    stdout = err.stdout ?? "";
    stderr = (err.stderr ?? "") + (err.killed ? "\n[stability-eval] 子行程被 timeout 殺掉" : "");
  }
  writeFileSync(`${LOG_DIR}/stability-run-${run}.log`, `${stdout}\n--- stderr ---\n${stderr}`);
  const line = stdout.split("\n").find((l) => l.startsWith("SPIKE_JSON:"));
  if (!line) {
    crashedRuns++;
    console.error(
      `run ${run}: 沒拿到 SPIKE_JSON（崩潰/超時）— 驗屍 ${LOG_DIR}/stability-run-${run}.log，尾段：`,
    );
    console.error([...stdout.split("\n"), ...stderr.split("\n")].filter(Boolean).slice(-6).join("\n"));
    continue;
  }
  const results = JSON.parse(line.slice("SPIKE_JSON:".length)) as Array<{
    name: string;
    pass: boolean;
  }>;
  for (const r of results) {
    if (r.name.startsWith("run 中斷")) {
      crashedRuns++;
      continue; // 崩潰標記不進矩陣（已由 crashedRuns 計）
    }
    if (!passes.has(r.name)) {
      passes.set(r.name, 0);
      appearances.set(r.name, 0);
      order.push(r.name);
    }
    appearances.set(r.name, appearances.get(r.name)! + 1);
    if (r.pass) passes.set(r.name, passes.get(r.name)! + 1);
  }
}

console.log(`\n===== 穩定性報告（${RUNS} 輪）=====`);
const stableFail: string[] = [];
const flaky: string[] = [];
for (const name of order) {
  const p = passes.get(name)!;
  const n = appearances.get(name)!;
  const mark = p === n ? "✅" : p === 0 ? "🔴" : "🟡";
  console.log(`${mark} ${p}/${n}${n < RUNS ? `（${RUNS - n} 輪缺席）` : ""}  ${name}`);
  if (p === 0) stableFail.push(name);
  else if (p < n) flaky.push(name);
}
console.log(`\n穩定失敗（真 bug）：${stableFail.length ? stableFail.join("；") : "無"}`);
console.log(`抖動（斷言或 prompt 待收斂）：${flaky.length ? flaky.join("；") : "無"}`);
if (crashedRuns > 0) console.log(`崩潰/超時輪數：${crashedRuns}/${RUNS}（驗屍 ${LOG_DIR}/）`);
if (order.length === 0) {
  console.error("沒有任何一輪產出資料 — eval 本身失敗，不得視為通過");
  process.exit(2);
}
const total = [...appearances.values()].reduce((a, b) => a + b, 0);
const passed = [...passes.values()].reduce((a, b) => a + b, 0);
console.log(`總通過率：${passed}/${total}（${((passed / total) * 100).toFixed(1)}%，分母 = 各檢查實際出現輪數）`);
process.exit(stableFail.length > 0 || crashedRuns === RUNS ? 1 : 0);
