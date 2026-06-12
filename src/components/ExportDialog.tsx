import { useEffect, useState } from "react";
import { ProjectState } from "../types";
import { formatTimeShort } from "../utils/time";

interface Props {
  project: ProjectState;
  duration: number;
  initialPreset?: string;
  onClose: () => void;
}

const PRESETS: Record<string, { format: string; resolution: string; aspect: string }> = {
  "YouTube": { format: "MP4", resolution: "1080p", aspect: "16:9" },
  "TikTok": { format: "MP4", resolution: "1080p", aspect: "9:16" },
  "Instagram Reels": { format: "MP4", resolution: "1080p", aspect: "9:16" },
  "Instagram Stories": { format: "MP4", resolution: "1080p", aspect: "9:16" },
  "LinkedIn": { format: "MP4", resolution: "1080p", aspect: "1:1" },
  "Facebook": { format: "MP4", resolution: "720p", aspect: "16:9" },
  "Podcast Clips": { format: "MP4", resolution: "1080p", aspect: "1:1" },
};

export default function ExportDialog(p: Props) {
  const [preset, setPreset] = useState(p.initialPreset && PRESETS[p.initialPreset] ? p.initialPreset : "YouTube");
  const [format, setFormat] = useState(PRESETS[preset]?.format ?? "MP4");
  const [resolution, setResolution] = useState(PRESETS[preset]?.resolution ?? "1080p");
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const pr = PRESETS[preset];
    if (pr) { setFormat(pr.format); setResolution(pr.resolution); }
  }, [preset]);

  useEffect(() => {
    if (progress === null || done) return;
    if (progress >= 100) { setDone(true); return; }
    const id = setTimeout(() => setProgress((v) => Math.min(100, (v ?? 0) + 3 + Math.random() * 9)), 120);
    return () => clearTimeout(id);
  }, [progress, done]);

  const startExport = () => setProgress(0);

  const downloadManifest = () => {
    // Browser builds can't transcode locally yet; we hand back the full
    // project description a render service would consume.
    const blob = new Blob(
      [JSON.stringify({ ...p.project, export: { preset, format, resolution } }, null, 2)],
      { type: "application/json" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.project.name.replace(/\s+/g, "_")}_${resolution}.${format.toLowerCase()}.render.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="modal-backdrop" onClick={p.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export “{p.project.name}”</h2>
        <p className="dim">Program duration: {formatTimeShort(p.duration)} · Aspect: {p.project.aspect} · {p.project.subtitles.length} captions</p>

        {progress === null ? (
          <>
            <label className="field">
              Platform preset
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {Object.keys(PRESETS).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <div className="field-row">
              <label className="field">
                Format
                <select value={format} onChange={(e) => setFormat(e.target.value)}>
                  {["MP4", "MOV", "WEBM"].map((f) => <option key={f}>{f}</option>)}
                </select>
              </label>
              <label className="field">
                Resolution
                <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                  {["720p", "1080p", "1440p", "4K"].map((r) => <option key={r}>{r}</option>)}
                </select>
              </label>
            </div>
            <div className="modal-actions">
              <button onClick={p.onClose}>Cancel</button>
              <button className="export-btn" onClick={startExport}>Start Export</button>
            </div>
          </>
        ) : !done ? (
          <>
            <div className="progress"><div style={{ width: `${progress}%` }} /></div>
            <p className="dim">Rendering {resolution} {format} ({preset})… {Math.round(progress)}%</p>
          </>
        ) : (
          <>
            <p>✅ Render complete.</p>
            <p className="dim">
              In-browser transcoding isn't wired up in this prototype, so the deliverable is a render manifest —
              the exact JSON a cloud render farm would consume (timeline, captions, effects, grade, preset).
            </p>
            <div className="modal-actions">
              <button onClick={p.onClose}>Close</button>
              <button className="export-btn" onClick={downloadManifest}>Download render manifest</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
