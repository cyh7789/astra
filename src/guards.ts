import type { ScoredMemory } from "./store.js";

export interface GuardContext {
  currentContext: string;
  now: Date;
}

export interface GuardedMemory extends ScoredMemory {
  annotations: string[];
  conflictsWith?: string[];
}

export interface ContradictsLink {
  sourceId: string;
  targetId: string;
}

export interface GuardDeps {
  loadContradictsLinks(ids: string[]): Promise<ContradictsLink[]>;
}

export interface RecallGuard {
  name: string;
  apply(
    memories: GuardedMemory[],
    ctx: GuardContext,
    deps: GuardDeps,
  ): Promise<GuardedMemory[]>;
}

export function toGuarded(memories: ScoredMemory[]): GuardedMemory[] {
  return memories.map((m) => ({ ...m, annotations: [] }));
}

/** 跨場景透明化：不攔截（SQL 層已過濾 private），標注來源讓 agent/使用者知道記憶從哪來。 */
export const PrivacyGuard: RecallGuard = {
  name: "privacy",
  async apply(memories, ctx) {
    return memories.map((m) => {
      const annotations = [...m.annotations];
      if (m.context !== ctx.currentContext && m.context !== "any") {
        annotations.push(`來自 ${m.context} 場景的記憶`);
      }
      if (m.sourceContext && m.sourceContext !== m.context) {
        annotations.push(`當時在 ${m.sourceContext} 場景提到`);
      }
      return annotations.length === m.annotations.length ? m : { ...m, annotations };
    });
  },
};

/** 過時標注：episodic 事件超過閾值提醒可能過時；semantic 是長期事實不標。 */
export const STALE_AFTER_DAYS = 14;

export const RecencyGuard: RecallGuard = {
  name: "recency",
  async apply(memories, ctx) {
    return memories.map((m) => {
      if (m.memoryType !== "episodic") return m;
      const ageDays = Math.floor((ctx.now.getTime() - m.createdAt.getTime()) / 86_400_000);
      if (ageDays < STALE_AFTER_DAYS) return m;
      return { ...m, annotations: [...m.annotations, `${ageDays} 天前的資訊，可能已過時`] };
    });
  },
};

/** 矛盾偵測：消費 memory_links 的 contradicts 邊（建邊是寫入時萃取器的職責）。
 *  兩端都在結果集才標注 — agent 據 conflictsWith 「問而不是猜」。 */
export const ConflictGuard: RecallGuard = {
  name: "conflict",
  async apply(memories, _ctx, deps) {
    const inSet = new Map(memories.map((m) => [m.id, m]));
    const links = await deps.loadContradictsLinks([...inSet.keys()]);
    const conflicts = new Map<string, Set<string>>();
    const add = (from: string, to: string) => {
      const set = conflicts.get(from) ?? new Set<string>();
      set.add(to);
      conflicts.set(from, set);
    };
    for (const { sourceId, targetId } of links) {
      if (!inSet.has(sourceId) || !inSet.has(targetId)) continue;
      add(sourceId, targetId);
      add(targetId, sourceId);
    }
    return memories.map((m) => {
      const others = conflicts.get(m.id);
      if (!others) return m;
      const conflictsWith = [...others];
      const summary = conflictsWith
        .map((id) => `「${inSet.get(id)!.content.slice(0, 20)}」`)
        .join("、");
      return {
        ...m,
        conflictsWith,
        annotations: [...m.annotations, `與記憶 ${summary} 矛盾，建議確認而非假設`],
      };
    });
  },
};

export const DEFAULT_GUARDS: RecallGuard[] = [PrivacyGuard, RecencyGuard, ConflictGuard];

export async function applyGuards(
  guards: RecallGuard[],
  memories: GuardedMemory[],
  ctx: GuardContext,
  deps: GuardDeps,
): Promise<GuardedMemory[]> {
  let out = memories;
  for (const g of guards) out = await g.apply(out, ctx, deps);
  return out;
}
