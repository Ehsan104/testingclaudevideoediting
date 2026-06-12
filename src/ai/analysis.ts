import { MediaAnalysis, TranscriptWord } from "../types";

// Simulated AI analysis pipeline. In production this would call
// transcription, scene-detection, and object-detection services.
// Results are deterministic per asset name+duration so re-analysis is stable.

const SAMPLE_SENTENCES = [
  "Welcome back to the channel everyone",
  "today we are diving into something special",
  "um so the first thing you need to know",
  "is that this changes everything",
  "let me show you exactly how it works",
  "uh basically the core idea is simple",
  "you know it took us months to figure this out",
  "and the results honestly speak for themselves",
  "here is the part most people get wrong",
  "actually there is a much faster way to do it",
  "so make sure you stick around for the end",
  "because the last tip is the most important one",
  "alright let's jump right into the demo",
  "as you can see the difference is huge",
  "that is everything for today thanks for watching",
];

const FILLERS = new Set(["um", "uh", "like", "basically", "actually", "you", "know"]);

function seededRandom(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

export function analyzeAsset(name: string, duration: number): MediaAnalysis {
  const rand = seededRandom(hash(name) + Math.round(duration));
  const speakers = duration > 120 ? ["Speaker 1", "Speaker 2"] : ["Speaker 1"];
  const transcript: TranscriptWord[] = [];
  const silences: { start: number; end: number }[] = [];
  const scenes: number[] = [];
  const highlights: { start: number; end: number; label: string }[] = [];

  let t = 0.5;
  let sentenceIdx = Math.floor(rand() * SAMPLE_SENTENCES.length);
  let speakerIdx = 0;
  while (t < duration - 1) {
    const sentence = SAMPLE_SENTENCES[sentenceIdx % SAMPLE_SENTENCES.length];
    sentenceIdx++;
    const speaker = speakers[speakerIdx % speakers.length];
    if (rand() < 0.3) speakerIdx++;
    for (const word of sentence.split(" ")) {
      if (t >= duration - 0.5) break;
      const len = 0.25 + rand() * 0.3;
      transcript.push({
        start: t,
        end: t + len,
        text: word,
        isFiller: FILLERS.has(word.toLowerCase()),
        speaker,
      });
      t += len + rand() * 0.08;
    }
    // pause between sentences; occasionally a long silence
    const pause = rand() < 0.18 ? 1.2 + rand() * 2 : 0.3 + rand() * 0.4;
    if (pause > 1 && t + pause < duration) {
      silences.push({ start: t, end: t + pause });
    }
    t += pause;
  }

  for (let s = 6 + rand() * 10; s < duration; s += 8 + rand() * 25) {
    scenes.push(Math.round(s * 10) / 10);
  }

  const nHighlights = Math.max(1, Math.min(8, Math.floor(duration / 45)));
  for (let i = 0; i < nHighlights; i++) {
    const start = (duration / (nHighlights + 1)) * (i + 1) - 4;
    if (start > 0 && start + 9 < duration) {
      highlights.push({
        start: Math.round(start * 10) / 10,
        end: Math.round((start + 9) * 10) / 10,
        label: `Highlight ${i + 1}`,
      });
    }
  }

  return { transcript, scenes, speakers, silences, highlights };
}
