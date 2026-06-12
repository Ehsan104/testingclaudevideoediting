import { useEffect, useRef, useState } from "react";
import { ChatMessage, MediaAsset, ProjectState, uid } from "../types";
import { runAgent } from "../ai/agent";

interface Props {
  project: ProjectState;
  assets: MediaAsset[];
  playhead: number;
  selected: string[];
  onCommit: (p: ProjectState) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSeek: (t: number) => void;
  onOpenExport: (preset?: string) => void;
  onSelect: (ids: string[]) => void;
  onThumbnail: (count: number) => void;
}

const SUGGESTIONS = [
  "Add subtitles",
  "Remove all dead space",
  "Remove all filler words",
  "Hormozi style captions",
  "Trim first 3 seconds",
  "Fade out the ending",
  "Add a call to action",
  "Speed up 2x",
  "Generate 5 shorts",
  "Generate thumbnail",
];

declare global {
  interface Window {
    webkitSpeechRecognition?: any;
    SpeechRecognition?: any;
  }
}

export default function ChatPanel(p: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: uid("msg"),
      role: "assistant",
      text: "Hi! I'm your editing assistant. Upload media, add it to the timeline, then tell me what to do — “add subtitles”, “remove everything between 0:10 and 0:25”, “make it cinematic”…",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const userMsg: ChatMessage = { id: uid("msg"), role: "user", text: trimmed };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setBusy(true);

    // small delay so the assistant feels responsive but visibly "thinks"
    setTimeout(() => {
      setMessages((prev) => {
        const lastAssistant = [...prev].reverse().find((m) => m.role === "assistant");
        // confirmation flow: "yes" applies the pending action
        if (lastAssistant?.pending && /^(yes|y|yeah|yep|apply|do it|confirm|go ahead|sure)\b/i.test(trimmed)) {
          p.onCommit(lastAssistant.pending.apply(p.project));
          return [
            ...prev.map((m) => (m.id === lastAssistant.id ? { ...m, pending: null } : m)),
            { id: uid("msg"), role: "assistant" as const, text: `Done — ${lastAssistant.pending.description.toLowerCase()}. The timeline has been updated.` },
          ];
        }
        if (lastAssistant?.pending && /^(no|n|nope|cancel|don't|skip)\b/i.test(trimmed)) {
          return [
            ...prev.map((m) => (m.id === lastAssistant.id ? { ...m, pending: null } : m)),
            { id: uid("msg"), role: "assistant" as const, text: "No problem, I left everything as it was." },
          ];
        }

        const result = runAgent(trimmed, {
          project: p.project,
          assets: p.assets,
          playhead: p.playhead,
          selectedClipIds: p.selected,
        });
        if (result.next) p.onCommit(result.next);
        if (result.effect?.type === "undo") p.onUndo();
        if (result.effect?.type === "redo") p.onRedo();
        if (result.effect?.type === "seek") p.onSeek(result.effect.time);
        if (result.effect?.type === "openExport") p.onOpenExport(result.effect.preset);
        if (result.effect?.type === "select") p.onSelect(result.effect.ids);
        if (result.effect?.type === "thumbnail") p.onThumbnail(result.effect.count);
        return [
          ...prev,
          { id: uid("msg"), role: "assistant" as const, text: result.reply, pending: result.pending ?? null },
        ];
      });
      setBusy(false);
    }, 350);
  };

  const toggleVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setMessages((m) => [...m, { id: uid("msg"), role: "assistant", text: "Voice commands need a browser with the Web Speech API (Chrome/Edge). You can keep typing instead." }]);
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    recognitionRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const text = e.results[0][0].transcript;
      setListening(false);
      send(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    setListening(true);
  };

  const pendingActive = messages.some((m) => m.pending);

  return (
    <aside className="chat">
      <div className="chat-header">
        <span>✦ AI Assistant</span>
        <span className="chat-sub">timeline-aware</span>
      </div>
      <div className="chat-messages" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.text.split("\n").map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            {m.pending && (
              <div className="confirm-row">
                <button className="mini-btn" onClick={() => send("yes")}>Apply</button>
                <button className="mini-btn ghost" onClick={() => send("no")}>Cancel</button>
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant thinking">Analyzing…</div>}
      </div>
      {!pendingActive && (
        <div className="chat-suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      )}
      <div className="chat-input-row">
        <button
          className={listening ? "mic-btn listening" : "mic-btn"}
          title="Voice command"
          onClick={toggleVoice}
        >
          {listening ? "● Listening" : "🎤"}
        </button>
        <input
          value={input}
          placeholder="Tell me what to edit…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
        />
        <button className="send-btn" onClick={() => send(input)} disabled={!input.trim() || busy}>
          ➤
        </button>
      </div>
    </aside>
  );
}
