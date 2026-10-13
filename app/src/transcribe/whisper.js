// On-device transcription with Whisper via transformers.js (WASM).
import { pipeline, env } from "@huggingface/transformers";
import { resampleHQ } from "../audio/decode.js";

// Both the library and the ONNX Runtime wasm are vendored under app/vendor/, so
// the desktop build runs with no network at all. The bundled models live in
// app/models/ and are preferred over the Hub; with the desktop CSP restricted
// to 'self' there is nothing to fall back to.
env.allowLocalModels = true;
env.localModelPath = "./models/";
try {
  // ONNX Runtime normally finds its wasm beside the bundle; set it explicitly
  // too, in case the bundler's path resolution does not apply.
  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.wasmPaths = new URL("../../vendor/transformers/", import.meta.url).href;
  }
} catch (e) {}

let current = null;
let loadedKey = null;
// In-flight load, so two quick clicks share one download rather than starting
// two; also lets a model switch dispose the previous pipeline.
let pending = null;
let pendingKey = null;

// Inference can in principle hang, so each window is given a deadline. On
// expiry the run stops and keeps the partial transcript rather than waiting
// forever. Cancellation is cooperative: checked between windows, and it also
// aborts a window that is currently in flight.
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

function pipelineOptions(dtype, onProgress) {
  return {
    dtype,
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

/** Load (or reuse) the WASM pipeline for `modelId`, disposing a previous model. */
async function getPipeline(modelId, onProgress) {
  // q8 keeps the download and the memory footprint small; it is what the
  // timestamps-capable ONNX exports are published as.
  const dtype = "q8";
  const key = `${modelId}|wasm`;
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
  pending = pipeline("automatic-speech-recognition", modelId, pipelineOptions(dtype, onProgress))
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

  // The decision is made in decibels against a high percentile, matching the
  // playback detector. Anchoring the threshold to the loudest frame (the old
  // `floor + 8% of the peak` in linear units) let one cough or plosive push the
  // threshold above soft speech, so a quiet speaker's window was cut as silence.
  const db = energies.map((e) => 20 * Math.log10(Math.max(1e-9, e)));
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length / 10)];
  const speechLevel = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const span = Math.max(1e-6, speechLevel - floor);
  const threshold = floor + 0.35 * span;
  const minimumGap = Math.max(1, Math.round(minSilenceSeconds * sampleRate));

  const gaps = [];
  let gapStartFrame = -1;
  for (let i = 0; i < db.length; i += 1) {
    if (db[i] <= threshold) {
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
export async function transcribe(pcm, sampleRate, modelId, { onProgress, onStatus, onSegment, language } = {}) {
  cancelled = false;
  cancelWaiters = [];
  onStatus && onStatus("Loading model…");
  const pipe = await getPipeline(modelId, onProgress);
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
   * A stalled session never returns and keeps the underlying ONNX session busy,
   * so starting another run fails with "Session already started". The only safe
   * move is to stop and keep whatever was already transcribed.
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
      if (/timed out|session already started/i.test(message)) {
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
  // Window texts are joined with a space when they come from the plain-text
  // fallback; word tokens already carry their own spacing (TX-10).
  const appendText = (t) => {
    const s = (t || "").trim();
    if (!s) return;
    if (text && !/\s$/.test(text)) text += " ";
    text += s;
  };

  for (let index = 0; index < windows.length; index += 1) {
    if (cancelled) throw new CancelledError();
    const seg = windows[index];
    const audioStartSeconds = seg.audioStart / 16000;
    const assignStartSeconds = seg.assignStart / 16000;
    const assignEndSeconds = seg.assignEnd / 16000;
    const chunksBefore = chunks.length;

    if (wantTimestamps) {
      try {
        const result = await infer(
          pcm16k.subarray(seg.audioStart, seg.audioEnd),
          { ...baseOptions, return_timestamps: "word" }
        );
        const words = Array.isArray(result.chunks) ? result.chunks : [];
        const timestamped = words.filter((word) => Array.isArray(word.timestamp));
        if (result.text && timestamped.length === 0) {
          wantTimestamps = false;
          const fallback = await infer(
            pcm16k.subarray(seg.assignStart, seg.assignEnd),
            { ...baseOptions }
          );
          appendText(fallback.text);
          // Keep what was collected before the model gave up on timestamps: this
          // window becomes one un-timestamped chunk spanning it, instead of
          // discarding every earlier word chunk (TX-10).
          if (fallback.text) {
            chunks.push({ text: fallback.text, timestamp: [assignStartSeconds, assignEndSeconds] });
          }
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
            pcm16k.subarray(seg.assignStart, seg.assignEnd),
            { ...baseOptions }
          );
          appendText(fallback.text);
          if (fallback.text) {
            chunks.push({ text: fallback.text, timestamp: [assignStartSeconds, assignEndSeconds] });
          }
        } else {
          throw err;
        }
      }
    } else {
      const fallback = await infer(
        pcm16k.subarray(seg.assignStart, seg.assignEnd),
        { ...baseOptions }
      );
      appendText(fallback.text);
      if (fallback.text) {
        chunks.push({ text: fallback.text, timestamp: [assignStartSeconds, assignEndSeconds] });
      }
    }

    if (onSegment) {
      onSegment({
        index,
        segments: windows.length,
        start: assignStartSeconds,
        end: assignEndSeconds,
        // What this window produced, so the transcript can appear as it is
        // transcribed instead of only at the end.
        chunks: chunks.slice(chunksBefore),
      });
    }
    completedSeconds = assignEndSeconds;
    await yieldToUI();
  }
  } catch (err) {
    if (err && err.stalled) {
      onStatus && onStatus("Inference stalled — stopping (partial transcript kept)");
      return {
        text,
        chunks: chunks.length ? chunks : null,
        timestamped: wantTimestamps,
        stalled: true,
        completedSeconds,
      };
    }
    throw err;
  }

  // Chunks are returned even when word timestamps were unavailable: those
  // windows are represented as one span each, so the transcript is complete.
  return { text, chunks: chunks.length ? chunks : null, timestamped: wantTimestamps };
}
