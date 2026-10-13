import { test } from "node:test";
import assert from "node:assert/strict";
import { restorePcmSnapshot, snapshotPcm } from "../src/audio/undo.js";

test("PCM undo snapshots round-trip exact samples in chunks", async () => {
  const pcm = new Float32Array([0, 0.5, -0.25, 0.125, 1, -1, 0.3, 0.7]);
  let reported = [];
  const blob = await snapshotPcm(pcm, {
    chunkSamples: 3,
    onProgress: (f) => reported.push(f),
  });
  assert.ok(blob instanceof Blob);
  assert.deepEqual(reported, [3 / 8, 6 / 8, 1]);
  assert.deepEqual(await restorePcmSnapshot(blob, pcm.length), pcm);
});

test("PCM undo snapshots handle empty audio and reject bad snapshots", async () => {
  const empty = await snapshotPcm(new Float32Array(0));
  assert.deepEqual(await restorePcmSnapshot(empty, 0), new Float32Array(0));
  const blob = await snapshotPcm(new Float32Array([0.25, -0.5]));
  await assert.rejects(() => restorePcmSnapshot(blob, 3), /expected 12/);
  await assert.rejects(() => restorePcmSnapshot({}, 2), /must be a Blob/);
  await assert.rejects(() => snapshotPcm([0.25]), /Float32 PCM/);
});
