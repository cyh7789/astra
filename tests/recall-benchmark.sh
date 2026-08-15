#!/bin/bash
# ASTRA 跨場景召回 benchmark
# 在 A 場景存 5 條記憶，切到 B 場景逐條提問，量「召回」與「來源標注」。
# 用法: bash tests/recall-benchmark.sh [BASE_URL]
set -u
B="${1:-https://astra.hcytlog.com}"
C="$(mktemp -t astra-bm)"
R="/tmp/astra-recall-results.jsonl"; : > "$R"

api() { curl -s -b "$C" -c "$C" -X POST "$B/api/$1" \
        -H "Content-Type: application/json" -d "$2"; }
rep() { python3 -c "import sys,json;print(json.load(sys.stdin).get('reply',''))" 2>/dev/null; }

echo "=== ASTRA Cross-Context Recall Benchmark ==="
echo "URL: $B"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

api reset '{}' >/dev/null; sleep 2
api chat '{"message":"Please respond in English from now on."}' >/dev/null; sleep 4

echo "--- storing 3 memories in DRIVING ---"
api scene '{"context":"driving"}' >/dev/null; sleep 2
api chat '{"message":"Remember: the left rear tire pressure is low, about 28 PSI."}' >/dev/null; sleep 5
api chat '{"message":"My wife'"'"'s birthday is this Saturday, I need to order roses."}' >/dev/null; sleep 5
api chat '{"message":"The gas tank is almost empty, about 30 km of range left."}'  >/dev/null; sleep 5

echo "--- storing 2 memories in OFFICE ---"
api scene '{"context":"office"}' >/dev/null; sleep 2
api chat '{"message":"The deadline for Project Alpha moved to Friday, my boss confirmed."}' >/dev/null; sleep 5
api chat '{"message":"I prefer my meeting notes in bullet points, never paragraphs."}' >/dev/null; sleep 5

echo "--- recalling from HOME ---"
api scene '{"context":"home"}' >/dev/null; sleep 3

# 題目|召回關鍵字(正則)|來源關鍵字(正則)|來源場景
CASES=(
"Is there anything about my car I should handle?|tire|28 ?PSI|in the car|while driv|during your driv|on the road|driving|car"
"Do I have any personal events this weekend?|birthday|rose|in the car|while driv|during your driv|driving|car"
"Are there any work deadlines I should know about?|Friday|Alpha|at the office|in the office|at work|while.*office|office"
"How do I prefer my meeting notes formatted?|bullet|at the office|in the office|at work|while.*office|office"
"Is the car low on fuel?|gas|fuel|30 ?km|in the car|while driv|during your driv|driving|car"
)

n=0; hit=0; src=0
for c in "${CASES[@]}"; do
  IFS='|' read -r -a F <<< "$c"
  q="${F[0]}"
  # 欄位：題目 | 召回正則... | 來源正則... | 場景（最後一欄）
  scene="${F[$(( ${#F[@]} - 1 ))]}"
  # 召回關鍵字放前段，來源片語一律含 "in the car / at the office" 這類完整說法
  recall_re="$(printf '%s|' "${F[@]:1:2}" | sed 's/|$//')"
  source_re="$(printf '%s|' "${F[@]:3:$((${#F[@]}-4))}" | sed 's/|$//')"
  n=$((n+1))
  r="$(api chat "{\"message\":\"$q\"}" | rep)"; sleep 4

  h=0; echo "$r" | grep -qiE "$recall_re" && { h=1; hit=$((hit+1)); }
  s=0; echo "$r" | grep -qiE "$source_re" && { s=1; src=$((src+1)); }

  printf "[%d] recall=%s source=%s  %s\n" "$n" \
    "$([ $h = 1 ] && echo ✓ || echo ✗)" "$([ $s = 1 ] && echo ✓ || echo ✗)" "$q"
  { [ $h = 0 ] || [ $s = 0 ]; } && echo "     → ${r:0:170}"
  printf '{"case":%d,"scene":"%s","recall":%d,"source":%d,"q":"%s"}\n' \
    "$n" "$scene" "$h" "$s" "$q" >> "$R"
done

echo
echo "=== Summary ==="
printf "Recall accuracy    : %d / %d\n" "$hit" "$n"
printf "Source attribution : %d / %d\n" "$src" "$n"
echo "Raw: $R"
rm -f "$C"
