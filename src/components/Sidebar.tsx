import { useRef, useState } from "react";
import { MediaAsset, ProjectState } from "../types";
import { opRemoveRange } from "../store";
import { timelineTranscript } from "../ai/agent";
import { TranscribeQuality } from "../ai/transcribe";
import { formatTimeShort } from "../utils/time";

interface Props {
  assets: MediaAsset[];
  project: ProjectState;
  onImport: (files: FileList) => void;
  onAddToTimeline: (asset: MediaAsset) => void;
  onSeek: (t: number) => void;
  onCommit: (p: ProjectState) => void;
  onRetranscribe: (asset: MediaAsset) => void;
  transcribeQuality: TranscribeQuality;
  onTranscribeQualityChange: (q: TranscribeQuality) => void;
}

const TABS = [
  { id: "media", icon: "🎞", label: "Media Library" },
  { id: "projects", icon: "📁", label: "Projects" },
  { id: "templates", icon: "📐", label: "Templates" },
  { id: "music", icon: "🎵", label: "Music" },
  { id: "graphics", icon: "✨", label: "Graphics" },
  { id: "transcript", icon: "💬", label: "Subtitles & Transcript" },
  { id: "brand", icon: "🏷", label: "Brand Assets" },
  { id: "stock", icon: "🌄", label: "Stock Footage" },
  { id: "ai", icon: "🤖", label: "AI Assets" },
] as const;

export default function Sidebar(p: Props) {
  const [tab, setTab] = useState<string>("media");
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const words = tab === "transcript" ? timelineTranscript(p.project, p.assets) : [];
  const filteredWords = search
    ? words.filter((w) => w.text.toLowerCase().includes(search.toLowerCase()))
    : words;

  return (
    <aside className="sidebar">
      <nav className="sidebar-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab active" : "tab"}
            title={t.label}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-icon">{t.icon}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-panel">
        <h3>{TABS.find((t) => t.id === tab)?.label}</h3>

        {tab === "media" && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept="video/mp4,video/quicktime,video/x-msvideo,video/x-matroska,video/webm,audio/mpeg,audio/wav,audio/aac,image/png,image/jpeg,image/svg+xml,image/webp"
              onChange={(e) => e.target.files && p.onImport(e.target.files)}
            />
            <div
              className={dragOver ? "dropzone over" : "dropzone"}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files.length) p.onImport(e.dataTransfer.files);
              }}
            >
              <strong>Import media</strong>
              <span>Drop files or click to browse</span>
              <span className="hint">MP4 · MOV · AVI · MKV · WEBM · MP3 · WAV · AAC · PNG · JPG · SVG · WEBP</span>
            </div>
            <label className="quality-row">
              Transcription quality
              <select
                value={p.transcribeQuality}
                onChange={(e) => p.onTranscribeQualityChange(e.target.value as TranscribeQuality)}
                title="Larger models are more accurate but slower and a bigger one-time download. Change it, then click Retry on a clip to re-transcribe."
              >
                <option value="fast">Fast (tiny model)</option>
                <option value="balanced">Balanced (base model)</option>
                <option value="accurate">Accurate (small model)</option>
              </select>
            </label>
            <div className="asset-list">
              {p.assets.length === 0 && <p className="empty">No media yet. Import files to get started — AI analysis (transcript, scenes, speakers, highlights) runs automatically.</p>}
              {p.assets.map((a) => (
                <div key={a.id} className="asset-card">
                  {a.type === "video" ? (
                    <video src={a.url} className="asset-thumb" muted preload="metadata" />
                  ) : a.type === "image" ? (
                    <img src={a.url} className="asset-thumb" alt="" />
                  ) : (
                    <div className="asset-thumb audio-thumb">🎵</div>
                  )}
                  <div className="asset-meta">
                    <span className="asset-name" title={a.name}>{a.name}</span>
                    <span className="asset-sub">
                      {a.type} · {formatTimeShort(a.duration)}
                      {a.analysis && ` · ${a.analysis.transcript.length} words · ${a.analysis.silences.length} silences`}
                    </span>
                    {a.transcription && (
                      <span className={`asset-sub transcribe-${a.transcription.state}`} title={a.transcription.error}>
                        {a.transcription.state === "decoding" && "🎧 Analyzing audio…"}
                        {a.transcription.state === "loading-model" &&
                          `⬇ Downloading speech model${a.transcription.progress ? ` ${a.transcription.progress}%` : "…"} (first time only)`}
                        {a.transcription.state === "transcribing" && "✍ Transcribing speech…"}
                        {a.transcription.state === "real" && "✓ Real transcript (Whisper)"}
                        {a.transcription.state === "simulated" && (
                          <>
                            ⚠ Using simulated transcript{" "}
                            <button className="mini-btn" onClick={() => p.onRetranscribe(a)}>Retry</button>
                          </>
                        )}
                      </span>
                    )}
                    <button className="mini-btn" onClick={() => p.onAddToTimeline(a)}>+ Add to timeline</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "transcript" && (
          <>
            <input
              className="search"
              placeholder="Search transcript…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {words.length === 0 ? (
              <p className="empty">No transcript yet. Add analyzed media to the timeline and the transcript appears here. Click a word to jump there; click ✕ to cut it from the video.</p>
            ) : (
              <div className="transcript">
                {filteredWords.map((w, i) => (
                  <span key={i} className={w.isFiller ? "tword filler" : "tword"}>
                    <button className="tword-text" title={`Jump to ${formatTimeShort(w.timelineStart)} (${w.speaker})`} onClick={() => p.onSeek(w.timelineStart)}>
                      {w.text}
                    </button>
                    <button
                      className="tword-x"
                      title="Cut this word from the video"
                      onClick={() => p.onCommit(opRemoveRange(p.project, w.timelineStart, w.timelineEnd))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="hint" style={{ marginTop: 8 }}>
              Editing the transcript edits the video. Filler words are tinted red — ask the AI to “remove all filler words”.
            </p>
          </>
        )}

        {tab === "music" && (
          <p className="empty">
            Royalty-free library coming soon. For now, import audio files in the Media Library and ask the AI to
            “add upbeat background music” — it will place, duck, and fade it automatically.
          </p>
        )}
        {tab === "projects" && <p className="empty">This prototype keeps one project in memory. Use Save in the top bar; multi-project storage is on the roadmap.</p>}
        {tab === "templates" && <p className="empty">Subtitle + intro templates land here. Try asking the AI for “TikTok-style captions” to use a built-in style.</p>}
        {tab === "graphics" && <p className="empty">Lower-thirds and stickers land here. Ask the AI to “add dramatic zooms” to add effect clips today.</p>}
        {tab === "brand" && <p className="empty">Upload brand fonts, colors, and logos here in a future release.</p>}
        {tab === "stock" && <p className="empty">Stock footage search is on the roadmap.</p>}
        {tab === "ai" && <p className="empty">AI-generated thumbnails, titles, and voiceovers will appear here after you run commands like “generate 5 shorts”.</p>}
      </div>
    </aside>
  );
}
