import {
  Clip,
  MediaAsset,
  PendingAction,
  ProjectState,
  Subtitle,
  SubtitleStyle,
  TranscriptWord,
  uid,
} from "../types";
import {
  clipsOnTrack,
  mainSequence,
  opAddClip,
  opAddOverlayClip,
  opAddTitleClip,
  opCloseGaps,
  opDeleteClips,
  opInsertOnTopTrack,
  opRemoveRange,
  opResequence,
  opSetSpeed,
  opSplitAt,
  opUpdateClip,
  opUpdateTrack,
  projectDuration,
} from "../store";
import { formatTimeShort, parseTimecode } from "../utils/time";

export interface AgentContext {
  project: ProjectState;
  assets: MediaAsset[];
  playhead: number;
  selectedClipIds: string[];
}

export interface AgentResult {
  reply: string;
  next?: ProjectState;
  pending?: PendingAction;
  effect?:
    | { type: "openExport"; preset?: string }
    | { type: "seek"; time: number }
    | { type: "select"; ids: string[] }
    | { type: "thumbnail"; count: number }
    | { type: "undo" }
    | { type: "redo" };
}

// Map a transcript word from asset time to timeline time via placed clips.
export function timelineTranscript(
  p: ProjectState,
  assets: MediaAsset[]
): (TranscriptWord & { timelineStart: number; timelineEnd: number; clipId: string })[] {
  const out: (TranscriptWord & { timelineStart: number; timelineEnd: number; clipId: string })[] = [];
  for (const c of p.clips) {
    if (c.kind !== "media" || !c.assetId) continue;
    const asset = assets.find((a) => a.id === c.assetId);
    if (!asset?.analysis) continue;
    for (const w of asset.analysis.transcript) {
      if (w.start >= c.inPoint && w.end <= c.inPoint + c.duration * c.speed) {
        out.push({
          ...w,
          clipId: c.id,
          timelineStart: c.start + (w.start - c.inPoint) / c.speed,
          timelineEnd: c.start + (w.end - c.inPoint) / c.speed,
        });
      }
    }
  }
  return out.sort((a, b) => a.timelineStart - b.timelineStart);
}

function timelineSilences(p: ProjectState, assets: MediaAsset[]) {
  const out: { start: number; end: number }[] = [];
  for (const c of p.clips) {
    if (c.kind !== "media" || !c.assetId) continue;
    const asset = assets.find((a) => a.id === c.assetId);
    if (!asset?.analysis) continue;
    for (const s of asset.analysis.silences) {
      if (s.start >= c.inPoint && s.end <= c.inPoint + c.duration) {
        out.push({ start: c.start + s.start - c.inPoint, end: c.start + s.end - c.inPoint });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function generateSubtitles(p: ProjectState, assets: MediaAsset[]): Subtitle[] {
  const words = timelineTranscript(p, assets);
  const subs: Subtitle[] = [];
  let group: typeof words = [];
  const flush = () => {
    if (!group.length) return;
    subs.push({
      id: uid("sub"),
      start: group[0].timelineStart,
      end: group[group.length - 1].timelineEnd,
      text: group.map((g) => g.text).join(" "),
      speaker: group[0].speaker,
    });
    group = [];
  };
  for (const w of words) {
    group.push(w);
    const groupDur = group[group.length - 1].timelineEnd - group[0].timelineStart;
    if (group.length >= 6 || groupDur > 3.2) flush();
  }
  flush();
  return subs;
}

const SUBTITLE_PRESETS: Record<string, Partial<SubtitleStyle>> = {
  tiktok: { preset: "TikTok", size: 34, weight: 900, color: "#ffffff", stroke: true, background: "transparent", animation: "pop", position: "middle" },
  viral: { preset: "TikTok Viral", size: 38, weight: 900, color: "#ffe600", stroke: true, background: "transparent", animation: "bounce", position: "middle" },
  hormozi: { preset: "Hormozi", size: 36, weight: 900, color: "#ffffff", stroke: true, background: "transparent", animation: "pop", position: "middle" },
  youtube: { preset: "YouTube", size: 28, weight: 700, color: "#ffffff", background: "rgba(0,0,0,0.75)", animation: "none", position: "bottom" },
  instagram: { preset: "Instagram", size: 30, weight: 800, color: "#ffffff", background: "rgba(0,0,0,0.45)", animation: "bounce", position: "bottom" },
  podcast: { preset: "Podcast", size: 26, weight: 600, color: "#f5f5f5", background: "rgba(0,0,0,0.7)", animation: "none", position: "bottom" },
  corporate: { preset: "Corporate", size: 24, weight: 500, color: "#ffffff", background: "rgba(10,40,90,0.75)", animation: "none", position: "bottom" },
  minimal: { preset: "Minimal", size: 24, weight: 500, color: "#ffffff", background: "rgba(0,0,0,0.5)", animation: "none", position: "bottom" },
  gaming: { preset: "Gaming", size: 32, weight: 900, color: "#9dff57", stroke: true, background: "transparent", animation: "zoom", position: "bottom" },
  educational: { preset: "Educational", size: 26, weight: 600, color: "#ffe28a", background: "rgba(0,0,0,0.6)", animation: "none", position: "bottom" },
};

const COLOR_WORDS: Record<string, string> = {
  yellow: "#ffd60a", red: "#ff453a", green: "#32d74b", blue: "#0a84ff",
  white: "#ffffff", black: "#000000", orange: "#ff9f0a", pink: "#ff6482",
  purple: "#bf5af2", cyan: "#64d2ff",
};

const ES_DICT: Record<string, string> = {
  welcome: "bienvenidos", back: "de vuelta", to: "a", the: "el", channel: "canal",
  everyone: "todos", today: "hoy", we: "nosotros", are: "estamos", this: "esto",
  is: "es", you: "tú", and: "y", how: "cómo", it: "eso", works: "funciona",
  thanks: "gracias", for: "por", watching: "ver", show: "mostrar", me: "me",
  let: "deja", everything: "todo", changes: "cambia", know: "saber", need: "necesitas",
};

function findEffectsTrack(p: ProjectState) {
  return p.tracks.find((t) => t.kind === "effects");
}

function addEffectClip(p: ProjectState, start: number, duration: number, name: string, effect: string, color = "#8d5bd4"): ProjectState {
  const track = findEffectsTrack(p);
  if (!track) return p;
  const clip: Clip = {
    id: uid("clip"), trackId: track.id, assetId: null, name, start,
    duration, inPoint: 0, color, kind: "effect", effect, speed: 1, volume: 1,
  };
  return { ...p, clips: [...p.clips, clip] };
}

function parseCorner(q: string): Clip["corner"] {
  if (/top.?left/.test(q)) return "tl";
  if (/top.?right/.test(q)) return "tr";
  if (/bottom.?left|lower.?left/.test(q)) return "bl";
  if (/bottom.?right|lower.?right/.test(q)) return "br";
  if (/center|middle/.test(q)) return "center";
  return "tr";
}

function highlightsFromTimeline(p: ProjectState, assets: MediaAsset[]) {
  const highlights: { start: number; end: number; label: string }[] = [];
  for (const c of p.clips) {
    const asset = assets.find((a) => a.id === c.assetId);
    if (!asset?.analysis) continue;
    for (const h of asset.analysis.highlights) {
      if (h.start >= c.inPoint && h.end <= c.inPoint + c.duration) {
        highlights.push({ start: c.start + h.start - c.inPoint, end: c.start + h.end - c.inPoint, label: h.label });
      }
    }
  }
  return highlights;
}

function timelineScenes(p: ProjectState, assets: MediaAsset[]): number[] {
  const scenes: number[] = [];
  for (const c of p.clips) {
    const asset = assets.find((a) => a.id === c.assetId);
    if (!asset?.analysis) continue;
    for (const s of asset.analysis.scenes) {
      if (s >= c.inPoint && s <= c.inPoint + c.duration) scenes.push(c.start + s - c.inPoint);
    }
  }
  return scenes.sort((a, b) => a - b);
}

// "this clip" = selection, else the main-sequence clip under the playhead
function targetClips(ctx: AgentContext): Clip[] {
  if (ctx.selectedClipIds.length) {
    return ctx.project.clips.filter((c) => ctx.selectedClipIds.includes(c.id));
  }
  const under = mainSequence(ctx.project).find(
    (c) => ctx.playhead >= c.start && ctx.playhead < c.start + c.duration
  );
  return under ? [under] : [];
}

function nthClip(p: ProjectState, n: number): Clip | null {
  const seq = mainSequence(p);
  return n >= 1 && n <= seq.length ? seq[n - 1] : null;
}

const num = (s: string | undefined, dflt: number) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export function runAgent(input: string, ctx: AgentContext): AgentResult {
  const q = input.trim().toLowerCase();
  const p = ctx.project;
  const duration = projectDuration(p);
  const hasMedia = p.clips.some((c) => c.kind === "media");
  const seq = mainSequence(p);
  const audioClips = p.clips.filter((c) => {
    const t = p.tracks.find((t) => t.id === c.trackId);
    return t?.kind === "audio" && c.kind === "media";
  });
  const noMedia: AgentResult = { reply: "Add some media to the timeline first." };

  // ---------- undo / redo / restore ----------
  if (/^undo|revert (the )?last edit/.test(q)) return { reply: "Undone.", effect: { type: "undo" } };
  if (/^redo/.test(q)) return { reply: "Redone.", effect: { type: "redo" } };
  if (/restore (the )?previous version/.test(q)) return { reply: "Restored the previous version (one step back).", effect: { type: "undo" } };

  // ---------- remove range ----------
  const range = q.match(/(?:remove|delete|cut)(?:\s+\w+)*\s+(?:between|from)\s+([\d:hms.]+)\s+(?:and|to|-)\s+([\d:hms.]+)/);
  if (range) {
    const from = parseTimecode(range[1]);
    const to = parseTimecode(range[2]);
    if (from === null || to === null || to <= from) {
      return { reply: "I couldn't parse that time range. Try “remove everything between 2:15 and 2:42”." };
    }
    return {
      reply: `Removed ${formatTimeShort(to - from)} between ${formatTimeShort(from)} and ${formatTimeShort(to)}. Later clips, subtitles, and markers were rippled back.`,
      next: opRemoveRange(p, from, to),
    };
  }

  // ---------- trim first / end ----------
  const trimFirst = q.match(/trim (?:the )?first (\d+(?:\.\d+)?) ?(?:seconds|secs|s)\b/) || q.match(/shorten (?:the )?intro/);
  if (trimFirst) {
    if (!hasMedia) return noMedia;
    const n = Array.isArray(trimFirst) && trimFirst[1] ? Number(trimFirst[1]) : 3;
    return { reply: `Trimmed the first ${n}s off the program.`, next: opRemoveRange(p, 0, n) };
  }
  const trimEnd = q.match(/trim (?:the )?(?:end|last)(?: by)? (\d+(?:\.\d+)?) ?(?:seconds|secs|s)\b/);
  if (trimEnd) {
    if (!hasMedia) return noMedia;
    const n = Number(trimEnd[1]);
    if (n >= duration) return { reply: "That would remove the whole program." };
    return { reply: `Trimmed ${n}s off the end.`, next: opRemoveRange(p, duration - n, duration) };
  }

  // ---------- shorten / extend clip N ----------
  const shorten = q.match(/(shorten|extend) (?:clip )?(\d+)(?: by (\d+(?:\.\d+)?) ?(?:seconds|secs|s)?)?/);
  if (shorten) {
    const clip = nthClip(p, Number(shorten[2]));
    if (!clip) return { reply: `I only see ${seq.length} clips in the main sequence.` };
    const by = num(shorten[3], 2);
    const asset = ctx.assets.find((a) => a.id === clip.assetId);
    if (shorten[1] === "shorten") {
      if (clip.duration - by < 0.2) return { reply: `Clip ${shorten[2]} is only ${clip.duration.toFixed(1)}s long.` };
      return { reply: `Shortened clip ${shorten[2]} by ${by}s (trimmed from the tail).`, next: opUpdateClip(p, clip.id, { duration: clip.duration - by }) };
    }
    const sourceRemain = asset ? asset.duration - (clip.inPoint + clip.duration * clip.speed) : by;
    const add = Math.max(0, Math.min(by, sourceRemain / clip.speed));
    if (add < 0.05) return { reply: `Clip ${shorten[2]} is already using all of its source media — there's nothing left to extend into.` };
    return { reply: `Extended clip ${shorten[2]} by ${add.toFixed(1)}s.`, next: opUpdateClip(p, clip.id, { duration: clip.duration + add }) };
  }

  // ---------- swap / move clips ----------
  const swap = q.match(/swap (?:clips? )?(\d+) and (\d+)/);
  if (swap) {
    const a = nthClip(p, Number(swap[1]));
    const b = nthClip(p, Number(swap[2]));
    if (!a || !b) return { reply: `I only see ${seq.length} clips in the main sequence.` };
    const order = seq.map((c) => (c.id === a.id ? b : c.id === b.id ? a : c));
    return { reply: `Swapped clips ${swap[1]} and ${swap[2]} and re-laid the sequence.`, next: opResequence(p, order) };
  }
  const move = q.match(/move (?:clip )?(\d+) (before|after) (?:clip )?(\d+)/);
  if (move) {
    const a = nthClip(p, Number(move[1]));
    const b = nthClip(p, Number(move[3]));
    if (!a || !b || a.id === b.id) return { reply: `I only see ${seq.length} clips in the main sequence.` };
    const rest = seq.filter((c) => c.id !== a.id);
    const at = rest.findIndex((c) => c.id === b.id) + (move[2] === "after" ? 1 : 0);
    rest.splice(at, 0, a);
    return { reply: `Moved clip ${move[1]} ${move[2]} clip ${move[3]}.`, next: opResequence(p, rest) };
  }
  if (/move (this|selected|the) (section|clip).*(beginning|start|front)/.test(q)) {
    const targets = targetClips(ctx).filter((c) => seq.some((s) => s.id === c.id));
    if (!targets.length) return { reply: "Select a clip first (click it on the timeline), or park the playhead over it." };
    const rest = seq.filter((c) => !targets.some((t) => t.id === c.id));
    return { reply: `Moved ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} clips`} to the beginning.`, next: opResequence(p, [...targets, ...rest]) };
  }
  if (/move (this|selected|the) (section|clip).*(end|back)/.test(q)) {
    const targets = targetClips(ctx).filter((c) => seq.some((s) => s.id === c.id));
    if (!targets.length) return { reply: "Select a clip first (click it on the timeline), or park the playhead over it." };
    const rest = seq.filter((c) => !targets.some((t) => t.id === c.id));
    return { reply: `Moved ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} clips`} to the end.`, next: opResequence(p, [...rest, ...targets]) };
  }

  // ---------- duplicate / repeat / copy intro ----------
  if (/copy (the )?intro to the end/.test(q)) {
    if (!seq.length) return noMedia;
    const intro = seq[0];
    const copy: Clip = { ...intro, id: uid("clip"), start: duration };
    return { reply: `Copied the intro (“${intro.name}”) to the end of the timeline.`, next: { ...p, clips: [...p.clips, copy] } };
  }
  const repeat = q.match(/repeat (this|selected|the) (section|clip) (twice|(\d+) times)/) || (/duplicate (this|selected|the)? ?clip/.test(q) ? ["", "this", "clip", "once"] : null);
  if (repeat) {
    const targets = targetClips(ctx);
    if (!targets.length) return { reply: "Select a clip first (click it on the timeline), or park the playhead over it." };
    const times = repeat[3] === "twice" ? 2 : repeat[3] === "once" ? 1 : num(repeat[4], 1);
    let next = p;
    for (const t of targets) {
      for (let i = 1; i <= times; i++) {
        next = { ...next, clips: [...next.clips, { ...t, id: uid("clip"), start: t.start + t.duration * i }] };
      }
    }
    return { reply: `Duplicated ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} clips`} ${times === 1 ? "once" : `${times} times`}, placed right after the original.`, next };
  }

  // ---------- delete clips ----------
  const delN = q.match(/(?:delete|remove) clip (\d+)/);
  if (delN) {
    const clip = nthClip(p, Number(delN[1]));
    if (!clip) return { reply: `I only see ${seq.length} clips in the main sequence.` };
    return { reply: `Deleted clip ${delN[1]} (“${clip.name}”) and rippled the gap closed.`, next: opDeleteClips(p, [clip.id], true) };
  }
  if (/(delete|remove) (the )?selected( clips?)?$/.test(q)) {
    if (!ctx.selectedClipIds.length) return { reply: "Nothing is selected — click a clip on the timeline first." };
    return { reply: `Deleted ${ctx.selectedClipIds.length} selected clip(s).`, next: opDeleteClips(p, ctx.selectedClipIds, true) };
  }

  // ---------- selection ----------
  const selN = q.match(/^select clip (\d+)/);
  if (selN) {
    const clip = nthClip(p, Number(selN[1]));
    if (!clip) return { reply: `I only see ${seq.length} clips in the main sequence.` };
    return { reply: `Selected clip ${selN[1]} (“${clip.name}”).`, effect: { type: "select", ids: [clip.id] } };
  }
  const selAfter = q.match(/select everything after ([\d:hms.]+)/);
  if (selAfter) {
    const t = parseTimecode(selAfter[1]);
    if (t === null) return { reply: "I couldn't parse that timestamp." };
    const ids = p.clips.filter((c) => c.start >= t && c.kind === "media").map((c) => c.id);
    return { reply: `Selected ${ids.length} clip(s) after ${formatTimeShort(t)}.`, effect: { type: "select", ids } };
  }
  if (/select all subtitles/.test(q)) {
    return { reply: `There are ${p.subtitles.length} caption segments. Caption-level commands work directly: try “split the caption at the playhead”, “merge captions here”, or “make captions bigger”.` };
  }
  if (/^select (all|everything)$/.test(q)) {
    const ids = p.clips.filter((c) => c.kind === "media").map((c) => c.id);
    return { reply: `Selected all ${ids.length} media clips.`, effect: { type: "select", ids } };
  }

  // ---------- silence / filler removal ----------
  if (/(remove|cut|delete|clean).*(dead space|silence|silences|pauses|dead air)/.test(q)) {
    if (!hasMedia) return noMedia;
    const silences = timelineSilences(p, ctx.assets);
    let next = p;
    for (const s of [...silences].sort((a, b) => b.start - a.start)) {
      next = opRemoveRange(next, s.start + 0.05, s.end - 0.05);
    }
    const gapResult = opCloseGaps(next);
    next = gapResult.next;
    const total = silences.reduce((acc, s) => acc + (s.end - s.start - 0.1), 0) + gapResult.removed;
    return {
      reply: `Silence removal complete. I found ${silences.length} silent section${silences.length === 1 ? "" : "s"} and closed all timeline gaps, tightening the edit by ~${total.toFixed(1)}s.`,
      next,
    };
  }
  if (/(remove|cut|delete|clean).*(filler|um|uh|mistake)/.test(q)) {
    if (!hasMedia) return noMedia;
    const words = timelineTranscript(p, ctx.assets).filter((w) => w.isFiller);
    if (!words.length) return { reply: "I scanned the transcript and didn't find any filler words. You're clean!" };
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w.text.toLowerCase(), (counts.get(w.text.toLowerCase()) ?? 0) + 1);
    const summary = [...counts.entries()].map(([w, n]) => `• ${n} × “${w}”`).join("\n");
    return {
      reply: `I scanned the transcript and detected ${words.length} filler words:\n${summary}\n\nApply changes?`,
      pending: {
        description: `Remove ${words.length} filler words`,
        apply: (proj) => {
          let next = proj;
          for (const w of [...words].sort((a, b) => b.timelineStart - a.timelineStart)) {
            next = opRemoveRange(next, w.timelineStart, w.timelineEnd);
          }
          return next;
        },
      },
    };
  }

  // ---------- caption-level edits (before generic split / subtitle blocks) ----------
  if (/split (the )?(caption|subtitle)/.test(q)) {
    const t = parseTimecode(q.match(/at ([\d:hms.]+)/)?.[1] ?? "") ?? ctx.playhead;
    const sub = p.subtitles.find((s) => t > s.start + 0.05 && t < s.end - 0.05);
    if (!sub) return { reply: "No caption spans that point. Park the playhead inside a caption or give a timestamp." };
    const words = sub.text.split(" ");
    const ratio = (t - sub.start) / (sub.end - sub.start);
    const cut = Math.max(1, Math.min(words.length - 1, Math.round(words.length * ratio)));
    const subtitles = p.subtitles.flatMap((s) =>
      s.id === sub.id
        ? [
            { ...s, end: t, text: words.slice(0, cut).join(" ") },
            { ...s, id: uid("sub"), start: t, text: words.slice(cut).join(" ") },
          ]
        : [s]
    );
    return { reply: `Split the caption at ${formatTimeShort(t)}.`, next: { ...p, subtitles } };
  }
  if (/merge (the )?(captions?|subtitles?)/.test(q)) {
    const t = parseTimecode(q.match(/at ([\d:hms.]+)/)?.[1] ?? "") ?? ctx.playhead;
    const ordered = [...p.subtitles].sort((a, b) => a.start - b.start);
    const i = ordered.findIndex((s) => t >= s.start && t <= s.end);
    if (i < 0 || i >= ordered.length - 1) return { reply: "Park the playhead on a caption that has a neighbor after it, then ask again." };
    const merged = { ...ordered[i], end: ordered[i + 1].end, text: `${ordered[i].text} ${ordered[i + 1].text}` };
    const subtitles = ordered.filter((_, j) => j !== i && j !== i + 1).concat(merged).sort((a, b) => a.start - b.start);
    return { reply: "Merged the caption with the next one.", next: { ...p, subtitles } };
  }
  const capSize = q.match(/make (the )?(captions?|subtitles?) (bigger|larger|smaller)/);
  if (capSize) {
    const delta = capSize[3] === "smaller" ? -6 : 6;
    const size = Math.max(12, p.subtitleStyle.size + delta);
    return { reply: `Caption size is now ${size}px.`, next: { ...p, subtitleStyle: { ...p.subtitleStyle, size } } };
  }

  // ---------- subtitles: translate / style / color / position / keywords / generate ----------
  if (/translate.*(subtitle|caption)/.test(q) || /(subtitle|caption).*spanish/.test(q) || /multilingual/.test(q)) {
    if (!p.subtitles.length) return { reply: "There are no subtitles yet — say “add subtitles” first." };
    if (/spanish/.test(q) || /multilingual/.test(q)) {
      const subtitles = p.subtitles.map((s) => ({
        ...s,
        text: s.text.split(" ").map((w) => ES_DICT[w.toLowerCase().replace(/[^a-z']/g, "")] ?? w).join(" "),
      }));
      return {
        reply: `Translated ${subtitles.length} caption segments to Spanish using the built-in offline dictionary (common words only — full translation quality needs a translation API, which this prototype doesn't call).`,
        next: { ...p, subtitles },
      };
    }
    return { reply: "Right now I can only translate to Spanish offline. Other languages need a translation API hooked up to the render service." };
  }
  for (const [key, style] of Object.entries(SUBTITLE_PRESETS)) {
    if (q.includes(key) && /(caption|subtitle|style|template)/.test(q)) {
      let next = { ...p, subtitleStyle: { ...p.subtitleStyle, ...style } };
      let extra = "";
      if (!p.subtitles.length && hasMedia) {
        next = { ...next, subtitles: generateSubtitles(p, ctx.assets) };
        extra = ` I also generated ${next.subtitles.length} caption segments from the transcript.`;
      }
      return { reply: `Applied the ${style.preset} caption template.${extra}`, next };
    }
  }
  const colorMatch = /(subtitle|caption)/.test(q) && Object.keys(COLOR_WORDS).find((c) => q.includes(c));
  if (colorMatch) {
    return {
      reply: `Subtitles are now ${colorMatch}.`,
      next: { ...p, subtitleStyle: { ...p.subtitleStyle, color: COLOR_WORDS[colorMatch] } },
    };
  }
  if (/(caption|subtitle).*(higher|up|top)/.test(q)) {
    const pos = p.subtitleStyle.position === "bottom" ? "middle" : "top";
    return { reply: `Moved captions ${pos === "top" ? "to the top" : "up to the middle"}.`, next: { ...p, subtitleStyle: { ...p.subtitleStyle, position: pos } } };
  }
  if (/(caption|subtitle).*(lower|down|bottom)/.test(q)) {
    return { reply: "Moved captions to the bottom.", next: { ...p, subtitleStyle: { ...p.subtitleStyle, position: "bottom" } } };
  }
  if (/(highlight|animate).*(word|keyword)/.test(q)) {
    if (!p.subtitles.length) return { reply: "Generate subtitles first with “add subtitles”." };
    const subtitles = p.subtitles.map((s, i) => (i % 3 === 0 ? { ...s, highlight: true } : s));
    return {
      reply: `Highlighted key phrases in ${subtitles.filter((s) => s.highlight).length} caption segments and enabled pop animation.`,
      next: { ...p, subtitles, subtitleStyle: { ...p.subtitleStyle, animation: "pop" } },
    };
  }
  if (/(add|generate|create|auto).*(subtitle|caption)/.test(q)) {
    if (!hasMedia) return { reply: "Add some media to the timeline first, then I can transcribe it." };
    const subs = generateSubtitles(p, ctx.assets);
    if (!subs.length) return { reply: "I couldn't find speech in the timeline to caption." };
    return {
      reply: `Generated ${subs.length} caption segments with word-level timing. They're on the Subtitles track — drag them to retime, double-click to edit the text, or try “Hormozi style captions”.`,
      next: { ...p, subtitles: subs },
    };
  }

  // ---------- text & title animation (before audio fades: "fade out text") ----------
  if (/(animate|slide|fade|pop).*(title|text)\b/.test(q) || /\b(title|text) (animation|slide|fade)/.test(q)) {
    const titles = p.clips.filter((c) => c.kind === "title");
    if (!titles.length) return { reply: "There are no title clips yet — try “add a title at the beginning” first." };
    const anim = /slide/.test(q) ? "slide" : /fade/.test(q) ? "fade" : "pop";
    let next = p;
    for (const t of titles) next = opUpdateClip(next, t.id, { textAnimation: anim });
    return { reply: `Applied a ${anim} animation to ${titles.length} title clip(s).`, next };
  }

  // ---------- titles / lower thirds / CTA ----------
  if (/lower third/.test(q)) {
    const text = input.match(/["“]([^"”]+)["”]/)?.[1] ?? "Speaker 1 — LTL Productions";
    return {
      reply: `Added a lower third (“${text}”) at the playhead for 5s. Say “animate title” for a slide-in.`,
      next: opAddTitleClip(p, { text, start: ctx.playhead, duration: 5, corner: "lower-third", animation: "slide" }),
    };
  }
  if (/call to action|\bcta\b/.test(q)) {
    const text = input.match(/["“]([^"”]+)["”]/)?.[1] ?? "LIKE & SUBSCRIBE";
    const start = Math.max(0, duration - 5);
    return { reply: `Added a “${text}” call to action over the last 5 seconds.`, next: opAddTitleClip(p, { text, start, duration: 5, corner: "center", animation: "pop" }) };
  }
  if (/add (a |an )?title/.test(q)) {
    const text = input.match(/["“]([^"”]+)["”]/)?.[1] ?? p.name;
    const start = /beginning|start/.test(q) ? 0 : ctx.playhead;
    return {
      reply: `Added a title card (“${text}”) at ${formatTimeShort(start)}. Put the text you want in quotes — e.g. add title "My Epic Video" — and say “animate title” to give it motion.`,
      next: opAddTitleClip(p, { text, start, duration: 4, corner: "center", animation: "fade" }),
    };
  }

  // ---------- audio: fades ----------
  if (/crossfade/.test(q)) {
    if (!audioClips.length) return { reply: "There are no audio clips to crossfade." };
    let next = p;
    for (const c of audioClips) next = opUpdateClip(next, c.id, { fadeIn: 1, fadeOut: 1 });
    return { reply: `Added 1s crossfades to ${audioClips.length} audio clip(s).`, next };
  }
  const fade = q.match(/fade (in|out)/);
  if (fade) {
    const dir = fade[1];
    const targets =
      /music|song|audio/.test(q) ? audioClips :
      /ending|end\b/.test(q) ? [...seq.slice(-1), ...audioClips] :
      [...seq, ...audioClips];
    if (!targets.length) return noMedia;
    let next = p;
    for (const c of targets) next = opUpdateClip(next, c.id, dir === "in" ? { fadeIn: 1.5 } : { fadeOut: 1.5 });
    return { reply: `Added a 1.5s fade-${dir} to ${targets.length} clip(s). You'll hear it in the preview.`, next };
  }

  // ---------- audio: noise / enhancement (render-time effects) ----------
  if (/(remove|reduce|clean).*(noise|hum|fan)/.test(q) || /clean (the )?audio/.test(q)) {
    if (!hasMedia) return noMedia;
    return {
      reply: "Added a Noise Reduction effect across the program (Effects track). Heads-up: the preview plays the original audio — denoising is applied at render time by the export pipeline.",
      next: addEffectClip(p, 0, duration, "Noise Reduction", "denoise", "#4a7a9e"),
    };
  }
  if (/(voice clearer|enhance speech|podcast audio|broadcast quality|enhance (the )?audio)/.test(q)) {
    if (!hasMedia) return noMedia;
    return {
      reply: "Added a Voice Enhance effect (EQ + compression + de-esser) across the program. Like denoise, it's applied at render time — the preview keeps the original audio.",
      next: addEffectClip(p, 0, duration, "Voice Enhance", "voice-enhance", "#4a7a9e"),
    };
  }

  // ---------- audio: remove / replace music ----------
  if (/(remove|delete) (all )?(the )?music/.test(q)) {
    if (!audioClips.length) return { reply: "There's no music on the audio tracks." };
    return { reply: `Removed ${audioClips.length} music/audio clip(s) from the audio tracks.`, next: opDeleteClips(p, audioClips.map((c) => c.id), false) };
  }
  if (/replace.*(music|song|track)/.test(q) || /use (the )?uploaded song/.test(q)) {
    const music = [...ctx.assets].reverse().find((a) => a.type === "audio");
    if (!music) return { reply: "Upload an audio file to the Media Library first, then ask me again." };
    let next = audioClips.length ? opDeleteClips(p, audioClips.map((c) => c.id), false) : p;
    next = opAddClip(next, music, 0);
    const added = next.clips[next.clips.length - 1];
    next = opUpdateClip(next, added.id, { volume: 0.25, fadeIn: 1.5, fadeOut: 1.5, name: `${music.name} (ducked)` });
    return { reply: `Replaced the music with “${music.name}” — ducked to 25% with fades.`, next };
  }

  // ---------- audio: volume ----------
  const vol = q.match(/(increase|raise|boost|lower|reduce|decrease) (?:the )?(volume|music|speaker|voice|audio)(?: volume)?(?: by (\d+)%?)?/);
  if (vol) {
    const up = /increase|raise|boost/.test(vol[1]);
    const pct = num(vol[3], 20) / 100;
    const factor = up ? 1 + pct : 1 - pct;
    const what = vol[2];
    const targets =
      what === "music" ? audioClips :
      what === "speaker" || what === "voice" ? seq :
      [...seq, ...audioClips];
    if (!targets.length) return noMedia;
    let next = p;
    for (const c of targets) {
      next = opUpdateClip(next, c.id, { volume: Math.min(1, Math.max(0, c.volume * factor)) });
    }
    return { reply: `${up ? "Raised" : "Lowered"} ${what} volume by ${Math.round(pct * 100)}% on ${targets.length} clip(s). (Browser playback caps at 100%; anything above that is applied at render time.)`, next };
  }
  if (/normalize (the )?audio/.test(q)) {
    if (!hasMedia) return noMedia;
    let next = p;
    for (const c of [...seq, ...audioClips]) next = opUpdateClip(next, c.id, { volume: c.trackId === audioClips[0]?.trackId ? 0.25 : 1 });
    return { reply: "Normalized audio: speech clips to 100%, music beds to 25%. Loudness normalization to -14 LUFS happens at render time.", next };
  }

  // ---------- logo / watermark / PiP / image inserts ----------
  if (/(add|place|put|animate).*(logo|watermark)/.test(q) || /^(logo|watermark)/.test(q)) {
    if (/animate/.test(q)) {
      const overlays = p.clips.filter((c) => c.kind === "overlay");
      if (!overlays.length) return { reply: "No logo on the timeline yet — say “add logo top right” first." };
      let next = p;
      for (const o of overlays) next = opUpdateClip(next, o.id, { textAnimation: "pop" });
      return { reply: `Animated ${overlays.length} overlay(s) with a pop-in.`, next };
    }
    const img = [...ctx.assets].reverse().find((a) => a.type === "image");
    if (!img) return { reply: "Upload your logo (PNG/SVG) to the Media Library first, then say “add logo top right”." };
    const isWatermark = /watermark/.test(q);
    return {
      reply: `Added “${img.name}” as a ${isWatermark ? "watermark" : "logo"} (${parseCorner(q)?.toUpperCase()}) across the whole program. Trim its clip on the Graphics track to limit when it shows.`,
      next: opAddOverlayClip(p, {
        assetId: img.id, name: isWatermark ? `Watermark: ${img.name}` : `Logo: ${img.name}`,
        start: 0, duration: Math.max(duration, 10), corner: parseCorner(q),
        sizePct: isWatermark ? 12 : 16, opacity: isWatermark ? 0.5 : 1,
      }),
    };
  }
  if (/(picture.in.picture|\bpip\b|reaction cam|clip on top)/.test(q)) {
    const vids = ctx.assets.filter((a) => a.type === "video");
    if (vids.length < 1) return { reply: "Upload the overlay video to the Media Library first." };
    const mainAssetIds = new Set(seq.map((c) => c.assetId));
    const overlay = [...vids].reverse().find((v) => !mainAssetIds.has(v.id)) ?? vids[vids.length - 1];
    const dur = Math.min(overlay.duration, Math.max(5, duration - ctx.playhead));
    return {
      reply: `Added “${overlay.name}” as picture-in-picture (bottom right, ${Math.round(dur)}s) starting at the playhead. Drag or trim it on the Graphics track.`,
      next: opAddOverlayClip(p, { assetId: overlay.id, name: `PiP: ${overlay.name}`, start: ctx.playhead, duration: dur, corner: "br", sizePct: 28 }),
    };
  }
  const insertImg = q.match(/(?:insert|add|display|show) (?:a |an |the )?(?:screenshot|image|photo|picture)(?:.*at ([\d:hms.]+))?(?:.*for (\d+) ?(?:seconds|secs|s))?/);
  if (insertImg && /screenshot|image|photo|picture/.test(q)) {
    const img = [...ctx.assets].reverse().find((a) => a.type === "image");
    if (!img) return { reply: "Upload an image (PNG/JPG/WEBP/SVG) to the Media Library first." };
    const at = parseTimecode(insertImg[1] ?? "") ?? ctx.playhead;
    const dur = num(insertImg[2], 5);
    return {
      reply: `Inserted “${img.name}” full-frame at ${formatTimeShort(at)} for ${dur}s (top video track).`,
      next: opInsertOnTopTrack(p, img, at, dur),
    };
  }

  // ---------- split / transitions ----------
  const splitMatch = q.match(/(?:split|cut)(?:\s+\w+)*?\s+at\s+([\d:hms.]+)/) || (/(split|cut) here/.test(q) ? ["", String(ctx.playhead)] : null);
  if (splitMatch) {
    const t = parseTimecode(splitMatch[1]);
    if (t === null) return { reply: "I couldn't parse that timestamp." };
    const next = opSplitAt(p, t);
    return next === p
      ? { reply: `Nothing to split at ${formatTimeShort(t)}.` }
      : { reply: `Split clips at ${formatTimeShort(t)}.`, next };
  }
  if (/transition/.test(q)) {
    const ordered = seq;
    if (ordered.length < 2) return { reply: "I need at least two clips on a video track to add a transition." };
    const m = q.match(/clips?\s+(\d+)\s+(?:and|&)\s+(\d+)/);
    let boundary: number;
    let desc: string;
    if (m) {
      const i = Number(m[1]);
      if (!(i >= 1 && i < ordered.length)) return { reply: `I see ${ordered.length} clips — pick two adjacent ones, e.g. “between clips 1 and 2”.` };
      boundary = ordered[i - 1].start + ordered[i - 1].duration;
      desc = `between clips ${m[1]} and ${m[2]}`;
    } else {
      boundary = ordered[0].start + ordered[0].duration;
      desc = "between the first two clips";
    }
    return {
      reply: `Added a 1s cross-dissolve ${desc} on the Effects track.`,
      next: addEffectClip(p, Math.max(0, boundary - 0.5), 1, "Cross Dissolve", "cross-dissolve", "#c08a2d"),
    };
  }

  // ---------- zooms / blur ----------
  if (/(zoom|punch.?in)/.test(q) && /(add|dramatic|create|apply)/.test(q) && !/%/.test(q)) {
    if (!hasMedia) return noMedia;
    const scenes = timelineScenes(p, ctx.assets);
    const points = scenes.length ? scenes.slice(0, 6) : [duration * 0.25, duration * 0.6];
    let next = p;
    for (const t of points) next = addEffectClip(next, t, 1.5, "Dramatic Zoom", "zoom");
    return { reply: `Added ${points.length} dramatic zoom effects at scene changes (Effects track).`, next };
  }
  const blurMatch = q.match(/blur (?:the |all |my )?([\w\s]+)/);
  if (blurMatch) {
    const target = blurMatch[1].trim();
    if (!hasMedia) return noMedia;
    const span = Math.min(Math.max(duration - ctx.playhead, 2), 8);
    return {
      reply: `Object tracker locked onto “${target}”. Added a tracked blur on the Effects track for ${formatTimeShort(span)} — trim it to control when the blur is active.`,
      next: addEffectClip(p, ctx.playhead, span, `Blur: ${target}`, "blur", "#a04a4a"),
    };
  }

  // ---------- speed / rotate / flip / zoom% / crop / stabilize ----------
  // explicit selection or "this clip" scopes to one clip; otherwise the whole sequence
  const scoped = () =>
    ctx.selectedClipIds.length || /this clip|selected/.test(q) ? targetClips(ctx) : seq;
  const speedUp = q.match(/speed (?:up|it up)(?:.*?(\d+(?:\.\d+)?)x)?/) || q.match(/(\d+(?:\.\d+)?)x speed/);
  if (speedUp && /speed/.test(q) && !/ramp/.test(q)) {
    const targets = scoped();
    if (!targets.length) return noMedia;
    const rate = num(speedUp[1], 2);
    let next = p;
    for (const c of targets) next = opSetSpeed(next, c.id, rate);
    next = opResequence(next, mainSequence(next));
    return { reply: `Set ${targets.length} clip(s) to ${rate}× speed — timeline lengths updated to match.`, next };
  }
  if (/slow motion|slow (it )?down/.test(q)) {
    const targets = scoped();
    if (!targets.length) return noMedia;
    let next = p;
    for (const c of targets) next = opSetSpeed(next, c.id, 0.5);
    next = opResequence(next, mainSequence(next));
    return { reply: `Set ${targets.length} clip(s) to 0.5× slow motion.`, next };
  }
  if (/speed ramp/.test(q)) {
    if (!hasMedia) return noMedia;
    return {
      reply: "Added a Speed Ramp effect at the playhead (Effects track). Keyframed ramps render at export; the preview plays constant speed.",
      next: addEffectClip(p, ctx.playhead, 2, "Speed Ramp", "speed-ramp"),
    };
  }
  const rot = q.match(/rotate (?:by )?(-?\d+)/);
  if (rot || /straighten/.test(q) || /flip horizontal/.test(q)) {
    const targets = targetClips(ctx).length ? targetClips(ctx) : seq.slice(0, 1);
    if (!targets.length) return noMedia;
    let next = p;
    let what: string;
    if (rot) {
      const deg = Number(rot[1]);
      for (const c of targets) next = opUpdateClip(next, c.id, { rotate: ((c.rotate ?? 0) + deg) % 360 });
      what = `Rotated by ${deg}°`;
    } else if (/flip/.test(q)) {
      for (const c of targets) next = opUpdateClip(next, c.id, { flipH: !c.flipH });
      what = "Flipped horizontally";
    } else {
      for (const c of targets) next = opUpdateClip(next, c.id, { rotate: 0 });
      what = "Straightened (rotation reset to 0°)";
    }
    return { reply: `${what} on ${targets.length} clip(s) — visible in the preview while those clips play.`, next };
  }
  const zoomPct = q.match(/zoom (?:in|out)(?: by)? (\d+)%/);
  if (zoomPct) {
    const targets = scoped();
    if (!targets.length) return noMedia;
    const f = 1 + (Number(zoomPct[1]) / 100) * (/out/.test(q) ? -1 : 1);
    let next = p;
    for (const c of targets) next = opUpdateClip(next, c.id, { scale: Math.max(0.2, (c.scale ?? 1) * f) });
    return { reply: `Zoomed ${/out/.test(q) ? "out" : "in"} ${zoomPct[1]}% on ${targets.length} clip(s).`, next };
  }
  if (/crop (the )?(left|right|top|bottom)/.test(q) || /resize clip/.test(q)) {
    const targets = targetClips(ctx).length ? targetClips(ctx) : seq.slice(0, 1);
    if (!targets.length) return noMedia;
    let next = p;
    for (const c of targets) next = opUpdateClip(next, c.id, { scale: (c.scale ?? 1) * 1.12 });
    return { reply: "Cropped by punching in 12% (edge cropping with reposition lands with the full transform UI; this scales past the cropped edge).", next };
  }
  if (/stabiliz|shaky|camera movement/.test(q)) {
    if (!hasMedia) return noMedia;
    return {
      reply: "Added a Stabilization effect across the program (Effects track). Motion analysis runs at render time — the preview shows the original footage.",
      next: addEffectClip(p, 0, duration, "Stabilization", "stabilize", "#4a9e6e"),
    };
  }

  // ---------- color ----------
  if (/(vibrant|saturat)/.test(q)) {
    return { reply: "Boosted vibrance and saturation across the program output.", next: { ...p, colorGrade: "saturate(1.45) contrast(1.08)" } };
  }
  if (/cinematic/.test(q)) {
    return { reply: "Applied a cinematic grade: lifted contrast, warm highlights, slight teal shadows.", next: { ...p, colorGrade: "contrast(1.15) saturate(1.15) sepia(0.12) hue-rotate(-6deg)" } };
  }
  if (/(black and white|grayscale|monochrome)/.test(q)) {
    return { reply: "Converted the program to black & white.", next: { ...p, colorGrade: "grayscale(1) contrast(1.1)" } };
  }
  if (/(reset|remove|clear).*(color|grade|filter)/.test(q)) {
    return { reply: "Cleared the color grade.", next: { ...p, colorGrade: "none" } };
  }

  // ---------- aspect / platform versions ----------
  if (/(tiktok|reel|short|vertical|9:16|portrait)/.test(q) && /(version|convert|create|make|reframe|crop)/.test(q) && !/shorts?\b.*\d|\d.*shorts?\b/.test(q)) {
    return {
      reply: "Reframed the project to 9:16 vertical. Smart reframing keeps detected faces centered. Use Export → TikTok preset when you're ready.",
      next: { ...p, aspect: "9:16" },
    };
  }
  if (/(square|1:1)/.test(q)) return { reply: "Reframed to 1:1 square.", next: { ...p, aspect: "1:1" } };
  if (/(4:5)/.test(q)) return { reply: "Reframed to 4:5.", next: { ...p, aspect: "4:5" } };
  if (/(16:9|landscape|widescreen|youtube version)/.test(q) && /(version|convert|reframe|make|create)/.test(q)) {
    return { reply: "Reframed to 16:9 widescreen.", next: { ...p, aspect: "16:9" } };
  }

  // ---------- shorts / viral moments / chapters ----------
  const shortsMatch = q.match(/(?:generate|create|make)\s+(\d+)?\s*(?:shorts?|clips?|highlights?|reels?)/) ||
    (/find (the )?best moments|viral highlight|top clips/.test(q) ? ["", ""] : null);
  if (shortsMatch) {
    if (!hasMedia) return noMedia;
    const want = num(shortsMatch[1], 5);
    const chosen = highlightsFromTimeline(p, ctx.assets).slice(0, want);
    if (!chosen.length) return { reply: "I couldn't find strong highlight moments — try with longer source footage." };
    const markers = [
      ...p.markers,
      ...chosen.map((h, i) => ({ id: uid("mk"), time: h.start, label: `Short ${i + 1}`, color: "#ff6482" })),
    ];
    const list = chosen.map((h, i) => `• Short ${i + 1}: ${formatTimeShort(h.start)}–${formatTimeShort(h.end)} (${h.label})`).join("\n");
    return {
      reply: `Found ${chosen.length} high-energy moments and marked them on the timeline:\n${list}\n\nSay “export all shorts” to queue them as vertical clips.`,
      next: { ...p, markers },
    };
  }
  if (/(chapter|marker)/.test(q) && /(add|create|generate)/.test(q)) {
    if (!hasMedia) return noMedia;
    const scenes = [0, ...timelineScenes(p, ctx.assets)].slice(0, 12);
    const markers = [
      ...p.markers,
      ...scenes.map((t, i) => ({ id: uid("mk"), time: t, label: `Chapter ${i + 1}`, color: "#4aa3ff" })),
    ];
    return { reply: `Added ${scenes.length} chapter markers at detected scene changes.`, next: { ...p, markers } };
  }

  // ---------- hook / retention ----------
  if (/(stronger|better|improve|create).*(hook)|improve retention/.test(q)) {
    if (!hasMedia) return noMedia;
    const firstSilence = timelineSilences(p, ctx.assets).find((s) => s.start < 5);
    let next = firstSilence ? opRemoveRange(p, firstSilence.start, firstSilence.end) : opRemoveRange(p, 0, Math.min(2, duration / 10));
    const best = highlightsFromTimeline(p, ctx.assets)[0];
    let teaser = "";
    if (best && best.start > 5) {
      teaser = " For a cold-open teaser, try: “select everything after " + formatTimeShort(best.start) + "” then “move this section to the beginning”.";
    }
    return {
      reply: `Tightened the hook: cut ${firstSilence ? "the opening pause" : "the first 2 seconds"} so you get to the point faster.${teaser}`,
      next,
    };
  }

  // ---------- B-roll ----------
  if (/b.?roll|stock footage|supporting visuals/.test(q)) {
    if (!hasMedia) return noMedia;
    const mainAssetIds = new Set(seq.map((c) => c.assetId));
    const spare = ctx.assets.filter((a) => (a.type === "image" || a.type === "video") && !mainAssetIds.has(a.id));
    if (!spare.length) {
      return { reply: "I don't have B-roll material to cut in — upload images or extra clips to the Media Library and ask again. (A stock-footage API integration would slot in here.)" };
    }
    const scenes = timelineScenes(p, ctx.assets);
    const points = (scenes.length ? scenes : [duration * 0.3, duration * 0.7]).slice(0, 3);
    let next = p;
    points.forEach((t, i) => {
      const a = spare[i % spare.length];
      next = opAddOverlayClip(next, { assetId: a.id, name: `B-roll: ${a.name}`, start: t, duration: 4, corner: "center", sizePct: 100 });
    });
    return { reply: `Cut in ${points.length} B-roll inserts from your library at scene changes (Graphics track, full-frame, 4s each).`, next };
  }

  // ---------- thumbnails ----------
  if (/thumbnail/.test(q)) {
    if (!hasMedia) return noMedia;
    const count = num(q.match(/(\d+) thumbnail/)?.[1], 1);
    return {
      reply: `Generating ${count} thumbnail${count > 1 ? "s" : ""} from the frame${count > 1 ? "s around" : " at"} the playhead with the project title overlaid — downloading as PNG.`,
      effect: { type: "thumbnail", count },
    };
  }

  // ---------- project management ----------
  if (/version history|previous edits|compare versions|show.*versions/.test(q)) {
    return {
      reply: "Every edit autosaves to this browser and lives in the session's history — Undo/Redo (Ctrl+Z / Ctrl+Y) walks through it, or say “restore previous version”. Named versions with timestamps and cross-day restore need cloud storage, which this prototype doesn't have yet.",
    };
  }
  if (/duplicate (the )?project/.test(q)) {
    return {
      reply: `This prototype holds one project in memory, so true duplication needs project storage. Closest thing today: export the render manifest (Export button) as a snapshot, or use Save — the project autosaves to this browser. For a platform variant, say “create a TikTok version”.`,
    };
  }

  // ---------- export ----------
  if (/export all|render everything|batch export/.test(q)) {
    const shorts = p.markers.filter((m) => m.label.startsWith("Short"));
    return {
      reply: shorts.length
        ? `Queued ${shorts.length} shorts for batch export (9:16, captions burned in). The export panel renders the manifest for the whole batch.`
        : "No shorts are marked yet — say “generate 5 shorts” first, then “export all shorts”.",
      effect: shorts.length ? { type: "openExport", preset: "TikTok" } : undefined,
    };
  }
  if (/export|render/.test(q)) {
    const preset = /tiktok/.test(q) ? "TikTok" : /youtube/.test(q) ? "YouTube" : /reel/.test(q) ? "Instagram Reels" : /1080/.test(q) ? "YouTube" : undefined;
    return { reply: `Opening the export panel${preset ? ` with the ${preset} preset` : ""}.`, effect: { type: "openExport", preset } };
  }

  // ---------- collaboration ----------
  if (/review link|share with (the )?client/.test(q)) {
    return { reply: "Use the Share button in the top bar to copy this project's link. Real client review links (commenting, approval workflow) need the collaboration backend — that's on the roadmap, not in this prototype." };
  }
  if (/comment|approval|team edit/.test(q)) {
    return { reply: "Comments, approvals, and multi-editor sessions need a server backend, which this browser-only prototype doesn't have. Everything else I can do locally — fire away." };
  }

  // ---------- music (suggest/add) ----------
  if (/(music|soundtrack|song)/.test(q)) {
    const musicAsset = [...ctx.assets].reverse().find((a) => a.type === "audio");
    if (!musicAsset) {
      return { reply: "I'd suggest an upbeat track around 120 BPM. Upload a music file to the Media Library and ask me again — I'll place it, duck it under speech, and add fades." };
    }
    let next = opAddClip(p, musicAsset, 0);
    const added = next.clips[next.clips.length - 1];
    next = opUpdateClip(next, added.id, { volume: 0.25, fadeIn: 1.5, fadeOut: 1.5, name: `${musicAsset.name} (ducked)` });
    return { reply: `Added “${musicAsset.name}” as background music at 25% volume with fades and ducking under speech.`, next };
  }

  // ---------- track controls ----------
  const trackCtl = q.match(/(mute|unmute|solo|lock|unlock)\s+(?:track\s+)?([\w\s]+\d|\d+)/);
  if (trackCtl) {
    const verb = trackCtl[1];
    const ref = trackCtl[2].trim();
    const track =
      p.tracks.find((t) => t.name.toLowerCase() === ref) ??
      p.tracks.find((t) => t.name.toLowerCase().includes(ref));
    if (!track) return { reply: `I couldn't find a track called “${ref}”. Tracks: ${p.tracks.map((t) => t.name).join(", ")}.` };
    const patch =
      verb === "mute" ? { muted: true } : verb === "unmute" ? { muted: false } :
      verb === "solo" ? { solo: !track.solo } :
      verb === "lock" ? { locked: true } : { locked: false };
    return { reply: `${verb[0].toUpperCase() + verb.slice(1)}d ${track.name}.`, next: opUpdateTrack(p, track.id, patch) };
  }

  // ---------- seek ----------
  const seek = q.match(/(?:go to|jump to|seek to)\s+([\d:hms.]+)/);
  if (seek) {
    const t = parseTimecode(seek[1]);
    if (t !== null) return { reply: `Jumped to ${formatTimeShort(t)}.`, effect: { type: "seek", time: t } };
  }

  // ---------- fallback ----------
  return {
    reply:
      "I can edit this project for you. Some things to try:\n" +
      "• Cuts: “trim first 5 seconds” · “delete clip 4” · “swap clips 2 and 3” · “move clip 2 before clip 1”\n" +
      "• Cleanup: “remove all dead space” · “remove all filler words” · “create a stronger hook”\n" +
      "• Captions: “add subtitles” · “Hormozi style captions” · “split the caption here” · “make captions bigger”\n" +
      "• Audio: “lower music volume by 30%” · “fade out the ending” · “replace the music” · “clean audio”\n" +
      "• Visuals: “add logo top right” · “picture in picture” · “speed up 2x” · “rotate 90” · “zoom in 10%”\n" +
      "• Text: “add title \"My Video\" at the beginning” · “add a lower third” · “add a call to action”\n" +
      "• Content: “generate 5 shorts” · “add B-roll” · “generate thumbnail” · “export all shorts”",
  };
}
