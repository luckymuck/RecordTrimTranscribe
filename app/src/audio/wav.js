// 16-bit PCM WAV encoding.
//
// Kept free of DOM imports so it can be unit-tested under Node. Two fixes over
// the original: samples are written straight into the output buffer through a
// view instead of via a second Int16Array copy, and quantization uses TPDF
// dither behind a soft knee instead of hard clipping.

/** Above this, samples are shaped rather than clipped. */
export const SOFT_KNEE = 0.95;
const LSB = 1 / 32768;
/** Largest value a 16-bit sample can represent; the limiter asymptotes here. */
const CEIL = 1 - LSB;

/** Soft limiter: identity below the knee, tanh-shaped above it, always below full scale. */
export function softClipSample(s) {
  if (!Number.isFinite(s)) return 0;
  const a = Math.abs(s);
  if (a <= SOFT_KNEE) return s;
  const over = (a - SOFT_KNEE) / (1 - SOFT_KNEE);
  const shaped = Math.min(SOFT_KNEE + (CEIL - SOFT_KNEE) * Math.tanh(over), CEIL);
  return Math.sign(s) * shaped;
}

/** One float sample to a 16-bit integer, with optional TPDF dither. */
export function quantize(s, dither = true, rng = Math.random) {
  const shaped = softClipSample(s);
  const noise = dither ? (rng() - rng()) * LSB : 0;
  const v = Math.round((shaped + noise) * 32768);
  return Math.max(-32768, Math.min(32767, v));
}

/** Mono float PCM to a 16-bit WAV ArrayBuffer (header + samples, one buffer). */
export function encodeWavBuffer(pcm, sampleRate, { dither = true, rng = Math.random, transcript = "" } = {}) {
  const n = pcm.length;
  const info = transcript ? infoChunk(transcript) : null;
  const infoBytes = info ? info.length : 0;
  const buffer = new ArrayBuffer(44 + n * 2 + infoBytes);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 2 + infoBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, n * 2, true);
  const samples = new Int16Array(buffer, 44, n);
  for (let i = 0; i < n; i++) samples[i] = quantize(pcm[i], dither, rng);
  if (info) new Uint8Array(buffer, 44 + n * 2).set(info);
  return buffer;
}

/**
 * A `LIST`/`INFO` chunk holding `transcript` as its comment field.
 *
 * The chunk sits after `data`, which the WAV format allows, and every player
 * and decoder ignores LIST/INFO, so the file stays an ordinary WAV that also
 * carries its transcript. It is how a backup reloads without re-transcribing.
 */
function infoChunk(transcript) {
  const payload = new TextEncoder().encode(String(transcript));
  // "INFO" + the comment sub-chunk (8-byte header + text + a NUL terminator).
  const body = 4 + 8 + payload.length + 1;
  const pad = body % 2;
  const out = new Uint8Array(8 + body + pad);
  const view = new DataView(out.buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  writeStr(0, "LIST");
  view.setUint32(4, body, true);
  writeStr(8, "INFO");
  writeStr(12, "ICMT");
  view.setUint32(16, payload.length + 1, true);
  out.set(payload, 20);
  out[20 + payload.length] = 0;
  return out;
}

/** Four-character chunk id at `offset`. */
function chunkId(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Walk the RIFF chunks of `bytes`, calling `visit(id, bodyOffset, size, offset)`.
 * Stops at the first chunk that runs past the end, so a truncated file is not
 * read out of bounds.
 */
function walkChunks(bytes, view, visit) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = chunkId(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) return;
    visit(id, body, size, offset);
    offset = body + size + (size % 2);
  }
}

/**
 * The transcript a backup carries, or "" when there is none.
 *
 * Chunks are walked by their declared sizes, so a WAV with other chunks (or
 * none) is read correctly, and a comment written by another tool is returned as
 * it is -- the caller decides whether it parses as a transcript.
 */
export function readWavTranscript(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 12) return "";
  if (chunkId(bytes, 0) !== "RIFF" || chunkId(bytes, 8) !== "WAVE") return "";
  const view = new DataView(arrayBuffer);
  let found = "";
  walkChunks(bytes, view, (id, body, size) => {
    if (found || id !== "LIST") return;
    if (size < 4 || chunkId(bytes, body) !== "INFO") return;
    let sub = body + 4;
    const end = body + size;
    while (sub + 8 <= end) {
      const subId = chunkId(bytes, sub);
      const subSize = view.getUint32(sub + 4, true);
      if (subId === "ICMT") {
        const slice = bytes.subarray(sub + 8, Math.min(sub + 8 + subSize, bytes.length));
        found = new TextDecoder().decode(slice).replace(/\0+$/, "");
        return;
      }
      sub += 8 + subSize + (subSize % 2);
    }
  });
  return found;
}

/**
 * The same WAV with the trailing LIST chunk removed.
 *
 * A backup is decoded from this rather than from the file itself, so the
 * browser's decoder never sees a chunk this app added: the transcript cannot
 * change how the audio loads.
 */
export function withoutTranscript(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 12 || chunkId(bytes, 0) !== "RIFF" || chunkId(bytes, 8) !== "WAVE") {
    return arrayBuffer;
  }
  const view = new DataView(arrayBuffer);
  let keep = 12;
  walkChunks(bytes, view, (id, body, size) => {
    if (id !== "LIST") keep = Math.min(bytes.length, body + size + (size % 2));
  });
  if (keep >= bytes.length || keep < 12) return arrayBuffer;
  const out = new ArrayBuffer(keep);
  new Uint8Array(out).set(bytes.subarray(0, keep));
  new DataView(out).setUint32(4, keep - 8, true);
  return out;
}

/**
 * The transcript from the LIST/INFO chunk near the end of a WAV, without reading
 * the whole file.
 *
 * `readWavTranscript` needs the buffer from the first chunk, which for a long
 * recording means holding gigabytes. Backups append the chunk last, so a tail
 * read is enough -- and that matters most on exactly the files this exists for.
 * Only a payload that looks like this app's JSON is returned.
 */
export function readWavTranscriptTail(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = Math.max(0, bytes.length - 1024 * 1024); i + 8 <= bytes.length; i++) {
    if (
      bytes[i] !== 0x49 || // I
      bytes[i + 1] !== 0x43 || // C
      bytes[i + 2] !== 0x4d || // M
      bytes[i + 3] !== 0x54 // T
    ) {
      continue;
    }
    const size = view.getUint32(i + 4, true);
    if (size <= 0 || i + 8 + size > bytes.length) continue;
    const text = new TextDecoder().decode(bytes.subarray(i + 8, i + 8 + size));
    const cleaned = text.replace(/\0+$/, "");
    if (cleaned.trim().startsWith("{")) return cleaned;
  }
  return "";
}

/** Mono float PCM to a 16-bit WAV Blob. */
export function encodeWavBlob(pcm, sampleRate, opts) {
  return new Blob([encodeWavBuffer(pcm, sampleRate, opts)], { type: "audio/wav" });
}

/**
 * Mono `Int16` PCM to a WAV, writing the samples through unchanged.
 *
 * The pristine source is already 16-bit, so this is lossless with respect to it,
 * and it avoids materialising a full-length `f32` copy just to re-quantize:
 * at 48 kHz an hour of audio would otherwise cost a 691 MB copy and a second
 * copy of the WAV bytes.
 */
export function encodeWavInt16Buffer(samples, sampleRate, { transcript = "" } = {}) {
  const n = samples.length;
  const info = transcript ? infoChunk(transcript) : null;
  const infoBytes = info ? info.length : 0;
  const buffer = new ArrayBuffer(44 + n * 2 + infoBytes);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * 2 + infoBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, n * 2, true);
  new Int16Array(buffer, 44, n).set(samples);
  if (info) new Uint8Array(buffer, 44 + n * 2).set(info);
  return buffer;
}
