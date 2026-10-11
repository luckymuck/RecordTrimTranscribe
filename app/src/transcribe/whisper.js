// On-device transcription with Whisper via transformers.js (WASM/WebGPU).
import { pipeline, env } from "@huggingface/transformers";
import { resampleHQ } from "../audio/decode.js";

env.allowLocalModels = false;

let current = null;
let loadedId = null;

async function getPipeline(modelId, onProgress) {
  if (current && loadedId === modelId) return current;
  current = await pipeline("automatic-speech-recognition", modelId, {
    dtype: "q8",
    progress_callback: onProgress,
  });
  loadedId = modelId;
  return current;
}

const TRANSCRIPTION_WINDOW_SECONDS = 30;
const TRANSCRIPTION_TARGET_SECONDS = 27.5;
const TRANSCRIPTION_OVERLAP_SECONDS = 2.5;
const TRANSCRIPTION_MIN_SILENCE_SECONDS = 0.35;

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

  const minimumMain = Math.max(1, Math.round(TRANSCRIPTION_TARGET_SECONDS * sampleRate));
  const overlap = Math.max(1, Math.round(TRANSCRIPTION_OVERLAP_SECONDS * sampleRate));
  const gaps = findSilenceGaps(samples, sampleRate);
  const windows = [];
  let assignStart = 0;
  let audioStart = 0;

  while (assignStart < total) {
    const audioEnd = Math.min(audioStart + maximum, total);
    let assignEnd = audioEnd;
    if (audioEnd < total) {
      const candidates = gaps.filter(
        ([gapStart, gapEnd]) => gapStart > assignStart && gapEnd < audioEnd
      );
      const preferred = [...candidates]
        .reverse()
        .find(([gapStart, gapEnd]) => Math.round((gapStart + gapEnd) / 2) - assignStart >= minimumMain);
      assignEnd = preferred
        ? Math.round((preferred[0] + preferred[1]) / 2)
        : Math.min(total, audioEnd - overlap);
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
export async function transcribe(pcm, sampleRate, modelId, { onProgress, onStatus, onSegment } = {}) {
  onStatus && onStatus("Loading model…");
  const pipe = await getPipeline(modelId, onProgress);
  onStatus && onStatus("Transcribing… 0%");
  const pcm16k = await resampleHQ(pcm, sampleRate, 16000);
  const windows = splitTranscriptionWindows(pcm16k, 16000);
  const totalSeconds = pcm16k.length / 16000;

  let text = "";
  const chunks = [];
  let wantTimestamps = true;

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const audioStartSeconds = window.audioStart / 16000;
    const assignStartSeconds = window.assignStart / 16000;
    const assignEndSeconds = window.assignEnd / 16000;

    if (wantTimestamps) {
      try {
        const result = await pipe(
          pcm16k.subarray(window.audioStart, window.audioEnd),
          { return_timestamps: "word" }
        );
        const words = Array.isArray(result.chunks) ? result.chunks : [];
        const timestamped = words.filter((word) => Array.isArray(word.timestamp));
        if (result.text && timestamped.length === 0) {
          wantTimestamps = false;
          const fallback = await pipe(
            pcm16k.subarray(window.assignStart, window.assignEnd),
            {}
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
          const fallback = await pipe(
            pcm16k.subarray(window.assignStart, window.assignEnd),
            {}
          );
          text += fallback.text || "";
        } else {
          throw err;
        }
      }
    } else {
      const fallback = await pipe(
        pcm16k.subarray(window.assignStart, window.assignEnd),
        {}
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
    await yieldToUI();
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
