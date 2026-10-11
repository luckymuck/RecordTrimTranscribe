// 16-bit PCM WAV encoding.
//
// Kept free of DOM imports so it can be unit-tested under Node. Two fixes over
// the original: samples are written straight into the output buffer through a
// view instead of via a second Int16Array copy, and quantization uses TPDF
// dither behind a soft knee instead of hard clipping.

/** Above this, samples are shaped rather than clipped. */
export const SOFT_KNEE = 0.95;
const LSB = 1 / 32768;
/** Largest value a 16-bit sample can represent; the limiter asymptotes here. */
const CEIL = 1 - LSB;

/** Soft limiter: identity below the knee, tanh-shaped above it, always below full scale. */
export function softClipSample(s) {
  if (!Number.isFinite(s)) return 0;
  const a = Math.abs(s);
  if (a <= SOFT_KNEE) return s;
  const over = (a - SOFT_KNEE) / (1 - SOFT_KNEE);
  const shaped = Math.min(SOFT_KNEE + (CEIL - SOFT_KNEE) * Math.tanh(over), CEIL);
  return Math.sign(s) * shaped;
}

/** One float sample to a 16-bit integer, with optional TPDF dither. */
export function quantize(s, dither = true, rng = Math.random) {
  const shaped = softClipSample(s);
  const noise = dither ? (rng() - rng()) * LSB : 0;
  const v = Math.round((shaped + noise) * 32768);
  return Math.max(-32768, Math.min(32767, v));
}

/** Mono float PCM to a 16-bit WAV ArrayBuffer (header + samples, one buffer). */
export function encodeWavBuffer(pcm, sampleRate, { dither = true, rng = Math.random } = {}) {
  const n = pcm.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, n * 2, true);
  const samples = new Int16Array(buffer, 44, n);
  for (let i = 0; i < n; i++) samples[i] = quantize(pcm[i], dither, rng);
  return buffer;
}

/** Mono float PCM to a 16-bit WAV Blob. */
export function encodeWavBlob(pcm, sampleRate, opts) {
  return new Blob([encodeWavBuffer(pcm, sampleRate, opts)], { type: "audio/wav" });
}
