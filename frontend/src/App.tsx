import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeviceState, type ToolCall, type WindowEntry } from "./api.js";
import { Conversation, type Message } from "./components/Conversation.js";
import { DataSources } from "./components/DataSources.js";
import { DeviceBoard, deviceRows } from "./components/DeviceBoard.js";
import { Inspector } from "./components/Inspector.js";
import { RotateIcon, WavesIcon } from "./components/icons.js";
import { Stage, type Announcement } from "./components/Stage.js";
import { useGeo } from "./hooks/useGeo.js";

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
  // 最近一次導航的 Google Maps 直開連結（live 路線才有）— 場景切換/reset 時清
  const [mapsUrl, setMapsUrl] = useState<string | null>(null);
  // 本輪進行中的工具活動（SSE 即時推）— 過程可見，不然長回合看起來像卡死
  const [activity, setActivity] = useState<ToolCall[]>([]);
  const hydrated = useRef(false);
  // 真實資料雙軌：GPS 拿得到就 live、拿不到全 mock；面板可手動關單一來源
  const geo = useGeo();
  const [disabledSources, setDisabledSources] = useState<Set<string>>(new Set());
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const disabledRef = useRef(disabledSources);
  disabledRef.current = disabledSources;
  const toggleSource = useCallback((key: string) => {
    setDisabledSources((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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
    setActivity([]);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const r = await api.chat(text, {
        location: geoRef.current.loc,
        disabled: [...disabledRef.current],
        onTool: (tc) => setActivity((a) => [...a, tc]),
      });
      setMessages((m) => [
        ...m,
        { role: "astra", text: r.reply, toolCalls: r.toolCalls as ToolCall[], escalated: r.escalated },
      ]);
      setWindow(r.window);
      setDeviceState(r.deviceState);
      setContext(r.context);
      setAnnouncement((a) => ({ id: (a?.id ?? 0) + 1, text: r.reply }));
      const mu = r.toolCalls.map((tc) => tc.result?.maps_url).find((u) => typeof u === "string");
      if (mu) setMapsUrl(mu as string);
    } catch (e) {
      setMessages((m) => [...m, { role: "system", text: `error: ${(e as Error).message}` }]);
    } finally {
      // activity 不清 — 回覆出現後工具 feed 留在畫面（下一輪 send 開頭才清），太快消失會看不到
      setBusy(false);
    }
  }, []);

  const switchScene = useCallback(
    async (scene: string) => {
      if (scene === context || busy) return;
      setBusy(true);
      try {
        const r = await api.scene(scene);
        setMapsUrl(null);
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
      setMapsUrl(null);
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
      <div data-scene={context}>
        <Stage
          context={context}
          busy={busy}
          announcement={announcement}
          activity={activity}
          deviceRows={deviceState ? deviceRows(deviceState, context) : []}
          mapsUrl={mapsUrl}
          geoStatus={geo.status}
          sourcesPanel={
            <DataSources geoStatus={geo.status} disabled={disabledSources} onToggle={toggleSource} />
          }
          onSend={send}
          onSwitchScene={switchScene}
          onInspector={() => setMode("inspector")}
        />
      </div>
    );
  }

  return (
    <div data-scene={context} className="flex h-screen flex-col bg-[var(--sea)] transition-colors duration-500">
      <header className="flex items-center gap-6 border-b border-[var(--accent-faint)] px-6 py-3">
        <h1 className="text-sm tracking-[0.35em] text-[var(--accent)]">A S T R A</h1>
        <nav className="flex gap-4 text-[12px] uppercase tracking-[0.15em]">
          {SCENES.map((s) => (
            <button
              key={s}
              onClick={() => switchScene(s)}
              className={`border-b pb-0.5 transition-colors ${
                s === context
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--accent-dim)] hover:text-[var(--ink)]"
              }`}
            >
              {s === context ? "◉ " : ""}
              {s === "driving" ? "car" : s}
            </button>
          ))}
        </nav>
        <div className="grow" />
        <button
          onClick={() => setMode("stage")}
          className="flex items-center gap-1.5 rounded-sm border border-[var(--accent-faint)] px-3 py-1 text-[11px] uppercase tracking-wider text-[var(--accent-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <WavesIcon /> stage
        </button>
        <button
          onClick={reset}
          className="flex items-center gap-1.5 rounded-sm border border-[var(--accent-faint)] px-3 py-1 text-[11px] uppercase tracking-wider text-[var(--accent-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <RotateIcon /> reset
        </button>
      </header>
      <main className="grid min-h-0 grow grid-cols-[280px_1fr_340px]">
        <aside className="space-y-6 overflow-y-auto border-r border-[var(--accent-faint)] p-4">
          {deviceState && <DeviceBoard state={deviceState} context={context} />}
          <DataSources geoStatus={geo.status} disabled={disabledSources} onToggle={toggleSource} />
        </aside>
        <Conversation messages={messages} busy={busy} activity={activity} onSend={send} />
        <aside className="overflow-y-auto border-l border-[var(--accent-faint)] p-4">
          <Inspector entries={window_} />
        </aside>
      </main>
    </div>
  );
}
