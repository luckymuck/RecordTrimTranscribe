// RNNoise speech denoising (S-5).
//
// RNNoise is trained for 48 kHz mono in 10 ms frames, so the caller's audio is
// resampled to 48 kHz, denoised, and resampled back. It works in 16-bit units
// internally, so samples are scaled by 32768 in and out.
//
// The build is vendored under `app/vendor/rnnoise/` and loaded from there only:
// the desktop build is strictly offline, so there is no CDN fallback.

import { resampleHQ } from "./decode.js";

/** RNNoise's frame size: 10 ms at 48 kHz. */
const FRAME = 480;
/** RNNoise operates on int16-range floats. */
const SCALE = 32768;
/** Frames between yields, so a long file does not block the UI. ~5 s of audio. */
const YIELD_FRAMES = 500;

let engine = null;
let loading = null;
let loadError = null;

async function loadModule() {
  const mod = await import("../../vendor/rnnoise/rnnoise.js");
  return await mod.default();
}

/** Load RNNoise once. Resolves to the engine, or throws. */
export async function loadDenoise() {
  if (engine) return engine;
  if (loadError) throw loadError;
  if (!loading) {
    loading = (async () => {
      const mod = await loadModule();
      const frameSize = mod._rnnoise_get_frame_size() || FRAME;
      const inPtr = mod._malloc(frameSize * 4);
      const outPtr = mod._malloc(frameSize * 4);
      engine = { mod, frameSize, inPtr, outPtr };
      return engine;
    })()
      .catch((err) => {
        loadError = err;
        throw err;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Whether RNNoise has loaded (or is loading) without error. */
export function denoiseAvailable() {
  return !!engine;
}

/**
 * Denoise mono 48 kHz PCM, returning a new array.
 *
 * A fresh recurrent state is created for every run: the state used to be created
 * once and reused, so the end of one file primed the start of the next.
 * `onProgress` receives 0..1 and the loop yields, so the page stays responsive.
 */
export async function denoise48(pcm, onProgress) {
  const { mod, frameSize, inPtr, outPtr } = await loadDenoise();
  const out = new Float32Array(pcm.length);
  const state = mod._rnnoise_create(0);
  if (!state) throw new Error("RNNoise could not create a state");
  try {
    const inHeap = mod.HEAPF32.subarray(inPtr >> 2, (inPtr >> 2) + frameSize);
    const outHeap = mod.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + frameSize);
    const frames = Math.floor(pcm.length / frameSize);
    for (let f = 0; f < frames; f++) {
      const base = f * frameSize;
      let peak = 0;
      for (let i = 0; i < frameSize; i++) {
        const v = pcm[base + i];
        inHeap[i] = v * SCALE;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      mod._rnnoise_process_frame(state, outPtr, inPtr);
      if (peak < 1e-5) {
        // Digital silence: the model can leave a faint residue, so pass the frame
        // through untouched. It is still fed so the state stays coherent.
        for (let i = 0; i < frameSize; i++) out[base + i] = pcm[base + i];
      } else {
        for (let i = 0; i < frameSize; i++) out[base + i] = outHeap[i] / SCALE;
      }
      if (onProgress && (f % YIELD_FRAMES === 0 || f + 1 === frames)) {
        onProgress(frames ? (f + 1) / frames : 1);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    // A trailing part-frame is passed through untouched rather than padded.
    for (let i = frames * frameSize; i < pcm.length; i++) out[i] = pcm[i];
  } finally {
    mod._rnnoise_destroy(state);
  }
  return out;
}

/**
 * Denoise mono PCM at any sample rate. `onProgress` receives 0..1.
 */
export async function denoise(pcm, sampleRate, onProgress) {
  await loadDenoise();
  onProgress && onProgress(0.1);
  const needsResample = sampleRate !== 48000;
  const pcm48 = needsResample ? await resampleHQ(pcm, sampleRate, 48000) : pcm;
  onProgress && onProgress(0.2);
  const out48 = await denoise48(pcm48, (f) => onProgress && onProgress(0.2 + 0.7 * f));
  onProgress && onProgress(0.9);
  const out = needsResample ? await resampleHQ(out48, 48000, sampleRate) : out48;
  onProgress && onProgress(1);
  return out;
}
