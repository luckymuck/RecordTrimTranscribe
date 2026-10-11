// Clip splitting and file download helpers.
import { encode } from "../audio/encode.js";

// Split validation and boundaries live in a pure module so they can be tested.
export { buildClips, isValidSplit, normalizeSplits, splitLabels } from "./boundaries.js";

export function sampleSlice(pcm, start, end) {
  return pcm.subarray(Math.max(0, start), Math.min(pcm.length, end));
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough that a large download cannot be cut off mid-transfer; the
  // object is released when the page goes away regardless.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function exportSlice(pcm, sampleRate, start, end, format, filename) {
  const slice = pcm.slice(Math.max(0, start), Math.min(pcm.length, end));
  const blob = encode(slice, sampleRate, format);
  downloadBlob(blob, filename);
  return blob;
}
