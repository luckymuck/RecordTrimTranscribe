import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGain, NORM_PEAK, normalizeGain, peakOf, rmsOf } from "../src/audio/normalize.js";

const sine = (amp, n = 48000, f = 200, sr = 48000) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / sr);
  return out;
};

test("peakOf and rmsOf", () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 0.25]);
  assert.equal(peakOf(pcm), 0.5);
  assert.ok(Math.abs(rmsOf(pcm) - Math.sqrt((0.25 + 0.25 + 0.0625) / 4)) < 1e-9);
  assert.equal(peakOf(new Float32Array(0)), 0);
  assert.equal(rmsOf(new Float32Array(0)), 0);
});

test("peak mode scales the loudest sample to the target", () => {
  const pcm = new Float32Array([0, 0.5, -0.25]);
  const gain = normalizeGain(pcm, "peak");
  assert.equal(gain, NORM_PEAK / 0.5);
  assert.ok(Math.abs(peakOf(applyGain(pcm, gain)) - NORM_PEAK) < 1e-6);
});

test("peak mode is not fooled by one spike the way peak-based gain always is", () => {
  // The spike sets the gain, so the body of the signal ends up quiet -- this is
  // the documented limitation of peak mode, pinned here so it stays a choice.
  const pcm = sine(0.1);
  pcm[0] = 0.75; // exactly representable in float32
  const gain = normalizeGain(pcm, "peak");
  assert.equal(gain, NORM_PEAK / 0.75);
});

test("rms mode hits the loudness target", () => {
  const pcm = sine(0.1);
  const gain = normalizeGain(pcm, "rms");
  const out = applyGain(pcm, gain);
  assert.ok(Math.abs(20 * Math.log10(rmsOf(out)) + 20) < 0.1, `rms ${rmsOf(out)}`);
});

test("rms mode backs off when the ceiling would bind", () => {
  const pcm = sine(0.01); // tiny RMS, and a spike to make the crest factor huge
  pcm[0] = 0.8;
  const gain = normalizeGain(pcm, "rms");
  assert.ok(peakOf(applyGain(pcm, gain)) <= NORM_PEAK + 1e-6, "ceiling must hold");
});

test("silence has no gain", () => {
  assert.equal(normalizeGain(new Float32Array(64), "peak"), null);
  assert.equal(normalizeGain(new Float32Array(64), "rms"), null);
  assert.equal(normalizeGain(new Float32Array(0), "peak"), null);
});

test("applying the inverse gain restores the original", () => {
  const pcm = sine(0.3, 1024);
  const gain = normalizeGain(pcm, "peak");
  const round = applyGain(applyGain(pcm, gain), 1 / gain);
  for (let i = 0; i < pcm.length; i++) {
    assert.ok(Math.abs(round[i] - pcm[i]) < 1e-6, `sample ${i}`);
  }
});
