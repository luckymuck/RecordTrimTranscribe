// Transcript view helpers: which line the playhead is in, where to scroll so it
// sits a few lines down, and where words appear to be missing.
//
// Kept free of DOM imports so it can be unit-tested under Node.

/** Index of the last line starting at or before `seconds`, or -1 before the first. */
export function findLineIndex(starts, seconds) {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= seconds) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Scroll offset that leaves the current line `linesAbove` lines from the top of
 * the box, so the reader sees what has just been said plus what is coming.
 */
export function followScrollTop(lineTop, lineHeight, linesAbove = 4) {
  return Math.max(0, lineTop - linesAbove * lineHeight);
}

/**
 * Speech spans from the silence zones: the complement over `[0, totalSeconds)`.
 * `zones` is a flat `[start, end, start, end, ...]` list in the same units.
 */
export function speechRegions(zones, totalSeconds) {
  const regions = [];
  let cursor = 0;
  for (let i = 0; i + 1 < zones.length; i += 2) {
    const start = zones[i];
    const end = zones[i + 1];
    if (start > cursor) regions.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < totalSeconds) regions.push([cursor, totalSeconds]);
  return regions;
}

/**
 * Times where speech is present but no word was recognised, so the transcript
 * can flag a word that was not intelligible.
 *
 * `regions` are speech spans in seconds, `words` the spans that did get
 * transcribed, and `[from, to)` the range that was actually transcribed (a clip
 * scope only covers part of the file). Very short regions are ignored: a cough
 * or a door is speech-shaped energy but never had a word in it.
 */
export function missingWordMarkers(regions, words, from = -Infinity, to = Infinity, { minRegion = 0.4 } = {}) {
  const marks = [];
  for (const [rs, re] of regions) {
    if (re - rs < minRegion) continue;
    if (re <= from || rs >= to) continue;
    const covered = words.some(([ws, we]) => we > rs && ws < re);
    if (!covered) marks.push(Math.max(rs, from));
  }
  return marks;
}
