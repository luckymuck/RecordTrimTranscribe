// Sample-rate reduction for long-file parts, and the memory estimates the
// pre-flight panel shows.
//
// Kept free of DOM imports so it can be unit-tested under Node.

/** Bytes one sample costs once loaded: f32 working copy plus the Int16 source. */
export const BYTES_PER_SAMPLE = 6;

/** Rates offered when a file is too large to open whole. */
export const PART_RATES = [48000, 24000, 16000];

/**
 * Estimate the memory a load will hold, in bytes.
 *
 * `seconds` is the audio being loaded, `rate` the rate it will be kept at. For a
 * decoded (compressed) source the file bytes and the browser's decoding buffer
 * are on top, which is why the caller adds them.
 */
export function estimateLoadBytes(seconds, rate, { compressedBytes = 0 } = {}) {
  const samples = Math.max(0, Math.round(Number(seconds) * Number(rate)));
  return samples * BYTES_PER_SAMPLE + Math.max(0, compressedBytes);
}

/**
 * Resample `pcm` from `fromRate` to `toRate` with a tent filter one output
 * period wide.
 *
 * `decode.js`'s linear `resample` degenerates to plain decimation when the ratio
 * is a whole number, so high frequencies fold back audibly. A triangular kernel
 * spanning two output periods is a genuine low-pass (-28 dB at 10 kHz for a 3:1
 * reduction), needs no second full-length buffer, and costs about `2 * step`
 * multiply-adds per output sample. Upsampling uses the same kernel, which is a
 * linear interpolator there and cannot alias.
 */
export function decimateTo(pcm, fromRate, toRate) {
  const from = Number(fromRate) || 48000;
  const to = Number(toRate) || from;
  if (to === from || !pcm.length) return pcm;
  const outLength = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Float32Array(outLength);
  const step = from / to;
  for (let i = 0; i < outLength; i++) {
    const centre = i * step;
    const lo = Math.max(0, Math.floor(centre - step));
    const hi = Math.min(pcm.length - 1, Math.ceil(centre + step));
    let sum = 0;
    let weight = 0;
    for (let j = lo; j <= hi; j++) {
      const w = 1 - Math.abs(j - centre) / step;
      if (w <= 0) continue;
      sum += pcm[j] * w;
      weight += w;
    }
    out[i] = weight > 0 ? sum / weight : 0;
  }
  return out;
}

/** `"12.4 MB"` for a byte count, for the pre-flight panel. */
export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
