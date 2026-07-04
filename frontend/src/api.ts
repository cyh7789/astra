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
  chat: (message: string) => post<ChatResponse>("/api/chat", { message }),
  scene: (context: string) => post<SceneResponse>("/api/scene", { context }),
  reset: () => post<{ ok: boolean }>("/api/reset", {}),
  state: async (): Promise<StateResponse> => {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error(`/api/state failed: ${res.status}`);
    return res.json() as Promise<StateResponse>;
  },
};
