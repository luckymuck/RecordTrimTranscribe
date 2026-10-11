// Download filename construction.
//
// Kept free of DOM imports so it can be unit-tested under Node.

/** Strip the final extension only: "a.v2.final.mp3" -> "a.v2.final". */
export function stripExtension(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}

/** Characters that are awkward or illegal in filenames on common platforms. */
export function sanitizeName(name) {
  return String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Base name for exports: no extension, no doubled spaces. */
export function exportBaseName(sourceName) {
  const base = sanitizeName(stripExtension(sourceName || "recording"));
  return base || "recording";
}

/**
 * Whole-file export name. The speed suffix is kept even when silence is also
 * skipped: the old name said only "nosilence" and silently dropped the speed.
 */
export function wholeExportName(sourceName, { baked = false, skip = false, speed = 1, format = "wav" } = {}) {
  const base = exportBaseName(sourceName);
  const parts = [];
  if (baked) parts.push(`${Number(speed).toFixed(2)}x`);
  if (skip) parts.push("nosilence");
  const stem = parts.length ? `${base}-${parts.join("-")}` : base;
  return `${stem}.${format}`;
}

/** Backup WAV name for the original recording. */
export function backupName(sourceName) {
  return `${exportBaseName(sourceName)}-backup.wav`;
}

/** Clip export name, prefixed with the source so clips from different sources do not collide. */
export function clipExportName(sourceName, clipName, format = "wav") {
  const base = exportBaseName(sourceName);
  const name = sanitizeName(clipName) || "clip";
  return `${base}-${name}.${format}`;
}

/** Recording name as `YYYY-MM-DD HHMM`, which sorts chronologically. */
export function recordingName(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}${p(date.getMinutes())}`
  );
}
