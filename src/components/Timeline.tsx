import { useCallback, useEffect, useRef, useState } from "react";
import { Clip, MediaAsset, ProjectState, uid } from "../types";
import { clipsOnTrack, opUpdateTrack, projectDuration } from "../store";
import { clamp, formatTimeShort } from "../utils/time";

interface Props {
  project: ProjectState;
  assets: MediaAsset[];
  playhead: number;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onSeek: (t: number) => void;
  onCommit: (p: ProjectState) => void;
  onSplit: () => void;
  onDelete: (ripple: boolean) => void;
}

interface DragState {
  clipId: string;
  mode: "move" | "trim-l" | "trim-r";
  originX: number;
  origStart: number;
  origDur: number;
  origIn: number;
}

const HEADER_W = 148;

export default function Timeline(p: Props) {
  const [pps, setPps] = useState(40); // pixels per second
  const [snap, setSnap] = useState(true);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [draft, setDraft] = useState<Partial<Clip> | null>(null);
  const [subDrag, setSubDrag] = useState<{ id: string; originX: number; origStart: number; origEnd: number } | null>(null);
  const [subDraft, setSubDraft] = useState<{ start: number; end: number } | null>(null);
  const subDragRef = useRef<typeof subDrag>(null);
  const subDraftRef = useRef<typeof subDraft>(null);
  subDragRef.current = subDrag;
  subDraftRef.current = subDraft;
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ drag: DragState | null; draft: Partial<Clip> | null }>({ drag: null, draft: null });
  dragRef.current = { drag, draft };

  const duration = Math.max(projectDuration(p.project), 60);
  const width = duration * pps + 200;

  const snapPoints = useCallback((): number[] => {
    const pts = [0, p.playhead, ...p.project.markers.map((m) => m.time)];
    for (const c of p.project.clips) pts.push(c.start, c.start + c.duration);
    return pts;
  }, [p.project, p.playhead]);

  const maybeSnap = useCallback(
    (t: number): number => {
      if (!snap) return t;
      const tol = 8 / pps;
      let best = t;
      let bestD = tol;
      for (const s of snapPoints()) {
        const d = Math.abs(s - t);
        if (d < bestD) { best = s; bestD = d; }
      }
      return best;
    },
    [snap, pps, snapPoints]
  );

  // ---- clip dragging / trimming ----
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current.drag!;
      const clip = p.project.clips.find((c) => c.id === d.clipId);
      if (!clip) return;
      const dx = (e.clientX - d.originX) / pps;
      if (d.mode === "move") {
        const start = Math.max(0, maybeSnap(d.origStart + dx));
        setDraft({ start });
      } else if (d.mode === "trim-l") {
        const newStart = clamp(maybeSnap(d.origStart + dx), 0, d.origStart + d.origDur - 0.1);
        const delta = newStart - d.origStart;
        setDraft({ start: newStart, duration: d.origDur - delta, inPoint: Math.max(0, d.origIn + delta) });
      } else {
        const newDur = Math.max(0.1, maybeSnap(d.origStart + d.origDur + dx) - d.origStart);
        setDraft({ duration: newDur });
      }
    };
    const onUp = () => {
      const { drag: d, draft: df } = dragRef.current;
      if (d && df) {
        p.onCommit({
          ...p.project,
          clips: p.project.clips.map((c) => (c.id === d.clipId ? { ...c, ...df } : c)),
        });
      }
      setDrag(null);
      setDraft(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, pps, maybeSnap, p]);

  const startDrag = (e: React.PointerEvent, clip: Clip, mode: DragState["mode"]) => {
    e.stopPropagation();
    const track = p.project.tracks.find((t) => t.id === clip.trackId);
    if (track?.locked) return;
    if (!e.shiftKey && !p.selected.includes(clip.id)) p.onSelect([clip.id]);
    else if (e.shiftKey) p.onSelect([...new Set([...p.selected, clip.id])]);
    setDrag({
      clipId: clip.id,
      mode,
      originX: e.clientX,
      origStart: clip.start,
      origDur: clip.duration,
      origIn: clip.inPoint,
    });
  };

  // ---- subtitle segment dragging ----
  useEffect(() => {
    if (!subDrag) return;
    const onMove = (e: PointerEvent) => {
      const d = subDragRef.current!;
      const dx = (e.clientX - d.originX) / pps;
      const start = Math.max(0, maybeSnap(d.origStart + dx));
      setSubDraft({ start, end: start + (d.origEnd - d.origStart) });
    };
    const onUp = () => {
      const d = subDragRef.current;
      const df = subDraftRef.current;
      if (d && df) {
        p.onCommit({
          ...p.project,
          subtitles: p.project.subtitles.map((s) =>
            s.id === d.id ? { ...s, start: df.start, end: df.end } : s
          ),
        });
      }
      setSubDrag(null);
      setSubDraft(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [subDrag, pps, maybeSnap, p]);

  // ---- ruler scrubbing ----
  const scrubFromEvent = (e: React.PointerEvent) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollRef.current!.scrollLeft - HEADER_W;
    p.onSeek(Math.max(0, x / pps));
  };
  const [scrubbing, setScrubbing] = useState(false);
  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: PointerEvent) => {
      const rect = scrollRef.current!.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollRef.current!.scrollLeft - HEADER_W;
      p.onSeek(Math.max(0, x / pps));
    };
    const onUp = () => setScrubbing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [scrubbing, pps, p]);

  const duplicateSelected = () => {
    const copies: Clip[] = p.project.clips
      .filter((c) => p.selected.includes(c.id))
      .map((c) => ({ ...c, id: uid("clip"), start: c.start + c.duration }));
    if (copies.length) p.onCommit({ ...p.project, clips: [...p.project.clips, ...copies] });
  };

  const addMarker = () => {
    p.onCommit({
      ...p.project,
      markers: [
        ...p.project.markers,
        { id: uid("mk"), time: p.playhead, label: `Marker ${p.project.markers.length + 1}`, color: "#4aa3ff" },
      ],
    });
  };

  // tick interval that keeps labels readable at any zoom
  const tickEvery = pps > 80 ? 1 : pps > 30 ? 5 : pps > 12 ? 10 : 30;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + tickEvery; t += tickEvery) ticks.push(t);

  const renderClip = (clip: Clip) => {
    const live = drag?.clipId === clip.id && draft ? { ...clip, ...draft } : clip;
    const sel = p.selected.includes(clip.id);
    return (
      <div
        key={clip.id}
        className={`clip ${sel ? "selected" : ""} kind-${clip.kind}`}
        style={{
          left: live.start * pps,
          width: Math.max(6, live.duration * pps),
          background: clip.color,
        }}
        onPointerDown={(e) => startDrag(e, clip, "move")}
        title={`${clip.name} · ${formatTimeShort(live.start)}–${formatTimeShort(live.start + live.duration)}`}
      >
        <div className="trim-handle l" onPointerDown={(e) => startDrag(e, clip, "trim-l")} />
        <span className="clip-label">{clip.name}</span>
        <div className="trim-handle r" onPointerDown={(e) => startDrag(e, clip, "trim-r")} />
      </div>
    );
  };

  return (
    <section className="timeline">
      <div className="timeline-toolbar">
        <button onClick={p.onSplit} title="Split at playhead (S)">✂ Split</button>
        <button onClick={() => p.onDelete(false)} disabled={!p.selected.length} title="Delete (Del)">🗑 Delete</button>
        <button onClick={() => p.onDelete(true)} disabled={!p.selected.length} title="Ripple delete (Shift+Del)">⇤ Ripple Delete</button>
        <button onClick={duplicateSelected} disabled={!p.selected.length}>⧉ Duplicate</button>
        <button className={snap ? "active" : ""} onClick={() => setSnap((s) => !s)} title="Toggle snapping">🧲 Snap</button>
        <button onClick={addMarker}>🚩 Marker</button>
        <span className="spacer" />
        <span className="tl-timecode">{formatTimeShort(p.playhead)}</span>
        <label className="zoom-ctl">
          Zoom
          <input type="range" min={8} max={160} value={pps} onChange={(e) => setPps(Number(e.target.value))} />
        </label>
      </div>

      <div className="timeline-scroll" ref={scrollRef}>
        <div className="timeline-inner" style={{ width: width + HEADER_W }}>
          {/* ruler */}
          <div className="ruler-row">
            <div className="track-header ruler-header" />
            <div
              className="ruler"
              style={{ width }}
              onPointerDown={(e) => { scrubFromEvent(e); setScrubbing(true); }}
            >
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pps }}>
                  <span>{formatTimeShort(t)}</span>
                </div>
              ))}
              {p.project.markers.map((m) => (
                <div
                  key={m.id}
                  className="marker"
                  style={{ left: m.time * pps, background: m.color }}
                  title={m.label}
                  onPointerDown={(e) => { e.stopPropagation(); p.onSeek(m.time); }}
                />
              ))}
            </div>
          </div>

          {/* tracks */}
          {p.project.tracks.map((track) => (
            <div key={track.id} className={`track-row kind-${track.kind} ${track.locked ? "locked" : ""}`}>
              <div className="track-header">
                <span className="track-name">{track.name}</span>
                <span className="track-btns">
                  <button
                    className={track.locked ? "on" : ""}
                    title="Lock track"
                    onClick={() => p.onCommit(opUpdateTrack(p.project, track.id, { locked: !track.locked }))}
                  >🔒</button>
                  {(track.kind === "audio" || track.kind === "video") && (
                    <>
                      <button
                        className={track.muted ? "on" : ""}
                        title="Mute track"
                        onClick={() => p.onCommit(opUpdateTrack(p.project, track.id, { muted: !track.muted }))}
                      >M</button>
                      <button
                        className={track.solo ? "on" : ""}
                        title="Solo track"
                        onClick={() => p.onCommit(opUpdateTrack(p.project, track.id, { solo: !track.solo }))}
                      >S</button>
                    </>
                  )}
                </span>
              </div>
              <div
                className="track-lane"
                style={{ width }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) {
                    p.onSelect([]);
                    scrubFromEvent(e);
                    setScrubbing(true);
                  }
                }}
              >
                {track.kind === "subtitle"
                  ? p.project.subtitles.map((s) => {
                      const live = subDrag?.id === s.id && subDraft ? subDraft : s;
                      return (
                        <div
                          key={s.id}
                          className="clip subtitle-clip"
                          style={{ left: live.start * pps, width: Math.max(6, (live.end - live.start) * pps) }}
                          title={`${s.text} — drag to retime, double-click to edit`}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            if (track.locked) return;
                            p.onSeek(s.start);
                            setSubDrag({ id: s.id, originX: e.clientX, origStart: s.start, origEnd: s.end });
                          }}
                          onDoubleClick={() => {
                            const text = window.prompt("Edit caption", s.text);
                            if (text !== null && text.trim()) {
                              p.onCommit({
                                ...p.project,
                                subtitles: p.project.subtitles.map((x) => (x.id === s.id ? { ...x, text: text.trim() } : x)),
                              });
                            }
                          }}
                        >
                          <span className="clip-label">{s.text}</span>
                        </div>
                      );
                    })
                  : clipsOnTrack(p.project, track.id).map(renderClip)}
              </div>
            </div>
          ))}

          {/* playhead */}
          <div className="playhead" style={{ left: HEADER_W + p.playhead * pps }}>
            <div className="playhead-cap" />
          </div>
        </div>
      </div>
    </section>
  );
}
