// Clean-up chain: rumble filter (S-5), denoise (S-5), consonant boost (S-4),
// normalize (REC-12), and a soft limiter (S-13). Runs on the loaded source
// before it is stretched, because stretching exaggerates noise and breath.
//
// Order matters: denoise before the consonant boost so the boost cannot lift
// the noise floor, normalize before the limiter (the limiter is the final
// guard), and the limiter last so it catches everything before it.

import { consonantBoost, highpassFilter, levelVoices, softLimiter } from "../core/dsp.js";
import { applyGain, NORM_RMS_DB, normalizeGain } from "./normalize.js";
import { denoise } from "./denoise.js";

export const RUMBLE_CUTOFF_HZ = 80;
export const CONSONANT_CORNER_HZ = 2000;
export const CONSONANT_MAX_DB = 6;
export const LIMIT_CEILING_DB = -1;
/** Leveler: lift quiet passages by at most this much, measured over this window. */
export const LEVEL_MAX_BOOST_DB = 12;
export const LEVEL_WINDOW_S = 3;

export const DEFAULT_CLEANUP = {
  rumble: true,
  denoise: true,
  level: false,
  consonant: false,
  consonantDb: 3,
  normalize: false,
  normalizeMode: "peak",
  loudness: false,
};

/** Merge a partial options object with the defaults and clamp the strength. */
export function cleanupOptions(partial) {
  const o = { ...DEFAULT_CLEANUP, ...(partial || {}) };
  const db = Number(o.consonantDb);
  o.consonantDb = Math.max(0, Math.min(CONSONANT_MAX_DB, Number.isFinite(db) ? db : 0));
  o.normalizeMode = o.normalizeMode === "rms" ? "rms" : "peak";
  return o;
}

/** True when the selected chain is exactly one normalize multiplier. */
export function isGainOnlyCleanup(partial) {
  const o = cleanupOptions(partial);
  return o.normalize && !o.rumble && !o.denoise && !o.level && !o.consonant && !o.loudness;
}
/** True when at least one stage is selected. */
export function cleanupActive(partial) {
  const o = cleanupOptions(partial);
  return o.rumble || o.denoise || o.level || o.consonant || o.normalize || o.loudness;
}

/** Human-readable summary of what a run did. */
export function cleanupSummary(steps) {
  return steps && steps.length ? `Cleaned up: ${steps.join(", ")}` : "Nothing selected to clean up";
}

/**
 * Run the selected stages over `pcm`.
 *
 * Returns `{ pcm, steps, gain }`. `pcm` is the input unchanged when nothing is
 * selected, so the caller can compare identity and skip the swap. `gain` is set
 * only when normalize is the sole stage: the whole chain is then one
 * multiplier, which the caller can undo exactly and without keeping a copy.
 */
export async function cleanUp(pcm, sampleRate, partial, onProgress) {
  const o = cleanupOptions(partial);
  const steps = [];
  let out = pcm;
  if (o.rumble) {
    out = highpassFilter(out, sampleRate, RUMBLE_CUTOFF_HZ);
    steps.push("rumble filtered");
  }
  if (o.denoise) {
    out = await denoise(out, sampleRate, onProgress);
    steps.push("denoised");
  }
  if (o.level) {
    // Before the consonant boost, so its level-dependent thresholds see
    // consistent levels, and before normalize, which still sets the final peak.
    out = levelVoices(out, sampleRate, LEVEL_MAX_BOOST_DB, LEVEL_WINDOW_S);
    steps.push("quiet passages lifted");
  }
  if (o.consonant && o.consonantDb > 0) {
    // Stronger shelf implies proportionally more high-band compression.
    const amount = Math.min(1, o.consonantDb / CONSONANT_MAX_DB);
    out = consonantBoost(out, sampleRate, CONSONANT_CORNER_HZ, o.consonantDb, amount);
    steps.push(`consonants +${o.consonantDb} dB`);
  }
  if (o.normalize) {
    const gain = normalizeGain(out, o.normalizeMode);
    if (gain !== null) {
      out = applyGain(out, gain);
      steps.push(
        o.normalizeMode === "rms" ? `normalized to ${NORM_RMS_DB} dBFS RMS` : "normalized"
      );
    }
  }
  if (o.loudness) {
    out = softLimiter(out, sampleRate, LIMIT_CEILING_DB);
    steps.push(`limited to ${LIMIT_CEILING_DB} dBFS`);
  }
  const gainOnly = isGainOnlyCleanup(o);
  return { pcm: out, steps, gain: gainOnly ? normalizeGain(pcm, o.normalizeMode) : null };
}
