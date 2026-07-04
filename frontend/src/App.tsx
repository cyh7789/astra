import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeviceState, type ToolCall, type WindowEntry } from "./api.js";
import { Conversation, type Message } from "./components/Conversation.js";
import { DeviceBoard, deviceRows } from "./components/DeviceBoard.js";
import { Inspector } from "./components/Inspector.js";
import { Stage, type Announcement } from "./components/Stage.js";

const SCENES = ["driving", "office", "home"] as const;

/** 落庫 transcript → 對話流（分頁載入/跨終端 resume 時還原歷史）。 */
function messagesFromTranscript(transcript: string[]): Message[] {
  return transcript.map((line) => {
    if (line.startsWith("User: ")) return { role: "user" as const, text: line.slice(6) };
    if (line.startsWith("(You): ")) return { role: "astra" as const, text: line.slice(7) };
    return { role: "system" as const, text: line.replace(/^System: /, "") };
  });
}

export default function App() {
  const [context, setContext] = useState("home");
  const [messages, setMessages] = useState<Message[]>([]);
  const [window_, setWindow] = useState<WindowEntry[]>([]);
  const [deviceState, setDeviceState] = useState<DeviceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"stage" | "inspector">("stage");
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return; // StrictMode 雙跑防重複載入
    hydrated.current = true;
    api.state().then((s) => {
      setContext(s.context);
      setMessages(messagesFromTranscript(s.transcript));
      setWindow(s.window);
      setDeviceState(s.deviceState);
    });
  }, []);

  const send = useCallback(async (text: string) => {
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const r = await api.chat(text);
      setMessages((m) => [
        ...m,
        { role: "astra", text: r.reply, toolCalls: r.toolCalls as ToolCall[], escalated: r.escalated },
      ]);
      setWindow(r.window);
      setDeviceState(r.deviceState);
      setContext(r.context);
      setAnnouncement((a) => ({ id: (a?.id ?? 0) + 1, text: r.reply }));
    } catch (e) {
      setMessages((m) => [...m, { role: "system", text: `error: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }, []);

  const switchScene = useCallback(
    async (scene: string) => {
      if (scene === context || busy) return;
      setBusy(true);
      try {
        const r = await api.scene(scene);
        setContext(r.context);
        setWindow(r.window);
        setDeviceState(r.deviceState);
        const notes = [
          `scene switched → ${r.context}`,
          ...r.surfaced.map((s) => `↑ surfaced: ${s.content}`),
          ...r.evicted.map((e) => `↓ private, left behind: ${e.content}`),
        ];
        setMessages((m) => [...m, ...notes.map((text) => ({ role: "system" as const, text }))]);
      } finally {
        setBusy(false);
      }
    },
    [context, busy],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      await api.reset();
      const s = await api.state();
      setContext(s.context);
      setMessages([]);
      setWindow(s.window);
      setDeviceState(s.deviceState);
    } finally {
      setBusy(false);
    }
  }, []);

  if (mode === "stage") {
    return (
      <Stage
        context={context}
        busy={busy}
        announcement={announcement}
        deviceRows={deviceState ? deviceRows(deviceState, context) : []}
        onSend={send}
        onSwitchScene={switchScene}
        onInspector={() => setMode("inspector")}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-[var(--amber-dim)] px-4 py-2">
        <h1 className="text-lg font-bold tracking-widest">ASTRA</h1>
        <nav className="flex gap-1">
          {SCENES.map((s) => (
            <button
              key={s}
              onClick={() => switchScene(s)}
              className={`px-3 py-1 text-sm uppercase tracking-wider ${
                s === context
                  ? "bg-[var(--amber)] text-[var(--sea)]"
                  : "border border-[var(--amber-dim)] hover:border-[var(--amber)]"
              }`}
            >
              {s}
            </button>
          ))}
        </nav>
        <div className="grow" />
        <button
          onClick={() => setMode("stage")}
          className="border border-[var(--amber-dim)] px-3 py-1 text-sm hover:border-[var(--amber)]"
        >
          stage
        </button>
        <button
          onClick={reset}
          className="border border-[var(--amber-dim)] px-3 py-1 text-sm hover:border-[var(--amber)]"
        >
          reset
        </button>
      </header>
      <main className="grid min-h-0 grow grid-cols-[280px_1fr_320px]">
        <aside className="overflow-y-auto border-r border-[var(--amber-dim)] p-3">
          {deviceState && <DeviceBoard state={deviceState} context={context} />}
        </aside>
        <Conversation messages={messages} busy={busy} onSend={send} />
        <aside className="overflow-y-auto border-l border-[var(--amber-dim)] p-3">
          <Inspector entries={window_} />
        </aside>
      </main>
    </div>
  );
}
