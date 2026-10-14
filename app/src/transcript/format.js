// Transcript export formatting: SRT, WebVTT and plain text.
//
// Kept free of DOM and CDN imports so it can be unit-tested under Node.

/** Longest cue before a forced break, matching the on-screen grouping. */
export const CUE_MAX_CHARS = 84;
/** Longest cue in seconds before a forced break. */
export const CUE_MAX_SECONDS = 6;

function textOf(group) {
  return group.map((w) => w.text).join("").trim();
}

/**
 * Group word chunks into cues.
 *
 * Breaks on sentence-ending punctuation, on `maxChars` of text, or on
 * `maxSeconds` of audio, whichever comes first, so a cue is never a wall of
 * text and never spans a long pause. A cue's end is clamped to the next cue's
 * start: the old `+1 s` fallback could overlap the following cue.
 */
export function buildCues(chunks, { maxChars = CUE_MAX_CHARS, maxSeconds = CUE_MAX_SECONDS } = {}) {
  const words = (chunks || []).filter((c) => c && c.timestamp);
  const cues = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0].timestamp[0];
    const last = group[group.length - 1];
    const end = last.timestamp[1] ?? last.timestamp[0];
    const text = textOf(group);
    if (text) cues.push({ start: first, end: Math.max(end, first), text });
    group = [];
  };
  for (const w of words) {
    group.push(w);
    const text = textOf(group);
    const last = w.timestamp[1];
    const span = last !== undefined ? last - group[0].timestamp[0] : 0;
    if (text.length >= maxChars || span >= maxSeconds || /[.!?]\s*$/.test(w.text)) flush();
  }
  flush();
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }
  return cues;
}

/** `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT). */
export function formatTimestamp(seconds, separator = ",") {
  const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const ms = Math.floor((clamped % 1) * 1000);
  const total = Math.floor(clamped);
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}${separator}${String(ms).padStart(3, "0")}`;
}

/** SRT document, or "" when there is nothing timestamped to write. */
export function toSrt(chunks) {
  const cues = buildCues(chunks);
  if (!cues.length) return "";
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatTimestamp(c.start, ",")} --> ${formatTimestamp(c.end, ",")}\n${c.text}\n`
      )
      .join("\n") + "\n"
  );
}

/** WebVTT document, or "" when there is nothing timestamped to write. */
export function toVtt(chunks) {
  const cues = buildCues(chunks);
  if (!cues.length) return "";
  return (
    "WEBVTT\n\n" +
    cues
      .map((c) => `${formatTimestamp(c.start, ".")} --> ${formatTimestamp(c.end, ".")}\n${c.text}\n`)
      .join("\n") +
    "\n"
  );
}

/**
 * Plain text, one sentence (or wrapped run of ~84 characters) per line rather
 * than the single unbroken paragraph this used to write. Falls back to the raw
 * text when there are no word timings.
 */
export function toTxt(result) {
  const chunks = result && result.chunks;
  if (chunks && chunks.length) {
    const lines = [];
    let line = "";
    for (const w of chunks) {
      line += w.text;
      if (/[.!?]\s*$/.test(w.text) || line.trim().length >= CUE_MAX_CHARS) {
        const t = line.trim();
        if (t) lines.push(t);
        line = "";
      }
    }
    const t = line.trim();
    if (t) lines.push(t);
    return lines.length ? lines.join("\n") + "\n" : "";
  }
  const text = ((result && result.text) || "").trim();
  if (!text) return "";
  return text.replace(/\s*([.!?])\s+/g, "$1\n") + "\n";
}

/** Marker so a stray JSON file is not mistaken for a transcript. */
export const TRANSCRIPT_FORMAT = "rtt-transcript";

/**
 * This app's own transcript as JSON, for reloading without re-transcribing.
 *
 * Word timings survive exactly, which SRT and VTT cannot carry, and the source
 * name and duration let a reload check that the transcript belongs to the audio
 * it is paired with.
 */
export function toTranscriptJson(result, { source = "", sampleRate = 0, duration = 0 } = {}) {
  return (
    JSON.stringify({
      format: TRANSCRIPT_FORMAT,
      version: 1,
      source: String(source || ""),
      sampleRate: Number(sampleRate) || 0,
      duration: Number(duration) || 0,
      timestamped: !!(result && result.timestamped),
      text: (result && result.text) || "",
      chunks: (result && result.chunks) || null,
    }) + "\n"
  );
}
