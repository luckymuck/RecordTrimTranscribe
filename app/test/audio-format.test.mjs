import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bytesPerSample,
  parseWavHeader,
  readWavRange,
  probeWav,
} from "../src/audio/wavread.js";
import { decimateTo, estimateLoadBytes, formatBytes } from "../src/audio/rate.js";

/** Build a WAV with `channels` interleaved samples per frame. */
function makeWav({ sampleRate = 48000, channels = 1, bits = 16, formatTag = 1, frames }) {
  const frameBytes = (bits / 8) * channels;
  const dataBytes = frames.length * channels * (bits / 8);
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, formatTag, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, bits, true);
  str(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const frame of frames) {
    for (const value of frame) {
      if (formatTag === 3) {
        view.setFloat32(offset, value, true);
        offset += 4;
      } else if (bits === 16) {
        view.setInt16(offset, Math.round(value * 32767), true);
        offset += 2;
      } else if (bits === 24) {
        const v = Math.round(value * 8388607) & 0xffffff;
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      } else {
        view.setInt32(offset, Math.round(value * 2147483647), true);
        offset += 4;
      }
    }
  }
  return new Uint8Array(buffer);
}

test("parseWavHeader reads the format and length", () => {
  const frames = Array.from({ length: 480 }, () => [0.5]);
  const bytes = makeWav({ sampleRate: 48000, channels: 1, bits: 16, frames });
  const header = parseWavHeader(bytes, bytes.length);
  assert.equal(header.sampleRate, 48000);
  assert.equal(header.channels, 1);
  assert.equal(header.frames, 480);
  assert.equal(header.durationSeconds, 0.01);
  assert.equal(header.dataOffset, 44);
});

test("parseWavHeader handles 24-bit, 32-bit float and stereo", () => {
  const frames = Array.from({ length: 100 }, () => [0.25, -0.25]);
  for (const [bits, formatTag] of [[24, 1], [32, 1], [32, 3]]) {
    const bytes = makeWav({ sampleRate: 44100, channels: 2, bits, formatTag, frames });
    const header = parseWavHeader(bytes, bytes.length);
    assert.equal(header.channels, 2, `${bits}/${formatTag}`);
    assert.equal(header.sampleRate, 44100);
    assert.equal(header.frames, 100);
    assert.equal(bytesPerSample(formatTag, bits), bits / 8);
  }
});

test("parseWavHeader rejects a streamed 0xFFFFFFFF length by using the file size", () => {
  const frames = Array.from({ length: 10 }, () => [0.1, 0.2]);
  const bytes = makeWav({ channels: 2, bits: 16, frames });
  new DataView(bytes.buffer).setUint32(40, 0xffffffff, true);
  const header = parseWavHeader(bytes, bytes.length);
  assert.equal(header.frames, 10);
});

test("parseWavHeader reports unsupported encodings clearly", () => {
  const frames = Array.from({ length: 4 }, () => [0.1]);
  // A-law in a 16-bit container: a real encoding this app does not decode.
  const bytes = makeWav({ bits: 16, frames });
  new DataView(bytes.buffer).setUint16(20, 6, true);
  assert.throws(() => parseWavHeader(bytes, bytes.length), /unsupported WAV encoding/);
  assert.throws(() => parseWavHeader(new Uint8Array(20), 20), /not a WAV/);
});

test("readWavRange decodes a range and mixes channels to mono", async () => {
  // 1 s of a ramp, stereo, so a frame's two channels differ.
  const frames = Array.from({ length: 48000 }, (_, i) => {
    const v = i / 48000;
    return [v, v];
  });
  const bytes = makeWav({ sampleRate: 48000, channels: 2, bits: 16, frames });
  const file = new Blob([bytes]);
  const header = await probeWav(file);
  assert.equal(header.frames, 48000);

  const { pcm, sampleRate } = await readWavRange(file, { startSec: 0.25, endSec: 0.5 });
  assert.equal(sampleRate, 48000);
  assert.equal(pcm.length, 12000);
  // First decoded frame is frame 12000 of the ramp.
  assert.ok(Math.abs(pcm[0] - 0.25) < 0.001, `got ${pcm[0]}`);
  assert.ok(Math.abs(pcm[pcm.length - 1] - 0.5) < 0.001, `got ${pcm[pcm.length - 1]}`);
});

test("readWavRange decodes float samples and whole files", async () => {
  const frames = Array.from({ length: 1000 }, (_, i) => [Math.sin((2 * Math.PI * i) / 100)]);
  const bytes = makeWav({ sampleRate: 16000, channels: 1, bits: 32, formatTag: 3, frames });
  const { pcm, sampleRate } = await readWavRange(new Blob([bytes]), {});
  assert.equal(sampleRate, 16000);
  assert.equal(pcm.length, 1000);
  assert.ok(Math.abs(pcm[25] - 1) < 0.01);
});

test("decimateTo halves length and keeps a tone", () => {
  const tone = new Float32Array(48000);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000);
  const out = decimateTo(tone, 48000, 24000);
  assert.equal(out.length, 24000);
  let sum = 0;
  for (let i = 100; i < out.length - 100; i++) sum += out[i] * out[i];
  const rms = Math.sqrt(sum / (out.length - 200));
  assert.ok(rms > 0.6, `a 1 kHz tone should survive, rms ${rms}`);
});

test("decimateTo attenuates content above the new Nyquist", () => {
  const high = new Float32Array(48000);
  for (let i = 0; i < high.length; i++) high[i] = Math.sin((2 * Math.PI * 10000 * i) / 48000);
  const out = decimateTo(high, 48000, 16000);
  let sum = 0;
  for (let i = 100; i < out.length - 100; i++) sum += out[i] * out[i];
  const rms = Math.sqrt(sum / (out.length - 200));
  assert.ok(rms < 0.2, `10 kHz should be filtered, rms ${rms}`);
});

test("decimateTo upsamples and passes identity through", () => {
  const pcm = Float32Array.from([0, 1, 0, -1]);
  assert.equal(decimateTo(pcm, 8000, 8000), pcm);
  assert.equal(decimateTo(pcm, 8000, 16000).length, 8);
  assert.equal(decimateTo(new Float32Array(0), 48000, 16000).length, 0);
});

test("estimateLoadBytes and formatBytes", () => {
  assert.equal(estimateLoadBytes(3600, 48000), 3600 * 48000 * 6);
  assert.equal(estimateLoadBytes(1, 48000, { compressedBytes: 100 }), 48000 * 6 + 100);
  assert.equal(estimateLoadBytes(0, 48000), 0);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.0 GB");
});
