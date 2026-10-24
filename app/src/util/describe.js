// Human-readable ages and durations for the recovery panel.
//
// Kept free of DOM imports so it can be unit-tested under Node.

/**
 * How long ago `timestamp` was, in the coarsest useful unit: "just now",
 * "3 min ago", "2 h ago", "5 days ago". Abbreviations are already singular, so
 * only full words are pluralised. A timestamp in the future (clock skew, or a
 * session written by a machine set differently) reads as "just now".
 */
export function describeAge(timestamp, now = Date.now()) {
  const then = Number(timestamp);
  if (!Number.isFinite(then) || then <= 0) return "unknown time";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function describeSeconds(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const p = (n) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
