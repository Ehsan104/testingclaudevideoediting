import { useCallback, useEffect, useRef, useState } from "react";
import { MediaAsset, uid } from "./types";
import { opAddClip, opDeleteClips, opSplitAt, projectDuration, useProject } from "./store";
import { analyzeAsset } from "./ai/analysis";
import { decodeAudio, detectSilences, transcribe, TranscribeQuality } from "./ai/transcribe";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import Preview from "./components/Preview";
import ChatPanel from "./components/ChatPanel";
import Timeline from "./components/Timeline";
import ExportDialog from "./components/ExportDialog";

export interface PreviewToggles {
  captions: boolean;
  safeZones: boolean;
  guides: boolean;
  trackingBoxes: boolean;
  faceDetection: boolean;
  sceneDetection: boolean;
  transcript: boolean;
}

export default function App() {
  const { project, canUndo, canRedo, commit, undo, redo } = useProject();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [exportOpen, setExportOpen] = useState<false | { preset?: string }>(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [toggles, setToggles] = useState<PreviewToggles>({
    captions: true,
    safeZones: false,
    guides: false,
    trackingBoxes: false,
    faceDetection: false,
    sceneDetection: false,
    transcript: false,
  });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [transcribeQuality, setTranscribeQuality] = useState<TranscribeQuality>(
    () => (localStorage.getItem("ltl.transcribeQuality") as TranscribeQuality) || "balanced"
  );
  const qualityRef = useRef(transcribeQuality);
  qualityRef.current = transcribeQuality;

  const duration = projectDuration(project);
  const projectRef = useRef(project);
  projectRef.current = project;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  // ---- autosave every edit to this browser; restore on load ----
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!restoredRef.current) {
      restoredRef.current = true;
      try {
        const saved = localStorage.getItem("ltl.autosave");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed?.tracks?.length && (parsed.clips?.length || parsed.subtitles?.length)) {
            commit(parsed);
            return; // skip saving the empty project over the restore
          }
        }
      } catch {
        // corrupt autosave: ignore
      }
    }
    try {
      localStorage.setItem("ltl.autosave", JSON.stringify(project));
    } catch {
      // storage full/unavailable: autosave is best-effort
    }
  }, [project, commit]);

  // ---- media import (Step 2 + 3: upload then automatic AI analysis) ----
  const patchAsset = useCallback((id: string, patch: (a: MediaAsset) => MediaAsset) => {
    setAssets((list) => list.map((a) => (a.id === id ? patch(a) : a)));
  }, []);

  // Real analysis: decode audio in-browser, detect true silences, then run
  // Whisper (transformers.js, in a worker) for an exact word-level transcript.
  // The simulated analysis stays as a fallback for undecodable files.
  const runRealAnalysis = useCallback(
    async (assetId: string, url: string) => {
      try {
        patchAsset(assetId, (a) => ({ ...a, transcription: { state: "decoding" } }));
        const pcm = await decodeAudio(url);
        const silences = detectSilences(pcm);
        patchAsset(assetId, (a) => ({
          ...a,
          analysis: a.analysis ? { ...a.analysis, silences } : a.analysis,
        }));
        const words = await transcribe(
          pcm,
          (u) =>
            patchAsset(assetId, (a) => ({
              ...a,
              transcription: { state: u.status, progress: u.progress },
            })),
          qualityRef.current
        );
        patchAsset(assetId, (a) => ({
          ...a,
          transcription: { state: "real" },
          analysis: a.analysis
            ? { ...a.analysis, transcript: words, silences }
            : { transcript: words, silences, scenes: [], speakers: ["Speaker 1"], highlights: [] },
        }));
      } catch (err: any) {
        patchAsset(assetId, (a) => ({
          ...a,
          transcription: { state: "simulated", error: String(err?.message ?? err) },
        }));
      }
    },
    [patchAsset]
  );

  // After an autosave restore, clips reference asset ids from the previous
  // session (blob URLs don't survive reloads). Re-importing a file with the
  // same name relinks those clips to the fresh asset.
  const relinkClips = useCallback(
    (asset: MediaAsset) => {
      const known = new Set(assetsRef.current.map((a) => a.id));
      known.add(asset.id);
      const proj = projectRef.current;
      const needsRelink = proj.clips.some(
        (c) => c.assetId && !known.has(c.assetId) && c.name.includes(asset.name)
      );
      if (!needsRelink) return;
      commit({
        ...proj,
        clips: proj.clips.map((c) =>
          c.assetId && !known.has(c.assetId) && c.name.includes(asset.name)
            ? { ...c, assetId: asset.id }
            : c
        ),
      });
    },
    [commit]
  );

  const importFiles = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const url = URL.createObjectURL(file);
        const type = file.type.startsWith("audio")
          ? "audio"
          : file.type.startsWith("image")
            ? "image"
            : "video";
        if (type === "image") {
          const asset: MediaAsset = {
            id: uid("asset"), name: file.name, type, url, duration: 5,
          };
          setAssets((a) => [...a, asset]);
          relinkClips(asset);
          continue;
        }
        const probe = document.createElement(type === "audio" ? "audio" : "video") as HTMLVideoElement;
        probe.preload = "metadata";
        probe.src = url;
        probe.onloadedmetadata = () => {
          const d = Number.isFinite(probe.duration) ? probe.duration : 60;
          const asset: MediaAsset = {
            id: uid("asset"),
            name: file.name,
            type,
            url,
            duration: d,
            width: probe.videoWidth || undefined,
            height: probe.videoHeight || undefined,
            analysis: analyzeAsset(file.name, d),
            transcription: { state: "decoding" },
          };
          setAssets((a) => [...a, asset]);
          relinkClips(asset);
          runRealAnalysis(asset.id, url);
        };
        probe.onerror = () => {
          const asset: MediaAsset = {
            id: uid("asset"), name: file.name, type, url, duration: 60,
            analysis: analyzeAsset(file.name, 60),
            transcription: { state: "simulated", error: "Browser could not decode this file" },
          };
          setAssets((a) => [...a, asset]);
        };
      }
    },
    [runRealAnalysis, relinkClips]
  );

  // Real thumbnail generation: grab the current preview frame onto a canvas,
  // overlay the project title, download as PNG(s).
  const generateThumbnails = useCallback((count: number) => {
    const video = document.querySelector<HTMLVideoElement>(".monitor-video");
    if (!video || !(video instanceof HTMLVideoElement) || video.readyState < 2) return;
    const banners = ["#7c5cff", "#ff453a", "#ffd60a", "#00c2a8", "#ff6482"];
    for (let i = 0; i < Math.min(count, 5); i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#000";
      g.fillRect(0, 0, 1280, 720);
      const ar = video.videoWidth / video.videoHeight || 16 / 9;
      const w = ar > 16 / 9 ? 1280 : 720 * ar;
      const h = ar > 16 / 9 ? 1280 / ar : 720;
      g.drawImage(video, (1280 - w) / 2, (720 - h) / 2, w, h);
      g.fillStyle = banners[i % banners.length];
      g.globalAlpha = 0.9;
      g.fillRect(0, 560, 1280, 110);
      g.globalAlpha = 1;
      g.fillStyle = "#fff";
      g.font = "bold 64px Inter, sans-serif";
      g.textBaseline = "middle";
      g.fillText(projectRef.current.name.toUpperCase(), 48, 615, 1184);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `thumbnail_${i + 1}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    }
  }, []);

  const addToTimeline = useCallback(
    (asset: MediaAsset) => commit(opAddClip(projectRef.current, asset)),
    [commit]
  );

  const splitAtPlayhead = useCallback(() => {
    const p = projectRef.current;
    const next = opSplitAt(p, playhead, selected.length ? selected : undefined);
    if (next !== p) commit(next);
  }, [commit, playhead, selected]);

  const deleteSelected = useCallback(
    (ripple: boolean) => {
      if (!selected.length) return;
      commit(opDeleteClips(projectRef.current, selected, ripple));
      setSelected([]);
    },
    [commit, selected]
  );

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) {
        splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelected(e.shiftKey);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        e.preventDefault();
        redo();
      } else if (e.key === "ArrowRight") {
        setPlaying(false);
        setPlayhead((t) => Math.min(duration, t + (e.shiftKey ? 1 : 1 / 30)));
      } else if (e.key === "ArrowLeft") {
        setPlaying(false);
        setPlayhead((t) => Math.max(0, t - (e.shiftKey ? 1 : 1 / 30)));
      } else if (e.key === "Home") {
        setPlayhead(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitAtPlayhead, deleteSelected, undo, redo, duration]);

  const seek = useCallback((t: number) => {
    setPlayhead(Math.max(0, t));
  }, []);

  return (
    <div className="app">
      <TopBar
        project={project}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onRename={(name) => commit({ ...project, name })}
        onSave={() => setSavedAt(Date.now())}
        savedAt={savedAt}
        onExport={() => setExportOpen({})}
        onToggleChat={() => setChatOpen((v) => !v)}
        chatOpen={chatOpen}
      />
      <div className="main-row">
        <Sidebar
          assets={assets}
          project={project}
          onImport={importFiles}
          onAddToTimeline={addToTimeline}
          onSeek={seek}
          onCommit={commit}
          onRetranscribe={(a) => runRealAnalysis(a.id, a.url)}
          transcribeQuality={transcribeQuality}
          onTranscribeQualityChange={(q) => {
            setTranscribeQuality(q);
            localStorage.setItem("ltl.transcribeQuality", q);
          }}
        />
        <div className="center-col">
          <Preview
            project={project}
            assets={assets}
            playhead={playhead}
            playing={playing}
            playbackRate={playbackRate}
            duration={duration}
            toggles={toggles}
            onTogglesChange={setToggles}
            onPlayingChange={setPlaying}
            onRateChange={setPlaybackRate}
            onSeek={seek}
          />
        </div>
        {chatOpen && (
          <ChatPanel
            project={project}
            assets={assets}
            playhead={playhead}
            selected={selected}
            onCommit={commit}
            onUndo={undo}
            onRedo={redo}
            onSeek={seek}
            onOpenExport={(preset) => setExportOpen({ preset })}
            onSelect={setSelected}
            onThumbnail={generateThumbnails}
          />
        )}
      </div>
      <Timeline
        project={project}
        assets={assets}
        playhead={playhead}
        selected={selected}
        onSelect={setSelected}
        onSeek={seek}
        onCommit={commit}
        onSplit={splitAtPlayhead}
        onDelete={deleteSelected}
      />
      {exportOpen && (
        <ExportDialog
          project={project}
          duration={duration}
          initialPreset={exportOpen.preset}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
