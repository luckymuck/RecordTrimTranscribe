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

/**
 * Gain to apply, or null when there is no signal.
 *
 * `peak` scales the loudest sample to `peakTarget`. `rms` scales so the RMS
 * hits `rmsDb`, then backs off if that would push the peak past `peakCeiling`
 * (a single spike can no longer be the only thing that sets the level).
 */
export function normalizeGain(
  pcm,
  mode = "peak",
  { peakTarget = NORM_PEAK, rmsDb = NORM_RMS_DB, peakCeiling = NORM_PEAK } = {}
) {
  const peak = peakOf(pcm);
  if (!(peak > 0)) return null;
  if (mode !== "rms") return peakTarget / peak;
  const rms = rmsOf(pcm);
  if (!(rms > 0)) return null;
  let gain = Math.pow(10, rmsDb / 20) / rms;
  if (peak * gain > peakCeiling) gain = peakCeiling / peak;
  return gain;
}

/** A new buffer with `gain` applied. */
export function applyGain(pcm, gain) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * gain;
  return out;
}
