// Split validation and clip boundaries.
//
// Kept free of DOM imports so it can be unit-tested under Node. Splits used to
// be taken verbatim: a split at 0, at the very end, or a duplicate was accepted
// by the waveform while `buildClips` silently dropped it, so the label numbers
// and the clip list could disagree.

/** A split must land strictly inside the recording. */
export function isValidSplit(sample, totalLength) {
  return Number.isFinite(sample) && sample > 0 && sample < totalLength;
}

/** Finite, in-range, deduplicated, sorted split positions. */
export function normalizeSplits(splits, totalLength) {
  const out = [];
  for (const raw of splits || []) {
    const v = Math.round(raw);
    if (!isValidSplit(v, totalLength)) continue;
    if (out.includes(v)) continue;
    out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/** Clip boundaries `{start, end}` from sorted split sample positions. */
export function buildClips(splits, totalLength) {
  const points = [0, ...normalizeSplits(splits, totalLength), totalLength];
  const clips = [];
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i + 1] > points[i]) clips.push({ start: points[i], end: points[i + 1] });
  }
  return clips;
}

/**
 * Labels for the valid splits only, numbered 1..n, so the numbers shown on the
 * waveform are exactly the clip numbers in the export list.
 */
export function splitLabels(splits, totalLength) {
  return normalizeSplits(splits, totalLength).map((sample, i) => ({
    sample,
    label: String(i + 1).padStart(2, "0"),
  }));
}
