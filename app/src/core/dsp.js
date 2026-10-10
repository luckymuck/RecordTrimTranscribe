// Loader/wrapper around the Rust WASM DSP core (fasttalk-core).
import init, {
  BakedMap,
  SkipBakedMap,
  StreamStretcher,
  analyze,
  initSync,
  silence_zones,
  time_stretch,
  time_stretch_skip_silence,
  version,
} from "../../vendor/fasttalk-core/fasttalk_core.js";

let ready = false;
let dspVersion = "?";

export async function initDsp() {
  if (ready) return;
  await init();
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
 * Offline render with silence longer than `minSilenceS` removed, then the rest
 * stretched to `speed`.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {number} speed
 * @param {boolean} classAware
 * @param {number} minSilenceS
 * @returns {Float32Array}
 */
export function timeStretchSkipSilence(pcm, sampleRate, speed, classAware, minSilenceS) {
  return time_stretch_skip_silence(pcm, sampleRate, speed, classAware, minSilenceS);
}

/**
 * Silence runs longer than `minSilenceS`, as `{start, end}` in samples.
 * @returns {{start: number, end: number}[]}
 */
export function silenceZones(pcm, sampleRate, minSilenceS) {
  const flat = silence_zones(pcm, sampleRate, minSilenceS);
  const zones = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    zones.push({ start: flat[i], end: flat[i + 1] });
  }
  return zones;
}

export function analyzeClip(pcm, sampleRate) {
  return JSON.parse(analyze(pcm, sampleRate));
}

/**
 * Reusable baked render map from original input positions to baked positions.
 * The caller must call `dispose()` when finished.
 */
export function makeBakedMap(pcm, sampleRate, speed, classAware) {
  const map = BakedMap.new(pcm, sampleRate, speed, classAware);
  return {
    mapSample: (sample) => Math.round(map.map_position(sample)),
    dispose: () => map.free(),
  };
}

/**
 * Position map for a skip-silence render. Matches `timeStretchSkipSilence`.
 * The caller must call `dispose()` when finished.
 */
export function makeSkipBakedMap(pcm, sampleRate, speed, classAware, minSilenceS) {
  const map = SkipBakedMap.new(pcm, sampleRate, speed, classAware, minSilenceS);
  return {
    mapSample: (sample) => Math.round(map.map_position(sample)),
    dispose: () => map.free(),
  };
}

export { BakedMap, SkipBakedMap, StreamStretcher, initSync };
