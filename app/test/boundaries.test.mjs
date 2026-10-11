import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClips, isValidSplit, normalizeSplits, splitLabels } from "../src/export/boundaries.js";

test("isValidSplit requires a position strictly inside the recording", () => {
  assert.equal(isValidSplit(5, 100), true);
  assert.equal(isValidSplit(0, 100), false);
  assert.equal(isValidSplit(100, 100), false);
  assert.equal(isValidSplit(101, 100), false);
  assert.equal(isValidSplit(-1, 100), false);
  assert.equal(isValidSplit(NaN, 100), false);
  assert.equal(isValidSplit(Infinity, 100), false);
});

test("normalizeSplits drops invalid entries and duplicates, and sorts", () => {
  assert.deepEqual(normalizeSplits([50, 0, 100, 50, -3, 20, NaN, 50.4], 100), [20, 50]);
});

test("buildClips covers the whole recording", () => {
  assert.deepEqual(buildClips([], 100), [{ start: 0, end: 100 }]);
  assert.deepEqual(buildClips([50], 100), [
    { start: 0, end: 50 },
    { start: 50, end: 100 },
  ]);
  const clips = buildClips([70, 20], 100);
  assert.deepEqual(clips, [
    { start: 0, end: 20 },
    { start: 20, end: 70 },
    { start: 70, end: 100 },
  ]);
});

test("buildClips ignores splits at the edges and duplicates", () => {
  assert.deepEqual(buildClips([0, 100, 50, 50], 100), [
    { start: 0, end: 50 },
    { start: 50, end: 100 },
  ]);
});

test("splitLabels number only valid splits, matching the clip list", () => {
  const splits = [0, 50, 50, 100, 20];
  const labels = splitLabels(splits, 100);
  const clips = buildClips(splits, 100);
  assert.equal(labels.length, clips.length - 1, "one label per internal boundary");
  assert.deepEqual(
    labels.map((l) => l.label),
    ["01", "02"]
  );
  assert.deepEqual(
    labels.map((l) => l.sample),
    [20, 50]
  );
});

test("splitLabels is empty without valid splits", () => {
  assert.deepEqual(splitLabels([0, 100], 100), []);
  assert.deepEqual(splitLabels(null, 100), []);
});
