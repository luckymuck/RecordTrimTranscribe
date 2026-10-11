// Decode audio blobs/files to mono Float32 PCM using the Web Audio API.

let _ctx = null;

export function audioContext() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _ctx;
}

/**
 * Decode a Blob/File to mono Float32 PCM.
 * @returns {Promise<{pcm: Float32Array, sampleRate: number, duration: number}>}
 */
export async function decodeAudioBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = await audioContext().decodeAudioData(arrayBuffer);
  const channels = buffer.numberOfChannels;
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < n; i++) out[i] /= channels;
  }
  return { pcm: out, sampleRate: buffer.sampleRate, duration: n / buffer.sampleRate };
}

/** Linear resample of mono PCM. */
export function resample(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const outLen = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, pcm.length - 1);
    const t = pos - lo;
    out[i] = pcm[lo] * (1 - t) + pcm[hi] * t;
  }
  return out;
}

/**
 * Band-limited resample using the browser's own resampler.
 *
 * The linear `resample` above degenerates to plain decimation whenever the rate
 * ratio is a whole number: at 48 -> 16 kHz the interpolation weight is always 0,
 * so every third sample is taken with no low-pass. Everything from 8-24 kHz then
 * aliases back into the 0-8 kHz band Whisper reads, adding noise on consonants.
 * This uses `OfflineAudioContext`, which applies a proper anti-alias filter.
 */
export async function resampleHQ(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx || pcm.length === 0) return resample(pcm, fromRate, toRate);
  const length = Math.max(1, Math.ceil((pcm.length * toRate) / fromRate));
  const off = new OfflineCtx(1, length, toRate);
  const buffer = off.createBuffer(1, pcm.length, fromRate);
  buffer.copyToChannel(pcm, 0);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}
