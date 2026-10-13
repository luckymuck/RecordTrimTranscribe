import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyGain,
  NORM_PEAK,
  normalizeGain,
  peakOf,
  rmsOf,
  speechRms,
} from "../src/audio/normalize.js";

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

test("speechRms ignores pauses and transients", () => {
  const sr = 48000;
  const speech = sine(0.1, sr, 200, sr); // 1 s of speech
  const withPause = new Float32Array(sr * 3);
  withPause.set(speech, 0);
  // 2 s of room tone: whole-file RMS would read far quieter than the speech.
  for (let i = sr; i < sr * 3; i++) withPause[i] = 0.0005;

  const whole = rmsOf(withPause);
  const active = speechRms(withPause, sr);
  assert.ok(active > whole * 1.5, `speech-active ${active} against whole-file ${whole}`);
  assert.ok(
    Math.abs(active - rmsOf(speech)) < rmsOf(speech) * 0.1,
    `speech-active ${active} against the speech alone ${rmsOf(speech)}`
  );

  const spiked = Float32Array.from(speech);
  // A 20 ms thump: long enough to own a frame, so the gate can see it.
  for (let i = 0; i < sr / 50; i++) {
    spiked[i] = 0.9 * Math.sin((2 * Math.PI * 300 * i) / sr);
  }
  assert.ok(
    speechRms(spiked, sr) < rmsOf(spiked),
    "a transient should not set the speech level"
  );
});

test("rms mode is raise-only", () => {
  // Already louder than the -20 dBFS target: normalizing must not turn it down.
  const loud = sine(0.5);
  assert.equal(normalizeGain(loud, "rms"), 1);
  // Quieter than the target: raised to it.
  const quiet = sine(0.01);
  const gain = normalizeGain(quiet, "rms");
  assert.ok(gain > 1, `expected a raise, got ${gain}`);
  const out = applyGain(quiet, gain);
  assert.ok(Math.abs(20 * Math.log10(rmsOf(out)) + 20) < 0.5, `rms ${rmsOf(out)}`);
});

test("rms mode can leave a raised peak to the limiter", () => {
  // A quiet body with a spike: raise-only ignores the spike, so the peak can
  // land above the ceiling and the limiter is what catches it.
  const pcm = sine(0.01);
  pcm[0] = 0.8;
  const gain = normalizeGain(pcm, "rms");
  assert.ok(gain > 1, "a quiet body should still be raised");
  assert.ok(peakOf(applyGain(pcm, gain)) > NORM_PEAK, "the spike is left for the limiter");
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
