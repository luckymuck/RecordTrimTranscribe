import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCues, parseTranscriptText, isTranscriptName } from "../src/transcript/parse.js";
import { toSrt, toTranscriptJson, toVtt } from "../src/transcript/format.js";

const words = [
  { text: " Hello", timestamp: [0.1, 0.4] },
  { text: " world.", timestamp: [0.4, 0.9] },
  { text: " Again", timestamp: [1.5, 1.8] },
  { text: " here.", timestamp: [1.8, 2.4] },
];

test("parseCues reads SRT and keeps cue timings", () => {
  const srt = toSrt(words);
  const parsed = parseCues(srt);
  assert.equal(parsed.timestamped, true);
  assert.equal(parsed.chunks.length, 2);
  assert.deepEqual(parsed.chunks[0].timestamp, [0.1, 0.9]);
  assert.equal(parsed.chunks[0].text.trim(), "Hello world.");
  assert.equal(parsed.text, "Hello world. Again here.");
});

test("parseCues reads WebVTT, skipping the header and notes", () => {
  const vtt = "WEBVTT\n\nNOTE a comment\n\n" + toVtt(words).replace("WEBVTT\n\n", "");
  const parsed = parseCues(vtt);
  assert.equal(parsed.chunks.length, 2);
  assert.equal(parsed.chunks[1].text.trim(), "Again here.");
});

test("parseCues strips inline markup and tolerates a dot or comma separator", () => {
  const parsed = parseCues("1\n00:00:01.500 --> 00:00:02.000\n<i>yes</i>\n");
  assert.equal(parsed.chunks[0].text.trim(), "yes");
  assert.deepEqual(parsed.chunks[0].timestamp, [1.5, 2]);
});

test("parseCues rejects a file with no cues", () => {
  assert.throws(() => parseCues("not a subtitle at all"), /no timed cues/);
});

test("the JSON transcript round-trips exactly", () => {
  const result = { text: " Hello world.", chunks: words, timestamped: true };
  const json = toTranscriptJson(result, { source: "a.mp3", sampleRate: 48000, duration: 3 });
  const parsed = parseTranscriptText(json, "a.json");
  assert.deepEqual(parsed.chunks, words);
  assert.equal(parsed.timestamped, true);
  assert.equal(parsed.meta.source, "a.mp3");
  assert.equal(parsed.meta.duration, 3);
});

test("parseTranscriptText picks the format from content and name", () => {
  assert.equal(parseTranscriptText("just some words", "a.txt").timestamped, false);
  assert.equal(parseTranscriptText("just some words", "a.txt").chunks, null);
  assert.equal(parseTranscriptText(toSrt(words), "a.srt").timestamped, true);
  // A JSON body is recognised even when the extension lies.
  const json = toTranscriptJson({ text: "hi", chunks: null, timestamped: false }, {});
  assert.equal(parseTranscriptText(json, "a.dat").text, "hi");
  assert.throws(() => parseTranscriptText("", "a.txt"), /empty/);
  assert.throws(() => parseTranscriptText("{ nope", "a.json"), /could not be parsed/);
});

test("isTranscriptName accepts the four supported kinds", () => {
  for (const name of ["a.srt", "a.VTT", "a.txt", "a.json"]) assert.equal(isTranscriptName(name), true);
  for (const name of ["a.mp3", "a.wav", "a.m4a", "srt"]) assert.equal(isTranscriptName(name), false);
});
