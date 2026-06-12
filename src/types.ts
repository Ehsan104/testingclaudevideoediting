export type AssetType = "video" | "audio" | "image";

export interface MediaAsset {
  id: string;
  name: string;
  type: AssetType;
  url: string;
  duration: number; // seconds; images get a default
  width?: number;
  height?: number;
  analysis?: MediaAnalysis;
  transcription?: TranscriptionState;
}

export interface TranscriptionState {
  state: "decoding" | "loading-model" | "transcribing" | "real" | "simulated";
  progress?: number; // model download %, when known
  error?: string;
}

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
  isFiller: boolean;
  speaker: string;
}

export interface MediaAnalysis {
  transcript: TranscriptWord[];
  scenes: number[]; // scene-change timestamps within the asset
  speakers: string[];
  silences: { start: number; end: number }[];
  highlights: { start: number; end: number; label: string }[];
}

export type TrackKind = "video" | "audio" | "subtitle" | "effects" | "graphics";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  locked: boolean;
  muted: boolean;
  solo: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  assetId: string | null; // null for generated clips (effects, transitions, titles)
  name: string;
  start: number; // timeline position, seconds
  duration: number; // seconds
  inPoint: number; // offset into source asset, seconds
  color: string;
  kind: "media" | "transition" | "effect" | "title";
  effect?: string; // e.g. "cross-dissolve", "zoom", "blur"
  speed: number;
  volume: number; // 0..1
}

export interface SubtitleStyle {
  font: string;
  size: number;
  weight: number;
  color: string;
  background: string;
  position: "top" | "middle" | "bottom";
  offsetY: number; // extra vertical offset in %
  stroke: boolean;
  animation: "none" | "bounce" | "zoom" | "pop";
  preset: string;
}

export interface Subtitle {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  highlight?: boolean;
}

export interface Marker {
  id: string;
  time: number;
  label: string;
  color: string;
}

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:5";

export interface ProjectState {
  name: string;
  aspect: AspectRatio;
  tracks: Track[];
  clips: Clip[];
  subtitles: Subtitle[];
  subtitleStyle: SubtitleStyle;
  markers: Marker[];
  colorGrade: string; // CSS filter string applied to preview
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: PendingAction | null;
}

// An action the AI proposes and applies after user confirmation
export interface PendingAction {
  description: string;
  apply: (p: ProjectState) => ProjectState;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  font: "Inter, sans-serif",
  size: 28,
  weight: 700,
  color: "#ffffff",
  background: "rgba(0,0,0,0.6)",
  position: "bottom",
  offsetY: 0,
  stroke: false,
  animation: "none",
  preset: "Minimal",
};

let counter = 0;
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
