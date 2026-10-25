// Reading the audio out of a loaded file, whatever its container.
//
// Three paths, chosen by container:
//
//   WAV          our own PCM reader: no `decodeAudioData`, no 2 GB argument cap,
//                and exact byte-range loads.
//   MP4 / MKV    demux the audio track and decode it with WebCodecs, reading only
//                the sample bytes in the wanted range. A 2-hour video's audio is
//                a fraction of the file, and its video is never touched.
//   anything     `decodeAudioData`, which needs the whole file in memory and
//   else         refuses anything over 2 GB.
//
// DOM-free helpers live in the sibling modules; this one drives the browser APIs.

import { demuxMkv, parseMkvHeader } from "./mkv.js";
import { demuxMp4, selectSamples } from "./mp4.js";
import { probeWav, readWavRange } from "./wavread.js";

/** Container from the name or MIME type. */
export function containerOf(file) {
  const name = String((file && file.name) || "").toLowerCase();
  const type = String((file && file.type) || "").toLowerCase();
  if (/\.wav$/.test(name) || type === "audio/wav" || type === "audio/x-wav") return "wav";
  if (/\.(mp4|m4a|m4v|mov)$/.test(name) || /^video\/mp4$/.test(type) || type === "audio/mp4") return "mp4";
  if (/\.(mkv|webm|mka)$/.test(name) || /matroska|webm/.test(type)) return "mkv";
  return "other";
}

/** True when WebCodecs audio decoding is available. */
export function webCodecsAvailable() {
  return typeof globalThis.AudioDecoder === "function";
}

/** Duration from an `<audio>` element's metadata, without decoding. */
export function mediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("audio");
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      el.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => finish(0);
    setTimeout(() => finish(0), 5000);
    el.src = url;
  });
}

/**
 * What can be learned about a file before decoding any audio.
 *
 * Returns `{ kind, durationSeconds, sampleRate, channels, exact, track? }`.
 * `exact` means the duration and sample rate came from the container itself, so
 * the memory estimate is trustworthy.
 */
export async function probeAudio(file) {
  const kind = containerOf(file);
  if (kind === "wav") {
    const header = await probeWav(file);
    return {
      kind,
      durationSeconds: header.durationSeconds,
      sampleRate: header.sampleRate,
      channels: header.channels,
      exact: true,
    };
  }
  if (kind === "mp4") {
    const track = await demuxMp4(file);
    return {
      kind,
      durationSeconds: track.durationSeconds,
      sampleRate: track.sampleRate,
      channels: track.channels,
      exact: true,
      track,
    };
  }
  if (kind === "mkv") {
    // Only the header elements: the cluster walk happens during the read.
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
    const header = parseMkvHeader(head);
    const audio = header.audio;
    return {
      kind,
      durationSeconds: header.durationSeconds,
      sampleRate: audio ? audio.sampleRate || 48000 : 48000,
      channels: audio ? audio.channels || 2 : 2,
      exact: header.durationSeconds > 0,
      header,
    };
  }
  const durationSeconds = await mediaDuration(file);
  return {
    kind: "other",
    durationSeconds,
    sampleRate: 48000,
    channels: 2,
    exact: false,
  };
}

/**
 * Per-channel weights for a mono downmix, normalised to sum to one.
 *
 * A plain average buries dialogue in a 5.1 film: the centre channel carries it,
 * and the low-frequency channel only adds rumble. The usual layouts are
 * L R C LFE Ls Rs and their variants, which is why the centre is favoured and
 * the LFE heavily attenuated. Unknown layouts fall back to an even average.
 */
export function downmixWeights(channels) {
  const table = {
    1: [1],
    2: [1, 1],
    3: [1, 1, 1.4], // L R C
    4: [1, 1, 0.7, 1.4], // L R Ls Rs
    5: [1, 1, 1.6, 0.7, 0.7], // L R C Ls Rs
    6: [1, 1, 1.6, 0.15, 0.7, 0.7], // L R C LFE Ls Rs
    7: [1, 1, 1.6, 0.15, 0.7, 0.7, 0.6],
    8: [1, 1, 1.6, 0.15, 0.7, 0.7, 0.6, 0.6],
  };
  const weights = table[channels] || new Array(channels).fill(1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => w / total);
}

/** Read one sample's bytes from the file. */
async function readSample(file, sample) {
  return new Uint8Array(await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
}

/**
 * Decode a demuxed track's samples covering `[startSec, endSec)` into mono f32.
 *
 * Output starts at `startSec` (the preroll samples before it are decoded and
 * discarded so the decoder is warm) and is placed by each frame's own timestamp,
 * so an encoder's priming does not shift the result.
 */
async function decodeTrackRange(file, track, { startSec = 0, endSec = null, onProgress } = {}) {
  if (!webCodecsAvailable()) {
    throw new Error("this browser cannot decode the audio in this container");
  }
  const end = endSec == null ? track.durationSeconds : endSec;
  const source = track.samples && track.samples.length
    ? track.samples
    : (await demuxMkv(file, { stopAfterSec: end })).samples;
  const selection = selectSamples({ ...track, samples: source }, startSec, end);
  if (!selection.samples.length) throw new Error("no audio samples in that range");

  const config = {
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
  };
  if (track.description && track.description.length) config.description = track.description;
  let support = null;
  try {
    support = await AudioDecoder.isConfigSupported(config);
  } catch (e) {
    support = null;
  }
  if (!support || !support.supported) {
    throw new Error(`this browser cannot decode ${track.codec}`);
  }

  let rate = config.sampleRate || 48000;
  const expected = Math.max(1, Math.ceil((end - startSec) * rate));
  let out = new Float32Array(expected);
  let written = 0;
  let failed = null;
  let scratch = null;
  // The decoder's own channel count is authoritative; the container's may be a
  // placeholder. Weights are computed inside the callback because the stream's
  // layout is only known once it reports one.
  let weights = null;

  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        rate = data.sampleRate || rate;
        const frames = data.numberOfFrames;
        const channels = data.numberOfChannels;
        if (!scratch || scratch.length < frames) scratch = new Float32Array(frames);
        if (!weights || weights.length !== channels) weights = downmixWeights(channels);
        const startFrame = Math.round(((data.timestamp / 1e6) - startSec) * rate);
        // Grow once if the estimate was short (a rate change, or SBR output).
        if (startFrame + frames > out.length) {
          const grown = new Float32Array(startFrame + frames + rate);
          grown.set(out.subarray(0, Math.max(0, written)));
          out = grown;
        }
        for (let c = 0; c < channels; c++) {
          data.copyTo(scratch, { planeIndex: c, format: "f32-planar" });
          const weight = weights[c] || 0;
          for (let i = 0; i < frames; i++) {
            const to = startFrame + i;
            if (to < 0) continue;
            out[to] = (c === 0 ? 0 : out[to]) + scratch[i] * weight;
          }
        }
        written = Math.max(written, Math.min(out.length, startFrame + frames));
      } catch (e) {
        failed = failed || e;
      } finally {
        data.close();
      }
    },
    error: (e) => {
      failed = failed || e;
    },
  });
  decoder.configure(config);

  const total = selection.samples.length;
  for (let i = 0; i < total; i++) {
    if (failed) break;
    const sample = selection.samples[i];
    const bytes = await readSample(file, sample);
    decoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: Math.round(sample.time * 1e6),
        duration: 0,
        data: bytes,
      })
    );
    // Bound the decoder's queue so a long range does not buffer in the codec.
    while (decoder.decodeQueueSize > 32) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (onProgress && (i % 64 === 0 || i + 1 === total)) onProgress((i + 1) / total);
  }
  try {
    await decoder.flush();
  } finally {
    try {
      decoder.close();
    } catch (e) {
      /* already closed */
    }
  }
  if (failed) throw failed;
  if (!written) {
    // A configured but misdescribed stream can decode to nothing. Say so rather
    // than loading a silent source with a flat waveform.
    throw new Error("the audio decoder produced no sound for this file");
  }
  const trimmed = Math.max(1, Math.min(out.length, Math.round((end - startSec) * rate)));
  return { pcm: out.subarray(0, Math.max(trimmed, written)), sampleRate: rate, container: track.container };
}

/** `decodeAudioData` fallback: the whole file, then trimmed to the range. */
async function decodeWithBrowser(file, { startSec = 0, endSec = null, onProgress } = {}) {
  if (file.size > 2 * 1024 * 1024 * 1024) {
    throw new Error(
      "this file is over the 2 GB the browser's decoder accepts; save a WAV backup, which can be opened by range, or split it with another tool"
    );
  }
  const Mod = await import("./decode.js");
  const ctx = Mod.audioContext();
  onProgress && onProgress(0.05);
  const buffer = await file.arrayBuffer();
  const decoded = await ctx.decodeAudioData(buffer);
  const channels = decoded.numberOfChannels;
  const startFrame = Math.max(0, Math.min(decoded.length, Math.floor(startSec * decoded.sampleRate)));
  const endFrame = endSec == null
    ? decoded.length
    : Math.max(startFrame, Math.min(decoded.length, Math.ceil(endSec * decoded.sampleRate)));
  const frames = endFrame - startFrame;
  const out = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] += data[startFrame + i] / channels;
  }
  onProgress && onProgress(1);
  return { pcm: out, sampleRate: decoded.sampleRate, container: "decoded" };
}

/**
 * Read the audio in `[startSec, endSec)` as mono `f32`, by the cheapest path the
 * container allows. `onProgress` receives 0..1.
 */
export async function readAudioRange(file, options = {}) {
  const { startSec = 0, endSec = null, onProgress } = options;
  const kind = containerOf(file);
  if (kind === "wav") return readWavRange(file, options);
  if (kind === "mp4" || kind === "mkv") {
    let track = options.track || null;
    try {
      if (!track) track = kind === "mp4" ? await demuxMp4(file) : await demuxMkv(file, { stopAfterSec: endSec });
    } catch (e) {
      track = null;
    }
    if (track && webCodecsAvailable() && track.codec && track.samples && track.samples.length) {
      return decodeTrackRange(file, track, { startSec, endSec, onProgress });
    }
    // No usable sample table -- a fragmented layout, an odd sample entry, or a
    // codec this browser will not configure. The browser's own decoder can still
    // try; it needs the whole file, so it carries the 2 GB guard.
    return decodeWithBrowser(file, options);
  }
  return decodeWithBrowser(file, options);
}
