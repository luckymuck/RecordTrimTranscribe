// Repairing repeated text in a transcription result.
//
// Whisper's decoder can lock into a loop: on music, noise or a window that is
// mostly silence it emits one phrase -- "Thank you.", a single character, a
// subtitle credit -- over and over. The n-gram limit passed to the decoder
// (`no_repeat_ngram_size`) stops most loops while they are being generated, but
// it is a blunt instrument: it cannot tell a loop from a chorus, and it often
// cuts a looping sentence mid-way. This pass is the tidy-up, and the marker it
// leaves is how the reader knows something was removed.
//
// Kept free of DOM imports so it can be unit-tested under Node.

/** Collapse a run of the same word or phrase seen this many times in a row. */
export const REPEAT_MIN = 4;
/** Longest repeated phrase, in tokens, that is treated as one run. */
export const REPEAT_MAX_PERIOD = 8;
/** A character this many times over is a run, not emphasis. */
export const CHAR_RUN_MIN = 4;

/** A token reduced to what comparison cares about: case, spacing, punctuation. */
export function normalizeToken(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\u200b\u00a0]+/g, "")
    .replace(/[.,!?;:…"'“”‘’()[\]{}<>«»¿¡—–\-]+/g, "");
}

/**
 * Collapse a run of one character inside a token: `ああああああ` -> `あ`,
 * `!!!!!` -> `!`. Returns the text and whether anything changed.
 */
export function collapseCharRuns(text, minRun = CHAR_RUN_MIN) {
  const source = String(text || "");
  if (!source) return { text: "", changed: false };
  let out = "";
  let changed = false;
  let i = 0;
  while (i < source.length) {
    let run = 1;
    while (i + run < source.length && source[i + run] === source[i]) run += 1;
    if (run >= minRun) {
      out += source[i];
      changed = true;
    } else {
      out += source.slice(i, i + run);
    }
    i += run;
  }
  return { text: out, changed };
}

/** True when the run starting at `start` repeats `times` times with `period`. */
function runRepeats(tokens, start, period, times) {
  for (let r = 1; r < times; r++) {
    for (let k = 0; k < period; k++) {
      const a = tokens[start + k];
      const b = tokens[start + r * period + k];
      // Punctuation-only chunks normalise to nothing and must not chain runs.
      if (!a || !b || a !== b) return false;
    }
  }
  return true;
}

/** The longest run starting at `start`: `{ period, repeats }` or null. */
function findRun(tokens, start, minRepeats, maxPeriod) {
  for (let period = 1; period <= maxPeriod; period++) {
    if (start + period * minRepeats > tokens.length) break;
    let repeats = 1;
    while (start + (repeats + 1) * period <= tokens.length) {
      if (!runRepeats(tokens, start, period, repeats + 1)) break;
      repeats += 1;
    }
    if (repeats >= minRepeats) return { period, repeats };
  }
  return null;
}

/**
 * Collapse repeated runs in a transcript result.
 *
 * Keeps the first occurrence, drops the rest, and leaves a `**` marker over the
 * dropped span carrying those words' timestamps, so the view shows a cut rather
 * than silently losing time. Returns `{ result, removed }`, `removed` being the
 * spans that were dropped.
 */
export function collapseRepeats(
  result,
  { minRepeats = REPEAT_MIN, maxPeriod = REPEAT_MAX_PERIOD, charRuns = true } = {}
) {
  const raw = result && Array.isArray(result.chunks) ? result.chunks : null;
  if (!raw || !raw.length) return { result, removed: [] };

  // Character runs first: a loop of one character is one token, so the word pass
  // would never see it.
  const chunks = charRuns
    ? raw.map((chunk) => {
        const { text, changed } = collapseCharRuns(chunk.text);
        return changed ? { ...chunk, text: `${text} **` } : chunk;
      })
    : raw;
  const tokens = chunks.map((chunk) => normalizeToken(chunk.text));

  const out = [];
  const removed = [];
  let i = 0;
  while (i < chunks.length) {
    const run = findRun(tokens, i, minRepeats, maxPeriod);
    if (!run) {
      out.push(chunks[i]);
      i += 1;
      continue;
    }
    for (let k = 0; k < run.period; k += 1) out.push(chunks[i + k]);
    const dropStart = i + run.period;
    const dropEnd = i + run.period * run.repeats;
    const first = chunks[dropStart];
    const last = chunks[dropEnd - 1];
    const start = first && Array.isArray(first.timestamp) ? first.timestamp[0] : null;
    const lastEnd = last && Array.isArray(last.timestamp) ? last.timestamp[1] : null;
    const end = typeof lastEnd === "number" ? lastEnd : start;
    if (typeof start === "number" && typeof end === "number") {
      out.push({
        text: " **",
        timestamp: [start, Math.max(end, start)],
        missing: true,
        repaired: true,
      });
      removed.push({ start, end });
    }
    i = dropEnd;
  }

  const text = out.map((chunk) => chunk.text || "").join("");
  return {
    result: { ...result, text, chunks: out, timestamped: result.timestamped },
    removed,
  };
}

/**
 * Repetition metrics for one window: how much a collapse would remove, how fast
 * the text is, and how many words share a start time with the word before.
 */
export function repetitionStats(result, seconds, { maxPeriod = REPEAT_MAX_PERIOD } = {}) {
  const chunks = result && Array.isArray(result.chunks) ? result.chunks : [];
  const total = chunks.length;
  const chars = chunks.reduce((n, chunk) => n + String(chunk.text || "").trim().length, 0);
  const duration = Number(seconds) > 0 ? Number(seconds) : 0;
  let sharedStarts = 0;
  for (let i = 1; i < total; i += 1) {
    const a = chunks[i - 1] && chunks[i - 1].timestamp;
    const b = chunks[i] && chunks[i].timestamp;
    if (Array.isArray(a) && Array.isArray(b) && a[0] === b[0]) sharedStarts += 1;
  }
  const dropped = droppedTokens(result, maxPeriod);
  return {
    tokens: total,
    dropped,
    droppedFraction: total ? dropped / total : 0,
    charsPerSecond: duration ? chars / duration : 0,
    sharedStartFraction: total > 1 ? sharedStarts / (total - 1) : 0,
  };
}

/** Tokens the word-level collapse would remove for this result. */
function droppedTokens(result, maxPeriod) {
  const chunks = result && Array.isArray(result.chunks) ? result.chunks : [];
  const tokens = chunks.map((chunk) => normalizeToken(chunk.text));
  let i = 0;
  let dropped = 0;
  while (i < tokens.length) {
    const run = findRun(tokens, i, REPEAT_MIN, maxPeriod);
    if (!run) {
      i += 1;
      continue;
    }
    const end = i + run.period * run.repeats;
    dropped += end - (i + run.period);
    i = end;
  }
  return dropped;
}

/**
 * Whether a window's text looks like a decode loop. Deliberately conservative:
 * a window is only called degenerate when several signs agree, because a false
 * positive costs a real sentence its wording.
 */
export function looksRepetitive(result, seconds, options = {}) {
  const stats = repetitionStats(result, seconds, options);
  if (stats.tokens < 6) return false;
  if (stats.droppedFraction >= 0.2 && stats.dropped >= 4) return true;
  if (stats.charsPerSecond > 40) return true;
  if (stats.tokens >= 12 && stats.sharedStartFraction >= 0.3) return true;
  return false;
}
