// Loader/wrapper around the Rust WASM DSP core (fasttalk-core).
import init, {
  BakedMap,
  SkipBakedMap,
  StreamStretcher,
  analyze,
  consonant_boost,
  highpass,
  initSync,
  level,
  silence_zones,
  soft_limiter,
  time_stretch,
  time_stretch_skip_silence,
  version,
} from "../../vendor/fasttalk-core/fasttalk_core.js";

let ready = false;
let dspVersion = "?";

export async function initDsp(moduleOrPath) {
  if (ready) return;
  await init(moduleOrPath);
  dspVersion = version();
  ready = true;
}

export function getDspVersion() {
  return dspVersion;
}

/**
 * Offline render of a mono clip at a chosen speed (faithful hybrid engine).
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {number} speed
 * @param {boolean} classAware
 * @returns {Float32Array}
 */
export function timeStretch(pcm, sampleRate, speed, classAware) {
  return time_stretch(pcm, sampleRate, speed, classAware);
}

/**
 * Offline render with silence longer than `minSilenceS` cut down to a
 * `keepSilenceS` pause, then the rest stretched to `speed`.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {number} speed
 * @param {boolean} classAware
 * @param {number} minSilenceS
 * @param {number} keepSilenceS
 * @returns {Float32Array}
 */
export function timeStretchSkipSilence(pcm, sampleRate, speed, classAware, minSilenceS, keepSilenceS) {
  return time_stretch_skip_silence(pcm, sampleRate, speed, classAware, minSilenceS, keepSilenceS);
}

/**
 * Silence runs longer than `minSilenceS`, as `{start, end}` in samples.
 *
 * Raw detected edges: the caller applies the speed-dependent inset on *both*
 * sides when it builds the gap map, so changing speed never re-scans.
 * @returns {{start: number, end: number}[]}
 */
export function silenceZones(pcm, sampleRate, minSilenceS, keepSilenceS) {
  const flat = silence_zones(pcm, sampleRate, minSilenceS, keepSilenceS);
  const zones = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    zones.push({ start: flat[i], end: flat[i + 1] });
  }
  return zones;
}

export function analyzeClip(pcm, sampleRate) {
  return JSON.parse(analyze(pcm, sampleRate));
}

/** Rumble/hum high-pass (S-5). */
export function highpassFilter(pcm, sampleRate, cutoffHz) {
  return highpass(pcm, sampleRate, cutoffHz);
}

/** Consonant boost: high-shelf plus light high-band compression (S-4). */
export function consonantBoost(pcm, sampleRate, cornerHz, gainDb, amount) {
  return consonant_boost(pcm, sampleRate, cornerHz, gainDb, amount);
}

/** Soft limiter to `ceilingDb` (S-13). */
export function softLimiter(pcm, sampleRate, ceilingDb) {
  return soft_limiter(pcm, sampleRate, ceilingDb);
}

/**
 * Slow leveler: brings quiet passages up toward the loud ones, so a speaker far
 * from the microphone is heard at about the same level as one close to it.
 * `maxBoostDb` caps the lift; `windowS` is how long a "passage" is.
 */
export function levelVoices(pcm, sampleRate, maxBoostDb, windowS) {
  return level(pcm, sampleRate, maxBoostDb, windowS);
}

/**
 * Reusable baked render map from original input positions to baked positions.
 * The caller must call `dispose()` when finished.
 */
export function makeBakedMap(pcm, sampleRate, speed, classAware) {
  const map = new BakedMap(pcm, sampleRate, speed, classAware);
  return {
    mapSample: (sample) => Math.round(map.map_position(sample)),
    dispose: () => map.free(),
  };
}

/**
 * Position map for a skip-silence render. Matches `timeStretchSkipSilence`.
 * The caller must call `dispose()` when finished.
 */
export function makeSkipBakedMap(pcm, sampleRate, speed, classAware, minSilenceS, keepSilenceS) {
  const map = new SkipBakedMap(pcm, sampleRate, speed, classAware, minSilenceS, keepSilenceS);
  return {
    mapSample: (sample) => Math.round(map.map_position(sample)),
    dispose: () => map.free(),
  };
}

export { BakedMap, SkipBakedMap, StreamStretcher, initSync };
