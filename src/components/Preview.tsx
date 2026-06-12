import { useEffect, useMemo, useRef, useState } from "react";
import { Clip, MediaAsset, ProjectState } from "../types";
import { PreviewToggles } from "../App";
import { formatTime } from "../utils/time";

interface Props {
  project: ProjectState;
  assets: MediaAsset[];
  playhead: number;
  playing: boolean;
  playbackRate: number;
  duration: number;
  toggles: PreviewToggles;
  onTogglesChange: (t: PreviewToggles) => void;
  onPlayingChange: (v: boolean) => void;
  onRateChange: (r: number) => void;
  onSeek: (t: number) => void;
}

const ASPECT: Record<string, string> = {
  "16:9": "16 / 9",
  "9:16": "9 / 16",
  "1:1": "1 / 1",
  "4:5": "4 / 5",
};

function isAudible(p: ProjectState, trackId: string): boolean {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track || track.muted) return false;
  const anySolo = p.tracks.some((t) => t.solo);
  return !anySolo || track.solo;
}

function clipAt(p: ProjectState, kind: "video" | "audio", t: number): Clip[] {
  const found: Clip[] = [];
  for (const track of p.tracks) {
    if (track.kind !== kind) continue;
    const c = p.clips.find(
      (c) => c.trackId === track.id && c.kind === "media" && t >= c.start && t < c.start + c.duration
    );
    if (c) found.push(c);
  }
  return found;
}

export default function Preview(p: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const containerRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(1);
  const [zoom, setZoom] = useState(1);

  const videoClips = clipAt(p.project, "video", p.playhead);
  const activeVideo = videoClips[0] ?? null; // topmost video track wins
  const activeAsset = activeVideo ? p.assets.find((a) => a.id === activeVideo.assetId) : null;
  const audioClips = clipAt(p.project, "audio", p.playhead).filter((c) => isAudible(p.project, c.trackId));
  const videoAudible = activeVideo ? isAudible(p.project, activeVideo.trackId) : false;

  const activeEffects = p.project.clips.filter(
    (c) => c.kind === "effect" && p.playhead >= c.start && p.playhead < c.start + c.duration
  );
  const zoomFx = activeEffects.find((e) => e.effect === "zoom");
  const blurFx = activeEffects.find((e) => e.effect === "blur");
  const dissolveFx = activeEffects.find((e) => e.effect === "cross-dissolve");

  const subtitle = p.toggles.captions
    ? p.project.subtitles.find((s) => p.playhead >= s.start && p.playhead <= s.end)
    : null;
  const st = p.project.subtitleStyle;

  // ---- keep the active <video> in sync with the playhead ----
  const targetTime = activeVideo
    ? activeVideo.inPoint + (p.playhead - activeVideo.start) * activeVideo.speed
    : 0;

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !activeVideo) return;
    if (Math.abs(v.currentTime - targetTime) > 0.2) v.currentTime = targetTime;
    v.playbackRate = p.playbackRate * activeVideo.speed;
    v.volume = videoAudible ? volume * activeVideo.volume : 0;
    if (p.playing && v.paused) v.play().catch(() => {});
    if (!p.playing && !v.paused) v.pause();
  });

  // audio clip elements
  useEffect(() => {
    for (const [id, el] of audioRefs.current) {
      const clip = audioClips.find((c) => c.id === id);
      if (!clip) { el.pause(); continue; }
      const t = clip.inPoint + (p.playhead - clip.start);
      if (Math.abs(el.currentTime - t) > 0.25) el.currentTime = t;
      el.volume = volume * clip.volume;
      el.playbackRate = p.playbackRate;
      if (p.playing && el.paused) el.play().catch(() => {});
      if (!p.playing && !el.paused) el.pause();
    }
  });

  // ---- transport clock ----
  const raf = useRef(0);
  const lastTick = useRef(0);
  useEffect(() => {
    if (!p.playing) return;
    lastTick.current = performance.now();
    const tick = (now: number) => {
      const v = videoRef.current;
      if (activeVideo && v && !v.paused && v.readyState >= 2) {
        // let the video element drive the clock for A/V accuracy
        const t = activeVideo.start + (v.currentTime - activeVideo.inPoint) / activeVideo.speed;
        p.onSeek(Math.max(p.playhead, Math.min(t, activeVideo.start + activeVideo.duration)));
      } else {
        p.onSeek(p.playhead + ((now - lastTick.current) / 1000) * p.playbackRate);
      }
      lastTick.current = now;
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  });

  useEffect(() => {
    if (p.playing && p.duration > 0 && p.playhead >= p.duration) {
      p.onPlayingChange(false);
    }
  }, [p.playing, p.playhead, p.duration]);

  const sceneNearby = useMemo(() => {
    if (!p.toggles.sceneDetection || !activeVideo) return false;
    const asset = p.assets.find((a) => a.id === activeVideo.assetId);
    return !!asset?.analysis?.scenes.some((s) => Math.abs(s - targetTime) < 0.5);
  }, [p.toggles.sceneDetection, activeVideo, targetTime, p.assets]);

  const subPos =
    st.position === "top" ? { top: "8%" } : st.position === "middle" ? { top: "45%" } : { bottom: "10%" };

  const toggleBtn = (key: keyof PreviewToggles, label: string) => (
    <button
      className={p.toggles[key] ? "pv-toggle active" : "pv-toggle"}
      onClick={() => p.onTogglesChange({ ...p.toggles, [key]: !p.toggles[key] })}
    >
      {label}
    </button>
  );

  return (
    <div className="preview">
      <div className="preview-stage">
        <div
          ref={containerRef}
          className="monitor"
          style={{
            aspectRatio: ASPECT[p.project.aspect],
            transform: `scale(${zoom})`,
          }}
        >
          <div
            className="monitor-inner"
            style={{
              filter: p.project.colorGrade === "none" ? undefined : p.project.colorGrade,
              transform: zoomFx ? "scale(1.18)" : undefined,
              opacity: dissolveFx ? 0.55 : 1,
              transition: "transform 0.35s ease, opacity 0.3s ease",
            }}
          >
            {activeAsset && activeAsset.type === "video" ? (
              <video
                key={activeVideo!.id}
                ref={videoRef}
                src={activeAsset.url}
                className="monitor-video"
                style={{ objectFit: p.project.aspect === "16:9" ? "contain" : "cover" }}
                preload="auto"
              />
            ) : activeAsset && activeAsset.type === "image" ? (
              <img src={activeAsset.url} className="monitor-video" alt="" />
            ) : (
              <div className="monitor-empty">
                {p.project.clips.length === 0
                  ? "Import media and add it to the timeline to begin"
                  : "No clip at playhead"}
              </div>
            )}
            {blurFx && (
              <div className="blur-region" title={blurFx.name}>
                <span>{blurFx.name}</span>
              </div>
            )}
          </div>

          {p.toggles.safeZones && (
            <>
              <div className="safe-zone outer" />
              <div className="safe-zone inner" />
            </>
          )}
          {p.toggles.guides && (
            <>
              <div className="guide v" /> <div className="guide h" />
            </>
          )}
          {p.toggles.faceDetection && activeAsset?.type === "video" && (
            <div className="face-box">Speaker 1</div>
          )}
          {p.toggles.trackingBoxes && activeAsset?.type === "video" && (
            <div className="track-box">object</div>
          )}
          {sceneNearby && <div className="scene-flash">Scene change</div>}

          {subtitle && (
            <div
              className={`subtitle-overlay anim-${st.animation} ${subtitle.highlight ? "sub-highlight" : ""}`}
              style={{
                ...subPos,
                fontFamily: st.font,
                fontSize: st.size * 0.6,
                fontWeight: st.weight,
                color: st.color,
                background: st.background,
                WebkitTextStroke: st.stroke ? "1px #000" : undefined,
              }}
              key={subtitle.id}
            >
              {subtitle.text}
            </div>
          )}
        </div>
      </div>

      {/* hidden audio elements for audio-track clips */}
      {audioClips.map((c) => {
        const asset = p.assets.find((a) => a.id === c.assetId);
        if (!asset) return null;
        return (
          <audio
            key={c.id}
            src={asset.url}
            ref={(el) => {
              if (el) audioRefs.current.set(c.id, el);
              else audioRefs.current.delete(c.id);
            }}
          />
        );
      })}

      <div className="transport">
        <button onClick={() => p.onSeek(0)} title="Go to start">⏮</button>
        <button onClick={() => p.onSeek(Math.max(0, p.playhead - 1 / 30))} title="Frame back">◂</button>
        <button className="play-btn" onClick={() => p.onPlayingChange(!p.playing)} title="Play/Pause (Space)">
          {p.playing ? "⏸" : "▶"}
        </button>
        <button onClick={() => p.onSeek(p.playhead + 1 / 30)} title="Frame forward">▸</button>
        <span className="timecode">
          {formatTime(p.playhead)} <span className="dim">/ {formatTime(p.duration)}</span>
        </span>
        <label className="vol">
          🔊
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
        </label>
        <select value={p.playbackRate} onChange={(e) => p.onRateChange(Number(e.target.value))} title="Playback speed">
          {[0.25, 0.5, 1, 1.5, 2].map((r) => (
            <option key={r} value={r}>{r}×</option>
          ))}
        </select>
        <label className="vol" title="Zoom preview">
          🔍
          <input type="range" min={0.5} max={2} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        <button onClick={() => containerRef.current?.requestFullscreen?.()} title="Fullscreen">⛶</button>
      </div>

      <div className="preview-toggles">
        {toggleBtn("captions", "Captions")}
        {toggleBtn("safeZones", "Safe Zones")}
        {toggleBtn("guides", "Guides")}
        {toggleBtn("trackingBoxes", "Tracking")}
        {toggleBtn("faceDetection", "Faces")}
        {toggleBtn("sceneDetection", "Scenes")}
      </div>
    </div>
  );
}
