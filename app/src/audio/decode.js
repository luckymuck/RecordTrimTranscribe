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
