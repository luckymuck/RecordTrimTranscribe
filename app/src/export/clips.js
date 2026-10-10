// Clip splitting and file download helpers.
import { encode } from "../audio/encode.js";

/** Build clips from sorted split sample positions. */
export function buildClips(splits, totalLength) {
  const points = [0, ...splits.filter((s) => s > 0 && s < totalLength), totalLength];
  const clips = [];
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i + 1] > points[i]) {
      clips.push({ start: points[i], end: points[i + 1] });
    }
  }
  return clips;
}

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
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function exportSlice(pcm, sampleRate, start, end, format, filename) {
  const slice = pcm.slice(Math.max(0, start), Math.min(pcm.length, end));
  const blob = encode(slice, sampleRate, format);
  downloadBlob(blob, filename);
  return blob;
}
