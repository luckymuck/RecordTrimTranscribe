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

/** `HHMMSS` for a position in the recording (13:45 -> "001345"). */
export function clockStamp(seconds) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(total / 3600))}${p(Math.floor((total % 3600) / 60))}${p(total % 60)}`;
}

/**
 * Default clip name: `<source> - <nn> - <HHMMSS>`, where the stamp is the
 * clip's start position in the recording. The source is part of the name, so
 * the export filename below is used verbatim rather than prefixed again.
 */
export function clipName(sourceName, index, startSample, sampleRate) {
  const base = exportBaseName(sourceName);
  const nn = String(index + 1).padStart(2, "0");
  const seconds = sampleRate > 0 ? startSample / sampleRate : 0;
  return `${base} - ${nn} - ${clockStamp(seconds)}`;
}

/** Exported filename for a clip. The clip name already carries the source. */
export function clipExportName(clipNameText, format = "wav") {
  const name = sanitizeName(clipNameText) || "clip";
  return `${name}.${format}`;
}

/** Recording name as `MMDDYYYY HHMM` (24-hour). */
export function recordingName(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${p(date.getMonth() + 1)}${p(date.getDate())}${date.getFullYear()} ` +
    `${p(date.getHours())}${p(date.getMinutes())}`
  );
}
