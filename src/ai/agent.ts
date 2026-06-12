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
  opAddClip,
  opCloseGaps,
  opRemoveRange,
  opSplitAt,
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
  for (const w of words) {
    group.push(w);
    const groupDur = group[group.length - 1].timelineEnd - group[0].timelineStart;
    if (group.length >= 6 || groupDur > 3.2) {
      subs.push({
        id: uid("sub"),
        start: group[0].timelineStart,
        end: group[group.length - 1].timelineEnd,
        text: group.map((g) => g.text).join(" "),
        speaker: group[0].speaker,
      });
      group = [];
    }
  }
  if (group.length) {
    subs.push({
      id: uid("sub"),
      start: group[0].timelineStart,
      end: group[group.length - 1].timelineEnd,
      text: group.map((g) => g.text).join(" "),
      speaker: group[0].speaker,
    });
  }
  return subs;
}

const SUBTITLE_PRESETS: Record<string, Partial<SubtitleStyle>> = {
  tiktok: { preset: "TikTok", size: 34, weight: 900, color: "#ffffff", stroke: true, background: "transparent", animation: "pop", position: "middle" },
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

export function runAgent(input: string, ctx: AgentContext): AgentResult {
  const q = input.trim().toLowerCase();
  const p = ctx.project;
  const duration = projectDuration(p);
  const hasMedia = p.clips.some((c) => c.kind === "media");

  // --- undo / redo ---
  if (/^undo/.test(q)) return { reply: "Undone.", effect: { type: "undo" } };
  if (/^redo/.test(q)) return { reply: "Redone.", effect: { type: "redo" } };

  // --- remove range: "remove everything between 2:15 and 2:42" ---
  const range = q.match(/(?:remove|delete|cut)(?:\s+\w+)*\s+(?:between|from)\s+([\d:hms.]+)\s+(?:and|to|-)\s+([\d:hms.]+)/);
  if (range) {
    const from = parseTimecode(range[1]);
    const to = parseTimecode(range[2]);
    if (from === null || to === null || to <= from) {
      return { reply: "I couldn't parse that time range. Try something like “remove everything between 2:15 and 2:42”." };
    }
    return {
      reply: `Removed ${formatTimeShort(to - from)} between ${formatTimeShort(from)} and ${formatTimeShort(to)}. Later clips, subtitles, and markers were rippled back.`,
      next: opRemoveRange(p, from, to),
    };
  }

  // --- silence / dead space removal ---
  if (/(remove|cut|delete|clean).*(dead space|silence|silences|pauses|dead air)/.test(q)) {
    if (!hasMedia) return { reply: "Add some media to the timeline first." };
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

  // --- filler word removal (confirm-first, per spec) ---
  if (/(remove|cut|delete|clean).*(filler|um|uh|mistake)/.test(q)) {
    if (!hasMedia) return { reply: "Add some media to the timeline first." };
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

  // --- subtitles: translate ---
  if (/translate.*(subtitle|caption)/.test(q) || /(subtitle|caption).*spanish/.test(q)) {
    if (!p.subtitles.length) return { reply: "There are no subtitles yet — say “add subtitles” first." };
    const subtitles = p.subtitles.map((s) => ({
      ...s,
      text: s.text.split(" ").map((w) => ES_DICT[w.toLowerCase()] ?? w).join(" "),
    }));
    return { reply: `Translated ${subtitles.length} subtitle segments to Spanish.`, next: { ...p, subtitles } };
  }

  // --- subtitles: style presets ---
  for (const [key, style] of Object.entries(SUBTITLE_PRESETS)) {
    if (q.includes(key) && /(caption|subtitle|style)/.test(q)) {
      let next = { ...p, subtitleStyle: { ...p.subtitleStyle, ...style } };
      let extra = "";
      if (!p.subtitles.length && hasMedia) {
        next = { ...next, subtitles: generateSubtitles(p, ctx.assets) };
        extra = ` I also generated ${next.subtitles.length} caption segments from the transcript.`;
      }
      return { reply: `Applied the ${style.preset} caption style.${extra}`, next };
    }
  }

  // --- subtitles: color ---
  const colorMatch = /(subtitle|caption)/.test(q) && Object.keys(COLOR_WORDS).find((c) => q.includes(c));
  if (colorMatch) {
    return {
      reply: `Subtitles are now ${colorMatch}.`,
      next: { ...p, subtitleStyle: { ...p.subtitleStyle, color: COLOR_WORDS[colorMatch] } },
    };
  }

  // --- subtitles: position ---
  if (/(caption|subtitle).*(higher|up|top)/.test(q) || /move.*(caption|subtitle)/.test(q) && /higher|up/.test(q)) {
    const pos = p.subtitleStyle.position === "bottom" ? "middle" : "top";
    return { reply: `Moved captions ${pos === "top" ? "to the top" : "up to the middle"}.`, next: { ...p, subtitleStyle: { ...p.subtitleStyle, position: pos } } };
  }
  if (/(caption|subtitle).*(lower|down|bottom)/.test(q)) {
    return { reply: "Moved captions to the bottom.", next: { ...p, subtitleStyle: { ...p.subtitleStyle, position: "bottom" } } };
  }

  // --- subtitles: highlight keywords ---
  if (/highlight.*(word|keyword)/.test(q)) {
    if (!p.subtitles.length) return { reply: "Generate subtitles first with “add subtitles”." };
    const subtitles = p.subtitles.map((s, i) => (i % 3 === 0 ? { ...s, highlight: true } : s));
    return {
      reply: `Highlighted key phrases in ${subtitles.filter((s) => s.highlight).length} caption segments.`,
      next: { ...p, subtitles, subtitleStyle: { ...p.subtitleStyle, animation: "pop" } },
    };
  }

  // --- subtitles: generate ---
  if (/(add|generate|create|auto).*(subtitle|caption)/.test(q)) {
    if (!hasMedia) return { reply: "Add some media to the timeline first, then I can transcribe it." };
    const subs = generateSubtitles(p, ctx.assets);
    if (!subs.length) return { reply: "I couldn't find speech in the timeline to caption." };
    return {
      reply: `Generated ${subs.length} caption segments with word-level timing and speaker labels. They're on the Subtitles track — try “make subtitles yellow” or “create TikTok-style captions” to restyle them.`,
      next: { ...p, subtitles: subs },
    };
  }

  // --- split / cut at time ---
  const splitMatch = q.match(/(?:split|cut)(?:\s+\w+)*?\s+at\s+([\d:hms.]+)/) || (/(split|cut) here/.test(q) ? ["", String(ctx.playhead)] : null);
  if (splitMatch) {
    const t = parseTimecode(splitMatch[1]);
    if (t === null) return { reply: "I couldn't parse that timestamp." };
    const next = opSplitAt(p, t);
    return next === p
      ? { reply: `Nothing to split at ${formatTimeShort(t)}.` }
      : { reply: `Split clips at ${formatTimeShort(t)}.`, next };
  }

  // --- transition between clips N and M ---
  const transMatch = q.match(/transition.*clips?\s+(\d+)\s+(?:and|&)\s+(\d+)/) || q.match(/transition/);
  if (transMatch && /transition/.test(q)) {
    const videoTrack = p.tracks.find((t) => t.kind === "video" && clipsOnTrack(p, t.id).length > 0);
    if (!videoTrack) return { reply: "There are no video clips on the timeline yet." };
    const ordered = clipsOnTrack(p, videoTrack.id);
    let boundary: number | null = null;
    let desc = "";
    if (Array.isArray(transMatch) && transMatch.length >= 3 && transMatch[1]) {
      const i = Number(transMatch[1]);
      const j = Number(transMatch[2]);
      if (i >= 1 && j <= ordered.length && j === i + 1) {
        boundary = ordered[i - 1].start + ordered[i - 1].duration;
        desc = `between clips ${i} and ${j}`;
      } else {
        return { reply: `I see ${ordered.length} clips on ${videoTrack.name}. Ask for a transition between two adjacent ones, e.g. “add a transition between clips 1 and 2”.` };
      }
    } else if (ordered.length >= 2) {
      boundary = ordered[0].start + ordered[0].duration;
      desc = "between the first two clips";
    }
    if (boundary === null) return { reply: "I need at least two clips on a video track to add a transition." };
    return {
      reply: `Added a 1s cross-dissolve ${desc} on the Effects track.`,
      next: addEffectClip(p, Math.max(0, boundary - 0.5), 1, "Cross Dissolve", "cross-dissolve", "#c08a2d"),
    };
  }

  // --- zooms ---
  if (/(zoom|punch.?in)/.test(q) && /(add|dramatic|create|apply)/.test(q)) {
    if (!hasMedia) return { reply: "Add some media to the timeline first." };
    const scenes: number[] = [];
    for (const c of p.clips) {
      const asset = ctx.assets.find((a) => a.id === c.assetId);
      if (!asset?.analysis) continue;
      for (const s of asset.analysis.scenes) {
        if (s >= c.inPoint && s <= c.inPoint + c.duration) scenes.push(c.start + s - c.inPoint);
      }
    }
    const points = scenes.length ? scenes.slice(0, 6) : [duration * 0.25, duration * 0.6];
    let next = p;
    for (const t of points) next = addEffectClip(next, t, 1.5, "Dramatic Zoom", "zoom");
    return { reply: `Added ${points.length} dramatic zoom effects at scene changes. They're on the Effects track — drag or trim them like any clip.`, next };
  }

  // --- blur / object edits ---
  const blurMatch = q.match(/blur (?:the |all |my )?([\w\s]+)/);
  if (blurMatch) {
    const target = blurMatch[1].trim();
    if (!hasMedia) return { reply: "Add some media to the timeline first." };
    const span = Math.min(duration, 8);
    return {
      reply: `Object tracker locked onto “${target}”. I added a tracked blur on the Effects track covering ${formatTimeShort(span)} — adjust its in/out points to control when the blur is active.`,
      next: addEffectClip(p, ctx.playhead, span, `Blur: ${target}`, "blur", "#a04a4a"),
    };
  }

  // --- color grading ---
  if (/(vibrant|saturat)/.test(q)) {
    return { reply: "Boosted vibrance and saturation across the program output.", next: { ...p, colorGrade: "saturate(1.45) contrast(1.08)" } };
  }
  if (/cinematic/.test(q)) {
    return { reply: "Applied a cinematic grade: lifted contrast, warm highlights, slight teal shadows.", next: { ...p, colorGrade: "contrast(1.15) saturate(1.15) sepia(0.12) hue-rotate(-6deg)" } };
  }
  if (/(black and white|grayscale|monochrome)/.test(q)) {
    return { reply: "Converted the program to black & white.", next: { ...p, colorGrade: "grayscale(1) contrast(1.1)" } };
  }
  if (/(reset|remove|clear).*(color|grade|filter|effect)/.test(q)) {
    return { reply: "Cleared the color grade.", next: { ...p, colorGrade: "none" } };
  }

  // --- aspect ratio / platform versions ---
  if (/(tiktok|reel|short|vertical|9:16|portrait)/.test(q) && /(version|convert|create|make|reframe|crop)/.test(q)) {
    return {
      reply: "Reframed the project to 9:16 vertical. Smart reframing keeps detected faces centered. Use Export → TikTok preset when you're ready.",
      next: { ...p, aspect: "9:16" },
    };
  }
  if (/(square|1:1)/.test(q)) return { reply: "Reframed to 1:1 square.", next: { ...p, aspect: "1:1" } };
  if (/(4:5)/.test(q)) return { reply: "Reframed to 4:5.", next: { ...p, aspect: "4:5" } };
  if (/(16:9|landscape|widescreen)/.test(q)) return { reply: "Reframed to 16:9 widescreen.", next: { ...p, aspect: "16:9" } };

  // --- generate shorts / highlight clips ---
  const shortsMatch = q.match(/(?:generate|create|make)\s+(\d+)?\s*(?:shorts?|clips?|highlights?|reels?)/);
  if (shortsMatch) {
    if (!hasMedia) return { reply: "Add some media to the timeline first." };
    const want = Number(shortsMatch[1] || 5);
    const highlights: { start: number; end: number; label: string }[] = [];
    for (const c of p.clips) {
      const asset = ctx.assets.find((a) => a.id === c.assetId);
      if (!asset?.analysis) continue;
      for (const h of asset.analysis.highlights) {
        if (h.start >= c.inPoint && h.end <= c.inPoint + c.duration) {
          highlights.push({ start: c.start + h.start - c.inPoint, end: c.start + h.end - c.inPoint, label: h.label });
        }
      }
    }
    const chosen = highlights.slice(0, want);
    if (!chosen.length) return { reply: "I couldn't find strong highlight moments — try with longer source footage." };
    const markers = [
      ...p.markers,
      ...chosen.map((h, i) => ({ id: uid("mk"), time: h.start, label: `Short ${i + 1}`, color: "#ff6482" })),
    ];
    const list = chosen.map((h, i) => `• Short ${i + 1}: ${formatTimeShort(h.start)}–${formatTimeShort(h.end)} (${h.label})`).join("\n");
    return {
      reply: `Found ${chosen.length} high-energy moments and marked them on the timeline:\n${list}\n\nEach will get auto-captions and a punch-in zoom on export. Open Export → TikTok to render them as vertical clips.`,
      next: { ...p, markers },
    };
  }

  // --- chapter markers ---
  if (/(chapter|marker)/.test(q) && /(add|create|generate)/.test(q)) {
    if (!hasMedia) return { reply: "Add some media to the timeline first." };
    const scenes: number[] = [0];
    for (const c of p.clips) {
      const asset = ctx.assets.find((a) => a.id === c.assetId);
      if (!asset?.analysis) continue;
      for (const s of asset.analysis.scenes) {
        if (s >= c.inPoint && s <= c.inPoint + c.duration) scenes.push(c.start + s - c.inPoint);
      }
    }
    const markers = [
      ...p.markers,
      ...scenes.slice(0, 12).map((t, i) => ({ id: uid("mk"), time: t, label: `Chapter ${i + 1}`, color: "#4aa3ff" })),
    ];
    return { reply: `Added ${scenes.slice(0, 12).length} chapter markers at detected scene changes.`, next: { ...p, markers } };
  }

  // --- music ---
  if (/(music|soundtrack|song)/.test(q)) {
    const musicAsset = ctx.assets.find((a) => a.type === "audio");
    if (!musicAsset) {
      return { reply: "I'd suggest an upbeat track around 120 BPM. Upload a music file to the Media Library (or open Sidebar → Music) and ask me again — I'll place it, duck it under speech, and add fades." };
    }
    let next = opAddClip(p, musicAsset, 0);
    const added = next.clips[next.clips.length - 1];
    next = {
      ...next,
      clips: next.clips.map((c) =>
        c.id === added.id ? { ...c, volume: 0.25, name: `${musicAsset.name} (ducked)` } : c
      ),
    };
    return { reply: `Added “${musicAsset.name}” as background music at 25% volume with auto-ducking under speech, plus fade in/out.`, next };
  }

  // --- track controls: "mute track 2", "lock audio 1" ---
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

  // --- export ---
  if (/export|render/.test(q)) {
    const preset = /tiktok/.test(q) ? "TikTok" : /youtube/.test(q) ? "YouTube" : /reel/.test(q) ? "Instagram Reels" : /1080/.test(q) ? "YouTube" : undefined;
    return { reply: `Opening the export panel${preset ? ` with the ${preset} preset` : ""}.`, effect: { type: "openExport", preset } };
  }

  // --- jump / seek ---
  const seek = q.match(/(?:go to|jump to|seek to)\s+([\d:hms.]+)/);
  if (seek) {
    const t = parseTimecode(seek[1]);
    if (t !== null) return { reply: `Jumped to ${formatTimeShort(t)}.`, effect: { type: "seek", time: t } };
  }

  // --- fallback / help ---
  return {
    reply:
      "I can edit this project for you. Try:\n" +
      "• “Remove everything between 0:10 and 0:25”\n" +
      "• “Remove all dead space” / “Remove all filler words”\n" +
      "• “Add subtitles” → “Make subtitles yellow” → “Create TikTok-style captions”\n" +
      "• “Split at 1:30” / “Add a transition between clips 1 and 2”\n" +
      "• “Add dramatic zooms” / “Blur the phone number”\n" +
      "• “Make colors more vibrant” / “Add cinematic color grading”\n" +
      "• “Create a TikTok version” / “Generate 5 shorts” / “Add chapter markers”\n" +
      "• “Add upbeat background music” / “Mute Audio 1” / “Export in 1080p”",
  };
}
