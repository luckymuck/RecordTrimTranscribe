// Speed-dial arithmetic.
//
// Kept free of DOM imports so it can be unit-tested under Node. The engine
// plays at 1.0x-4.0x; there is no slow-down.

export const SPEED_MIN = 1.0;
export const SPEED_MAX = 4.0;
export const SPEED_STEP = 0.25;
/** Horizontal pixels per 1.0x of dial drag. */
export const PIXELS_PER_SPEED = 200;
/** Movement at or below this counts as a click, not a drag. */
export const CLICK_PX = 3;

/** Clamp to the playable range and round to two decimals. */
export function clampSpeed(v) {
  if (!Number.isFinite(v)) return SPEED_MIN;
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
  return Math.round(clamped * 100) / 100;
}

/** Snap to the nearest quarter step (the click and keyboard increments). */
export function snapToStep(v) {
  return Math.round(v / SPEED_STEP) * SPEED_STEP;
}

/** Live value while dragging: linear in pixels, clamped. */
export function speedFromDrag(startSpeed, dxPx) {
  return clampSpeed(startSpeed + dxPx / PIXELS_PER_SPEED);
}

/**
 * Value once the gesture ends.
 *
 * A drag shorter than CLICK_PX is a click: it must step from the speed the drag
 * started at, snapped to a quarter, not from whatever a 1-2 px wobble produced
 * (which used to give values like 1.26x).
 */
export function speedAfterDrag(startSpeed, dxPx) {
  if (Math.abs(dxPx) <= CLICK_PX) return clampSpeed(snapToStep(startSpeed) + SPEED_STEP);
  return speedFromDrag(startSpeed, dxPx);
}

/** Keyboard step: stays on quarter values whatever the drag left behind. */
export function stepSpeed(current, direction) {
  return clampSpeed(snapToStep(current) + Math.sign(direction) * SPEED_STEP);
}
