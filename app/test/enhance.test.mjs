import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDsp } from "../src/core/dsp.js";
import { NORM_PEAK } from "../src/audio/normalize.js";
import {
  cleanUp,
  cleanupActive,
  cleanupOptions,
  cleanupSummary,
  isGainOnlyCleanup,
  LIMIT_CEILING_DB,
} from "../src/audio/enhance.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, "..", "vendor", "fasttalk-core", "fasttalk_core_bg.wasm");

// The WASM core loads from bytes here because Node cannot fetch a file:// URL.
before(async () => {
  await initDsp({ module_or_path: fs.readFileSync(wasmPath) });
});

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

function noise(n, amp) {
  const out = new Float32Array(n);
  let seed = 0x2545f491;
  for (let i = 0; i < n; i++) {
    // Math.imul keeps the LCG in 32-bit arithmetic. Plain float multiplication
    // lost the low bits, so the sequence collapsed to two alternating values and
    // the "noise" tests were measuring a square wave.
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out[i] = ((seed >>> 8) / 8388608 - 1) * amp;
  }
  return out;
}

function tone(f, seconds, sr, amp) {
  const n = (seconds * sr) | 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / sr);
  return out;
}

test("cleanupOptions clamps the consonant strength", () => {
  assert.equal(cleanupOptions({ consonantDb: 99 }).consonantDb, 6);
  assert.equal(cleanupOptions({ consonantDb: -5 }).consonantDb, 0);
  assert.equal(cleanupOptions({ consonantDb: NaN }).consonantDb, 0);
  assert.equal(cleanupOptions().consonantDb, 3);
  assert.equal(cleanupOptions().rumble, true, "rumble defaults on");
  assert.equal(cleanupOptions().denoise, true, "denoise defaults on");
});

test("cleanupActive reflects the selected stages", () => {
  const none = { rumble: false, denoise: false, consonant: false, normalize: false, loudness: false };
  assert.equal(cleanupActive(none), false);
  assert.equal(cleanupActive({ ...none, loudness: true }), true);
  assert.equal(cleanupActive({ ...none, normalize: true }), true);
  assert.equal(cleanupActive({ ...none, consonant: true, consonantDb: 0 }), true);
});

test("cleanUp normalizes as part of the chain", async () => {
  const x = tone(300, 0.5, 48000, 0.2);
  const { pcm, steps } = await cleanUp(x, 48000, {
    rumble: false,
    denoise: false,
    consonant: false,
    normalize: true,
    normalizeMode: "peak",
    loudness: false,
  });
  assert.ok(steps.includes("normalized"), `steps: ${steps}`);
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak - NORM_PEAK) < 1e-3, `peak ${peak}, expected ${NORM_PEAK}`);
});

test("cleanUp reports a gain only when normalize is the sole stage", async () => {
  const x = tone(300, 0.5, 48000, 0.2);
  const only = {
    rumble: false,
    denoise: false,
    consonant: false,
    normalize: true,
    normalizeMode: "peak",
    loudness: false,
  };
  const a = await cleanUp(x, 48000, only);
  assert.ok(a.gain !== null && a.gain > 1, `expected a gain, got ${a.gain}`);
  const b = await cleanUp(x, 48000, { ...only, rumble: true });
  assert.equal(b.gain, null, "a mixed chain cannot be undone by a single gain");
});

test("cleanUp returns the input untouched when nothing is selected", async () => {
  const x = tone(300, 0.2, 48000, 0.3);
  const none = { rumble: false, denoise: false, consonant: false, loudness: false };
  const { pcm, steps } = await cleanUp(x, 48000, none);
  assert.equal(pcm, x, "the same array should come back");
  assert.deepEqual(steps, []);
});

test("cleanUp runs every stage in order and honours the limiter ceiling", async () => {
  const x = noise(48000, 0.05);
  const { pcm, steps } = await cleanUp(x, 48000, {
    rumble: true,
    denoise: true,
    consonant: true,
    consonantDb: 4,
    loudness: true,
  });
  assert.equal(pcm.length, x.length);
  assert.ok(pcm.every(Number.isFinite));
  assert.deepEqual(steps, [
    "rumble filtered",
    "denoised",
    "consonants +4 dB",
    `limited to ${LIMIT_CEILING_DB} dBFS`,
  ]);
  const ceiling = 10 ** (LIMIT_CEILING_DB / 20);
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak <= ceiling + 1e-6, `peak ${peak} exceeds ${ceiling}`);
});

test("cleanUp attenuates noise-only input", async () => {
  const x = noise(48000, 0.05);
  const { pcm } = await cleanUp(x, 48000, {
    rumble: false,
    denoise: true,
    consonant: false,
    loudness: false,
  });
  assert.ok(rms(pcm) < rms(x) * 0.5, `noise not attenuated: ${rms(x)} -> ${rms(pcm)}`);
});

test("cleanUp leaves digital silence silent", async () => {
  const x = new Float32Array(4800);
  const { pcm } = await cleanUp(x, 48000, {
    rumble: false,
    denoise: true,
    consonant: false,
    loudness: false,
  });
  assert.ok(pcm.every((v) => v === 0), "silence should pass through untouched");
});

test("isGainOnlyCleanup matches the single-multiplier undo rule", () => {
  const only = {
    rumble: false,
    denoise: false,
    consonant: false,
    normalize: true,
    normalizeMode: "peak",
    loudness: false,
  };
  assert.equal(isGainOnlyCleanup(only), true);
  assert.equal(isGainOnlyCleanup({ ...only, rumble: true }), false);
  // A selected consonant stage means the chain is not one multiplier, even at 0 dB.
  assert.equal(isGainOnlyCleanup({ ...only, consonant: true, consonantDb: 0 }), false);
});

test("cleanUp never mutates the caller's buffer", async () => {
  // The caller's buffer is the pristine source every render starts from.
  const x = tone(300, 0.3, 48000, 0.2);
  const copy = Float32Array.from(x);
  await cleanUp(x, 48000, {
    rumble: true,
    denoise: false,
    level: true,
    consonant: true,
    consonantDb: 3,
    loudness: false,
  });
  assert.deepEqual(x, copy, "the source buffer was modified in place");
});

test("cleanUp auto-engages the limiter when a stage raises the level", async () => {
  const x = tone(300, 0.5, 48000, 0.2);
  const { pcm, steps } = await cleanUp(x, 48000, {
    rumble: false,
    denoise: false,
    level: true,
    consonant: false,
    loudness: false,
  });
  assert.ok(
    steps.some((s) => s.includes("limited")),
    `the limiter should run after a gain stage, steps: ${steps}`
  );
  const ceiling = 10 ** (LIMIT_CEILING_DB / 20);
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak <= ceiling + 1e-6, `peak ${peak} exceeds ${ceiling}`);
});

test("cleanUp does not limit a chain that only attenuates", async () => {
  const x = tone(300, 0.5, 48000, 0.2);
  const { steps } = await cleanUp(x, 48000, {
    rumble: true,
    denoise: false,
    level: false,
    consonant: false,
    loudness: false,
  });
  assert.ok(!steps.some((s) => s.includes("limited")), `steps: ${steps}`);
});

test("cleanupSummary describes the run", () => {
  assert.equal(cleanupSummary([]), "Nothing selected to clean up");
  assert.match(cleanupSummary(["denoised"]), /denoised/);
});
