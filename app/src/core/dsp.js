// Loader/wrapper around the Rust WASM DSP core (fasttalk-core).
import init, {
  BakedMap,
  StreamStretcher,
  analyze,
  initSync,
  time_stretch,
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

export { BakedMap, StreamStretcher, initSync };
