// Transcript import: SRT, WebVTT, plain text, and this app's own JSON.
//
// Kept free of DOM and CDN imports so it can be unit-tested under Node.
//
// Subtitle formats carry cue timings, not word timings, so a reloaded SRT or
// VTT becomes one chunk per cue. That is coarser than a Whisper transcript but
// keeps every line, its timing and the follow-along view working. The JSON form
// round-trips exactly.

/** `HH:MM:SS,mmm --> HH:MM:SS,mmm`, the comma or dot accepted. */
const TIMING =
  /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function cueSeconds(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, "0")) / 1000;
}

/**
 * Parse SRT or WebVTT into cue-level chunks.
 *
 * Blocks without a timing line are skipped, which drops the WEBVTT header and
 * any NOTE or STYLE block. Inline markup is stripped: `<i>` and friends are not
 * speech.
 */
export function parseCues(text) {
  const blocks = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);
  const chunks = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (!lines.length) continue;
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    if (timingIndex < 0) continue;
    const m = lines[timingIndex].match(TIMING);
    const start = cueSeconds(m[1], m[2], m[3], m[4]);
    const end = cueSeconds(m[5], m[6], m[7], m[8]);
    const body = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    // A trailing space keeps two cues from running together when the view joins
    // consecutive chunks.
    chunks.push({ text: `${body} `, timestamp: [start, Math.max(end, start)] });
  }
  if (!chunks.length) throw new Error("no timed cues were found");
  return {
    text: chunks.map((c) => c.text).join("").trim(),
    chunks,
    timestamped: true,
  };
}

/** This app's JSON transcript, or anything shaped like it. */
export function parseJsonTranscript(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("the JSON could not be parsed");
  }
  const chunks = Array.isArray(data && data.chunks)
    ? data.chunks.filter((c) => c && typeof c.text === "string" && Array.isArray(c.timestamp))
    : null;
  const plain = typeof (data && data.text) === "string" ? data.text : "";
  if (!chunks && !plain.trim()) throw new Error("the JSON has no transcript text");
  return {
    text: plain || chunks.map((c) => c.text).join(""),
    chunks,
    timestamped: !!chunks && chunks.length > 0,
    meta: {
      source: typeof (data && data.source) === "string" ? data.source : "",
      duration: Number.isFinite(data && data.duration) ? data.duration : null,
    },
  };
}

/**
 * Parse a transcript file of any supported kind.
 *
 * `name` selects JSON by extension; content decides between cues and plain text.
 * Throws with a readable message when the file holds no transcript.
 */
export function parseTranscriptText(text, name = "") {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("the file is empty");
  if (/\.json$/i.test(name) || trimmed.startsWith("{")) return parseJsonTranscript(trimmed);
  if (/^WEBVTT/.test(trimmed) || TIMING.test(trimmed)) return parseCues(trimmed);
  return { text: trimmed, chunks: null, timestamped: false, meta: {} };
}

/** True for a filename this module can parse. */
export function isTranscriptName(name) {
  return /\.(srt|vtt|txt|json)$/i.test(String(name || ""));
}
