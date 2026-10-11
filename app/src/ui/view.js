// Waveform view arithmetic.
//
// Kept free of DOM imports so it can be unit-tested under Node.

/**
 * New view start/length for a zoom of `factor`, keeping `anchor` (a sample
 * position) at the same fraction across the view. The zoom buttons used to
 * change only `viewLen`, so every zoom crawled toward the left edge.
 */
export function zoomAround(viewStart, viewLen, factor, anchor) {
  const frac = viewLen > 0 ? (anchor - viewStart) / viewLen : 0.5;
  const nextLen = viewLen * factor;
  return { viewStart: anchor - frac * nextLen, viewLen: nextLen };
}

/**
 * Zoom anchor: the playhead when it is on screen, otherwise the view centre.
 */
export function zoomAnchor(viewStart, viewLen, cursorSample) {
  const inside =
    Number.isFinite(cursorSample) &&
    cursorSample >= viewStart &&
    cursorSample <= viewStart + viewLen;
  return inside ? cursorSample : viewStart + viewLen / 2;
}
