import type { DeviceState } from "../../server/device-state.js";

/** API client：型別直接借 server 的（type-only import，打包時零 runtime 依賴）。 */

export type { DeviceState };

export interface WindowEntry {
  id: string;
  content: string;
  memoryType: string;
  context: string;
  via: "passive" | "tool" | "link" | "pin" | "handoff" | "event";
  score: number;
  pinned: boolean;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface ChatResponse {
  reply: string;
  toolCalls: ToolCall[];
  admitted: Array<{ id: string; via: string; content: string }>;
  escalated: boolean;
  turns: number;
  context: string;
  window: WindowEntry[];
  deviceState: DeviceState;
}

export interface SceneResponse {
  context: string;
  surfaced: Array<{ id: string; content: string }>;
  evicted: Array<{ id: string; content: string }>;
  window: WindowEntry[];
  deviceState: DeviceState;
}

export interface StateResponse {
  context: string;
  turn: number;
  transcript: string[];
  digest: string;
  openThreads: string[];
  window: WindowEntry[];
  deviceState: DeviceState;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  /** SSE 版 chat：每次工具執行當下回呼 onTool（過程可見），完成回傳完整結果 */
  chat: async (
    message: string,
    opts?: {
      location?: { lat: number; lng: number } | null;
      disabled?: string[];
      onTool?: (t: ToolCall) => void;
    },
  ): Promise<ChatResponse> => {
    const res = await fetch("/api/chat?stream=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        location: opts?.location ?? undefined,
        disabled: opts?.disabled,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`/api/chat failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done: ChatResponse | null = null;
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frame: "event: x\ndata: {...}\n\n"
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!event || !data) continue;
        if (event === "tool") opts?.onTool?.(JSON.parse(data) as ToolCall);
        else if (event === "done") done = JSON.parse(data) as ChatResponse;
        else if (event === "error") throw new Error((JSON.parse(data) as { message: string }).message);
      }
    }
    if (!done) throw new Error("stream ended without result");
    return done;
  },
  scene: (context: string) => post<SceneResponse>("/api/scene", { context }),
  reset: () => post<{ ok: boolean }>("/api/reset", {}),
  state: async (): Promise<StateResponse> => {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error(`/api/state failed: ${res.status}`);
    return res.json() as Promise<StateResponse>;
  },
};
