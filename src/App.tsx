import { useCallback, useEffect, useRef, useState } from "react";
import { MediaAsset, uid } from "./types";
import { opAddClip, opDeleteClips, opSplitAt, projectDuration, useProject } from "./store";
import { analyzeAsset } from "./ai/analysis";
import { decodeAudio, detectSilences, transcribe } from "./ai/transcribe";
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

  const duration = projectDuration(project);
  const projectRef = useRef(project);
  projectRef.current = project;

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
        const words = await transcribe(pcm, (u) =>
          patchAsset(assetId, (a) => ({
            ...a,
            transcription: { state: u.status, progress: u.progress },
          }))
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
    [runRealAnalysis]
  );

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
