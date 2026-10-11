// On-device transcription with Whisper via transformers.js (WASM/WebGPU).
import { pipeline, env } from "@huggingface/transformers";
import { resampleHQ } from "../audio/decode.js";

env.allowLocalModels = false;

let current = null;
let loadedKey = null;
// In-flight load, so two quick clicks share one download rather than starting
// two; also lets a model switch dispose the previous pipeline.
let pending = null;
let pendingKey = null;

// A WebGPU session that stalls partway through the file never returns, so each
// window is given a deadline; on expiry the pipeline is dropped and the window
// is retried on WASM. Cancellation is cooperative: checked between windows, and
// it also aborts a window that is currently waiting.
const WINDOW_TIMEOUT_MS = 120000;
let cancelled = false;
// Resolvers waiting on cancellation, so Cancel aborts the window in flight
// rather than only taking effect once it returns.
let cancelWaiters = [];

class CancelledError extends Error {
  constructor() {
    super("Transcription cancelled");
    this.cancelled = true;
  }
}

/** Ask the running transcription to stop. */
export function cancelTranscription() {
  cancelled = true;
  const waiters = cancelWaiters;
  cancelWaiters = [];
  for (const resolve of waiters) resolve();
}

/** Resolves as soon as a cancel is requested. */
function cancelSignal() {
  if (cancelled) return Promise.resolve();
  return new Promise((resolve) => cancelWaiters.push(resolve));
}

// WebGPU load guard. `navigator.gpu` can exist without a usable adapter, and
// requesting one can throw, so probe before asking for the WebGPU device.
// Returns the dtype to use on WebGPU, or null when WebGPU is not usable.
const WEBGPU_LOAD_TIMEOUT_MS = 120000;

async function webgpuDtype() {
  if (!navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    // fp16 halves the download where the adapter supports it.
    return adapter.features.has("shader-f16") ? "fp16" : "fp32";
  } catch (e) {
    return null;
  }
}

function pipelineOptions(device, dtype, onProgress) {
  return {
    dtype,
    ...(device ? { device } : {}),
    progress_callback: onProgress,
  };
}

/** Reject if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, message) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function getPipeline(modelId, onProgress, device, onStatus) {
  let useDevice = device;
  let dtype = "q8";
  if (useDevice) {
    const gpuDtype = await webgpuDtype();
    if (gpuDtype) {
      dtype = gpuDtype;
    } else {
      onStatus && onStatus("WebGPU not available — using WASM");
      useDevice = undefined;
    }
  }
  const key = `${modelId}|${useDevice || "wasm"}`;
  if (current && loadedKey === key) return current;
  if (pending && pendingKey === key) return pending;
  if (current) {
    // Switching models: release the old pipeline's WASM heaps.
    try {
      await current.dispose();
    } catch (e) {}
    current = null;
    loadedKey = null;
  }
  pendingKey = key;
  pending = (async () => {
    if (useDevice) {
      // q8 is the WASM quantisation. The WebGPU execution provider needs a
      // float dtype -- a quantized model on WebGPU tends to hang rather than
      // fail, which is what made the WebGPU option appear to do nothing.
      const load = pipeline(
        "automatic-speech-recognition",
        modelId,
        pipelineOptions("webgpu", dtype, onProgress)
      );
      return withTimeout(load, WEBGPU_LOAD_TIMEOUT_MS, "WebGPU load timed out");
    }
    return pipeline(
      "automatic-speech-recognition",
      modelId,
      pipelineOptions(undefined, dtype, onProgress)
    );
  })()
    .catch((err) => {
      if (!useDevice) throw err;
      onStatus && onStatus("WebGPU failed — falling back to WASM…");
      return pipeline(
        "automatic-speech-recognition",
        modelId,
        pipelineOptions(undefined, "q8", onProgress)
      );
    })
    .then((pipe) => {
      current = pipe;
      loadedKey = key;
      pending = null;
      pendingKey = null;
      return pipe;
    })
    .catch((err) => {
      pending = null;
      pendingKey = null;
      throw err;
    });
  return pending;
}

const TRANSCRIPTION_WINDOW_SECONDS = 30;
const TRANSCRIPTION_TARGET_SECONDS = 27.5;
const TRANSCRIPTION_OVERLAP_SECONDS = 2.5;
const TRANSCRIPTION_MIN_SILENCE_SECONDS = 0.35;
// A window's main body must reach at least this far before a silence cut is
// allowed, so windows do not become tiny.
const TRANSCRIPTION_MIN_MAIN_SECONDS = 12;

function yieldToUI() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function pcmEnergies(samples, frameSamples, hopSamples) {
  const energies = [];
  for (let start = 0; start + frameSamples <= samples.length; start += hopSamples) {
    let sum = 0;
    for (let i = start; i < start + frameSamples; i += 1) {
      sum += samples[i] * samples[i];
    }
    energies.push(Math.sqrt(sum / frameSamples));
  }
  return energies;
}

/**
 * Find quiet intervals so long recordings can be divided without cutting through
 * speech whenever possible. Positions are sample indices in `samples`.
 */
function findSilenceGaps(samples, sampleRate, minSilenceSeconds = TRANSCRIPTION_MIN_SILENCE_SECONDS) {
  const frameSamples = Math.max(2, Math.round(0.02 * sampleRate));
  const hopSamples = Math.max(1, Math.round(0.01 * sampleRate));
  const energies = pcmEnergies(samples, frameSamples, hopSamples);
  if (energies.length === 0) return [];

  const sorted = [...energies].sort((a, b) => a - b);
  const peak = sorted[sorted.length - 1];
  const floor = sorted[Math.floor(sorted.length / 10)];
  const threshold = Math.max(1e-4, floor + 0.08 * (peak - floor));
  const minimumGap = Math.max(1, Math.round(minSilenceSeconds * sampleRate));

  const gaps = [];
  let gapStartFrame = -1;
  for (let i = 0; i < energies.length; i += 1) {
    if (energies[i] <= threshold) {
      if (gapStartFrame < 0) gapStartFrame = i;
    } else if (gapStartFrame >= 0) {
      const start = gapStartFrame * hopSamples;
      const end = Math.min(samples.length, i * hopSamples + frameSamples);
      if (end - start >= minimumGap) gaps.push([start, end]);
      gapStartFrame = -1;
    }
  }
  if (gapStartFrame >= 0) {
    const start = gapStartFrame * hopSamples;
    if (samples.length - start >= minimumGap) gaps.push([start, samples.length]);
  }
  return gaps;
}

/**
 * Divide audio into sequential model windows that never exceed Whisper's
 * 30-second input context. Words are retained only from each window's assigned
 * range, while adjacent windows carry up to 2.5 seconds of acoustic context.
 */
function splitTranscriptionWindows(samples, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("A valid sample rate is required to split audio.");
  }
  const total = samples.length;
  const maximum = Math.max(1, Math.round(TRANSCRIPTION_WINDOW_SECONDS * sampleRate));
  if (total <= maximum) {
    return [{ audioStart: 0, audioEnd: total, assignStart: 0, assignEnd: total }];
  }

  const minimumMain = Math.max(1, Math.round(TRANSCRIPTION_MIN_MAIN_SECONDS * sampleRate));
  const overlap = Math.max(1, Math.round(TRANSCRIPTION_OVERLAP_SECONDS * sampleRate));
  const gaps = findSilenceGaps(samples, sampleRate);
  const windows = [];
  let assignStart = 0;
  let audioStart = 0;

  while (assignStart < total) {
    const audioEnd = Math.min(audioStart + maximum, total);
    let assignEnd = audioEnd;
    if (audioEnd < total) {
      // Cut at the longest silence that starts late enough to leave a usable
      // main body and ends before the overlap window, so the next window keeps
      // real acoustic context. The previous test required the cut to sit
      // >= 27.5 s past assignStart, which is impossible once audioEnd is
      // assignStart + 27.5 s -- so every cut fell back to mid-speech.
      const latestCut = audioEnd - overlap;
      let best = null;
      for (const [gapStart, gapEnd] of gaps) {
        if (gapStart <= assignStart + minimumMain) continue;
        if (gapEnd > latestCut) continue;
        if (!best || gapEnd - gapStart > best[1] - best[0]) best = [gapStart, gapEnd];
      }
      assignEnd = best
        ? Math.round((best[0] + best[1]) / 2)
        : Math.min(total, latestCut);
      assignEnd = Math.max(assignStart + 1, assignEnd);
    }

    windows.push({ audioStart, audioEnd, assignStart, assignEnd });
    if (assignEnd >= total) break;
    assignStart = assignEnd;
    audioStart = Math.max(0, assignStart - overlap);
    if (windows.length > 10000) break;
  }
  return windows;
}

/**
 * Transcribe mono PCM.
 * Returns { text, chunks: [{ text, timestamp:[s,e] }] | null, timestamped: bool }.
 *
 * The ASR pipeline itself returns a promise and does not report intermediate
 * inference events. For genuine file-fraction progress, long audio is therefore
 * transcribed as sequential model-length windows. `onSegment` is called with
 * `{ index, segments, start, end }` in seconds after each window completes.
 *
 * Timestamp extraction needs a model exported with `output_attentions=True` (the
 * `*_timestamped` ONNX exports). If the selected model cannot provide them, we
 * transparently retry without timestamps and return plain text.
 */
export async function transcribe(pcm, sampleRate, modelId, { onProgress, onStatus, onSegment, language, device } = {}) {
  cancelled = false;
  cancelWaiters = [];
  onStatus && onStatus("Loading model…");
  let activeDevice = device;
  let pipe = await getPipeline(modelId, onProgress, activeDevice, onStatus);
  onStatus && onStatus("Transcribing… 0%");
  const pcm16k = await resampleHQ(pcm, sampleRate, 16000);
  const windows = splitTranscriptionWindows(pcm16k, 16000);
  const totalSeconds = pcm16k.length / 16000;
  // Forcing the language avoids per-window auto-detection, which can mislabel
  // quiet or noisy windows and produce the wrong language (or a translation).
  const baseOptions = language ? { language } : {};

  /**
   * Run one window with a deadline.
   *
   * A stalled WebGPU session never returns, and it keeps the underlying ONNX
   * session busy, so starting another run -- even on a freshly loaded pipeline
   * -- fails with "Session already started". The only safe move is to stop and
   * keep whatever was already transcribed.
   */
  const infer = async (audio, options) => {
    if (cancelled) throw new CancelledError();
    try {
      return await Promise.race([
        withTimeout(pipe(audio, options), WINDOW_TIMEOUT_MS, "window timed out"),
        cancelSignal().then(() => {
          throw new CancelledError();
        }),
      ]);
    } catch (err) {
      if (cancelled) throw new CancelledError();
      const message = String((err && err.message) || err);
      if (activeDevice && /timed out|session already started/i.test(message)) {
        throw Object.assign(new Error(message), { stalled: true });
      }
      throw err;
    }
  };

  let text = "";
  const chunks = [];
  let wantTimestamps = true;
  let completedSeconds = 0;

  try {
  for (let index = 0; index < windows.length; index += 1) {
    if (cancelled) throw new CancelledError();
    const window = windows[index];
    const audioStartSeconds = window.audioStart / 16000;
    const assignStartSeconds = window.assignStart / 16000;
    const assignEndSeconds = window.assignEnd / 16000;

    if (wantTimestamps) {
      try {
        const result = await infer(
          pcm16k.subarray(window.audioStart, window.audioEnd),
          { ...baseOptions, return_timestamps: "word" }
        );
        const words = Array.isArray(result.chunks) ? result.chunks : [];
        const timestamped = words.filter((word) => Array.isArray(word.timestamp));
        if (result.text && timestamped.length === 0) {
          wantTimestamps = false;
          const fallback = await infer(
            pcm16k.subarray(window.assignStart, window.assignEnd),
            { ...baseOptions }
          );
          text += fallback.text || "";
        } else {
          for (const word of timestamped) {
            const start = word.timestamp[0] + audioStartSeconds;
            if (!Number.isFinite(start)) continue;
            if (start < assignStartSeconds) continue;
            if (index + 1 < windows.length && start >= assignEndSeconds) continue;
            chunks.push({
              ...word,
              timestamp: [
                start,
                typeof word.timestamp[1] === "number"
                  ? word.timestamp[1] + audioStartSeconds
                  : word.timestamp[1],
              ],
            });
            text += word.text || "";
          }
        }
      } catch (err) {
        const message = String((err && err.message) || err);
        if (/cross attentions/i.test(message)) {
          wantTimestamps = false;
          onStatus && onStatus("Model lacks timestamp data — transcribing without timestamps…");
          const fallback = await infer(
            pcm16k.subarray(window.assignStart, window.assignEnd),
            { ...baseOptions }
          );
          text += fallback.text || "";
        } else {
          throw err;
        }
      }
    } else {
      const fallback = await infer(
        pcm16k.subarray(window.assignStart, window.assignEnd),
        { ...baseOptions }
      );
      text += fallback.text || "";
    }

    if (onSegment) {
      onSegment({
        index,
        segments: windows.length,
        start: assignStartSeconds,
        end: assignEndSeconds,
      });
    }
    completedSeconds = assignEndSeconds;
    await yieldToUI();
  }
  } catch (err) {
    if (err && err.stalled) {
      onStatus && onStatus("WebGPU stalled — stopping (partial transcript kept)");
      return {
        text,
        chunks: wantTimestamps ? chunks : null,
        timestamped: wantTimestamps,
        stalled: true,
        completedSeconds,
      };
    }
    throw err;
  }

  if (wantTimestamps) {
    return { text, chunks, timestamped: true };
  }
  return { text, chunks: null, timestamped: false };
}

export function toSrt(chunks) {
  const fmt = (s) => {
    const ms = Math.floor((s % 1) * 1000);
    const total = Math.floor(s);
    const hh = String(Math.floor(total / 3600)).padStart(2, "0");
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss},${String(ms).padStart(3, "0")}`;
  };
  // Group word chunks into ~1 line per 8 words.
  const words = (chunks || []).filter((c) => c.timestamp);
  const lines = [];
  for (let i = 0; i < words.length; i += 8) {
    const group = words.slice(i, i + 8);
    const start = group[0].timestamp[0];
    const end = group[group.length - 1].timestamp[1] ?? group[group.length - 1].timestamp[0] + 1;
    const text = group.map((w) => w.text).join("").trim();
    lines.push(`${lines.length + 1}\n${fmt(start)} --> ${fmt(end)}\n${text}\n`);
  }
  return lines.join("\n");
}
