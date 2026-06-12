import { useCallback, useMemo, useReducer } from "react";
import {
  Clip,
  DEFAULT_SUBTITLE_STYLE,
  MediaAsset,
  ProjectState,
  Subtitle,
  Track,
  TrackKind,
  uid,
} from "./types";

export function defaultTracks(): Track[] {
  const mk = (kind: TrackKind, name: string): Track => ({
    id: uid("trk"),
    kind,
    name,
    locked: false,
    muted: false,
    solo: false,
  });
  return [
    mk("graphics", "Graphics"),
    mk("effects", "Effects"),
    mk("subtitle", "Subtitles"),
    mk("video", "Video 3"),
    mk("video", "Video 2"),
    mk("video", "Video 1"),
    mk("audio", "Audio 1"),
    mk("audio", "Audio 2"),
    mk("audio", "Audio 3"),
  ];
}

export function initialProject(): ProjectState {
  return {
    name: "Untitled Project",
    aspect: "16:9",
    tracks: defaultTracks(),
    clips: [],
    subtitles: [],
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    markers: [],
    colorGrade: "none",
  };
}

interface History {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
}

type Action =
  | { type: "commit"; next: ProjectState }
  | { type: "undo" }
  | { type: "redo" };

function reducer(h: History, a: Action): History {
  switch (a.type) {
    case "commit":
      if (a.next === h.present) return h;
      return { past: [...h.past.slice(-99), h.present], present: a.next, future: [] };
    case "undo": {
      const prev = h.past[h.past.length - 1];
      if (!prev) return h;
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
    }
    case "redo": {
      const next = h.future[0];
      if (!next) return h;
      return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
    }
    default:
      return h;
  }
}

export function projectDuration(p: ProjectState): number {
  return p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
}

export function clipsOnTrack(p: ProjectState, trackId: string): Clip[] {
  return p.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

// ---------- pure timeline operations ----------

export function opAddClip(p: ProjectState, asset: MediaAsset, at?: number): ProjectState {
  const kind: TrackKind = asset.type === "audio" ? "audio" : "video";
  const track =
    [...p.tracks].reverse().find((t) => t.kind === kind && !t.locked) ??
    p.tracks.find((t) => t.kind === kind);
  if (!track) return p;
  const existing = clipsOnTrack(p, track.id);
  const start = at ?? (existing.length ? Math.max(...existing.map((c) => c.start + c.duration)) : 0);
  const clip: Clip = {
    id: uid("clip"),
    trackId: track.id,
    assetId: asset.id,
    name: asset.name,
    start,
    duration: asset.duration,
    inPoint: 0,
    color: asset.type === "audio" ? "#2e7d52" : "#3b6ea5",
    kind: "media",
    speed: 1,
    volume: 1,
  };
  return { ...p, clips: [...p.clips, clip] };
}

export function opSplitAt(p: ProjectState, time: number, onlyIds?: string[]): ProjectState {
  const clips: Clip[] = [];
  let changed = false;
  for (const c of p.clips) {
    const inRange = time > c.start + 0.01 && time < c.start + c.duration - 0.01;
    const targeted = !onlyIds || onlyIds.includes(c.id);
    const track = p.tracks.find((t) => t.id === c.trackId);
    if (inRange && targeted && !track?.locked && c.kind === "media") {
      const offset = time - c.start;
      clips.push({ ...c, duration: offset });
      clips.push({
        ...c,
        id: uid("clip"),
        start: time,
        duration: c.duration - offset,
        inPoint: c.inPoint + offset * c.speed,
      });
      changed = true;
    } else {
      clips.push(c);
    }
  }
  return changed ? { ...p, clips } : p;
}

export function opDeleteClips(p: ProjectState, ids: string[], ripple: boolean): ProjectState {
  const doomed = p.clips.filter((c) => ids.includes(c.id));
  if (!doomed.length) return p;
  let clips = p.clips.filter((c) => !ids.includes(c.id));
  if (ripple) {
    for (const d of doomed.sort((a, b) => b.start - a.start)) {
      clips = clips.map((c) =>
        c.trackId === d.trackId && c.start >= d.start + d.duration
          ? { ...c, start: c.start - d.duration }
          : c
      );
    }
  }
  return { ...p, clips };
}

// Remove a time range from every unlocked track, rippling later clips back.
export function opRemoveRange(p: ProjectState, from: number, to: number): ProjectState {
  if (to <= from) return p;
  let next = opSplitAt(p, from);
  next = opSplitAt(next, to);
  const len = to - from;
  const lockedTracks = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const clips = next.clips
    .filter((c) => {
      if (lockedTracks.has(c.trackId)) return true;
      const mid = c.start + c.duration / 2;
      return !(mid >= from && mid <= to);
    })
    .map((c) =>
      !lockedTracks.has(c.trackId) && c.start >= to - 0.01
        ? { ...c, start: c.start - len }
        : c
    );
  const subtitles = next.subtitles
    .filter((s) => !(s.start >= from && s.end <= to))
    .map((s) =>
      s.start >= to ? { ...s, start: s.start - len, end: s.end - len } : s
    );
  const markers = next.markers
    .filter((m) => m.time < from || m.time > to)
    .map((m) => (m.time > to ? { ...m, time: m.time - len } : m));
  return { ...next, clips, subtitles, markers };
}

export function opCloseGaps(p: ProjectState, trackId?: string): { next: ProjectState; removed: number } {
  let removed = 0;
  const clips = [...p.clips];
  const targets = p.tracks.filter(
    (t) => (t.kind === "video" || t.kind === "audio") && !t.locked && (!trackId || t.id === trackId)
  );
  for (const t of targets) {
    const onTrack = clips
      .filter((c) => c.trackId === t.id)
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const c of onTrack) {
      if (c.start > cursor + 0.001) {
        removed += c.start - cursor;
        const i = clips.findIndex((x) => x.id === c.id);
        clips[i] = { ...c, start: cursor };
        cursor += c.duration;
      } else {
        cursor = c.start + c.duration;
      }
    }
  }
  return { next: { ...p, clips }, removed };
}

export function opAddSubtitles(p: ProjectState, subs: Subtitle[]): ProjectState {
  return { ...p, subtitles: [...p.subtitles, ...subs].sort((a, b) => a.start - b.start) };
}

export function opUpdateTrack(p: ProjectState, trackId: string, patch: Partial<Track>): ProjectState {
  return {
    ...p,
    tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
  };
}

export function opUpdateClip(p: ProjectState, clipId: string, patch: Partial<Clip>): ProjectState {
  return {
    ...p,
    clips: p.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
  };
}

// The "main sequence": media clips on the video track that holds the most of
// them, in timeline order. Chat references like "clip 3" resolve against this.
export function mainSequence(p: ProjectState): Clip[] {
  let best: Clip[] = [];
  for (const t of p.tracks) {
    if (t.kind !== "video") continue;
    const cs = clipsOnTrack(p, t.id).filter((c) => c.kind === "media");
    if (cs.length > best.length) best = cs;
  }
  return best;
}

// Re-lay a track's media clips back-to-back in the given order, starting at
// the position of the earliest clip (ripple reorder, gaps removed).
export function opResequence(p: ProjectState, ordered: Clip[]): ProjectState {
  if (!ordered.length) return p;
  let cursor = Math.min(...ordered.map((c) => c.start));
  const newStarts = new Map<string, number>();
  for (const c of ordered) {
    newStarts.set(c.id, cursor);
    cursor += c.duration;
  }
  return {
    ...p,
    clips: p.clips.map((c) =>
      newStarts.has(c.id) ? { ...c, start: newStarts.get(c.id)! } : c
    ),
  };
}

// Change playback speed, keeping the same source range (timeline length scales).
export function opSetSpeed(p: ProjectState, clipId: string, speed: number): ProjectState {
  const clip = p.clips.find((c) => c.id === clipId);
  if (!clip || speed <= 0) return p;
  const sourceLen = clip.duration * clip.speed;
  return opUpdateClip(p, clipId, { speed, duration: sourceLen / speed });
}

export function opAddTitleClip(
  p: ProjectState,
  opts: { text: string; start: number; duration: number; corner: Clip["corner"]; animation?: Clip["textAnimation"] }
): ProjectState {
  const track = p.tracks.find((t) => t.kind === "graphics");
  if (!track) return p;
  const clip: Clip = {
    id: uid("clip"), trackId: track.id, assetId: null, name: `Title: ${opts.text}`,
    start: opts.start, duration: opts.duration, inPoint: 0, color: "#b8862d",
    kind: "title", speed: 1, volume: 1, text: opts.text, corner: opts.corner,
    textAnimation: opts.animation ?? "none",
  };
  return { ...p, clips: [...p.clips, clip] };
}

export function opAddOverlayClip(
  p: ProjectState,
  opts: {
    assetId: string; name: string; start: number; duration: number;
    corner: Clip["corner"]; sizePct?: number; opacity?: number;
  }
): ProjectState {
  const track = p.tracks.find((t) => t.kind === "graphics");
  if (!track) return p;
  const clip: Clip = {
    id: uid("clip"), trackId: track.id, assetId: opts.assetId, name: opts.name,
    start: opts.start, duration: opts.duration, inPoint: 0, color: "#6d8a3a",
    kind: "overlay", speed: 1, volume: 0, corner: opts.corner,
    sizePct: opts.sizePct, opacity: opts.opacity,
  };
  return { ...p, clips: [...p.clips, clip] };
}

// Full-frame insert (e.g. "insert screenshot at 2:10") on the topmost video track.
export function opInsertOnTopTrack(
  p: ProjectState,
  asset: MediaAsset,
  start: number,
  duration: number
): ProjectState {
  const track = p.tracks.find((t) => t.kind === "video" && !t.locked);
  if (!track) return p;
  const clip: Clip = {
    id: uid("clip"), trackId: track.id, assetId: asset.id, name: asset.name,
    start, duration, inPoint: 0, color: "#3b6ea5", kind: "media", speed: 1, volume: 1,
  };
  return { ...p, clips: [...p.clips, clip] };
}

// ---------- hook ----------

export function useProject() {
  const [history, dispatch] = useReducer(reducer, undefined, () => ({
    past: [] as ProjectState[],
    present: initialProject(),
    future: [] as ProjectState[],
  }));

  const commit = useCallback((next: ProjectState) => dispatch({ type: "commit", next }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  return useMemo(
    () => ({
      project: history.present,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      commit,
      undo,
      redo,
    }),
    [history, commit, undo, redo]
  );
}
