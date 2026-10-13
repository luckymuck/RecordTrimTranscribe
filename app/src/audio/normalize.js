// Normalization gain arithmetic.
//
// Kept free of DOM imports so it can be unit-tested under Node. The undo path
// relies on the gain being a single float multiplier: multiplying by 1/gain
// restores the original samples exactly in float32.

/** -1 dBFS peak target (10^(-1/20)). */
export const NORM_PEAK = Math.pow(10, -1 / 20);
/** -20 dBFS RMS target for the loudness mode. */
export const NORM_RMS_DB = -20;

export function peakOf(pcm) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

export function rmsOf(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

/** How far below the loud level a frame may sit and still count as speech. */
const SPEECH_GATE_DB = 25;
/** Frames this far above the loud level are transients, not speech. */
const TRANSIENT_DB = 6;

/**
 * RMS of the speech-active frames, with pauses and transients excluded.
 *
 * Whole-file RMS let pauses and room noise set the level: a recording with long
 * gaps measured quieter than the speech actually was, so it was lifted too far,
 * and one loud thump measured it louder. Frames are 20 ms on a 10 ms hop.
 */
export function speechRms(pcm, sampleRate = 48000) {
  const frame = Math.max(2, Math.round(0.02 * sampleRate));
  const hop = Math.max(1, Math.round(0.01 * sampleRate));
  if (pcm.length < frame) return rmsOf(pcm);

  const levels = [];
  for (let start = 0; start + frame <= pcm.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) sum += pcm[i] * pcm[i];
    levels.push(20 * Math.log10(Math.max(1e-12, Math.sqrt(sum / frame))));
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const loud = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.9))];
  const gate = loud - SPEECH_GATE_DB;
  const ceiling = loud + TRANSIENT_DB;

  let sum = 0;
  let count = 0;
  for (let f = 0; f < levels.length; f++) {
    if (levels[f] < gate || levels[f] > ceiling) continue;
    const start = f * hop;
    for (let i = start; i < start + frame; i++) sum += pcm[i] * pcm[i];
    count += frame;
  }
  if (!count) return rmsOf(pcm);
  return Math.sqrt(sum / count);
}

/**
 * Gain to apply, or null when there is no signal.
 *
 * `peak` scales the loudest sample to `peakTarget`. `rms` scales so the
 * speech-active RMS hits `rmsDb`, and only ever upward: a normalizer that
 * quietly turns a loud recording down is a surprise, and the limiter already
 * guards the peaks.
 */
export function normalizeGain(
  pcm,
  mode = "peak",
  { peakTarget = NORM_PEAK, rmsDb = NORM_RMS_DB, sampleRate = 48000 } = {}
) {
  const peak = peakOf(pcm);
  if (!(peak > 0)) return null;
  if (mode !== "rms") return peakTarget / peak;
  const rms = speechRms(pcm, sampleRate);
  if (!(rms > 0)) return null;
  const gain = Math.pow(10, rmsDb / 20) / rms;
  return gain < 1 ? 1 : gain;
}

/** A new buffer with `gain` applied. */
export function applyGain(pcm, gain) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * gain;
  return out;
}
