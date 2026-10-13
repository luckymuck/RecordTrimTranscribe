// Clean-up chain: rumble filter (S-5), denoise (S-5), voice leveling,
// consonant boost (S-4), normalize (REC-12), and a lookahead limiter (S-13).
// Runs on the loaded source before it is stretched, because stretching
// exaggerates noise and breath.
//
// Order matters: denoise before the leveler so the level it measures is speech
// rather than noise, the leveler before the consonant boost so the boost's
// level-relative threshold sees consistent levels, and normalize before the
// limiter, which is the final guard.
//
// Every stage works in place on a copy, so the caller's buffer -- the pristine
// source the app renders from -- is never touched.

import { consonantBoost, highpassFilter, levelVoices, softLimiter } from "../core/dsp.js";
import { applyGain, NORM_RMS_DB, normalizeGain } from "./normalize.js";
import { denoise } from "./denoise.js";

export const RUMBLE_CUTOFF_HZ = 80;
export const CONSONANT_CORNER_HZ = 2000;
export const CONSONANT_MAX_DB = 6;
export const LIMIT_CEILING_DB = -1;
/**
 * Leveler: lift quiet passages by at most this much, measured over this window.
 * The leveler lowers the effective cap further when the recording's own noise
 * floor is too close to its loud level, so a large cap cannot simply lift noise.
 */
export const LEVEL_MAX_BOOST_DB = 18;
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

/** True when a selected stage can push peaks up, so the limiter must run. */
export function cleanupRaisesLevel(partial) {
  const o = cleanupOptions(partial);
  return o.level || (o.consonant && o.consonantDb > 0) || (o.normalize && o.normalizeMode === "rms");
}

/** Human-readable summary of what a run did. */
export function cleanupSummary(steps) {
  return steps && steps.length ? `Cleaned up: ${steps.join(", ")}` : "Nothing selected to clean up";
}

/**
 * Run the selected stages over `pcm`.
 *
 * Returns `{ pcm, steps, gain }`. `pcm` is the input unchanged when nothing is
 * selected, so the caller can compare identity and skip the swap; otherwise it
 * is a new buffer. `gain` is set only when normalize is the sole stage: the
 * whole chain is then one multiplier, which the caller can undo exactly.
 *
 * The input is never mutated unless `copy: false` is passed, which is for a
 * buffer the caller allocated for this render alone. That saves a full-length
 * copy, which at 48 kHz is 691 MB for a one-hour recording.
 */
export async function cleanUp(pcm, sampleRate, partial, onProgress, { copy = true } = {}) {
  const o = cleanupOptions(partial);
  const steps = [];
  if (!cleanupActive(o)) return { pcm, steps, gain: null };
  let out = copy ? Float32Array.from(pcm) : pcm;
  if (o.rumble) {
    out = highpassFilter(out, sampleRate, RUMBLE_CUTOFF_HZ);
    steps.push("rumble filtered");
  }
  if (o.denoise) {
    out = await denoise(out, sampleRate, onProgress);
    steps.push("denoised");
  }
  if (o.level) {
    // Before the consonant boost, so its level-relative threshold sees
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
    const gain = normalizeGain(out, o.normalizeMode, { sampleRate });
    if (gain !== null) {
      out = applyGain(out, gain);
      steps.push(
        o.normalizeMode === "rms" ? `normalized to ${NORM_RMS_DB} dBFS RMS` : "normalized"
      );
    }
  }
  // The limiter runs whenever a stage raised the level, not only when the box was
  // ticked: cleaned audio used to be exported unlimited, so a boost could clip.
  // Peak-mode normalize already lands the peak on the ceiling, so it needs none.
  const auto = !o.loudness && cleanupRaisesLevel(o);
  if (o.loudness || auto) {
    out = softLimiter(out, sampleRate, LIMIT_CEILING_DB);
    steps.push(`limited to ${LIMIT_CEILING_DB} dBFS${auto ? " (auto)" : ""}`);
  }
  const gainOnly = isGainOnlyCleanup(o);
  return {
    pcm: out,
    steps,
    gain: gainOnly ? normalizeGain(pcm, o.normalizeMode, { sampleRate }) : null,
  };
}
