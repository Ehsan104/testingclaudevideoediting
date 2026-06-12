# LTL AI Video Editor

A next-generation AI-powered video editor that combines a Premiere-style professional
editing workflow with a conversational AI editing agent. Edit on the timeline, edit by
chat, edit by voice — the timeline is always the source of truth.

## Run it

```bash
npm install
npm run dev      # open the printed localhost URL
npm run build    # type-check + production build
```

## What works today

**Professional editing UI**
- Top bar: project rename, undo/redo, save, share, export, AI assistant toggle
- Left sidebar: Media Library (import MP4/MOV/AVI/MKV/WEBM/MP3/WAV/AAC/PNG/JPG/SVG/WEBP
  via picker or drag-and-drop), Transcript editor, plus tabs for Projects, Templates,
  Music, Graphics, Brand, Stock, and AI Assets
- Center: program monitor with real video playback, volume, playback speed, frame
  step, fullscreen, preview zoom, and overlay toggles (captions, safe zones, guides,
  tracking boxes, face detection, scene detection)
- Right: AI chat assistant (type or use the 🎤 voice button — Web Speech API)
- Bottom: multi-track timeline (3 video, 3 audio, subtitle, effects, graphics tracks)
  with drag-to-move, edge trimming, split, delete, ripple delete, duplicate, snapping,
  markers, track lock/mute/solo, zoomable ruler, and scrubbing

**Keyboard shortcuts**: `Space` play/pause · `S` split at playhead · `Delete` delete
clip (`Shift+Delete` ripple) · `Ctrl+Z` undo · `Ctrl+Y` redo · arrow keys frame-step ·
`Home` go to start

**AI editing agent** (right panel) — every command operates on the real timeline:
- `Remove everything between 2:15 and 2:42` — ripple-removes a range across tracks
- `Remove all dead space` — deletes detected silences and closes gaps
- `Remove all filler words` — reports counts, asks to confirm, then cuts each one
- `Add subtitles` / `Make subtitles yellow` / `Create TikTok-style captions` /
  `Move captions higher` / `Translate subtitles to Spanish` / `Highlight keywords`
- `Split at 1:30` / `Add a transition between clips 1 and 2`
- `Add dramatic zooms` / `Blur the phone number`
- `Make colors more vibrant` / `Add cinematic color grading` / `Black and white`
- `Create a TikTok version` (9:16 smart reframe), `1:1`, `4:5`, `16:9`
- `Generate 5 shorts` / `Add chapter markers`
- `Add upbeat background music` (places, ducks, and fades an imported audio asset)
- `Mute Audio 1` / `Lock Video 2` / `Export in 1080p` / `Go to 0:45` / `Undo`

**Transcript-driven editing**: the Subtitles & Transcript tab shows the timeline
transcript; click a word to jump there, click × to cut that word from the video.
Filler words are tinted red.

**Export**: platform presets (YouTube, TikTok, Reels, Stories, LinkedIn, Facebook,
Podcast Clips), MP4/MOV/WEBM, 720p–4K. The prototype renders a downloadable JSON
render manifest describing the full program (a cloud render service would consume it).

## How the "AI" works in this prototype

**Transcription is real.** When you import a video or audio file, the app decodes the
audio in-browser, detects true silences via RMS energy analysis
(`src/ai/transcribe.ts`), and runs OpenAI Whisper locally through
[transformers.js](https://github.com/huggingface/transformers.js) in a Web Worker
(`src/ai/whisperWorker.ts`) to produce a word-level transcript of exactly what is
said. The first import downloads the speech model (~40 MB, cached by the browser);
everything after that runs fully on-device with no audio leaving your machine.
Subtitles, the transcript editor, filler-word removal, and dead-space removal all
operate on this real data. If a file can't be decoded (some AVI/MKV codecs), the app
falls back to a simulated transcript and labels the asset accordingly.

Scene detection and highlight picking are still simulated (`src/ai/analysis.ts`), and
the chat agent (`src/ai/agent.ts`) is a natural-language command interpreter that
compiles requests into pure timeline operations (`src/store.ts`). Swapping in a real
scene detector or an LLM planner only requires replacing those modules — the
operation layer and UI stay the same.

## Architecture

```
src/
  types.ts            project/clip/subtitle/track data model
  store.ts            pure timeline operations + undo/redo history hook
  utils/time.ts       timecode parsing & formatting
  ai/analysis.ts      simulated media analysis (transcript, scenes, silences, highlights)
  ai/agent.ts         conversational command interpreter → timeline operations
  App.tsx             layout, keyboard shortcuts, media import
  components/
    TopBar.tsx        project controls
    Sidebar.tsx       media library + transcript editor
    Preview.tsx       program monitor, playback engine, overlays, subtitles
    ChatPanel.tsx     AI chat + voice commands + confirm flow
    Timeline.tsx      multi-track timeline editor
    ExportDialog.tsx  presets + render manifest export
```
