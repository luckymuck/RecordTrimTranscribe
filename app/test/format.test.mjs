import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCues, formatTimestamp, toSrt, toTxt, toVtt } from "../src/transcript/format.js";

const w = (text, start, end) => ({ text, timestamp: [start, end] });

test("formatTimestamp pads and uses the requested separator", () => {
  assert.equal(formatTimestamp(0), "00:00:00,000");
  assert.equal(formatTimestamp(65.4321), "00:01:05,432");
  assert.equal(formatTimestamp(3661.5, "."), "01:01:01.500");
  assert.equal(formatTimestamp(-4), "00:00:00,000");
  assert.equal(formatTimestamp(NaN), "00:00:00,000");
});

test("buildCues breaks on sentence punctuation", () => {
  const cues = buildCues([w("Hello", 0, 0.5), w(" world.", 0.5, 1), w(" Next", 2, 2.5), w(" one.", 2.5, 3)]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "Hello world.");
  assert.equal(cues[0].start, 0);
  assert.equal(cues[1].text, "Next one.");
});

test("buildCues breaks on accumulated length", () => {
  const chunks = [];
  for (let i = 0; i < 30; i++) chunks.push(w("word ", i, i + 0.5));
  const cues = buildCues(chunks, { maxChars: 20 });
  assert.ok(cues.length > 1, "expected more than one cue");
  for (const c of cues) assert.ok(c.text.length <= 26, `cue too long: ${c.text.length}`);
});

test("buildCues breaks on duration", () => {
  // Word tokens carry their own leading space, as Whisper emits them.
  const cues = buildCues([w("a", 0, 3), w(" b", 3, 6.5), w(" c", 6.5, 9)], { maxSeconds: 6 });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "a b");
  assert.equal(cues[1].text, "c");
  assert.ok(cues[0].end - cues[0].start <= 6.5);
});

test("buildCues clamps a cue end to the next cue start", () => {
  // The last word of cue 1 claims to run past the start of cue 2.
  const cues = buildCues([w("One.", 0, 5), w("Two.", 2, 3)]);
  assert.equal(cues.length, 2);
  assert.ok(cues[0].end <= cues[1].start, `${cues[0].end} > ${cues[1].start}`);
});

test("buildCues ignores chunks without timestamps and empty input", () => {
  assert.deepEqual(buildCues(null), []);
  assert.deepEqual(buildCues([]), []);
  assert.deepEqual(buildCues([{ text: "no timing" }]), []);
});

test("toSrt numbers cues, formats ranges and ends with a newline", () => {
  const srt = toSrt([w("Hi.", 0, 0.25), w(" Bye.", 1, 1.5)]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:00,250\nHi\.\n\n2\n/);
  assert.ok(srt.endsWith("\n"));
});

test("toSrt and toVtt are empty when nothing is timestamped", () => {
  assert.equal(toSrt([]), "");
  assert.equal(toSrt([{ text: "x" }]), "");
  assert.equal(toVtt([]), "");
});

test("toVtt starts with the WEBVTT header and uses dot separators", () => {
  const vtt = toVtt([w("Hi.", 0, 1.25)]);
  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.250/);
});

test("toTxt puts sentences on separate lines", () => {
  const txt = toTxt({ text: "One thing. Two things! Three?", chunks: null });
  assert.equal(txt, "One thing.\nTwo things!\nThree?\n");
});

test("toTxt falls back to raw text and handles empty input", () => {
  assert.equal(toTxt({ text: "", chunks: null }), "");
  assert.equal(toTxt(null), "");
  assert.equal(toTxt({ text: "  ", chunks: [] }), "");
});

test("toTxt uses chunks when available", () => {
  const txt = toTxt({ text: "ignored", chunks: [w("Done.", 0, 1), w(" Next", 1, 2), w(" line.", 2, 3)] });
  assert.equal(txt, "Done.\nNext line.\n");
});
