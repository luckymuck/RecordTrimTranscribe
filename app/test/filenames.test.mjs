import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backupName,
  clipExportName,
  clipName,
  clockStamp,
  exportBaseName,
  recordingName,
  sanitizeName,
  stripExtension,
  transcriptName,
  wholeExportName,
} from "../src/util/filenames.js";

test("stripExtension removes only the final extension", () => {
  assert.equal(stripExtension("a.v2.final.mp3"), "a.v2.final");
  assert.equal(stripExtension("talk.mp3"), "talk");
  assert.equal(stripExtension("noext"), "noext");
  assert.equal(stripExtension(""), "");
});

test("sanitizeName removes path-hostile characters and collapses spaces", () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(sanitizeName("  two   spaces  "), "two spaces");
});

test("exportBaseName strips the extension and defaults when empty", () => {
  assert.equal(exportBaseName("talk.mp3"), "talk");
  assert.equal(exportBaseName(""), "recording");
  assert.equal(exportBaseName(null), "recording");
});

test("wholeExportName keeps the speed even when silence is skipped", () => {
  assert.equal(wholeExportName("talk.mp3", {}), "talk.wav");
  assert.equal(
    wholeExportName("talk.mp3", { baked: true, speed: 2 }),
    "talk-2.00x.wav"
  );
  assert.equal(
    wholeExportName("talk.mp3", { baked: true, skip: true, speed: 4 }),
    "talk-4.00x-nosilence.wav"
  );
  assert.equal(wholeExportName("talk.mp3", { skip: true, speed: 4, format: "mp3" }), "talk-nosilence.mp3");
});

test("transcriptName keeps the source base and the kind", () => {
  assert.equal(transcriptName("a.v2.final.mp3", "srt"), "a.v2.final.srt");
  assert.equal(transcriptName("", "json"), "recording.json");
});

test("backupName", () => {  assert.equal(backupName("talk.mp3"), "talk-backup.wav");
});

test("clockStamp formats a position as HHMMSS", () => {
  assert.equal(clockStamp(0), "000000");
  assert.equal(clockStamp(75), "000115");
  assert.equal(clockStamp(3661), "010101");
  assert.equal(clockStamp(-5), "000000");
  assert.equal(clockStamp(NaN), "000000");
});

test("clipName carries the source, the number and the start clock", () => {
  assert.equal(clipName("talk.mp3", 0, 0, 48000), "talk - 01 - 000000");
  assert.equal(clipName("talk.mp3", 1, 48000 * 75, 48000), "talk - 02 - 000115");
  assert.equal(clipName("talk.mp3", 11, 48000 * 3661, 48000), "talk - 12 - 010101");
  assert.equal(clipName("", 0, 48000 * 3, 48000), "recording - 01 - 000003");
});

test("clipExportName uses the clip name as given", () => {
  assert.equal(clipExportName("talk - 01 - 000000", "mp3"), "talk - 01 - 000000.mp3");
  assert.equal(clipExportName("", "wav"), "clip.wav");
});

test("recordingName is MMDDYYYY HHMM", () => {
  const d = new Date(2026, 9, 10, 9, 5, 0); // 10 Oct 2026 09:05 local
  assert.equal(recordingName(d), "10102026 0905");
  assert.equal(recordingName(new Date(2026, 0, 3, 23, 59, 0)), "01032026 2359");
});
