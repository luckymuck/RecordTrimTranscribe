import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collapseCharRuns,
  collapseRepeats,
  looksRepetitive,
  normalizeToken,
  repetitionStats,
} from "../src/transcript/clean.js";

/** Word chunks with 0.2 s per word, so timings can be checked. */
function words(list) {
  return list.map((text, i) => ({ text, timestamp: [i * 0.2, (i + 1) * 0.2] }));
}
function result(list) {
  const chunks = words(list);
  return { text: chunks.map((c) => c.text).join(""), chunks, timestamped: true };
}

test("collapseCharRuns shortens character runs but keeps emphasis", () => {
  assert.deepEqual(collapseCharRuns("ああああああ"), { text: "あ", changed: true });
  assert.deepEqual(collapseCharRuns("!!!!!"), { text: "!", changed: true });
  assert.deepEqual(collapseCharRuns("no!!"), { text: "no!!", changed: false });
  assert.deepEqual(collapseCharRuns(""), { text: "", changed: false });
});

test("normalizeToken ignores case, spacing and punctuation", () => {
  assert.equal(normalizeToken(" The,"), "the");
  assert.equal(normalizeToken("Don't"), "dont");
  assert.equal(normalizeToken("..."), "");
});

test("collapseRepeats keeps the first copy and marks the cut", () => {
  const input = result(["Thank", " you.", "Thank", " you.", "Thank", " you.", "Thank", " you."]);
  const { result: out, removed } = collapseRepeats(input);
  assert.equal(out.chunks.length, 3, JSON.stringify(out.chunks));
  assert.equal(out.chunks[0].text, "Thank");
  assert.equal(out.chunks[1].text, " you.");
  assert.equal(out.chunks[2].text, " **");
  assert.equal(out.chunks[2].missing, true);
  assert.equal(removed.length, 1);
  // The marker covers the dropped span.
  assert.equal(removed[0].start, 0.4);
  assert.equal(removed[0].end, 1.6);
  assert.ok(out.text.includes("**"));
});

test("collapseRepeats leaves a short repetition alone", () => {
  const input = result(["no,", " no,", " no!"]);
  assert.equal(collapseRepeats(input).removed.length, 0);
});

test("collapseRepeats collapses a single word loop and keeps its timing", () => {
  const input = result(["you", " you", " you", " you", " you", " you"]);
  const { result: out } = collapseRepeats(input);
  assert.equal(out.chunks.filter((c) => c.text.trim() === "you").length, 1);
  assert.equal(out.chunks[1].text, " **");
  assert.equal(out.chunks[1].timestamp[0], 0.2);
});

test("collapseRepeats marks a character loop inside one token", () => {
  const input = result(["ああああああああ"]);
  const { result: out } = collapseRepeats(input);
  assert.equal(out.chunks[0].text, "あ **");
});

test("collapseRepeats is a no-op without chunks", () => {
  const plain = { text: "hi", chunks: null, timestamped: false };
  const { result: out, removed } = collapseRepeats(plain);
  assert.equal(out, plain);
  assert.deepEqual(removed, []);
});

test("repetitionStats measures a loop and a normal passage", () => {
  const loop = result(["I don't", " know.", "I don't", " know.", "I don't", " know.", "I don't", " know."]);
  const loopStats = repetitionStats(loop, 1.6);
  assert.ok(loopStats.droppedFraction >= 0.5, JSON.stringify(loopStats));

  const normal = result(["we", " need", " to", " go", " now"]);
  const normalStats = repetitionStats(normal, 1);
  assert.equal(normalStats.dropped, 0);
  assert.ok(normalStats.charsPerSecond < 40);
});

test("looksRepetitive flags a loop and not ordinary speech", () => {
  const loop = result(["thank", " you.", "thank", " you.", "thank", " you.", "thank", " you.", "thank", " you."]);
  assert.equal(looksRepetitive(loop, 2), true);
  const normal = result(["a", " short", " sentence", " about", " something", " else", " entirely"]);
  assert.equal(looksRepetitive(normal, 2), false);
  // Too little text to judge, even if it repeats.
  assert.equal(looksRepetitive(result(["no", " no", " no"]), 2), false);
});

test("looksRepetitive flags text far faster than the audio", () => {
  const fast = result(Array.from({ length: 40 }, (_, i) => `word${i % 7}`));
  assert.equal(looksRepetitive(fast, 0.5), true);
});
