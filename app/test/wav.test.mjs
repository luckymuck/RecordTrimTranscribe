import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWavBuffer, quantize, SOFT_KNEE, softClipSample } from "../src/audio/wav.js";

const str = (view, off, len) => {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
};

test("WAV header describes mono 16-bit PCM", () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1]);
  const buffer = encodeWavBuffer(pcm, 44100, { dither: false });
  const view = new DataView(buffer);
  assert.equal(str(view, 0, 4), "RIFF");
  assert.equal(str(view, 8, 4), "WAVE");
  assert.equal(str(view, 12, 4), "fmt ");
  assert.equal(str(view, 36, 4), "data");
  assert.equal(view.getUint32(4, true), 36 + pcm.length * 2);
  assert.equal(view.getUint16(20, true), 1, "PCM format");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint32(28, true), 44100 * 2, "byte rate");
  assert.equal(view.getUint16(32, true), 2, "block align");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
  assert.equal(view.getUint32(40, true), pcm.length * 2);
  assert.equal(buffer.byteLength, 44 + pcm.length * 2);
});

test("WAV samples round-trip", () => {
  const buffer = encodeWavBuffer(new Float32Array([0, 0.5, -0.5]), 8000, { dither: false });
  const samples = new Int16Array(buffer, 44, 3);
  assert.equal(samples[0], 0);
  assert.equal(samples[1], Math.round(0.5 * 32768));
  assert.equal(samples[2], -Math.round(0.5 * 32768));
});

test("silence encodes to zeros", () => {
  const buffer = encodeWavBuffer(new Float32Array(16), 8000, { dither: false });
  const samples = new Int16Array(buffer, 44, 16);
  assert.ok(samples.every((s) => s === 0));
});

test("softClipSample is identity below the knee and never reaches 1", () => {
  assert.equal(softClipSample(0.5), 0.5);
  assert.equal(softClipSample(-0.5), -0.5);
  assert.equal(softClipSample(SOFT_KNEE), SOFT_KNEE);
  const loud = softClipSample(2);
  assert.ok(loud > SOFT_KNEE && loud < 1, `got ${loud}`);
  assert.ok(Math.abs(softClipSample(-2)) < 1);
  assert.equal(softClipSample(NaN), 0);
});

test("soft clipping is monotone", () => {
  let prev = -Infinity;
  for (let s = -3; s <= 3; s += 0.05) {
    const v = softClipSample(s);
    assert.ok(v >= prev, `not monotone at ${s}`);
    prev = v;
  }
});

test("quantize never hard-clips full-scale input", () => {
  const v = quantize(1, false);
  assert.ok(v < 32767 && v > 32000, `got ${v}`);
  assert.equal(quantize(-1, false), -v, "symmetrical");
  assert.equal(quantize(0, false), 0);
});

test("dither stays within one LSB of the undithered value", () => {
  let i = 0;
  const rng = () => (i++ % 2 === 0 ? 0 : 1); // (0 - 1) => -1 LSB
  const plain = quantize(0.5, false);
  for (let k = 0; k < 8; k++) {
    assert.ok(Math.abs(quantize(0.5, true, rng) - plain) <= 1);
  }
});

test("a zero rng leaves the sample unchanged", () => {
  assert.equal(quantize(0.25, true, () => 0.5), quantize(0.25, false));
});
