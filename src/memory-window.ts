import { WINDOW_CAPACITY, WINDOW_CHAR_BUDGET } from "./config.js";
import type { Memory } from "./store.js";

/** 作用中記憶窗（設計文件 §4.3）：跨輪工作集。
 *  純類別零 DB — 准入/去重/淘汰/carry-over 全部可單元測試。 */

export type WindowVia = "passive" | "tool" | "link" | "pin" | "handoff" | "event";

export interface WindowEntry {
  memory: Memory;
  score: number; // 准入時的融合分（pin/handoff 用 importance、link 用固定低分）
  enteredTurn: number;
  lastRelevantTurn: number;
  pinned: boolean;
  via: WindowVia;
  expiresTurn?: number; // event 條目 TTL：beginTurn(t) 時 t >= expiresTurn 即移除
}

export interface AdmitOptions {
  score: number;
  turn: number;
  via: WindowVia;
  pinned?: boolean;
  ttlTurns?: number;
}

export class MemoryWindow {
  private byId = new Map<string, WindowEntry>();

  constructor(
    private readonly capacity = WINDOW_CAPACITY,
    private readonly charBudget = WINDOW_CHAR_BUDGET,
  ) {}

  /** 准入：已在窗內 → refresh（score 取 max、lastRelevantTurn 更新）；新條目 → 加入後檢查預算淘汰。
   *  回傳 true = 新進窗、false = refresh。 */
  admit(memory: Memory, opts: AdmitOptions): boolean {
    const existing = this.byId.get(memory.id);
    if (existing) {
      existing.score = Math.max(existing.score, opts.score);
      existing.lastRelevantTurn = opts.turn;
      existing.pinned = existing.pinned || (opts.pinned ?? false);
      existing.expiresTurn = undefined; // 再次相關 → 解除 TTL
      return false;
    }
    this.byId.set(memory.id, {
      memory,
      score: opts.score,
      enteredTurn: opts.turn,
      lastRelevantTurn: opts.turn,
      pinned: opts.pinned ?? false,
      via: opts.via,
      expiresTurn: opts.ttlTurns !== undefined ? opts.turn + opts.ttlTurns : undefined,
    });
    this.evictOverBudget();
    return true;
  }

  /** 每輪開始：清掉過期的 event 條目。 */
  beginTurn(turn: number): void {
    for (const [id, e] of this.byId) {
      if (e.expiresTurn !== undefined && turn >= e.expiresTurn) this.byId.delete(id);
    }
  }

  /** 場景切換 carry-over（§4.5）：private 且不屬於新場景的踢出。回傳被踢的條目。 */
  carryOver(newContext: string): WindowEntry[] {
    const evicted: WindowEntry[] = [];
    for (const [id, e] of this.byId) {
      const m = e.memory;
      const keep =
        m.context === newContext || m.context === "any" || m.privacyLevel !== "private";
      if (!keep) {
        evicted.push(e);
        this.byId.delete(id);
      }
    }
    return evicted;
  }

  /** score 由高到低（展示/除錯用）。 */
  entries(): WindowEntry[] {
    return [...this.byId.values()].sort((a, b) => b.score - a.score);
  }

  /** 插入序（Map 天然保序）：prompt render 用 — refresh 不重排，prefix cache 才有命中可言。 */
  stableEntries(): WindowEntry[] {
    return [...this.byId.values()];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get size(): number {
    return this.byId.size;
  }

  charSize(): number {
    let total = 0;
    for (const e of this.byId.values()) total += e.memory.content.length;
    return total;
  }

  /** 超容量/超字數 → 淘汰 lastRelevantTurn 最舊者，同齡淘汰 score 低者。pinned 豁免。 */
  private evictOverBudget(): void {
    while (this.byId.size > this.capacity || this.charSize() > this.charBudget) {
      const candidates = [...this.byId.values()]
        .filter((e) => !e.pinned)
        .sort((a, b) => a.lastRelevantTurn - b.lastRelevantTurn || a.score - b.score);
      const victim = candidates[0];
      if (!victim) return; // 全 pinned：pin 由呼叫端限量，不強拆
      this.byId.delete(victim.memory.id);
    }
  }
}
