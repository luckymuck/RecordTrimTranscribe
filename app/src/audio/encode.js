// Audio encoders: 16-bit WAV (native) and MP3 (lamejs).
import { resample } from "./decode.js";

function floatToInt16(pcm) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Encode mono Float32 PCM to a 16-bit PCM WAV Blob. */
export function encodeWav(pcm, sampleRate) {
  const samples = floatToInt16(pcm);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
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
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    view.setInt16(off, samples[i], true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Encode mono Float32 PCM to an MP3 Blob using lamejs (loaded as a global). */
export function encodeMp3(pcm, sampleRate, kbps = 128) {
  const lame = window.lamejs;
  if (!lame) throw new Error("lamejs not loaded");
  // lamejs only supports MPEG rates up to 48 kHz, so a 96/88.2 kHz context
  // would fail outright. Resample down first.
  const rate = sampleRate > 48000 ? 48000 : sampleRate;
  const source = rate === sampleRate ? pcm : resample(pcm, sampleRate, rate);
  const samples = floatToInt16(source);
  const encoder = new lame.Mp3Encoder(1, rate, kbps);
  const blockSize = 1152;
  const data = [];
  for (let i = 0; i < samples.length; i += blockSize) {
    const chunk = samples.subarray(i, i + blockSize);
    const buf = encoder.encodeBuffer(chunk);
    if (buf.length > 0) data.push(new Uint8Array(buf));
  }
  const end = encoder.flush();
  if (end.length > 0) data.push(new Uint8Array(end));
  return new Blob(data, { type: "audio/mpeg" });
}

export function encode(pcm, sampleRate, format) {
  return format === "mp3" ? encodeMp3(pcm, sampleRate) : encodeWav(pcm, sampleRate);
}
