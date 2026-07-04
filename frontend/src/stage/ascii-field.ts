/** 字元海引擎（自 docs/mockups/stage-mode-ascii.html 移植，邏輯 1:1）：
 *  全螢幕 ASCII 流場 + 立繪亮度遮罩浮現 + EQ 頻帶物理 + 滑鼠撥水尾流。
 *  React 之外的純 canvas 迴圈 — Stage 元件持 API 控制（setSpeaking / punch / maybeRelocate）。 */

export interface Placement {
  anchor: number;
  scaleH: number;
  flip: boolean;
  subSide: "left" | "right";
}

/** 每次開口換一個構圖（不連續重複）— 她不是桌布，是會走動的存在 */
const PLACEMENTS: Placement[] = [
  { anchor: 0.8, scaleH: 1.08, flip: false, subSide: "left" }, // 右側大
  { anchor: 0.21, scaleH: 1.02, flip: true, subSide: "right" }, // 左側大（鏡像面向內）
  { anchor: 0.68, scaleH: 0.85, flip: false, subSide: "left" }, // 中右中景
  { anchor: 0.26, scaleH: 0.76, flip: true, subSide: "right" }, // 左側中景
];

const RAMP = " ·:;=+*#%@";

function noise(x: number, y: number, t: number): number {
  return (
    (Math.sin(x * 1.6 + t) +
      Math.sin(y * 2.1 - t * 1.25) +
      Math.sin((x + y) * 0.9 + t * 0.6) +
      Math.sin(Math.hypot(x, y) * 1.3 - t * 0.4)) /
    4
  );
}

/** 靜態顆粒：每格固定隨機偏移 — 打散字元同時換檔的頻閃、讓能量點亮不同簇 */
function grain(c: number, r: number): number {
  const h = Math.sin(c * 127.1 + r * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

export interface AsciiField {
  setSpeaking(v: boolean): void;
  /** 聆聽預浮現：麥克風開著時她半浮現（在聽的樣子），開口才完全成形 */
  setListening(v: boolean): void;
  /** 真打點（TTS boundary / AnalyserNode 帶進來） */
  punch(strength?: number): void;
  /** 完全溶解後才換構圖（不會講到一半瞬移）。回傳目前構圖（字幕跳空側用）。 */
  maybeRelocate(): Placement;
  destroy(): void;
}

export function createAsciiField(
  cv: HTMLCanvasElement,
  onPlacement: (p: Placement) => void,
): AsciiField {
  const ctx = cv.getContext("2d")!;
  const DPR = Math.min(devicePixelRatio, 2);
  const CELL = 13 * DPR;
  let W = 0;
  let H = 0;
  let COLS = 0;
  let ROWS = 0;
  let mask = new Float32Array(0);
  let img: HTMLImageElement | null = null;
  let placement = PLACEMENTS[0]!;
  let lastPlacementIdx = 0;

  /** 立繪（已離線去背的透明 PNG）→ 亮度遮罩：透明區 flood-fill 標背景 + 純白口袋，
   *  主體亮度歸一化到 0.12-0.84 — 輪廓不破洞、明暗由字元密度呈現。 */
  function buildMaskFromImage(im: HTMLImageElement): void {
    const oc = document.createElement("canvas");
    oc.width = COLS;
    oc.height = ROWS;
    const o = oc.getContext("2d")!;
    const scale = (ROWS * placement.scaleH) / im.height;
    const w = im.width * scale;
    const h = im.height * scale;
    const x = COLS * placement.anchor - w / 2;
    const y = ROWS - h * 0.98;
    if (placement.flip) {
      o.save();
      o.translate(x + w, y);
      o.scale(-1, 1);
      o.drawImage(im, 0, 0, w, h);
      o.restore();
    } else {
      o.drawImage(im, x, y, w, h);
    }
    const d = o.getImageData(0, 0, COLS, ROWS).data;
    const N = COLS * ROWS;
    const lum = new Float32Array(N);
    const sat = new Float32Array(N);
    const alpha = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = d[i * 4]!;
      const g = d[i * 4 + 1]!;
      const b2 = d[i * 4 + 2]!;
      lum[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b2) / 255;
      sat[i] = Math.max(r, g, b2) - Math.min(r, g, b2);
      alpha[i] = d[i * 4 + 3]! / 255;
    }
    const bgMask = new Uint8Array(N);
    const q: number[] = [];
    for (let i = 0; i < N; i++)
      if (alpha[i]! < 0.5) {
        bgMask[i] = 1;
        q.push(i);
      }
    while (q.length) {
      const i = q.pop()!;
      const cx = i % COLS;
      const cy = (i / COLS) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const j = ny * COLS + nx;
        if (!bgMask[j] && lum[j]! > 0.9) {
          bgMask[j] = 1;
          q.push(j);
        }
      }
    }
    for (let i = 0; i < N; i++) if (!bgMask[i] && lum[i]! > 0.975 && sat[i]! < 7) bgMask[i] = 1;
    const m = new Float32Array(N);
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < N; i++) {
      if (bgMask[i]) continue;
      lo = Math.min(lo, lum[i]!);
      hi = Math.max(hi, lum[i]!);
    }
    const range = Math.max(0.05, hi - lo);
    for (let i = 0; i < N; i++) {
      if (bgMask[i]) continue;
      m[i] = 0.12 + ((lum[i]! - lo) / range) * 0.72;
    }
    mask = m;
  }

  function resize(): void {
    W = cv.width = innerWidth * DPR;
    H = cv.height = innerHeight * DPR;
    cv.style.width = `${innerWidth}px`;
    cv.style.height = `${innerHeight}px`;
    COLS = Math.ceil(W / CELL);
    ROWS = Math.ceil(H / CELL);
    if (img) buildMaskFromImage(img);
  }
  resize();
  addEventListener("resize", resize);

  const portrait = new Image();
  portrait.onload = () => {
    img = portrait;
    buildMaskFromImage(portrait);
  };
  portrait.src = "/xiaoxia.png";

  // 滑鼠尾流
  const wake: Array<{ x: number; y: number; t: number }> = [];
  function onMove(e: MouseEvent): void {
    wake.push({ x: e.clientX * DPR, y: e.clientY * DPR, t: performance.now() });
    if (wake.length > 24) wake.shift();
  }
  addEventListener("mousemove", onMove);

  // EQ 頻帶：瞬間 attack、指數 decay（低頻餘韻、高頻清脆）
  const bands = [0, 0, 0, 0];
  const disp = [0, 0, 0, 0];
  let speaking = false;
  let listening = false;
  let nextHit = 0;
  let presenceEnv = 0;

  function punchBands(strength = 1): void {
    const punch = (0.5 + Math.random() * 0.5) * strength;
    bands[0] = Math.max(bands[0]!, punch * (0.6 + Math.random() * 0.4));
    bands[1] = Math.max(bands[1]!, punch);
    bands[2] = Math.max(bands[2]!, punch * (0.5 + Math.random() * 0.5));
    bands[3] = Math.max(bands[3]!, Math.random() * strength);
  }

  let raf = 0;
  function frame(ms: number): void {
    const t = ms / 1000;
    const now = performance.now();
    if (speaking && now >= nextHit) {
      nextHit = now + 90 + Math.random() * 170; // boundary 事件沒來時的音節底拍
      punchBands(0.8);
    }
    bands[0]! *= 0.965;
    bands[1]! *= 0.9;
    bands[2]! *= 0.88;
    bands[3]! *= 0.82;
    for (let k = 0; k < 4; k++) disp[k]! += (bands[k]! - disp[k]!) * 0.5;
    const speak = disp[1]!;
    const lowBand = disp[0]!;
    // 存在包絡：平常她不在 — 說話 ~2s 凝聚、說完 ~3s 溶回海裡；聆聽時半浮現（預浮現）
    const presenceTarget = speaking ? 1 : listening ? 0.35 : 0;
    presenceEnv += (presenceTarget - presenceEnv) * (presenceTarget > presenceEnv ? 0.013 : 0.0075);

    ctx.fillStyle = "#0a0806";
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${CELL * 0.92}px ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c <= COLS; c++) {
        const gx = c * CELL;
        const gy = r * CELL;
        const nx = gx / (140 * DPR);
        const ny = gy / (140 * DPR);
        // 全域海面：說話只給很淡的漣漪（主要共鳴在她身上）
        const turbulence = 0.15 + speak * 0.07;
        let b = 0.16 + noise(nx, ny, t * (0.9 + speak * 0.4)) * turbulence;
        b += lowBand * noise(nx * 0.4, ny * 0.4, t * 0.6) * 0.06;

        const m = mask[c + r * COLS] ?? 0;
        if (m > 0 && presenceEnv > 0.01) {
          const g = grain(c, r);
          const emerge = Math.max(0, Math.min(1, (presenceEnv - g * 0.35) / 0.65)); // 一簇一簇浮現
          const wave = 0.5 + 0.5 * Math.sin(ny * 5.2 + nx * 1.3 - t * 3.2); // 穿過身體的波
          const voice = speak * (0.3 + 0.55 * wave) * (0.65 + 0.55 * g) + disp[3]! * g * 0.12;
          b += m * emerge * (0.5 + 0.06 * Math.sin(t * 1.5) + voice * 0.55);
        }

        let px = 0;
        let py = 0;
        for (const w of wake) {
          const age = (now - w.t) / 900;
          if (age > 1) continue;
          const wd = Math.hypot(gx - w.x, gy - w.y);
          const fall = Math.exp(-wd / (70 * DPR)) * (1 - age);
          b += fall * 0.55;
          if (wd > 0.01) {
            px += ((gx - w.x) / wd) * fall * 9 * DPR;
            py += ((gy - w.y) / wd) * fall * 9 * DPR;
          }
        }

        b = Math.max(0, Math.min(1, b));
        const ch =
          RAMP[
            Math.max(
              0,
              Math.min(RAMP.length - 1, Math.floor((b + (grain(r, c) - 0.5) * 0.09) * (RAMP.length - 1))),
            )
          ]!;
        if (ch === " ") continue;
        // 單色琥珀：形象只靠字元密度浮現
        ctx.fillStyle = `rgba(${(185 + b * 70) | 0}, ${(135 + b * 80) | 0}, ${(88 + b * 45) | 0}, ${0.28 + b * 0.72})`;
        ctx.fillText(ch, gx + px, gy + py);
      }
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setSpeaking(v) {
      speaking = v;
    },
    setListening(v) {
      listening = v;
    },
    punch(strength = 1) {
      punchBands(strength);
    },
    maybeRelocate() {
      if (presenceEnv < 0.05) {
        let i;
        do {
          i = Math.floor(Math.random() * PLACEMENTS.length);
        } while (i === lastPlacementIdx);
        lastPlacementIdx = i;
        placement = PLACEMENTS[i]!;
        if (img) buildMaskFromImage(img);
        onPlacement(placement);
      }
      return placement;
    },
    destroy() {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      removeEventListener("mousemove", onMove);
    },
  };
}
