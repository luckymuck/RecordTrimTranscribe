import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findLineIndex,
  followScrollTop,
  missingWordMarkers,
  speechRegions,
} from "../src/transcript/view.js";

test("findLineIndex returns the line containing a position", () => {
  const starts = [0, 10, 20, 30];
  assert.equal(findLineIndex(starts, -1), -1, "before the first line");
  assert.equal(findLineIndex(starts, 0), 0);
  assert.equal(findLineIndex(starts, 9.9), 0);
  assert.equal(findLineIndex(starts, 10), 1);
  assert.equal(findLineIndex(starts, 25), 2);
  assert.equal(findLineIndex(starts, 999), 3, "past the end stays on the last");
  assert.equal(findLineIndex([], 5), -1);
});

test("followScrollTop leaves the line four lines down", () => {
  assert.equal(followScrollTop(1000, 20, 4), 920);
  assert.equal(followScrollTop(50, 20, 4), 0, "never negative");
  assert.equal(followScrollTop(1000, 20), 920, "four is the default");
});

test("speechRegions is the complement of the silence zones", () => {
  // silence 1-2 and 3-4, over 5 seconds
  const regions = speechRegions([1, 2, 3, 4], 5);
  assert.deepEqual(regions, [
    [0, 1],
    [2, 3],
    [4, 5],
  ]);
});

test("speechRegions handles leading and trailing silence", () => {
  assert.deepEqual(speechRegions([0, 1], 3), [[1, 3]]);
  assert.deepEqual(speechRegions([2, 3], 3), [[0, 2]]);
  assert.deepEqual(speechRegions([], 2), [[0, 2]]);
});

test("missingWordMarkers flags speech with no words in it", () => {
  const regions = [
    [0, 1],
    [2, 3],
  ];
  const words = [[0.1, 0.9]]; // only the first region produced words
  assert.deepEqual(missingWordMarkers(regions, words), [2]);
});

test("missingWordMarkers ignores short regions and uncovered ranges", () => {
  // A 0.2 s blip is under the minimum, and the 3-4 region is outside the
  // transcribed range [0, 2.5).
  const regions = [
    [0.1, 0.3],
    [3, 4],
  ];
  assert.deepEqual(missingWordMarkers(regions, [], 0, 2.5), []);
});

test("missingWordMarkers clamps to the transcribed range", () => {
  // The only word is outside the speech region, so the region is uncovered.
  const marks = missingWordMarkers([[2, 5]], [[0.5, 1]], 2, 6);
  assert.deepEqual(marks, [2]);
});
