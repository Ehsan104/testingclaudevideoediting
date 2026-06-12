// Parse "2:15", "1:02:15", "95", "2m15s", "1h2m" into seconds
export function parseTimecode(s: string): number | null {
  s = s.trim().toLowerCase();
  if (!s) return null;
  const hms = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    const a = Number(hms[1]);
    const b = Number(hms[2]);
    const c = hms[3] !== undefined ? Number(hms[3]) : null;
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  const units = s.match(/^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s?)?$/);
  if (units && (units[1] || units[2] || units[3])) {
    return (
      Number(units[1] || 0) * 3600 + Number(units[2] || 0) * 60 + Number(units[3] || 0)
    );
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function formatTime(t: number, fps = 30): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f)}`
    : `${pad(m)}:${pad(s)}.${pad(f)}`;
}

export function formatTimeShort(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
