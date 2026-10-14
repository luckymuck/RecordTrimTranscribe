// Audio encoders: 16-bit WAV (native) and MP3 (lamejs).
import { resample } from "./decode.js";
import { encodeWavBlob, quantize } from "./wav.js";

function floatToInt16(pcm, dither = false, rng = Math.random) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = quantize(pcm[i], dither, rng);
  return out;
}

/**
 * Encode mono Float32 PCM to a 16-bit PCM WAV Blob.
 *
 * Dither and a soft knee are applied by `wav.js`; MP3 quantization below uses
 * the same conversion without dither, because the lossy codec that follows
 * dominates any quantization noise. `opts.transcript` embeds a transcript in a
 * LIST/INFO chunk, which is how a backup carries it.
 */
export function encodeWav(pcm, sampleRate, opts) {
  return encodeWavBlob(pcm, sampleRate, opts);
}

/**
 * Yield MP3 frames as they are produced.
 *
 * lamejs only supports MPEG rates up to 48 kHz, so a 96/88.2 kHz context would
 * fail outright; resample down first.
 */
function* mp3Blocks(pcm, sampleRate, kbps) {
  const lame = window.lamejs;
  if (!lame) throw new Error("lamejs not loaded");
  const rate = sampleRate > 48000 ? 48000 : sampleRate;
  const source = rate === sampleRate ? pcm : resample(pcm, sampleRate, rate);
  const samples = floatToInt16(source);
  const encoder = new lame.Mp3Encoder(1, rate, kbps);
  const blockSize = 1152;
  const total = Math.max(1, Math.ceil(samples.length / blockSize));
  let done = 0;
  for (let i = 0; i < samples.length; i += blockSize) {
    const buf = encoder.encodeBuffer(samples.subarray(i, i + blockSize));
    done++;
    if (buf.length > 0) yield { chunk: new Uint8Array(buf), done, total };
  }
  const end = encoder.flush();
  if (end.length > 0) yield { chunk: new Uint8Array(end), done: total, total };
}

/** Encode mono Float32 PCM to an MP3 Blob using lamejs (loaded as a global). */
export function encodeMp3(pcm, sampleRate, kbps = 128) {
  const data = [];
  for (const { chunk } of mp3Blocks(pcm, sampleRate, kbps)) data.push(chunk);
  return new Blob(data, { type: "audio/mpeg" });
}

/**
 * MP3 encoding that yields to the event loop every few hundred frames, so a
 * long file does not freeze the page for minutes. `onProgress` receives 0..1.
 */
export async function encodeMp3Async(pcm, sampleRate, kbps = 128, onProgress) {
  const data = [];
  let reported = 0;
  for (const { chunk, done, total } of mp3Blocks(pcm, sampleRate, kbps)) {
    data.push(chunk);
    if (done === total || done - reported >= 400) {
      reported = done;
      if (onProgress) onProgress(done / total);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return new Blob(data, { type: "audio/mpeg" });
}

export function encode(pcm, sampleRate, format) {
  return format === "mp3" ? encodeMp3(pcm, sampleRate) : encodeWav(pcm, sampleRate);
}

/** Async encode: yields during MP3 encoding, WAV is fast enough to stay sync. */
export async function encodeAsync(pcm, sampleRate, format, onProgress) {
  if (format !== "mp3") return encodeWav(pcm, sampleRate);
  return encodeMp3Async(pcm, sampleRate, 128, onProgress);
}
